"use strict";
/* ============ journal.js — Journal intelligence for Micro Buddy dashboard ============
 *
 * Ports the iOS journal pipeline:
 *   JournalModels.swift      — InteractionType/Direction, MomentOverride, JournalStory,
 *                              JournalMention (token: "sale|<uuid>" / "coworker|<uuid>"),
 *                              JournalEntry, InteractionClassifier
 *   JournalSpanLocator.swift — verbatim port (UTF-16 offsets; JS strings are UTF-16)
 *   InteractionParser.swift  — moment extraction, quotes, pronoun chains, tags, summaries
 *   JournalAnalyzer.swift    — deterministic story extraction from mentions
 *   JournalEditorView.swift  — `[` / `@` pickers, token highlighting, linked chips
 *   InteractionTimelineView.swift — per-coworker timeline, moment cards, type menu
 *   JournalPassageView.swift — read-only passage with highlight + scroll-to
 *
 * DATA MODEL (matches Swift Codable keys exactly):
 *   JournalEntry { id, dayKey, title, text, stories[], mentions[], summary,
 *                  aiMoments[], parkedMomentOverrides[], createdAt, updatedAt }
 *   JournalStory { id, kind: "sale"|"coworker", referenceID, text, contactID, ticketID,
 *                  saleLabel, interactionType, direction, typeLocked, directionLocked,
 *                  momentOverrides[], momentAnchors[] }
 *   JournalMention { id, kind, referenceID, label, location (UTF-16), length }
 *   MomentOverride { momentID, excerptKey, interactionType, direction,
 *                    typeLocked, directionLocked }
 *
 * OP TYPES (for SyncEngine.queueWrite — to be added to sync.js applyOp):
 *   setJournalEntryFull { date, entry } — writes the full JournalEntry object
 *     (replaces the simple setJournalEntry { date, content } for rich entries;
 *     both are accepted, full wins when present)
 *   updateMomentOverride { date, storyID, momentID, excerpt,
 *                           interactionType?, direction?, clearDirection? }
 *     — mirrors AppStore.updateMoment: upserts a MomentOverride with locks,
 *       maintains momentAnchors. Does not bump updatedAt.
 *
 * USAGE:
 *   JournalUI.renderJournalTab(boxEl, dateISO)  — full tab UI
 *   JournalUI.renderTimeline(contact, boxEl)     — coworker interaction timeline
 *   InteractionParser.parse(entry, contacts)    — [InteractionMoment]
 * ====================================================================================
 */

const JournalModels = (() => {
  const InteractionType = {
    CONVERSATION: "Conversation",
    SALE: "Sale",
    FAVOR: "Favor",
    MILESTONE: "Milestone",
  };

  const InteractionDirection = {
    THEY_CAME: "Came to you",
    YOU_WENT: "You went to them",
  };

  const StoryKind = {
    SALE: "sale",
    COWORKER: "coworker",
  };

  // UUID v4 generator
  function uuid() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // MomentOverride.key(for:) — first 64 collapsed chars, lowercased.
  // Used to migrate corrections saved before moments had stable ids.
  function excerptKeyFor(excerpt) {
    const collapsed = (excerpt || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
    return collapsed.slice(0, 64);
  }

  // JournalMention token: "sale|<uuid>" or "coworker|<uuid>"
  // Stored on the text run; the name is what you see, the id is what it links to.
  function mentionToken(kind, referenceID) {
    return kind + "|" + referenceID;
  }

  function parseMentionToken(token) {
    if (!token || typeof token !== "string") return null;
    const i = token.indexOf("|");
    if (i < 0) return null;
    const kind = token.slice(0, i);
    const ref = token.slice(i + 1);
    if ((kind !== StoryKind.SALE && kind !== StoryKind.COWORKER) || !ref) return null;
    return { kind, referenceID: ref };
  }

  function newMention(kind, referenceID, label, location, length) {
    return {
      id: uuid(),
      kind,
      referenceID,
      label: label || "",
      location: location | 0,  // UTF-16 offset in the journal body
      length: length | 0,
    };
  }

  function newStory(kind, referenceID, text, opts) {
    opts = opts || {};
    return {
      id: uuid(),
      kind,
      referenceID: referenceID || "",
      text: text || "",
      contactID: opts.contactID || null,
      ticketID: opts.ticketID || null,
      saleLabel: opts.saleLabel || null,
      interactionType: opts.interactionType || null,
      direction: opts.direction || null,
      typeLocked: !!opts.typeLocked,
      directionLocked: !!opts.directionLocked,
      momentOverrides: [],
      momentAnchors: [],
    };
  }

  function newEntry(dayKey, title, text, mentions) {
    const now = new Date().toISOString();
    return {
      id: uuid(),
      dayKey,
      title: title || "",
      text: text || "",
      stories: [],
      mentions: mentions || [],
      summary: null,
      aiMoments: [],
      parkedMomentOverrides: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  // Resolved contact/ticket id (handles pre-dual-link journals).
  function resolvedContactID(story) {
    const explicit = (story.contactID || "").trim();
    if (explicit) return explicit;
    return story.kind === StoryKind.COWORKER && story.referenceID ? story.referenceID : null;
  }

  function resolvedTicketID(story) {
    const explicit = (story.ticketID || "").trim();
    if (explicit) return explicit;
    return story.kind === StoryKind.SALE && story.referenceID ? story.referenceID : null;
  }

  return {
    InteractionType,
    InteractionDirection,
    StoryKind,
    uuid,
    excerptKeyFor,
    mentionToken,
    parseMentionToken,
    newMention,
    newStory,
    newEntry,
    resolvedContactID,
    resolvedTicketID,
  };
})();

/* ============ InteractionClassifier (from JournalModels.swift) ============
 * On-device guess for interaction type and who started the moment.
 * Precedence: user override (locked) > AI classification > this classifier.
 */
const InteractionClassifier = (() => {
  function detectType(text, hasTicket) {
    const lower = (text || "").toLowerCase();
    if (isMilestone(lower)) return JournalModels.InteractionType.MILESTONE;
    if (hasTicket && isSaleTalk(lower)) return JournalModels.InteractionType.SALE;
    if (isFavor(lower)) return JournalModels.InteractionType.FAVOR;
    if (isSaleTalk(lower)) return JournalModels.InteractionType.SALE;
    return JournalModels.InteractionType.CONVERSATION;
  }

  function detectDirection(text) {
    const lower = (text || "").toLowerCase();
    const theyCame = [
      "came over", "walked up", "walked over to me", "stopped by", "swung by",
      "came by", "came to me", "came up to", "asked me", "told me",
      "he said", "she said", "they said", "he asked", "she asked", "they asked",
    ];
    const youWent = [
      "i went", "i walked over", "i asked", "i told", "i found", "i checked",
      "i stopped by", "i swung by", "went to find", "i headed", "i went over",
    ];
    const theyHit = theyCame.some(p => lower.includes(p));
    const youHit = youWent.some(p => lower.includes(p));
    if (theyHit && !youHit) return JournalModels.InteractionDirection.THEY_CAME;
    if (youHit && !theyHit) return JournalModels.InteractionDirection.YOU_WENT;
    return null;
  }

  function isSaleTalk(lower) {
    return ["return", "returned", "refund", "sold", "sale", "customer", "receipt", "bought", "purchase"]
      .some(k => lower.includes(k));
  }

  function isMilestone(lower) {
    return ["birthday", "anniversary", "promot", "first day", "last day", "quitt", "hired", "turning"]
      .some(k => lower.includes(k));
  }

  function isFavor(lower) {
    return ["favor", "covered my", "covered for", "helped me", "did me a solid", "saved me", "lent me", "let me borrow"]
      .some(k => lower.includes(k));
  }

  return { detectType, detectDirection, isSaleTalk, isMilestone, isFavor };
})();

/* ============ JournalSpanLocator (verbatim port of JournalSpanLocator.swift) ============
 * Finds a moment's verbatim sentences inside a journal entry. Prefers the story
 * window, then the excerpt, then a single sentence if edited around the edges.
 * All offsets are UTF-16 — JS strings are UTF-16, so this maps directly.
 */
const JournalSpanLocator = (() => {
  function rangeOf(excerpt, text, window) {
    const needle = (excerpt || "").trim();
    if (!needle || !text) return null;

    const w = (window || "").trim();
    if (w) {
      const windowRange = find(w, text);
      if (windowRange) {
        const slice = text.slice(windowRange.location, windowRange.location + windowRange.length);
        const inner = find(needle, slice);
        if (inner) {
          return { location: windowRange.location + inner.location, length: inner.length };
        }
      }
    }

    const exact = find(needle, text);
    if (exact) return exact;

    // Fall back to single sentences (>= 12 chars).
    for (const s of sentenceRanges(needle)) {
      const sentence = needle.slice(s.location, s.location + s.length).trim();
      if (sentence.length < 12) continue;
      const hit = find(sentence, text);
      if (hit) return hit;
    }
    return null;
  }

  function find(needle, text) {
    if (!text || !needle) return null;
    let idx = text.indexOf(needle);
    if (idx >= 0) return { location: idx, length: needle.length };
    // Case + diacritic insensitive
    const foldedText = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const foldedNeedle = needle.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    idx = foldedText.indexOf(foldedNeedle);
    if (idx >= 0) {
      // Map back — approximate by finding the same length span.
      // For simplicity, return the folded location (lengths may differ slightly
      // with diacritics, but this is a fallback path).
      return { location: idx, length: needle.length };
    }
    return normalizedRange(needle, text);
  }

  // Maps a whitespace-collapsed match back onto the original UTF-16 span.
  function normalizedRange(needle, text) {
    const [haystack, map] = collapse(text);
    const [foldedNeedle] = collapse(needle);
    if (foldedNeedle.length < 8 || !map.length) return null;
    const foldedHay = haystack.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const foldedN = foldedNeedle.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const hit = foldedHay.indexOf(foldedN);
    if (hit < 0) return null;
    const endUnit = hit + foldedN.length - 1;
    if (hit >= map.length || endUnit >= map.length) return null;
    const start = map[hit];
    const end = map[endUnit];
    if (end < start) return null;
    return { location: start, length: end - start + 1 };
  }

  // Collapses whitespace to single spaces. map[i] = original UTF-16 index.
  function collapse(text) {
    const units = [];
    const map = [];
    let pendingSpace = false;
    let started = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const code = text.charCodeAt(i);
      const isWs = code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ||
                   code === 0xa0 || code === 0x0c || code === 0x0b;
      if (isWs) {
        if (started) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        units.push(" ");
        map.push(i);
        pendingSpace = false;
      }
      units.push(ch);
      map.push(i);
      started = true;
    }
    return [units.join(""), map];
  }

  // Sentence ranges — mirrors JournalAnalyzer.sentenceRanges (approximate;
  // the analyzer spec will refine this).
  function sentenceRanges(text) {
    const ranges = [];
    const re = /[^.!?]+[.!?]+/g;
    let m;
    let lastEnd = 0;
    while ((m = re.exec(text)) !== null) {
      ranges.push({ location: m.index, length: m[0].length });
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd < text.length) {
      ranges.push({ location: lastEnd, length: text.length - lastEnd });
    }
    return ranges;
  }

  return { rangeOf, sentenceRanges };
})();

/* ============ JournalEditor — `[` / `@` pickers + token-based highlighting ============
 * Mirrors JournalEditorView.swift:
 * - Typing `[` opens the product picker (today's sales lines)
 * - Typing `@` opens the coworker picker (contacts with avatar + work line)
 * - Selecting inserts a token: the visible label stays, but a JournalMention
 *   { kind, referenceID, location (UTF-16), length } is recorded.
 * - Mentions highlight: mint for sales, navy for people (token-based, not name match)
 * - LINKED TO THIS DAY chips below the editor
 * - Mentions survive edits: we track by token, re-locating via SpanLocator
 *   if the text shifts; the referenceID never re-guesses from the name.
 */
const JournalEditor = (() => {
  // CSS classes (dashboard uses CSS variables; mint/navy map to theme tokens)
  const MINT = "var(--accent)";   // sales mentions
  const NAVY = "var(--blue)";    // people mentions

  /**
   * Render highlighted HTML from text + mentions (token-based).
   * Mentions are drawn from the mentions array, not regex name matching.
   */
  function renderHighlighted(text, mentions) {
    if (!text) return "";
    // Sort mentions by location descending so replacements don't shift offsets.
    const sorted = (mentions || []).slice().sort((a, b) => b.location - a.location);
    // Build segments.
    let html = "";
    let pos = text.length;
    const parts = [];
    for (const m of sorted) {
      if (m.location < 0 || m.location >= text.length) continue;
      const end = Math.min(m.location + m.length, text.length);
      if (end <= m.location) continue;
      // Text after this mention (from end to pos)
      if (pos > end) parts.push({ text: text.slice(end, pos), mention: null });
      parts.push({ text: text.slice(m.location, end), mention: m });
      pos = m.location;
    }
    if (pos > 0) parts.push({ text: text.slice(0, pos), mention: null });
    parts.reverse();

    for (const p of parts) {
      const escaped = escapeHtml(p.text).replace(/\n/g, "<br>");
      if (p.mention) {
        const cls = p.mention.kind === "sale" ? "mention-product" : "mention-person";
        const token = JournalModels.mentionToken(p.mention.kind, p.mention.referenceID);
        html += '<span class="' + cls + '" data-token="' + escapeHtml(token) + '">' + escaped + "</span>";
      } else {
        html += escaped;
      }
    }
    return html;
  }

  function escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /**
   * Build the `[` picker list: today's sales lines.
   * Returns [{ ticketID, label, product, brand, unitPrice, quantity }]
   */
  function productPickerItems(day, tickets) {
    const items = [];
    for (const t of tickets || []) {
      for (const line of t.lines || []) {
        items.push({
          ticketID: t.id,
          label: line.product || "Item",
          product: line.product || "",
          brand: line.brand || "",
          unitPrice: line.unitPrice || 0,
          quantity: line.quantity || 1,
        });
      }
    }
    return items;
  }

  /**
   * Build the `@` picker list: contacts.
   * Returns [{ contactID, name, workLine, avatar }]
   */
  function coworkerPickerItems(contacts) {
    return (contacts || []).map(c => ({
      contactID: c.id,
      name: c.fullName || c.firstName || "Coworker",
      workLine: c.department || c.title || "",
      avatar: c.avatar || null,
    }));
  }

  /**
   * Insert a mention at the cursor in a textarea.
   * Returns { text, mention } — the mention has the correct UTF-16 location.
   */
  function insertMention(textarea, label, kind, referenceID) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    // If the user typed `[` or `@`, replace it.
    const triggerChar = text[start - 1];
    const replaceStart = (triggerChar === "[" || triggerChar === "@") ? start - 1 : start;
    const newText = text.slice(0, replaceStart) + label + " " + text.slice(end);
    const mention = JournalModels.newMention(
      kind, referenceID, label,
      replaceStart,  // UTF-16 offset (JS strings are UTF-16)
      label.length
    );
    return { text: newText, mention, cursorPos: replaceStart + label.length + 1 };
  }

  /**
   * Re-locate mentions after an edit. If a mention's text still matches at its
   * recorded location, keep it. Otherwise, try SpanLocator to find it.
   * Mentions that can't be found are dropped (user deleted the text).
   */
  function relocalizeMentions(text, mentions) {
    const kept = [];
    for (const m of mentions || []) {
      const atLoc = text.slice(m.location, m.location + m.length);
      if (atLoc === m.label) {
        kept.push(m);
        continue;
      }
      // Try to find the label text elsewhere.
      const found = JournalSpanLocator.rangeOf(m.label, text, null);
      if (found) {
        kept.push(Object.assign({}, m, { location: found.location, length: found.length }));
      }
      // Else: mention text was deleted — drop it.
    }
    return kept;
  }

  /**
   * LINKED TO THIS DAY chips: one chip per unique mention.
   */
  function linkedChipsHTML(mentions) {
    const seen = new Set();
    const chips = [];
    for (const m of mentions || []) {
      const key = m.kind + "|" + m.referenceID;
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = m.kind === "sale" ? "mention-product" : "mention-person";
      const icon = m.kind === "sale" ? "🧾" : "👤";
      chips.push(
        '<span class="link-chip ' + cls + '">' + icon + " " + escapeHtml(m.label) + "</span>"
      );
    }
    let html = '<div class="linked-chips"><span class="linked-label">LINKED TO THIS DAY</span>';
    if (chips.length) {
      html += chips.join("");
    } else {
      html += '<span class="linked-hint">Type [ for a sale or @ for a coworker. ' +
        "Picks stay linked even if you edit the wording.</span>";
    }
    return html + "</div>";
  }

  return {
    renderHighlighted,
    escapeHtml,
    productPickerItems,
    coworkerPickerItems,
    insertMention,
    relocalizeMentions,
    linkedChipsHTML,
  };
})();

/* ============ InteractionTimeline — per-coworker timeline UI ============
 * Mirrors InteractionTimelineView.swift:
 * - "Interactions" section, newest first, grouped by day
 * - Each moment: type chip (menu to correct), second-person summary, chevron
 * - Tap card → JournalPassageView (read-only, scrolled to passage, highlighted)
 * - Type correction writes a MomentOverride (locked, survives re-analysis)
 */
const InteractionTimeline = (() => {
  const TYPE_META = {
    "Conversation": { icon: "💬", color: "var(--blue)" },
    "Sale": { icon: "🛍️", color: "var(--accent)" },
    "Favor": { icon: "💛", color: "var(--amber)" },
    "Milestone": { icon: "⭐", color: "var(--accent)" },
  };

  /**
   * Render the timeline for a contact into boxEl.
   * moments: [InteractionMoment] from InteractionParser.days()
   */
  function render(contact, days, boxEl, onOpenPassage, onCorrectType) {
    const name = contact.fullName || contact.firstName || "them";
    let html = '<div class="timeline-section">' +
      '<div class="section-title">Interactions</div>' +
      '<div class="section-sub">Newest first, from your journals</div>';

    if (!days.length) {
      html += '<div class="empty-box">Name-drop ' + JournalEditor.escapeHtml(name) +
        " in a day's journal — each moment shows up here, newest first.</div>";
    } else {
      for (const day of days) {
        html += '<div class="timeline-day">' +
          '<button class="timeline-day-link" data-day="' + day.dayKey + '">' +
          JournalEditor.escapeHtml(formatDay(day.date)) + " ›</button>";
        for (const m of day.moments) {
          html += momentCardHTML(m);
        }
        html += "</div>";
      }
    }
    html += "</div>";
    boxEl.innerHTML = html;

    // Wire up.
    boxEl.querySelectorAll(".moment-card").forEach(card => {
      card.addEventListener("click", e => {
        if (e.target.closest(".type-menu")) return; // type menu handles its own clicks
        const momentId = card.dataset.momentId;
        const moment = findMoment(days, momentId);
        if (moment && onOpenPassage) onOpenPassage(moment);
      });
    });
    boxEl.querySelectorAll(".type-menu select").forEach(sel => {
      sel.addEventListener("change", e => {
        e.stopPropagation();
        const card = e.target.closest(".moment-card");
        const moment = findMoment(days, card.dataset.momentId);
        if (moment && onCorrectType) onCorrectType(moment, e.target.value);
      });
      sel.addEventListener("click", e => e.stopPropagation());
    });
    boxEl.querySelectorAll(".timeline-day-link").forEach(btn => {
      btn.addEventListener("click", () => {
        // Navigate to day detail — parent handles this.
        if (onOpenPassage) onOpenPassage({ dayKey: btn.dataset.day, openDay: true });
      });
    });
  }

  function findMoment(days, momentId) {
    for (const d of days) {
      for (const m of d.moments) {
        if (m.id === momentId) return m;
      }
    }
    return null;
  }

  function momentCardHTML(m) {
    const meta = TYPE_META[m.interactionType] || TYPE_META["Conversation"];
    const typeOptions = Object.keys(TYPE_META).map(t =>
      '<option value="' + t + '"' + (t === m.interactionType ? " selected" : "") + ">" + t + "</option>"
    ).join("");
    const dirLabel = m.direction ? ' <span class="moment-dir">' + JournalEditor.escapeHtml(m.direction) + "</span>" : "";
    const tags = (m.tags || []).map(t =>
      '<span class="moment-tag">' + JournalEditor.escapeHtml(t) + "</span>"
    ).join("");

    return '<div class="moment-card" data-moment-id="' + m.id + '">' +
      '<div class="moment-top">' +
        '<span class="type-chip" style="color:' + meta.color + '">' + meta.icon + " " +
          JournalEditor.escapeHtml(m.interactionType) + "</span>" +
        '<span class="type-menu"><select>' + typeOptions + "</select></span>" +
      "</div>" +
      '<div class="moment-summary">' + JournalEditor.escapeHtml(m.summary) +
        '<span class="chev">›</span></div>' +
      (dirLabel || tags ? '<div class="moment-meta">' + dirLabel + tags + "</div>" : "") +
    "</div>";
  }

  function formatDay(dateISO) {
    try {
      const d = new Date(dateISO);
      return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    } catch (e) {
      return dateISO;
    }
  }

  return { render, momentCardHTML };
})();

/* ============ JournalPassageView — read-only passage with highlight ============
 * Mirrors JournalPassageView.swift:
 * - Shows the day's journal, scrolled to the moment's passage
 * - The matched span is highlighted (navy at 28% alpha)
 * - Uses JournalSpanLocator to find the span (prefers story window)
 */
const JournalPassageView = (() => {
  function render(entry, moment, boxEl) {
    const span = JournalSpanLocator.rangeOf(moment.excerpt, entry.text, moment.storyText);
    let html = '<div class="passage-view">';
    if (entry.title) {
      html += '<div class="passage-title">' + JournalEditor.escapeHtml(entry.title) + "</div>";
    }
    html += '<div class="passage-body" id="passage-body">' +
      highlightSpan(entry.text, span) + "</div>";
    html += '<button class="btn" id="passage-back">← Back</button></div>';
    boxEl.innerHTML = html;

    // Scroll the highlight into view (centered).
    const body = boxEl.querySelector("#passage-body");
    const hl = body.querySelector(".passage-highlight");
    if (hl) {
      // Defer to let layout settle.
      setTimeout(() => {
        hl.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
    }

    boxEl.querySelector("#passage-back").addEventListener("click", () => {
      // Parent handles navigation back.
      if (JournalPassageView.onBack) JournalPassageView.onBack();
    });
  }

  function highlightSpan(text, span) {
    if (!span || span.location < 0 || span.length <= 0) {
      return JournalEditor.escapeHtml(text).replace(/\n/g, "<br>");
    }
    const before = text.slice(0, span.location);
    const hit = text.slice(span.location, span.location + span.length);
    const after = text.slice(span.location + span.length);
    return JournalEditor.escapeHtml(before).replace(/\n/g, "<br>") +
      '<span class="passage-highlight">' + JournalEditor.escapeHtml(hit).replace(/\n/g, "<br>") + "</span>" +
      JournalEditor.escapeHtml(after).replace(/\n/g, "<br>");
  }

  return { render, onBack: null };
})();

/* ============ JournalUI — main journal tab module ============
 * Replaces the basic journal tab in dashboard.html.
 * 
 * Features:
 * - Date picker + entry viewer/editor
 * - `[` product picker, `@` coworker picker (with dropdown)
 * - Token-based mention highlighting
 * - LINKED TO THIS DAY chips
 * - Save via SyncEngine.queueWrite (setJournalEntryFull op)
 */
const JournalUI = (() => {
  let currentDate = null;
  let currentEntry = null;  // JournalEntry object
  let currentMentions = []; // [JournalMention] being edited
  let pickerState = null;   // { kind: "product"|"coworker", query, items }

  /**
   * Render the full journal tab into boxEl for dateISO.
   */
  async function renderJournalTab(boxEl, dateISO) {
    currentDate = dateISO;
    boxEl.innerHTML = '<div class="spinner">Loading journal…</div>';

    try {
      const backup = await SyncEngine.getLocalBackup();
      const entry = findEntry(backup, dateISO);
      currentEntry = entry;
      currentMentions = entry ? (entry.mentions || []).slice() : [];

      let html = '<div class="journal-controls">' +
        '<div class="field"><label>Date</label><input type="date" id="journal-date" value="' + dateISO + '"></div>' +
        '<button class="btn" id="journal-go">Load</button>' +
        '<button class="btn primary" id="journal-new">＋ New entry</button>' +
        "</div>" +
        '<div id="journal-body"></div>';

      boxEl.innerHTML = html;
      renderEntry(boxEl.querySelector("#journal-body"), entry, false);

      boxEl.querySelector("#journal-go").addEventListener("click", () => {
        renderJournalTab(boxEl, boxEl.querySelector("#journal-date").value);
      });
      boxEl.querySelector("#journal-new").addEventListener("click", () => {
        const today = new Date().toISOString().slice(0, 10);
        boxEl.querySelector("#journal-date").value = today;
        renderJournalTab(boxEl, today);
      });
      boxEl.querySelector("#journal-date").addEventListener("change", e => {
        renderJournalTab(boxEl, e.target.value);
      });

      // Recent entries list
      renderRecentList(boxEl, backup, dateISO);
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t load journal: ' +
        JournalEditor.escapeHtml(e.message) + "</div>";
    }
  }

  function findEntry(backup, dateISO) {
    const j = backup && backup.data && backup.data.journals;
    if (!j) return null;
    if (Array.isArray(j)) {
      const e = j.find(x => (x.dayKey || x.date || x.id) === dateISO);
      return e ? normalizeEntry(e, dateISO) : null;
    }
    const e = j[dateISO];
    return e ? normalizeEntry(typeof e === "string" ? { text: e } : e, dateISO) : null;
  }

  // Normalize blob data to the full JournalEntry shape.
  function normalizeEntry(e, dateISO) {
    return {
      id: e.id || JournalModels.uuid(),
      dayKey: e.dayKey || e.date || dateISO,
      title: e.title || "",
      text: e.text || e.content || "",
      stories: e.stories || [],
      mentions: e.mentions || [],
      summary: e.summary || null,
      aiMoments: e.aiMoments || [],
      parkedMomentOverrides: e.parkedMomentOverrides || [],
      createdAt: e.createdAt || e.created_at || new Date().toISOString(),
      updatedAt: e.updatedAt || e.updated_at || new Date().toISOString(),
    };
  }

  function renderEntry(bodyEl, entry, forceEdit) {
    if (entry && entry.text && !forceEdit) {
      // View mode
      let html = '<div class="journal-entry"><div class="j-head">' +
        "<strong>" + JournalEditor.escapeHtml(formatDate(entry.dayKey)) + "</strong>" +
        '<button class="btn" id="journal-edit">Edit</button></div>';
      if (entry.title) {
        html += '<div class="j-title">' + JournalEditor.escapeHtml(entry.title) + "</div>";
      }
      html += '<div class="j-content">' +
        JournalEditor.renderHighlighted(entry.text, entry.mentions) + "</div>";
      html += JournalEditor.linkedChipsHTML(entry.mentions);
      if (entry.summary) {
        html += '<div class="j-summary"><strong>Summary:</strong> ' +
          JournalEditor.escapeHtml(entry.summary) + "</div>";
      }
      html += "</div>";
      bodyEl.innerHTML = html;
      bodyEl.querySelector("#journal-edit").addEventListener("click", () => {
        renderEntry(bodyEl, entry, true);
      });
    } else {
      // Edit mode
      renderEditor(bodyEl, entry);
    }
  }

  function renderEditor(bodyEl, entry) {
    const title = entry ? entry.title : "";
    const text = entry ? entry.text : "";
    currentMentions = entry ? (entry.mentions || []).slice() : [];

    let html = '<div class="journal-entry"><div class="j-head">' +
      "<strong>" + JournalEditor.escapeHtml(formatDate(currentDate)) + "</strong></div>" +
      '<input type="text" id="journal-title" placeholder="Title (optional)" value="' +
        JournalEditor.escapeHtml(title) + '">' +
      '<div class="editor-wrap">' +
      '<textarea id="journal-text" rows="12" placeholder="Write about your day… Type [ for products, @ for coworkers.">' +
        JournalEditor.escapeHtml(text) + "</textarea>" +
      '<div id="picker-dropdown" class="picker-dropdown" style="display:none"></div>' +
      "</div>" +
      '<div id="linked-chips"></div>' +
      '<div class="modal-actions"><button class="btn primary" id="journal-save">Save entry</button></div>' +
      '<div id="journal-error" class="form-error"></div></div>';
    bodyEl.innerHTML = html;

    const textarea = bodyEl.querySelector("#journal-text");
    const dropdown = bodyEl.querySelector("#picker-dropdown");
    const chipsEl = bodyEl.querySelector("#linked-chips");

    updateChips();

    // Picker trigger: `[` or `@`
    textarea.addEventListener("input", async e => {
      const suggestion = detectSuggestion(textarea);
      if (suggestion) {
        if (!pickerState || pickerState.kind !== suggestion.kind) {
          await showPicker(suggestion.kind, suggestion.query, textarea, dropdown,
            suggestion.triggerLocation);
        } else {
          pickerState.query = suggestion.query;
          pickerState.triggerLocation = suggestion.triggerLocation;
          renderPickerItems(textarea, dropdown);
        }
      } else if (pickerState) {
        hidePicker(dropdown);
      }
      // Re-localize mentions as they type.
      currentMentions = JournalEditor.relocalizeMentions(textarea.value, currentMentions);
      scheduleChipsUpdate();
    });

    // Debounced chips update (300ms, per spec).
    let chipsTimer = null;
    function scheduleChipsUpdate() {
      if (chipsTimer) clearTimeout(chipsTimer);
      chipsTimer = setTimeout(updateChips, 300);
    }

    textarea.addEventListener("keydown", e => {
      if (pickerState && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        handlePickerKey(e.key, textarea, dropdown);
      }
    });

    // Click outside closes picker.
    document.addEventListener("click", function closePicker(e) {
      if (!dropdown.contains(e.target) && e.target !== textarea) {
        hidePicker(dropdown);
      }
    });

    bodyEl.querySelector("#journal-save").addEventListener("click", async () => {
      const saveBtn = bodyEl.querySelector("#journal-save");
      const errEl = bodyEl.querySelector("#journal-error");
      errEl.textContent = "";
      saveBtn.disabled = true;
      try {
        const newTitle = bodyEl.querySelector("#journal-title").value;
        const newText = textarea.value;
        // Final re-localization.
        currentMentions = JournalEditor.relocalizeMentions(newText, currentMentions);
        const entryToSave = currentEntry ?
          Object.assign({}, currentEntry, {
            title: newTitle,
            text: newText,
            mentions: currentMentions,
            updatedAt: new Date().toISOString(),
          }) :
          Object.assign(JournalModels.newEntry(currentDate, newTitle, newText, currentMentions), {
            // Run deterministic story extraction.
            stories: await extractStories(currentDate, newText, currentMentions),
          });

        // Re-extract stories on edit (deterministic; AI pass is server-side).
        if (currentEntry) {
          entryToSave.stories = await extractStories(currentDate, newText, currentMentions);
        }

        await SyncEngine.queueWrite({
          type: "setJournalEntryFull",
          date: currentDate,
          entry: entryToSave,
        });
        currentEntry = entryToSave;
        renderEntry(bodyEl, entryToSave, false);
      } catch (e) {
        errEl.textContent = e.message || "Couldn't save the entry.";
      } finally {
        saveBtn.disabled = false;
      }
    });

    async function updateChips() {
      try {
        const backup = await SyncEngine.getLocalBackup();
        const day = findDay(backup, currentDate);
        const tickets = day ? day.tickets || [] : [];
        const contacts = getContacts(backup);
        const textarea = document.getElementById("journal-text");
        const text = textarea ? textarea.value : (currentEntry ? currentEntry.text : "");
        // Use the full matches pipeline, deduped by referenceID.
        const allMatches = JournalAnalyzer.matches(text, tickets, contacts, currentMentions);
        const seen = new Set();
        const chips = [];
        for (const m of allMatches) {
          if (seen.has(m.referenceID)) continue;
          seen.add(m.referenceID);
          chips.push({ kind: m.kind, referenceID: m.referenceID, label: m.label });
        }
        chipsEl.innerHTML = JournalEditor.linkedChipsHTML(chips);
      } catch (e) {
        chipsEl.innerHTML = JournalEditor.linkedChipsHTML(currentMentions);
      }
    }
  }

  // Detect suggestion trigger: walk backwards from caret-1.
  // Stops at \n, \r, or `]`. Finds `[` (sale) or `@` (coworker).
  // Returns { kind, triggerLocation, query } or null.
  function detectSuggestion(textarea) {
    const caret = textarea.selectionStart;
    // Only when selection is a collapsed caret.
    if (textarea.selectionStart !== textarea.selectionEnd) return null;
    const text = textarea.value;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === "\n" || ch === "\r" || ch === "]") return null;
      if (ch === "[") {
        return { kind: "product", triggerLocation: i, query: text.slice(i + 1, caret).toLowerCase() };
      }
      if (ch === "@") {
        return { kind: "coworker", triggerLocation: i, query: text.slice(i + 1, caret).toLowerCase() };
      }
    }
    return null;
  }

  function getPickerQuery(textarea) {
    const s = detectSuggestion(textarea);
    return s ? s.query : null;
  }

  async function showPicker(kind, query, textarea, dropdown, triggerLocation) {
    pickerState = { kind, query, selectedIndex: 0, items: [], triggerLocation };
    await loadPickerItems(textarea);
    renderPickerItems(textarea, dropdown);
    dropdown.style.display = "block";
  }

  function hidePicker(dropdown) {
    pickerState = null;
    dropdown.style.display = "none";
  }

  async function loadPickerItems(textarea) {
    if (!pickerState) return;
    try {
      const backup = await SyncEngine.getLocalBackup();
      if (pickerState.kind === "product") {
        const day = findDay(backup, currentDate);
        pickerState.items = JournalEditor.productPickerItems(day, day ? day.tickets : []);
      } else {
        const contacts = getContacts(backup);
        pickerState.items = JournalEditor.coworkerPickerItems(contacts);
      }
    } catch (e) {
      pickerState.items = [];
    }
  }

  function renderPickerItems(textarea, dropdown) {
    if (!pickerState) return;
    const q = (pickerState.query || "").toLowerCase();
    const filtered = pickerState.items.filter(item => {
      const label = (item.label || item.name || "").toLowerCase();
      return !q || label.includes(q);
    }).slice(0, 8);

    if (!filtered.length) {
      dropdown.innerHTML = '<div class="picker-empty">No matches</div>';
      return;
    }

    let html = "";
    filtered.forEach((item, i) => {
      const selected = i === pickerState.selectedIndex ? " selected" : "";
      if (pickerState.kind === "product") {
        html += '<div class="picker-item' + selected + '" data-index="' + i + '">' +
          '<span class="picker-label">' + JournalEditor.escapeHtml(item.label) + "</span>" +
          '<span class="picker-sub">' + JournalEditor.escapeHtml(item.brand) + " · $" +
            (item.unitPrice || 0).toFixed(2) + "</span></div>";
      } else {
        html += '<div class="picker-item' + selected + '" data-index="' + i + '">' +
          '<span class="picker-avatar">' + JournalEditor.escapeHtml((item.name || "?")[0]) + "</span>" +
          '<span class="picker-label">' + JournalEditor.escapeHtml(item.name) + "</span>" +
          '<span class="picker-sub">' + JournalEditor.escapeHtml(item.workLine) + "</span></div>";
      }
    });
    dropdown.innerHTML = html;
    pickerState.filtered = filtered;

    dropdown.querySelectorAll(".picker-item").forEach(el => {
      el.addEventListener("click", () => {
        selectPickerItem(parseInt(el.dataset.index), textarea, dropdown);
      });
    });
  }

  function handlePickerKey(key, textarea, dropdown) {
    if (!pickerState || !pickerState.filtered) return;
    if (key === "Escape") {
      hidePicker(dropdown);
    } else if (key === "ArrowDown") {
      pickerState.selectedIndex = Math.min(pickerState.selectedIndex + 1, pickerState.filtered.length - 1);
      renderPickerItems(textarea, dropdown);
    } else if (key === "ArrowUp") {
      pickerState.selectedIndex = Math.max(pickerState.selectedIndex - 1, 0);
      renderPickerItems(textarea, dropdown);
    } else if (key === "Enter") {
      selectPickerItem(pickerState.selectedIndex, textarea, dropdown);
    }
  }

  function selectPickerItem(index, textarea, dropdown) {
    const item = pickerState.filtered[index];
    if (!item) return;
    const kind = pickerState.kind === "product" ? "sale" : "coworker";
    const refID = pickerState.kind === "product" ? item.ticketID : item.contactID;
    const label = pickerState.kind === "product" ? item.label : item.name;
    // Replace from triggerLocation to caret with "label " (trailing space).
    // The mention covers the label only, not the trailing space.
    const triggerLoc = pickerState.triggerLocation != null ?
      pickerState.triggerLocation : textarea.selectionStart - 1;
    const caret = textarea.selectionStart;
    const text = textarea.value;
    const display = label + " ";
    const newText = text.slice(0, triggerLoc) + display + text.slice(caret);
    const mention = JournalModels.newMention(kind, refID, label, triggerLoc, label.length);
    textarea.value = newText;
    currentMentions.push(mention);
    const newCaret = triggerLoc + display.length;
    textarea.selectionStart = textarea.selectionEnd = newCaret;
    textarea.focus();
    hidePicker(dropdown);
    scheduleChipsUpdate();
  }

  function findDay(backup, dateISO) {
    const days = backup && backup.data && backup.data.days;
    if (!days) return null;
    if (Array.isArray(days)) return days.find(d => (d.id || d.date) === dateISO) || null;
    return days[dateISO] || null;
  }

  function getContacts(backup) {
    const c = backup && backup.data && backup.data.contacts;
    if (!c) return [];
    return Array.isArray(c) ? c : Object.values(c);
  }

  async function renderRecentList(boxEl, backup, currentDateISO) {
    // Appended after the entry by the parent — simplified here.
    // The parent dashboard.html handles the recent list; this is a hook.
  }

  function formatDate(dateISO) {
    try {
      return new Date(dateISO + "T12:00:00").toLocaleDateString(undefined, {
        weekday: "long", month: "long", day: "numeric",
      });
    } catch (e) {
      return dateISO;
    }
  }

  /**
   * Deterministic story extraction (mirrors JournalAnalyzer.stories).
   * Groups consecutive sentences by linked mention; falls back to name matching.
   * Full spec pending from analyzer agent — this is the structural shell.
   */
  async function extractStories(dayKey, text, mentions) {
    // Use the full deterministic analyzer: tokens + fuzzy matching → stories.
    try {
      const backup = await SyncEngine.getLocalBackup();
      const day = findDay(backup, dayKey);
      const tickets = day ? day.tickets || [] : [];
      const contacts = getContacts(backup);
      const fresh = JournalAnalyzer.stories(text, tickets, contacts, mentions || []);
      // Preserve user edits from the previous stories.
      const previous = currentEntry ? currentEntry.stories || [] : [];
      const parked = currentEntry ? (currentEntry.parkedMomentOverrides || []).slice() : [];
      return JournalAnalyzer.carryingEdits(fresh, previous, parked);
    } catch (e) {
      console.warn("journal: story extraction failed:", e.message);
      return [];
    }
  }

  return {
    renderJournalTab,
    normalizeEntry,
    extractStories,
  };
})();

/* ============ CSS (to be added to dashboard.html) ============
 * .mention-product { background: color-mix(in srgb, var(--accent) 18%, transparent);
 *                    color: var(--accent); border-radius: 4px; padding: 0 2px; }
 * .mention-person  { background: color-mix(in srgb, var(--blue) 18%, transparent);
 *                    color: var(--blue); border-radius: 4px; padding: 0 2px; }
 * .linked-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; align-items: center; }
 * .linked-label { font-size: 11px; font-weight: 700; color: var(--muted);
 *                 letter-spacing: 0.5px; }
 * .link-chip { font-size: 12px; padding: 3px 8px; border-radius: 12px; }
 * .picker-dropdown { position: absolute; background: var(--bg2); border: 1px solid var(--border);
 *                    border-radius: 8px; max-height: 240px; overflow-y: auto; z-index: 100;
 *                    width: 100%; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
 * .picker-item { padding: 8px 12px; cursor: pointer; display: flex; gap: 8px; align-items: center; }
 * .picker-item.selected, .picker-item:hover { background: var(--accent-dim); }
 * .picker-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--blue-dim);
 *                  display: flex; align-items: center; justify-content: center; font-weight: 700; }
 * .moment-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
 *                padding: 12px; margin-bottom: 8px; cursor: pointer; }
 * .moment-card:hover { border-color: var(--accent); }
 * .passage-highlight { background: rgba(96, 165, 250, 0.28); border-radius: 2px; }
 * .editor-wrap { position: relative; }
 */

/* ============ InteractionParser — JS port of InteractionParser.swift ============
 * Turns coworker journal stories into interaction cards.
 * 
 * Main entry: InteractionParser.days(storyLinks, contact) -> [InteractionDay]
 *   storyLinks: [JournalStoryLink] — stories about this contact
 *   contact: { id, firstName, fullName, nickname }
 *
 * Each story is split into topic slices (moments). For each moment:
 * - quotes: spoken quotes attributed to the coworker
 * - summary: one-to-two second-person sentences (not pronoun-flipped)
 * - tags: Birthday, Check-in, Support, Work, Fun
 * - type: override (locked) > AI > heuristic classifier
 * - direction: override (locked) > AI > heuristic classifier
 */
const InteractionParser = (() => {
  // ---- Entry point ----

  function days(storyLinks, contact) {
    const name = shortName(contact);
    const speakers = speakerNames(contact);
    const moments = [];
    let index = 0;

    for (const story of storyLinks) {
      const groups = interactionGroups(story, contact, speakers);
      const usedAnchors = new Set();
      for (const group of groups) {
        const excerpt = group.trim();
        if (!excerpt) continue;
        const quotes = spokenQuotes(excerpt, speakers);
        const place = placeIn(excerpt);
        const item = returnItem(excerpt);
        const key = JournalModels.excerptKeyFor(excerpt);
        const anchor = claimMomentAnchor(excerpt, key, story.momentAnchors, usedAnchors);
        const saved = savedOverride(anchor ? anchor.id : null, key, story.momentOverrides);
        const momentID = anchor ? anchor.id : (saved && saved.momentID ? saved.momentID : JournalModels.uuid());
        if (anchor) usedAnchors.add(anchor.id);

        const droppedBackground = normalize(story.text).length > normalize(excerpt).length + 12;
        const showSale = shouldShowSale(excerpt, story, !droppedBackground && slicesOf(story.text).length === 1);
        const ai = classificationFor(excerpt, story.classifications);
        const heuristicTags = tagsIn(excerpt, quotes);
        const resolvedTags = ai ? ai.tags.map(t => toTag(t)).filter(Boolean) : heuristicTags;
        const heuristicHelped = helpedIn(excerpt, resolvedTags, item);
        const detectedType = ai && ai.interactionType ? ai.interactionType :
          InteractionClassifier.detectType(excerpt, showSale);
        const type = (saved && saved.typeLocked && saved.interactionType) ? saved.interactionType : detectedType;
        const detectedDirection = ai ? ai.direction : InteractionClassifier.detectDirection(excerpt);
        const direction = (saved && saved.directionLocked) ? saved.direction : detectedDirection;
        const voice = pronounsIn(excerpt);

        moments.push({
          id: momentID,
          storyID: story.storyID,
          dayKey: story.dayKey,
          date: story.date,
          sortIndex: index,
          quotes,
          summary: cardSummary(name, excerpt, quotes, resolvedTags, voice, story.date, ai),
          place,
          tags: resolvedTags,
          helped: ai ? ai.helped : heuristicHelped,
          excerpt,
          excerptKey: key,
          momentID,
          interactionType: type,
          direction,
          contactName: name,
          ticketID: showSale ? story.ticketID : null,
          saleLabel: showSale ? story.saleLabel : null,
          storyText: story.text,
        });
        index++;
      }
    }

    // Group by day, newest moment first within day, days newest first.
    const byDay = {};
    for (const m of moments) {
      if (!byDay[m.dayKey]) byDay[m.dayKey] = [];
      byDay[m.dayKey].push(m);
    }
    return Object.keys(byDay).map(dayKey => ({
      dayKey,
      date: byDay[dayKey][0].date,
      moments: byDay[dayKey].sort((a, b) => b.sortIndex - a.sortIndex),
    })).sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  // ---- Moment grouping ----

  function interactionGroups(story, contact, speakers) {
    // Beat-link attribution: each sentence beat must carry the coworker's
    // @-tag, name, or a clear pronoun chain. Unattributed beats produce nothing.
    const beats = sentenceBeats(story.text);
    if (!beats.length) return [];
    const contactID = contact.id;
    const groups = [];
    let current = [];
    let chainAlive = false;
    let anchorVoice = null;
    let topic = null;

    for (const beat of beats) {
      const link = beatLink(beat, story, contactID, speakers, chainAlive, anchorVoice);
      if (link === "NONE") {
        if (current.length) { groups.push(current); current = []; }
        chainAlive = false; anchorVoice = null; topic = null;
        continue;
      }
      const nextTopic = primaryTopic(beat.text);
      const shifts = topic && nextTopic && nextTopic !== topic;
      const fresh = topic && nextTopic && nextTopic !== topic && startsNewBeat(beat.text);
      if ((shifts || fresh) && current.length) {
        groups.push(current); current = [];
      }
      current.push(beat);
      chainAlive = true;
      if (link !== "PRONOUN") anchorVoice = pronounsIn(beat.text);
      if (!topic) topic = nextTopic;
      else if (nextTopic) topic = nextTopic;
    }
    if (current.length) groups.push(current);

    return groups.map(g => {
      const first = g[0];
      const last = g[g.length - 1];
      const start = first.range.location;
      const end = last.range.location + last.range.length;
      return story.text.slice(start, end).trim();
    }).filter(s => s);
  }

  function sentenceBeats(text) {
    const ranges = JournalSpanLocator.sentenceRanges(text);
    if (!ranges.length && text.trim()) {
      return [{ text: text.trim(), range: { location: 0, length: text.length } }];
    }
    return ranges
      .map(r => ({
        text: text.slice(r.location, r.location + r.length).trim(),
        range: r,
      }))
      .filter(b => b.text);
  }

  // BeatLink: TAGGED | NAMED | PRONOUN | NONE
  function beatLink(beat, story, contactID, speakers, chainAlive, anchorVoice) {
    const bStart = beat.range.location;
    const bEnd = bStart + beat.range.length;
    // 1. Check mention spans (strictly > 0 intersection).
    const tags = (story.mentionSpans || []).filter(span => {
      const sStart = span.range.location;
      const sEnd = sStart + span.range.length;
      return Math.min(bEnd, sEnd) - Math.max(bStart, sStart) > 0;
    });
    if (tags.length) {
      return tags.some(t => t.contactID === contactID) ? "TAGGED" : "NONE";
    }
    // 2. Contains the contact's name?
    if (containsAnyName(speakers, beat.text)) return "NAMED";
    // 3. Names someone else? (breaks the chain)
    if (containsAnyName(story.otherNames || [], beat.text)) return "NONE";
    // 4. Unambiguous pronoun continuing the chain?
    if (chainAlive && unambiguousPronoun(beat.text, anchorVoice)) return "PRONOUN";
    return "NONE";
  }

  function containsAnyName(names, text) {
    const lower = text.toLowerCase();
    for (const raw of names || []) {
      const name = (raw || "").trim().toLowerCase();
      if (name.length < 3) continue;
      const re = new RegExp("\\b" + escapeRegex(name) + "(?:'s|\u2019s)?\\b");
      if (re.test(lower)) return true;
    }
    return false;
  }

  function unambiguousPronoun(text, anchorVoice) {
    // Exact port of InteractionParser.unambiguousPronoun.
    const padded = " " + text.toLowerCase() + " ";
    const hasHe = [" he ", " him ", " his ", " he's ", " hes "].some(s => padded.includes(s));
    const hasShe = [" she ", " her ", " hers ", " she's ", " shes "].some(s => padded.includes(s));
    const hasThey = [" they ", " them ", " their ", " they're ", " theyre "].some(s => padded.includes(s));
    if (anchorVoice) {
      if (anchorVoice.possessive === "his" && hasShe && !hasHe) return false;
      if (anchorVoice.possessive === "her" && hasHe && !hasShe) return false;
    }
    if (hasThey && !hasHe && !hasShe) {
      if (isProductThey(padded)) return false;
      return anchorVoice && anchorVoice.possessive === "their" && personIsActing(padded);
    }
    if (!hasHe && !hasShe) return false;
    if (isWriterSoloSale(padded) && !personIsActing(padded)) return false;
    return personIsActing(padded) || isBirthday(padded);
  }

  function isProductThey(lower) {
    return ["stock", "router", "customer", "ticket", "out of", "register"]
      .some(s => lower.includes(s));
  }

  function isWriterSoloSale(lower) {
    return ["i sold", "sold a", "sold the", "walk-in", "walk in", "rang up", "ubiquiti"]
      .some(s => lower.includes(s));
  }

  function personIsActing(lower) {
    const subject = /\b(he|she|they|he's|she's|they're|hes|shes)\b/.test(lower);
    if (!subject) return isBirthday(lower) || lower.includes("turning");
    const verbs = ["said", "asked", "told", "helped", "checked", "laughed", "joked",
      "was", "is", "were", "came", "walked", "covered", "sympath", "turning", "birthday"];
    return verbs.some(v => lower.includes(v)) || isBirthday(lower);
  }

  function isBirthday(lower) {
    return lower.includes("birthday");
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function slicesOf(text) {
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p);
    const chunks = paragraphs.length ? paragraphs : [text];
    return chunks.flatMap(topicSlices);
  }

  function topicSlices(text) {
    const ranges = JournalSpanLocator.sentenceRanges(text).filter(r => {
      return text.slice(r.location, r.location + r.length).trim();
    });
    if (ranges.length <= 1) return [text];
    const groups = [[ranges[0]]];
    let topic = primaryTopic(text.slice(ranges[0].location, ranges[0].location + ranges[0].length));
    for (let i = 1; i < ranges.length; i++) {
      const sentence = text.slice(ranges[i].location, ranges[i].location + ranges[i].length);
      const next = primaryTopic(sentence);
      const shifts = topic && next && next !== topic;
      const newBeat = topic && next && next !== topic && startsNewBeat(sentence);
      if (shifts || newBeat) {
        groups.push([ranges[i]]);
        topic = next || topic;
      } else {
        groups[groups.length - 1].push(ranges[i]);
        if (!topic) topic = next;
      }
    }
    return groups.map(g => {
      const first = g[0];
      const last = g[g.length - 1];
      return text.slice(first.location, last.location + last.length);
    });
  }

  function primaryTopic(sentence) {
    const lower = sentence.toLowerCase();
    if (isBirthday(lower)) return "birthday";
    if (isSympathy(lower) || (lower.includes("return") &&
        (lower.includes("$") || lower.includes("suck") || lower.includes("dang")))) {
      return "support";
    }
    if (isCheckIn(lower)) return "checkIn";
    return null;
  }

  function startsNewBeat(sentence) {
    const lower = sentence.toLowerCase();
    const lead = lower.startsWith("later") || lower.startsWith("after") ||
                 lower.startsWith("then") || lower.startsWith("afterwards");
    const event = lower.includes("return") || lower.includes("$") ||
                  lower.includes("meeting") || lower.includes("customer");
    return lead && event && !isBirthday(lower);
  }

  // ---- Quotes ----

  function spokenQuotes(text, speakers) {
    // Matches: "quote" or "quote" or «quote»
    const quoteRe = /[""«]([^""»\n]{1,400})[""»]/g;
    const quotes = [];
    let m;
    while ((m = quoteRe.exec(text)) !== null) {
      quotes.push(m[1].trim());
    }
    return quotes;
  }

  // ---- Tags ----

  function tagsIn(text, quotes) {
    const blob = (text + " " + quotes.join(" ")).toLowerCase();
    const found = [];
    const birthday = isBirthday(blob);
    const support = isSupport(blob);
    if (birthday) found.push("Birthday");
    if (isCheckIn(blob)) found.push("Check-in");
    if (support) found.push("Support");
    if (isWork(blob) && !(support && blob.includes("return"))) found.push("Work");
    if (isFun(blob) || (birthday && !isSad(blob))) found.push("Fun");
    return found;
  }

  function toTag(s) {
    const valid = ["Birthday", "Check-in", "Support", "Work", "Fun"];
    return valid.includes(s) ? s : null;
  }

  function isBirthday(lower) {
    return lower.includes("birthday") || lower.includes("b-day") || lower.includes("bday") ||
           /turning\s+\d/.test(lower);
  }

  function isSympathy(lower) {
    return lower.includes("suck") || lower.includes("dang") || lower.includes("sorry") ||
           lower.includes("sympath") || lower.includes("oh no") || lower.includes("that sucks");
  }

  function isSupport(lower) {
    if (isSympathy(lower)) return true;
    if (lower.includes("comfort") || lower.includes("cheered") || lower.includes("lifted")) return true;
    if (lower.includes("don't worry") || lower.includes("i got you") || lower.includes("my bad")) return true;
    if (lower.includes("helped me") || lower.includes("covered my") || lower.includes("covered the")) return true;
    return false;
  }

  function isCheckIn(lower) {
    return lower.includes("how are you") || lower.includes("how's it going") ||
           lower.includes("hows it going") || lower.includes("how was your") ||
           lower.includes("how's your") || lower.includes("hows your") ||
           lower.includes("check-in") || lower.includes("check in") ||
           lower.includes("caught up") || lower.includes("asked how");
  }

  function isWork(lower) {
    return ["sold", "sale", "customer", "ticket", "register", "shift", "commission", "meeting", "inventory"]
      .some(k => lower.includes(k));
  }

  function isFun(lower) {
    return lower.includes("joke") || lower.includes("laugh") || lower.includes("funny") ||
           lower.includes("haha") || lower.includes("lol") || lower.includes("party") ||
           lower.includes("goof");
  }

  function isSad(lower) {
    return lower.includes("missed") || lower.includes("forgot") ||
           lower.includes("cried") || lower.includes("upset");
  }

  // ---- Place, helped, return item ----

  function placeIn(text) {
    const lower = text.toLowerCase();
    const places = [
      ["afternoon meeting", "afternoon meeting"],
      ["morning meeting", "morning meeting"],
      ["evening meeting", "evening meeting"],
      ["sales floor", "sales floor"],
      ["on the floor", "sales floor"],
      ["break room", "break room"],
      ["lunch room", "lunch room"],
      ["back room", "back room"],
      ["warehouse", "warehouse"],
      ["customer service", "customer service"],
      ["parking lot", "parking lot"],
      ["at the register", "the register"],
      ["the register", "the register"],
      ["in a meeting", "meeting"],
      ["at the meeting", "meeting"],
      ["during lunch", "lunch"],
      ["at lunch", "lunch"],
    ];
    for (const [key, val] of places) {
      if (lower.includes(key)) return val;
    }
    return null;
  }

  function helpedIn(text, tags, item) {
    const lower = text.toLowerCase();
    const concrete = concreteHelp(lower);
    if (concrete) return concrete;
    if (lower.includes("lifted my mood") || lower.includes("cheered me up") ||
        lower.includes("made me feel better")) {
      if (item && lower.includes("return")) return "Lifted your mood after the " + item + " return";
      return "Lifted your mood";
    }
    if (tags.includes("Support") || isSympathy(lower)) {
      return "Moral support after a rough moment";
    }
    return null;
  }

  function concreteHelp(lower) {
    // Port of concreteHelp — specific help patterns.
    // Full list pending from parser spec; basic version here.
    const patterns = [
      [/covered (my|the) (\w+)/, "Covered $2"],
      [/helped me (with|with the) (\w+)/, "Helped with $2"],
    ];
    for (const [re, template] of patterns) {
      const m = lower.match(re);
      if (m) return template.replace("$2", m[2]);
    }
    return null;
  }

  function returnItem(text) {
    // Extract the item being returned (e.g., "the camera return").
    const m = text.toLowerCase().match(/(?:the|a|an) ([\w\s]+?) return/);
    return m ? m[1].trim() : null;
  }

  // ---- Summaries ----

  function cardSummary(name, text, quotes, tags, voice, date, ai) {
    // Prefer AI summary if it's a real summary (not just the name).
    if (ai && ai.summary && isRealSummary(ai.summary, name)) {
      return polish(ai.summary);
    }
    // Heuristic composed summary.
    return composedSummary(name, text, quotes, tags, voice, date);
  }

  function isRealSummary(text, name) {
    // A real summary mentions the interaction, not just the name.
    const lower = text.toLowerCase();
    return lower.length > 20 && !lower.startsWith(name.toLowerCase());
  }

  function composedSummary(name, text, quotes, tags, voice, date) {
    // Simplified: use the first 1-2 sentences, second-person.
    // Full composedSummary logic pending from parser spec.
    let summary = text;
    // Limit to 2 sentences.
    const sentences = summary.match(/[^.!?]+[.!?]+/g) || [summary];
    summary = sentences.slice(0, 2).join(" ").trim();
    return polish(summary);
  }

  function polish(text) {
    // Capitalize first letter, ensure ends with period.
    let t = (text || "").trim();
    if (!t) return t;
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (!".!?".includes(t[t.length - 1])) t += ".";
    return t;
  }

  // ---- Stable identity ----

  function claimMomentAnchor(excerpt, key, anchors, used) {
    // Find an unused anchor matching this excerpt or key.
    for (const a of anchors || []) {
      if (used.has(a.id)) continue;
      if (a.excerpt === excerpt || a.legacyKey === key) {
        return a;
      }
    }
    return null;
  }

  function savedOverride(momentID, key, overrides) {
    for (const o of overrides || []) {
      if (momentID && o.momentID === momentID) return o;
      if (o.excerptKey && o.excerptKey === key) return o;
    }
    return null;
  }

  function classificationFor(excerpt, classifications) {
    // Find AI classification matching this excerpt.
    // Simplified: match by text inclusion.
    for (const c of classifications || []) {
      if (c.text && excerpt.includes(c.text.slice(0, 40))) {
        return c;
      }
    }
    return null;
  }

  function shouldShowSale(excerpt, story, isOnlySlice) {
    // Show the sale link if the excerpt talks about the sale.
    if (!story.ticketID) return false;
    if (isOnlySlice) return true;
    return InteractionClassifier.isSaleTalk(excerpt.toLowerCase());
  }

  // ---- Helpers ----

  function normalize(text) {
    return (text || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  }

  function shortName(contact) {
    return contact.firstName || (contact.fullName || "").split(" ")[0] || "them";
  }

  function speakerNames(contact) {
    const names = [];
    if (contact.firstName) names.push(contact.firstName);
    if (contact.fullName) names.push(contact.fullName);
    if (contact.nickname) names.push(contact.nickname);
    return names;
  }

  function pronounsIn(text) {
    const lower = " " + text.toLowerCase() + " ";
    if (lower.includes(" she ") || lower.includes(" her ") || lower.includes(" she's ")) {
      return { possessive: "her", contraction: "she's" };
    }
    if (lower.includes(" he ") || lower.includes(" his ") || lower.includes(" he's ") || lower.includes(" him ")) {
      return { possessive: "his", contraction: "he's" };
    }
    return { possessive: "their", contraction: "they're" };
  }

  return {
    days,
    // Exposed for testing:
    slicesOf,
    tagsIn,
    spokenQuotes,
    cardSummary,
  };
})();

/* ============ JournalAnalyzer — JS port of JournalAnalyzer.swift ============
 * Deterministic story extraction from journal text.
 * 
 * Two pipelines:
 * 1. Deterministic (always runs): matches() → stories()
 * 2. AI pass (server-side): refines boundaries, writes summary, classifies moments
 *
 * Key rules:
 * - Picker tokens beat fuzzy name matching (covered ranges)
 * - Phrases: ≥3 chars, first-registration-wins, longest-wins on overlap
 * - Word boundaries: no alphanumeric before/after
 * - Sentences: Intl.Segmenter, drop whitespace-only
 * - Stories: consecutive sentence runs per entity; coworker extends forward
 *   only onto pronoun follow-ups; sale extends ±1 onto entity-free neighbors
 */
const JournalAnalyzer = (() => {
  /**
   * Main entry: extract stories from journal text.
   * @param {string} text - journal body
   * @param {Array} tickets - day's sale tickets
   * @param {Array} contacts - coworker contacts
   * @param {Array} mentions - picker-inserted JournalMentions
   * @returns {Array} [JournalStory]
   */
  function stories(text, tickets, contacts, mentions) {
    if (!text || !text.trim()) return [];
    const matched = matches(text, tickets, contacts, mentions || []);
    const sentences = sentenceRanges(text);
    if (!matched.length || !sentences.length) return [];

    // entityInfo: "kind:referenceID" -> { kind, referenceID, label }
    const entityInfo = {};
    for (const m of matched) {
      const key = m.kind + ":" + m.referenceID;
      entityInfo[key] = { kind: m.kind, referenceID: m.referenceID, label: m.label };
    }

    // sentenceEntities: per sentence, set of entity keys
    const sentenceEntities = sentences.map(s => entityKeysIn(s, matched, mentions || [], text));

    const result = [];
    const sortedKeys = Object.keys(entityInfo).sort();

    for (const key of sortedKeys) {
      const info = entityInfo[key];
      // Find sentence indices containing this key.
      const indices = [];
      sentenceEntities.forEach((entities, i) => {
        if (entities.has(key)) indices.push(i);
      });
      if (!indices.length) continue;

      // Group into runs of consecutive indices.
      const runs = [];
      let runStart = indices[0];
      for (let i = 1; i <= indices.length; i++) {
        if (i < indices.length && indices[i] === indices[i-1] + 1) continue;
        runs.push([runStart, indices[i-1]]);
        if (i < indices.length) runStart = indices[i];
      }

      for (let [first, last] of runs) {
        // Extend the run.
        if (info.kind === "coworker") {
          // Forward only, onto entity-free pronoun follow-ups.
          while (last + 1 < sentences.length) {
            const nextEntities = sentenceEntities[last + 1];
            const others = new Set([...nextEntities].filter(k => k !== key));
            if (others.size > 0) break;
            const nextText = text.slice(sentences[last+1].location,
              sentences[last+1].location + sentences[last+1].length);
            const runFirstText = text.slice(sentences[first].location,
              sentences[first].location + sentences[first].length);
            if (!isPronounFollowUp(nextText, runFirstText)) break;
            last++;
          }
        } else {
          // Sale: ±1 onto entity-free neighbors.
          if (first > 0) {
            const prevOthers = new Set([...sentenceEntities[first-1]].filter(k => k !== key));
            if (prevOthers.size === 0) first--;
          }
          if (last + 1 < sentences.length) {
            const nextOthers = new Set([...sentenceEntities[last+1]].filter(k => k !== key));
            if (nextOthers.size === 0) last++;
          }
        }

        const startLoc = sentences[first].location;
        const endLoc = sentences[last].location + sentences[last].length;
        const storyText = text.slice(startLoc, endLoc).trim();
        if (!storyText) continue;

        if (info.kind === "coworker") {
          // Find best-overlapping sale.
          let bestSale = null;
          let bestOverlap = 0;
          for (const m of matched) {
            if (m.kind !== "sale") continue;
            const overlap = Math.max(0, Math.min(m.location + m.length, endLoc) -
              Math.max(m.location, startLoc));
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestSale = m;
            }
          }
          result.push(JournalModels.newStory("coworker", info.referenceID, storyText, {
            contactID: info.referenceID,
            ticketID: bestSale ? bestSale.referenceID : null,
            saleLabel: bestSale ? bestSale.label : null,
            interactionType: InteractionClassifier.detectType(storyText, !!bestSale),
            direction: InteractionClassifier.detectDirection(storyText),
          }));
        } else {
          // Skip if a story with same ticket and overlapping text exists.
          const duplicate = result.some(s => {
            const sid = JournalModels.resolvedTicketID(s);
            return sid === info.referenceID && textsOverlap(s.text, storyText);
          });
          if (duplicate) continue;
          result.push(JournalModels.newStory("sale", info.referenceID, storyText, {
            ticketID: info.referenceID,
            saleLabel: info.label,
            interactionType: InteractionClassifier.detectType(storyText, true),
            direction: InteractionClassifier.detectDirection(storyText),
          }));
        }
      }
    }

    return result;
  }

  /**
   * Find all matches (tokens + fuzzy phrases) in text.
   * Returns [{ location, length, kind, referenceID, label }] sorted by location.
   */
  function matches(text, tickets, contacts, mentions) {
    const covered = []; // token ranges that fuzzy matching can't touch
    const result = [];

    // 1. Picker tokens first.
    for (const m of mentions || []) {
      if (m.location < 0 || m.length <= 0 || m.location + m.length > text.length) continue;
      const visible = text.slice(m.location, m.location + m.length).trim();
      result.push({
        location: m.location,
        length: m.length,
        kind: m.kind,
        referenceID: m.referenceID,
        label: m.label || visible,
        isToken: true,
      });
      covered.push({ location: m.location, length: m.length });
    }

    // 2. Build phrase catalog.
    const phrases = buildPhrases(tickets, contacts);

    // 3. Fuzzy phrase scan.
    const fuzzy = scanPhrases(text, phrases, covered);

    // 4. Longest-wins overlap resolution for fuzzy matches.
    fuzzy.sort((a, b) => b.length - a.length);
    const kept = [];
    for (const f of fuzzy) {
      const overlaps = kept.some(k =>
        f.location < k.location + k.length && k.location < f.location + f.length);
      if (!overlaps) kept.push(f);
    }

    // 5. Combine and sort by location.
    return result.concat(kept).sort((a, b) => a.location - b.location);
  }

  function buildPhrases(tickets, contacts) {
    const phrases = [];
    const seen = new Set(); // dedupe key -> first wins

    function add(text, kind, referenceID, label) {
      const trimmed = (text || "").trim();
      if (trimmed.length < 3) return;
      const key = foldKey(trimmed);
      if (seen.has(key)) return;
      seen.add(key);
      phrases.push({
        text: trimmed,
        folded: foldDiacritics(trimmed),
        length: trimmed.length,
        kind, referenceID, label,
        key,
      });
    }

    // Per ticket line.
    for (const t of tickets || []) {
      const seenInTicket = new Set();
      const lines = (t.lines || []).slice().sort((a, b) => (a.time || "") < (b.time || "") ? -1 : 1);
      for (const line of lines) {
        const product = (line.product || "").trim();
        if (!product) continue;
        const brand = (line.brand || "").trim();
        const dedupe = product + "|" + brand;
        if (seenInTicket.has(dedupe)) continue;
        seenInTicket.add(dedupe);
        add(product, "sale", t.id, product);
        // brand + product if product doesn't already contain brand.
        if (brand && !product.toLowerCase().includes(brand.toLowerCase())) {
          add(brand + " " + product, "sale", t.id, product);
        }
      }
    }

    // Per contact.
    // First names only if unique across contacts.
    const firstNameCounts = {};
    for (const c of contacts || []) {
      const fn = (c.firstName || "").trim().toLowerCase();
      if (fn) firstNameCounts[fn] = (firstNameCounts[fn] || 0) + 1;
    }
    for (const c of contacts || []) {
      const refID = c.id;
      if (c.fullName) add(c.fullName, "coworker", refID, c.fullName);
      if (c.nickname) add(c.nickname, "coworker", refID, c.nickname);
      const fn = (c.firstName || "").trim();
      if (fn && firstNameCounts[fn.toLowerCase()] === 1) {
        add(fn, "coworker", refID, fn);
      }
    }

    return phrases;
  }

  function scanPhrases(text, phrases, covered) {
    const result = [];
    // Sort by length descending, process in chunks of 40.
    const sorted = phrases.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < sorted.length; i += 40) {
      const chunk = sorted.slice(i, i + 40);
      // Build regex: (?<![\p{L}\p{N}])(alt)(?![\p{L}\p{N}])
      const alt = chunk.map(p => escapeRegex(p.folded)).join("|");
      try {
        const re = new RegExp("(?<![\\p{L}\\p{N}])(" + alt + ")(?![\\p{L}\\p{N}])", "giu");
        const foldedText = foldDiacritics(text);
        let m;
        const chunkMap = {};
        for (const p of chunk) {
          if (!(p.key in chunkMap)) chunkMap[p.key] = p;
        }
        while ((m = re.exec(foldedText)) !== null) {
          const captured = m[1];
          if (!captured) continue;
          const key = foldKey(captured);
          const phrase = chunkMap[key];
          if (!phrase) continue;
          const loc = m.index;
          // Skip if intersects covered.
          const intersects = covered.some(c =>
            loc < c.location + c.length && c.location < loc + captured.length);
          if (intersects) continue;
          result.push({
            location: loc,
            length: captured.length,
            kind: phrase.kind,
            referenceID: phrase.referenceID,
            label: phrase.label,
            isToken: false,
          });
        }
      } catch (e) {
        // Fallback to legacy scan for this chunk.
        for (const p of chunk) {
          legacyScan(text, p, covered, result);
        }
      }
    }
    return result;
  }

  function legacyScan(text, phrase, covered, result) {
    const needle = phrase.text;
    let searchFrom = 0;
    const lowerText = text.toLowerCase();
    const lowerNeedle = needle.toLowerCase();
    while (true) {
      const idx = lowerText.indexOf(lowerNeedle, searchFrom);
      if (idx < 0) break;
      // Boundary check.
      const beforeOK = idx === 0 || !isWordChar(text[idx - 1]);
      const afterOK = idx + needle.length >= text.length || !isWordChar(text[idx + needle.length]);
      if (beforeOK && afterOK) {
        const intersects = covered.some(c =>
          idx < c.location + c.length && c.location < idx + needle.length);
        if (!intersects) {
          result.push({
            location: idx,
            length: needle.length,
            kind: phrase.kind,
            referenceID: phrase.referenceID,
            label: phrase.label,
            isToken: false,
          });
        }
      }
      searchFrom = idx + Math.max(needle.length, 1);
    }
  }

  function isWordChar(ch) {
    return /[\p{L}\p{N}]/u.test(ch);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function foldDiacritics(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function foldKey(s) {
    return foldDiacritics(s).toLowerCase();
  }

  /**
   * Entity keys in a sentence. Token-over-name authority:
   * if a coworker token is in the sentence, drop fuzzy coworker matches.
   */
  function entityKeysIn(sentenceRange, allMatches, mentions, text) {
    const sStart = sentenceRange.location;
    const sEnd = sStart + sentenceRange.length;
    const hits = allMatches.filter(m =>
      m.location < sEnd && sStart < m.location + m.length);

    // Find coworker token hits.
    const tokenHits = hits.filter(h => {
      if (!h.isToken || h.kind !== "coworker") return false;
      return (mentions || []).some(m =>
        m.kind === "coworker" && m.referenceID === h.referenceID &&
        m.location === h.location && m.length === h.length);
    });

    const keys = new Set();
    for (const h of hits) {
      if (h.kind === "coworker" && !h.isToken && tokenHits.length > 0) {
        // A token anchors this sentence — drop fuzzy coworker matches.
        continue;
      }
      keys.add(h.kind + ":" + h.referenceID);
    }
    return keys;
  }

  function sentenceRanges(text) {
    if (!text) return [];
    // Use Intl.Segmenter for locale-aware sentence segmentation.
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      const ranges = [];
      for (const seg of segmenter.segment(text)) {
        if (seg.segment.trim()) {
          // Find the location — approximate via indexOf.
          // Note: Intl.Segmenter doesn't give indices directly in all browsers,
          // so we track position manually.
          ranges.push(seg.segment);
        }
      }
      // Convert to location/length.
      const result = [];
      let pos = 0;
      for (const s of ranges) {
        const idx = text.indexOf(s, pos);
        if (idx >= 0) {
          result.push({ location: idx, length: s.length });
          pos = idx + s.length;
        }
      }
      return result;
    } catch (e) {
      // Fallback: regex-based.
      return JournalSpanLocator.sentenceRanges(text);
    }
  }

  function isPronounFollowUp(sentence, anchorSentence) {
    // Simplified: check if sentence starts with he/she/they/him/her/it
    // and doesn't name someone else.
    // Full logic: InteractionParser.isPronounFollowUp — pending detailed spec.
    const lower = sentence.trim().toLowerCase();
    return /^(he|she|they|him|her|it|his|their)\b/.test(lower);
  }

  function textsOverlap(a, b) {
    const ta = (a || "").trim().toLowerCase();
    const tb = (b || "").trim().toLowerCase();
    if (!ta || !tb) return false;
    if (ta.includes(tb) || tb.includes(ta)) return true;
    const probe = ta.slice(0, 40);
    return probe.length >= 24 && tb.includes(probe);
  }

  /**
   * Preserve user edits across re-analysis.
   * Carries id, locked type/direction, overrides, anchors.
   */
  function preservingUserEdits(fresh, previous) {
    return fresh.map(f => {
      const old = previous.find(p => sameMoment(p, f));
      if (!old) return f;
      const copy = Object.assign({}, f, { id: old.id });
      if (old.typeLocked) {
        copy.interactionType = old.interactionType;
        copy.typeLocked = true;
      }
      if (old.directionLocked) {
        copy.direction = old.direction;
        copy.directionLocked = true;
      }
      copy.momentOverrides = (old.momentOverrides || []).slice();
      copy.momentAnchors = (old.momentAnchors || []).slice();
      return copy;
    });
  }

  function sameMoment(a, b) {
    const aContact = JournalModels.resolvedContactID(a);
    const bContact = JournalModels.resolvedContactID(b);
    const aTicket = JournalModels.resolvedTicketID(a);
    const bTicket = JournalModels.resolvedTicketID(b);
    const sameSide = (aContact && bContact && aContact === bContact) ||
                     (aTicket && bTicket && aTicket === bTicket);
    return sameSide && textsOverlap(a.text, b.text);
  }

  /**
   * Rehome orphaned overrides or park them.
   */
  function carryingEdits(fresh, previous, parked) {
    const result = preservingUserEdits(fresh, previous);
    const freshIds = new Set(result.map(s => s.id));
    for (const old of previous) {
      if (freshIds.has(old.id)) continue;
      if (!old.momentOverrides.length && !old.momentAnchors.length) continue;
      // Try to rehome.
      let rehomed = false;
      for (const o of old.momentOverrides) {
        const probe = (o.excerptKey || "").slice(0, 24);
        if (probe.length < 8) continue;
        const target = result.find(s => s.text.toLowerCase().includes(probe.toLowerCase()));
        if (target) {
          target.momentOverrides = (target.momentOverrides || []).concat(old.momentOverrides);
          target.momentAnchors = (target.momentAnchors || []).concat(old.momentAnchors);
          rehomed = true;
          break;
        }
      }
      if (!rehomed) {
        // Park the overrides (anchors are dropped).
        parked.push(...old.momentOverrides);
      }
    }
    return result;
  }

  return {
    stories,
    matches,
    sentenceRanges,
    preservingUserEdits,
    carryingEdits,
    textsOverlap,
  };
})();

/* ============ JournalStore — store-level journal operations ============
 * Mirrors AppStore+Journal.swift:
 * - storiesAbout(contactID): all JournalStoryLinks about a contact
 * - updateMoment: write a type/direction correction (MomentOverride, locked)
 * - saveJournal: upsert entry, run deterministic analysis, preserve edits
 */
const JournalStore = (() => {
  /**
   * Get all stories about a contact across all journals.
   * Returns [JournalStoryLink] sorted by date descending.
   */
  async function storiesAbout(contactID) {
    const backup = await SyncEngine.getLocalBackup();
    const journals = getAllEntries(backup);
    const links = [];
    for (const entry of journals) {
      for (const story of entry.stories || []) {
        const cid = JournalModels.resolvedContactID(story);
        if (cid === contactID) {
          links.push({
            storyID: story.id,
            dayKey: entry.dayKey,
            date: entry.dayKey,
            text: story.text,
            contactID: cid,
            ticketID: JournalModels.resolvedTicketID(story),
            saleLabel: story.saleLabel,
            interactionType: story.interactionType,
            direction: story.direction,
            momentOverrides: story.momentOverrides || [],
            momentAnchors: story.momentAnchors || [],
            classifications: entry.aiMoments || [],
            mentionSpans: [], // TODO: locate mention spans within story text
            otherNames: [],   // TODO: other coworker names in the story
          });
        }
      }
    }
    return links.sort((a, b) => b.dayKey.localeCompare(a.dayKey));
  }

  function getAllEntries(backup) {
    const j = backup && backup.data && backup.data.journals;
    if (!j) return [];
    if (Array.isArray(j)) {
      return j.map(e => JournalUI.normalizeEntry(e, e.dayKey || e.date));
    }
    return Object.keys(j).map(k =>
      JournalUI.normalizeEntry(typeof j[k] === "string" ? { text: j[k] } : j[k], k));
  }

  /**
   * Write a type or direction correction for a moment.
   * Mirrors AppStore.updateMoment: upserts MomentOverride with locks,
   * maintains momentAnchors. Does not bump updatedAt.
   */
  async function updateMoment(dayKey, storyID, momentID, excerpt, opts) {
    opts = opts || {};
    const excerptKey = JournalModels.excerptKeyFor(excerpt);
    await SyncEngine.queueWrite({
      type: "updateMomentOverride",
      date: dayKey,
      storyID,
      momentID,
      excerpt,
      excerptKey,
      interactionType: opts.interactionType || null,
      direction: opts.direction || null,
      clearDirection: !!opts.clearDirection,
    });
  }

  /**
   * Save a journal entry: upsert, run deterministic analysis, preserve edits.
   * Mirrors AppStore.saveJournal.
   */
  async function saveJournal(dayKey, title, text, mentions) {
    const trimmedText = (text || "").trim();
    const backup = await SyncEngine.getLocalBackup();
    const existing = findEntry(backup, dayKey);

    if (!existing && !trimmedText) return; // nothing to save
    if (existing && !trimmedText) {
      // Saving empty clears the journal.
      await SyncEngine.queueWrite({ type: "deleteJournalEntry", date: dayKey });
      return;
    }

    let entry;
    if (!existing) {
      entry = JournalModels.newEntry(dayKey, title, text, mentions);
      entry.stories = JournalAnalyzer.stories(text, await getTickets(dayKey), await getContacts(), mentions);
      // TODO: InteractionParser.rebound(entry) — bind moments to anchors
    } else {
      const previous = existing.stories || [];
      const parked = (existing.parkedMomentOverrides || []).slice();
      const fresh = JournalAnalyzer.stories(text, await getTickets(dayKey), await getContacts(), mentions);
      entry = Object.assign({}, existing, {
        title: (title || "").trim(),
        text,
        mentions: mentions || [],
        stories: JournalAnalyzer.carryingEdits(fresh, previous, parked),
        parkedMomentOverrides: parked,
        aiMoments: [],
        summary: null,
        updatedAt: new Date().toISOString(),
      });
    }

    await SyncEngine.queueWrite({ type: "setJournalEntryFull", date: dayKey, entry });
    // TODO: schedule AI analysis (server-side)
    return entry;
  }

  function findEntry(backup, dayKey) {
    const j = backup && backup.data && backup.data.journals;
    if (!j) return null;
    if (Array.isArray(j)) {
      const e = j.find(x => (x.dayKey || x.date) === dayKey);
      return e ? JournalUI.normalizeEntry(e, dayKey) : null;
    }
    const e = j[dayKey];
    return e ? JournalUI.normalizeEntry(typeof e === "string" ? { text: e } : e, dayKey) : null;
  }

  async function getTickets(dayKey) {
    const backup = await SyncEngine.getLocalBackup();
    const days = backup && backup.data && backup.data.days;
    if (!days) return [];
    const day = Array.isArray(days) ?
      days.find(d => (d.id || d.date) === dayKey) : days[dayKey];
    return day ? day.tickets || [] : [];
  }

  async function getContacts() {
    const backup = await SyncEngine.getLocalBackup();
    const c = backup && backup.data && backup.data.contacts;
    if (!c) return [];
    return Array.isArray(c) ? c : Object.values(c);
  }

  return {
    storiesAbout,
    updateMoment,
    saveJournal,
    getAllEntries,
  };
})();

/* ============ OP TYPES FOR sync.js ============
 *
 * Add these cases to SyncEngine.applyOp in sync.js:
 *
 * case "setJournalEntryFull": {
 *   // Writes the full JournalEntry object (not just content).
 *   // op: { date, entry }
 *   if (!data.journals) data.journals = {};
 *   if (Array.isArray(data.journals)) {
 *     let e = data.journals.find(j => (j.dayKey || j.date) === op.date);
 *     if (!e) { e = { dayKey: op.date }; data.journals.push(e); }
 *     Object.assign(e, op.entry, { dayKey: op.date });
 *   } else {
 *     data.journals[op.date] = Object.assign({}, op.entry, { dayKey: op.date });
 *   }
 *   return true;
 * }
 *
 * case "updateMomentOverride": {
 *   // Mirrors AppStore.updateMoment. Upserts a MomentOverride with locks.
 *   // op: { date, storyID, momentID, excerpt, excerptKey,
 *   //       interactionType?, direction?, clearDirection? }
 *   const entry = findJournalEntry(data, op.date);
 *   if (!entry || !entry.stories) return false;
 *   const story = entry.stories.find(s => s.id === op.storyID);
 *   if (!story) return false;
 *   if (!story.momentOverrides) story.momentOverrides = [];
 *   let ov = story.momentOverrides.find(o =>
 *     (o.momentID && o.momentID === op.momentID) ||
 *     (o.excerptKey && o.excerptKey === op.excerptKey));
 *   if (ov) {
 *     ov.momentID = op.momentID;
 *     if (op.interactionType) { ov.interactionType = op.interactionType; ov.typeLocked = true; }
 *     if (op.clearDirection) { ov.direction = null; ov.directionLocked = true; }
 *     else if (op.direction) { ov.direction = op.direction; ov.directionLocked = true; }
 *   } else {
 *     story.momentOverrides.push({
 *       momentID: op.momentID,
 *       excerptKey: op.excerptKey,
 *       interactionType: op.interactionType || null,
 *       direction: op.clearDirection ? null : (op.direction || null),
 *       typeLocked: !!op.interactionType,
 *       directionLocked: !!op.direction || op.clearDirection,
 *     });
 *   }
 *   if (!story.momentAnchors) story.momentAnchors = [];
 *   let anchor = story.momentAnchors.find(a => a.id === op.momentID);
 *   if (anchor) {
 *     anchor.excerpt = op.excerpt;
 *     if (!anchor.legacyKey) anchor.legacyKey = op.excerptKey;
 *   } else {
 *     story.momentAnchors.push({ id: op.momentID, excerpt: op.excerpt, legacyKey: op.excerptKey });
 *   }
 *   // Note: does NOT bump updatedAt (so in-flight AI summaries can still land).
 *   return true;
 * }
 *
 * case "deleteJournalEntry": {
 *   // op: { date }
 *   if (!data.journals) return true;
 *   if (Array.isArray(data.journals)) {
 *     data.journals = data.journals.filter(j => (j.dayKey || j.date) !== op.date);
 *   } else {
 *     delete data.journals[op.date];
 *   }
 *   return true;
 * }
 */
