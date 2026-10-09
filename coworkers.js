"use strict";
/* ============ coworkers.js — Coworkers tab for Micro Buddy dashboard ============
 *
 * Ports the iOS Coworkers feature set:
 *   Models/CoworkerContact.swift       — full contact shape (Apple Contacts-level
 *                                       fields + shift notes, favorites, links)
 *   Models/CoworkerComparison.swift   — ComparisonSide / CoworkerComparison
 *   Views/CoworkersView.swift         — grid (favorites on top, alphabetical
 *                                       sections, search), detail page
 *   Views/CoworkerCompareView.swift   — you-vs-coworker compare flow
 *   Views/ComparisonDetailView.swift  — saved comparison breakdown
 *   Stores/AppStore+Contacts.swift    — upsert/delete/favorite/shift notes
 *
 * DATA MODEL (matches Swift Codable keys exactly — data.contacts is
 * [CoworkerContact]):
 *   CoworkerContact { id, firstName, lastName, organization, phone, email,
 *     photoData (base64), isFavorite, favoriteRank, notes, shiftNotes[],
 *     createdAt, linkedUserID, linkedPhotoData, namePrefix, middleName,
 *     nameSuffix, nickname, jobTitle, department, birthday, phones[],
 *     emails[], urls[], addresses[], socials[], relatedNames[], customDates[],
 *     dismissedSuggestions[] }
 *   CoworkerComparison { id, coworkerName, dayKey, date, createdAt,
 *     yours: ComparisonSide, theirs: ComparisonSide, theirTickets[] }
 *   ComparisonSide { revenue, commission, items, plans, customers, hours?,
 *     topProducts[] }
 *
 * OP TYPES (for SyncEngine.queueWrite — add these cases to sync.js applyOp):
 *
 *   addContact { contact }
 *     — Appends a full CoworkerContact to data.contacts. Generates id/createdAt
 *       when missing. Returns true.
 *
 *   updateContact { contactId, updates }   [EXISTS in sync.js]
 *     — Object.assign onto the matched contact. For nested arrays (phones,
 *       shiftNotes, …) pass the complete replacement array.
 *
 *   deleteContact { contactId }
 *     — Removes the contact from data.contacts. Returns false when missing.
 *
 *   addShiftNote { contactId, note: { id?, date, shiftLabel?, text, shiftID? } }
 *     — Appends a CoworkerShiftNote to the contact's shiftNotes.
 *
 *   deleteShiftNote { contactId, noteId }
 *     — Removes one shift note from the contact.
 *
 *   addComparison { comparison }
 *     — Appends a CoworkerComparison to data.comparisons (creates the array).
 *
 *   updateComparison { comparisonId, updates }
 *     — Object.assign onto the matched comparison.
 *
 *   deleteComparison { comparisonId }
 *     — Removes the comparison. Never touches the user's own sales.
 *
 * USAGE (parent wires these into the coworkers tab):
 *   CoworkersUI.renderGrid(boxEl)                    — card grid + search hookup
 *   CoworkersUI.renderDetail(boxEl, contactId)        — full detail + timeline
 *   CoworkersUI.renderContactForm(boxEl, contactId?)  — add/edit sheet
 *   CoworkersUI.renderCompare(boxEl, dayKey?)         — you-vs-coworker flow
 *   CoworkersUI.renderComparisonDetail(boxEl, id)     — saved comparison view
 *   CoworkersUI.renderComparisonsList(boxEl)          — saved comparisons
 * ====================================================================================
 */

const CoworkersUI = (() => {
  // ---------------------------------------------------------------------------
  // Contact model helpers (mirror CoworkerContact.swift computed properties)
  // ---------------------------------------------------------------------------

  function fullName(c) {
    const n = ((c.firstName || "") + " " + (c.lastName || "")).trim();
    return n || (c.organization || "").trim() || (c.name || "").trim() || "Unknown";
  }

  function displayName(c) {
    if (c.displayName) return c.displayName;
    const parts = [c.namePrefix, c.firstName, c.middleName, c.lastName, c.nameSuffix]
      .map(s => (s || "").trim()).filter(Boolean);
    return parts.length ? parts.join(" ") : fullName(c);
  }

  function preferredName(c) {
    const nick = (c.nickname || "").trim();
    return nick || fullName(c);
  }

  function workLine(c) {
    return [c.organization, c.jobTitle || c.title, c.department, c.role]
      .map(s => (s || "").trim()).filter(Boolean).join(" · ");
  }

  function sortName(c) {
    const last = (c.lastName || "").trim();
    const first = (c.firstName || "").trim();
    if (!last && !first) return (c.organization || fullName(c)).trim();
    if (!last) return first;
    return last + " " + first;
  }

  function initials(c) {
    const words = fullName(c).split(/\s+/).filter(Boolean).slice(0, 2);
    return words.map(w => w[0]).join("").toUpperCase() || "?";
  }

  function photoSrc(c) {
    // photoData wins, then linkedPhotoData (synced from their MB account),
    // then legacy photo/avatar fields.
    const d = c.photoData || c.linkedPhotoData || c.photo || c.avatar;
    if (!d) return null;
    return String(d).startsWith("data:") ? d : "data:image/jpeg;base64," + d;
  }

  function primaryPhone(c) {
    if (Array.isArray(c.phones) && c.phones.length) return c.phones[0].value || "";
    return c.phone || "";
  }

  function primaryEmail(c) {
    if (Array.isArray(c.emails) && c.emails.length) return c.emails[0].value || "";
    return c.email || "";
  }

  /// "+1 (714) 555-0134" — port of CoworkerContact.formattedPhone.
  function formattedPhone(raw) {
    const cleaned = String(raw || "").replace(/[^\d+]/g, "");
    const digits = cleaned.replace(/\D/g, "");
    let local = null;
    if (digits.length === 11 && digits[0] === "1") local = digits.slice(1);
    else if (digits.length === 10) local = digits;
    if (!local) return cleaned;
    return "+1 (" + local.slice(0, 3) + ") " + local.slice(3, 6) + "-" + local.slice(6);
  }

  function callablePhone(raw) {
    return String(raw || "").replace(/[^\d+]/g, "");
  }

  function normalizeContact(c) {
    // Accept both the full Swift shape and the dashboard's simplified shape.
    const out = Object.assign({}, c);
    if (!out.id) out.id = "contact-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    if (!out.firstName && !out.lastName && out.name) {
      const parts = String(out.name).trim().split(/\s+/);
      out.firstName = parts[0] || "";
      out.lastName = parts.slice(1).join(" ") || "";
    }
    if (!out.createdAt) out.createdAt = new Date().toISOString();
    if (!Array.isArray(out.shiftNotes)) out.shiftNotes = [];
    if (!Array.isArray(out.phones)) out.phones = [];
    if (!Array.isArray(out.emails)) out.emails = [];
    // Migrate legacy single phone/email into labeled lists (mirrors Swift init).
    if (!out.phones.length && out.phone) out.phones = [{ id: uid(), label: "Mobile", value: out.phone }];
    if (!out.emails.length && out.email) out.emails = [{ id: uid(), label: "Email", value: out.email }];
    return out;
  }

  // The phone decodes these ids as Swift UUIDs — anything else breaks its
  // restore, so always mint real (uppercase) UUIDs.
  function uid() { return AppDataSanitizer.uuid(); }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  async function getContacts() {
    const backup = await SyncEngine.getLocalBackup();
    const raw = backup && backup.data && backup.data.contacts;
    const arr = Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
    return arr.map(normalizeContact);
  }

  async function getComparisons() {
    const backup = await SyncEngine.getLocalBackup();
    const raw = backup && backup.data && backup.data.comparisons;
    return Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
  }

  async function saveContact(contact) {
    const c = normalizeContact(contact);
    // Keep legacy single-value fields in sync (mirrors normalized()).
    c.phones = (c.phones || []).filter(p => (p.value || "").trim());
    c.emails = (c.emails || []).filter(p => (p.value || "").trim());
    c.phone = c.phones.length ? c.phones[0].value : "";
    c.email = c.emails.length ? c.emails[0].value : "";
    const existing = await findContact(c.id);
    if (existing) {
      await SyncEngine.queueWrite({ type: "updateContact", contactId: c.id, updates: c });
    } else {
      await SyncEngine.queueWrite({ type: "addContact", contact: c });
    }
    return c;
  }

  async function findContact(id) {
    const all = await getContacts();
    return all.find(c => String(c.id) === String(id)) || null;
  }

  async function deleteContact(id) {
    await SyncEngine.queueWrite({ type: "deleteContact", contactId: id });
  }

  // ---------------------------------------------------------------------------
  // Avatar
  // ---------------------------------------------------------------------------

  function avatarHTML(c, size) {
    size = size || 44;
    const src = photoSrc(c);
    const style = "width:" + size + "px;height:" + size + "px;font-size:" + Math.round(size * 0.36) + "px;";
    if (src) {
      return '<img class="c-avatar" src="' + esc(src) + '" alt="" style="' + style + "object-fit:cover;\">";
    }
    return '<div class="c-avatar c-initial" style="' + style + '">' + esc(initials(c)) + "</div>";
  }

  // ---------------------------------------------------------------------------
  // 1. Coworker grid
  // ---------------------------------------------------------------------------

  /**
   * Contact cards: favorites (custom order) on top, then alphabetical letter
   * sections like Apple Contacts. Each card shows avatar, name, role/department,
   * and the last interaction date from the journal timeline.
   */
  async function renderGrid(boxEl) {
    boxEl.innerHTML = spinner("Loading coworkers…");
    try {
      const contacts = await getContacts();
      const q = (boxEl.dataset.query || "").toLowerCase().trim();

      let list = contacts;
      if (q) {
        list = contacts.filter(c =>
          fullName(c).toLowerCase().includes(q) ||
          preferredName(c).toLowerCase().includes(q) ||
          (c.organization || "").toLowerCase().includes(q) ||
          (c.notes || "").toLowerCase().includes(q) ||
          primaryEmail(c).toLowerCase().includes(q) ||
          primaryPhone(c).includes(q));
      }

      // Last interaction per contact (from journal stories).
      const lastSeen = await lastInteractionDates(list.map(c => String(c.id)));

      const favorites = list.filter(c => c.isFavorite)
        .sort((a, b) => (a.favoriteRank || 0) - (b.favoriteRank || 0));
      const rest = list.filter(c => !c.isFavorite)
        .sort((a, b) => sortName(a).toLowerCase().localeCompare(sortName(b).toLowerCase()));

      let html = '<div class="cw-toolbar">' +
        '<input type="search" id="cw-search" placeholder="Search coworkers…" autocomplete="off" value="' + esc(boxEl.dataset.query || "") + '">' +
        '<button class="btn primary" id="cw-add">' + Icon("user-plus", { size: 14 }) + ' Add</button>' +
        '<button class="btn" id="cw-compare">' + Icon("swap", { size: 14 }) + ' Compare</button>' +
        "</div>";

      if (!list.length) {
        html += '<div class="empty-box">' +
          (q ? "No coworkers match." : "No coworkers yet. Add the people you work with — their journal moments will build a timeline here.") +
          "</div>";
      } else {
        if (favorites.length && !q) {
          html += '<div class="section-title">' + Icon("star", { size: 13 }) + ' Favorites</div><div class="coworker-grid">';
          favorites.forEach(c => { html += cardHTML(c, lastSeen[String(c.id)]); });
          html += "</div>";
        }
        if (q) {
          html += '<div class="coworker-grid">';
          list.forEach(c => { html += cardHTML(c, lastSeen[String(c.id)]); });
          html += "</div>";
        } else {
          // Alphabetical letter sections.
          const buckets = {};
          rest.forEach(c => {
            const letter = sortName(c).charAt(0).toUpperCase();
            const key = /[A-Z]/.test(letter) ? letter : "#";
            (buckets[key] = buckets[key] || []).push(c);
          });
          Object.keys(buckets).sort((a, b) => a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b))
            .forEach(k => {
              html += '<div class="section-title">' + esc(k) + "</div>" +
                '<div class="coworker-grid">';
              buckets[k].forEach(c => { html += cardHTML(c, lastSeen[String(c.id)]); });
              html += "</div>";
            });
        }
      }

      // Saved comparisons shortcut.
      const comps = await getComparisons();
      if (comps.length) {
        html += '<div class="section-title">Saved comparisons</div><div id="cw-comps"></div>';
      }

      boxEl.innerHTML = html;

      boxEl.querySelector("#cw-search").addEventListener("input", e => {
        boxEl.dataset.query = e.target.value;
        // Debounced re-render.
        clearTimeout(boxEl._qT);
        boxEl._qT = setTimeout(() => renderGrid(boxEl), 250);
      });
      boxEl.querySelector("#cw-add").addEventListener("click", () =>
        renderContactForm(boxEl, null));
      boxEl.querySelector("#cw-compare").addEventListener("click", () =>
        renderCompare(boxEl, null));

      boxEl.querySelectorAll(".coworker-card").forEach(el => {
        el.addEventListener("click", () => renderDetail(boxEl, el.dataset.id));
      });

      if (comps.length) {
        renderComparisonsList(boxEl.querySelector("#cw-comps"));
      }
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t load coworkers: ' + esc(e.message) + "</div>";
    }
  }

  function cardHTML(c, lastSeenISO) {
    const wl = workLine(c);
    let sub = wl;
    if (lastSeenISO) {
      sub += (sub ? " · " : "") + "last seen " + shortDate(lastSeenISO);
    }
    return '<div class="coworker-card" data-id="' + esc(c.id) + '">' +
      avatarHTML(c, 44) +
      '<div class="c-info"><strong>' + esc(preferredName(c)) + "</strong>" +
      (sub ? '<span class="c-role">' + esc(sub) + "</span>" : "") +
      (c.linkedUserID ? '<span class="c-linked" title="Linked to their Micro Buddy account">' + Icon("link", { size: 13 }) + '</span>' : "") +
      "</div></div>";
  }

  async function lastInteractionDates(contactIds) {
    // Newest journal story date per contact.
    const out = {};
    try {
      for (const id of contactIds) {
        const links = await JournalStore.storiesAbout(String(id));
        if (links.length) out[String(id)] = links[0].dayKey || links[0].date;
      }
    } catch (e) { /* journals unavailable — skip */ }
    return out;
  }

  function shortDate(iso) {
    try {
      return new Date(iso + "T12:00:00").toLocaleDateString(undefined,
        { month: "short", day: "numeric" });
    } catch (e) { return ""; }
  }

  // ---------------------------------------------------------------------------
  // 2. Coworker detail
  // ---------------------------------------------------------------------------

  /**
   * Full detail page: avatar, name, work line, favorite toggle, contact info
   * (phones, emails, urls, addresses, socials, birthday, custom dates),
   * notes, shift notes, leaderboard link, then the InteractionTimeline
   * (newest first, moment cards tap-to-jump to journal passages).
   */
  async function renderDetail(boxEl, contactId) {
    boxEl.innerHTML = spinner("Loading…");
    try {
      const c = await findContact(contactId);
      if (!c) {
        boxEl.innerHTML = '<div class="empty-box">Contact not found.</div>';
        return;
      }
      const wl = workLine(c);
      let html = '<div class="cw-detail-nav">' +
        '<button class="btn ghost" id="cw-back">' + Icon("chevron-left", { size: 14 }) + ' All coworkers</button>' +
        '<div><button class="btn" id="cw-edit">Edit</button> ' +
        '<button class="btn ghost" id="cw-del">Delete</button></div></div>';

      html += '<div class="coworker-detail">' + avatarHTML(c, 72) +
        "<h2>" + esc(preferredName(c)) + "</h2>" +
        (fullName(c) !== preferredName(c) ? '<div class="cw-fullname">' + esc(fullName(c)) + "</div>" : "") +
        (wl ? '<div class="cw-workline">' + esc(wl) + "</div>" : "") +
        '<div class="cw-actions">' +
        '<button class="btn' + (c.isFavorite ? " primary" : "") + '" id="cw-fav">' +
          (c.isFavorite ? Icon("star", { size: 14 }) + " Favorited" : Icon("star", { size: 14 }) + " Favorite") + "</button>";

      const phone = primaryPhone(c);
      if (phone) {
        const tel = callablePhone(phone);
        html += '<a class="btn" href="tel:' + esc(tel) + '">' + Icon("phone", { size: 14 }) + ' Call</a>' +
          '<a class="btn" href="sms:' + esc(tel) + '">' + Icon("chat", { size: 14 }) + ' Text</a>';
      }
      const email = primaryEmail(c);
      if (email) html += '<a class="btn" href="mailto:' + esc(email) + '">' + Icon("mail", { size: 14 }) + ' Email</a>';
      if (c.linkedUserID) {
        html += '<button class="btn" id="cw-leaderboard">' + Icon("trophy", { size: 14 }) + ' Leaderboard</button>';
      } else {
        html += '<button class="btn ghost" id="cw-compare-one">' + Icon("swap", { size: 14 }) + ' Compare sales</button>';
      }
      html += "</div></div>";

      // Contact info sections.
      html += infoSectionsHTML(c);

      // Notes.
      if (c.notes) {
        html += '<div class="section-title">Notes</div>' +
          '<div class="panel"><div class="pre-wrap">' + esc(c.notes) + "</div></div>";
      }

      // Shift notes.
      html += '<div class="section-title">Shift notes</div><div id="cw-shiftnotes"></div>';

      // Timeline (InteractionParser via journal.js).
      html += '<div id="cw-timeline"></div>';

      boxEl.innerHTML = html;

      boxEl.querySelector("#cw-back").addEventListener("click", () => renderGrid(boxEl));
      boxEl.querySelector("#cw-edit").addEventListener("click", () => renderContactForm(boxEl, c.id));
      boxEl.querySelector("#cw-del").addEventListener("click", async () => {
        if (!confirm("Delete " + preferredName(c) + "? This can't be undone.")) return;
        await deleteContact(c.id);
        renderGrid(boxEl);
      });
      boxEl.querySelector("#cw-fav").addEventListener("click", async () => {
        const all = await getContacts();
        const favs = all.filter(x => x.isFavorite);
        const updates = { isFavorite: !c.isFavorite };
        if (!c.isFavorite) {
          updates.favoriteRank = Math.max(-1, ...favs.map(x => x.favoriteRank || 0)) + 1;
        }
        await SyncEngine.queueWrite({ type: "updateContact", contactId: c.id, updates });
        renderDetail(boxEl, c.id);
      });
      const lbBtn = boxEl.querySelector("#cw-leaderboard");
      if (lbBtn) lbBtn.addEventListener("click", () => {
        // Parent app handles leaderboard deep-link; fall back to stats tab.
        document.querySelector('[data-tab="stats"]')?.click();
      });
      const cmpBtn = boxEl.querySelector("#cw-compare-one");
      if (cmpBtn) cmpBtn.addEventListener("click", () =>
        renderCompare(boxEl, null, c.id));

      renderShiftNotes(boxEl.querySelector("#cw-shiftnotes"), c);
      await renderTimeline(boxEl.querySelector("#cw-timeline"), c, boxEl);
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t load contact: ' + esc(e.message) + "</div>";
    }
  }

  function labeledListHTML(title, items, fmt) {
    if (!items || !items.length) return "";
    let html = '<div class="cw-info-group"><div class="cw-info-title">' + esc(title) + "</div>";
    items.forEach(it => {
      html += '<div class="cw-info-row">' +
        (it.label ? '<span class="cw-info-label">' + esc(it.label) + "</span>" : "") +
        '<span class="cw-info-value">' + fmt(it) + "</span></div>";
    });
    return html + "</div>";
  }

  function infoSectionsHTML(c) {
    let html = '<div class="section-title">Info</div><div class="panel cw-info">';
    let any = false;
    const push = s => { if (s) { html += s; any = true; } };

    push(labeledListHTML("Phone", c.phones, p =>
      '<a href="tel:' + esc(callablePhone(p.value)) + '">' + esc(formattedPhone(p.value)) + "</a>"));
    push(labeledListHTML("Email", c.emails, p =>
      '<a href="mailto:' + esc(p.value) + '">' + esc(p.value) + "</a>"));
    push(labeledListHTML("URL", c.urls, p => {
      const u = /^https?:/i.test(p.value) ? p.value : "https://" + p.value;
      return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(p.value) + "</a>";
    }));
    if (c.birthday) {
      any = true;
      html += '<div class="cw-info-group"><div class="cw-info-title">Birthday</div>' +
        '<div class="cw-info-row"><span class="cw-info-value">' +
        esc(new Date(c.birthday).toLocaleDateString(undefined, { month: "long", day: "numeric" })) +
        "</span></div></div>";
    }
    push(labeledListHTML("Address", c.addresses, a => esc(oneLineAddress(a))));
    push(labeledListHTML("Social", c.socials, s => {
      const url = socialURL(s.service, s.username);
      const label = esc(s.service ? s.service + ": " : "") + esc(s.username);
      return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + label + "</a>" : label;
    }));
    push(labeledListHTML("Related", c.relatedNames, p =>
      (p.label ? esc(p.label) + ": " : "") + esc(p.value)));
    push(labeledListHTML("Dates", c.customDates, d =>
      esc(d.label ? d.label + ": " : "") +
      esc(new Date(d.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))));
    if (!any) html += '<div class="muted">No contact info yet — tap Edit to add some.</div>';
    return html + "</div>";
  }

  function oneLineAddress(a) {
    return [a.street, a.city, a.state, a.zip].map(s => (s || "").trim())
      .filter(Boolean).join(", ");
  }

  function socialURL(service, username) {
    const h = String(username || "").trim();
    if (!h) return null;
    switch (service) {
      case "Instagram": return "https://instagram.com/" + h;
      case "X": return "https://x.com/" + h;
      case "LinkedIn": return "https://linkedin.com/in/" + h;
      case "Facebook": return "https://facebook.com/" + h;
      case "TikTok": return "https://tiktok.com/@" + h;
      case "Snapchat": return "https://snapchat.com/add/" + h;
      default: return null;
    }
  }

  // ---- Shift notes ----

  function renderShiftNotes(boxEl, c) {
    const notes = (c.shiftNotes || []).slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    let html = "";
    if (!notes.length) {
      html = '<div class="muted" style="margin-bottom:8px">No shift notes yet.</div>';
    } else {
      notes.forEach(n => {
        html += '<div class="panel shift-note">' +
          '<div class="shift-note-head"><strong>' + esc(shortDate(n.date)) + "</strong>" +
          (n.shiftLabel ? ' <span class="muted">' + esc(n.shiftLabel) + "</span>" : "") +
          '<button class="btn ghost sm" data-delnote="' + esc(n.id) + '">Delete</button></div>' +
          '<div class="pre-wrap">' + esc(n.text) + "</div></div>";
      });
    }
    html += '<div class="shift-note-form"><input type="date" id="sn-date" value="' +
      PayEngine.dayKey(new Date()) + '">' +
      '<input type="text" id="sn-label" placeholder="Shift label (e.g. 2–11)">' +
      '<textarea id="sn-text" rows="2" placeholder="Note about this shift…"></textarea>' +
      '<button class="btn primary" id="sn-add">Add shift note</button></div>';
    boxEl.innerHTML = html;

    boxEl.querySelector("#sn-add").addEventListener("click", async () => {
      const text = boxEl.querySelector("#sn-text").value.trim();
      if (!text) return;
      const note = {
        id: uid(),
        date: boxEl.querySelector("#sn-date").value || PayEngine.dayKey(new Date()),
        shiftLabel: boxEl.querySelector("#sn-label").value.trim(),
        text,
        createdAt: new Date().toISOString(),
      };
      await SyncEngine.queueWrite({ type: "addShiftNote", contactId: c.id, note });
      renderDetail(boxEl.closest("#coworkers-body") || document.body, c.id);
    });
    boxEl.querySelectorAll("[data-delnote]").forEach(btn => {
      btn.addEventListener("click", async () => {
        await SyncEngine.queueWrite({
          type: "deleteShiftNote", contactId: c.id, noteId: btn.dataset.delnote,
        });
        renderDetail(boxEl.closest("#coworkers-body") || document.body, c.id);
      });
    });
  }

  // ---- Interaction timeline (uses journal.js InteractionParser) ----

  async function renderTimeline(boxEl, c, rootEl) {
    boxEl.innerHTML = spinner("Loading interactions…");
    try {
      const contactRef = {
        id: String(c.id),
        firstName: c.firstName || "",
        fullName: fullName(c),
        nickname: c.nickname || "",
      };
      const links = await JournalStore.storiesAbout(String(c.id));
      const days = InteractionParser.days(links, contactRef);
      InteractionTimeline.render(contactRef, days, boxEl,
        // onOpenPassage: tap a moment card → read-only passage, scrolled to it.
        async (moment) => {
          if (moment.openDay) {
            // "View day" link — parent app can route to day detail.
            return;
          }
          await openPassage(boxEl, moment);
        },
        // onCorrectType: type correction → MomentOverride (locked).
        async (moment, newType) => {
          await JournalStore.updateMoment(moment.dayKey, moment.storyID, moment.id,
            moment.excerpt, { interactionType: newType });
          renderTimeline(boxEl, c, rootEl);
        });
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t load timeline: ' +
        esc(e.message) + "</div>";
    }
  }

  async function openPassage(boxEl, moment) {
    try {
      const backup = await SyncEngine.getLocalBackup();
      const entry = JournalStore.getAllEntries(backup)
        .find(e => (e.dayKey || e.date) === moment.dayKey);
      if (!entry) return;
      const view = document.createElement("div");
      view.className = "passage-overlay";
      boxEl.appendChild(view);
      JournalPassageView.render(entry, moment, view);
      view.querySelector("#passage-back").addEventListener("click", () => view.remove());
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // 4. Add / edit contact
  // ---------------------------------------------------------------------------

  /**
   * Contact editor: name parts, nickname, job title, department, organization,
   * labeled phones/emails/urls, addresses, socials, birthday, custom dates,
   * related names, notes, photo (file upload → base64).
   */
  async function renderContactForm(boxEl, contactId) {
    const existing = contactId ? await findContact(contactId) : null;
    const c = existing || {};
    boxEl.innerHTML = spinner("Loading…");

    const lvRow = (it, kind) =>
      '<div class="lv-row" data-kind="' + kind + '">' +
      '<input class="lv-label" placeholder="Label" value="' + esc(it.label || "") + '">' +
      '<input class="lv-value" placeholder="Value" value="' + esc(it.value || "") + '">' +
      '<button class="btn ghost sm lv-del" type="button" aria-label="Remove">' + Icon("close", { size: 14 }) + '</button></div>';

    const lvSection = (title, items, kind, valuePh) =>
      '<div class="form-group"><label>' + esc(title) + "</label>" +
      '<div class="lv-list" data-list="' + kind + '">' +
      (items || []).map(it => lvRow(it, kind)).join("") + "</div>" +
      '<button class="btn ghost sm lv-add" data-add="' + kind + '" type="button">' + Icon("plus", { size: 14 }) + ' Add ' +
      esc(title.toLowerCase()) + "</button></div>";

    let html = '<div class="cw-detail-nav">' +
      '<button class="btn ghost" id="cf-back">' + Icon("chevron-left", { size: 14 }) + ' Cancel</button>' +
      "<h2>" + (existing ? "Edit contact" : "New coworker") + "</h2></div>" +
      '<div class="panel contact-form">';

    // Photo
    html += '<div class="cf-photo-row">' +
      '<div id="cf-avatar-preview">' + avatarHTML(c, 64) + "</div>" +
      '<div><input type="file" id="cf-photo" accept="image/*">' +
      (photoSrc(c) ? '<button class="btn ghost sm" id="cf-photo-clear" type="button">Remove photo</button>' : "") +
      "</div></div>";

    html += '<div class="form-row2">' +
      field("First name", "cf-first", c.firstName) +
      field("Last name", "cf-last", c.lastName) + "</div>" +
      '<div class="form-row2">' +
      field("Nickname", "cf-nick", c.nickname) +
      field("Organization", "cf-org", c.organization) + "</div>" +
      '<div class="form-row2">' +
      field("Job title", "cf-title", c.jobTitle || c.title) +
      field("Department", "cf-dept", c.department || c.role) + "</div>" +
      field("Birthday", "cf-bday", c.birthday ? String(c.birthday).slice(0, 10) : "", "date");

    html += lvSection("Phones", c.phones, "phones");
    html += lvSection("Emails", c.emails, "emails");
    html += lvSection("URLs", c.urls, "urls");
    html += lvSection("Socials", (c.socials || []).map(s =>
      ({ label: s.service, value: s.username })), "socials");
    html += lvSection("Related names", c.relatedNames, "relatedNames");

    html += '<div class="form-group"><label>Notes</label>' +
      '<textarea id="cf-notes" rows="3">' + esc(c.notes || "") + "</textarea></div>";

    html += '<div class="form-row2"><button class="btn primary" id="cf-save">Save</button>' +
      '<button class="btn ghost" id="cf-cancel">Cancel</button></div>';
    html += '<div id="cf-error" class="form-error" style="display:none"></div></div>';

    boxEl.innerHTML = html;

    const back = () => existing ? renderDetail(boxEl, existing.id) : renderGrid(boxEl);
    boxEl.querySelector("#cf-back").addEventListener("click", back);
    boxEl.querySelector("#cf-cancel").addEventListener("click", back);

    // Labeled-value rows.
    boxEl.querySelectorAll(".lv-add").forEach(btn => {
      btn.addEventListener("click", () => {
        const list = boxEl.querySelector('[data-list="' + btn.dataset.add + '"]');
        const div = document.createElement("div");
        div.innerHTML = lvRow({ label: "", value: "" }, btn.dataset.add);
        list.appendChild(div.firstChild);
        wireLvDel(boxEl);
      });
    });
    wireLvDel(boxEl);

    // Photo upload.
    let photoData = c.photoData || null;
    let photoCleared = false;
    boxEl.querySelector("#cf-photo").addEventListener("change", e => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        photoData = String(r.result).split(",")[1];
        photoCleared = false;
        boxEl.querySelector("#cf-avatar-preview").innerHTML =
          '<img class="c-avatar" style="width:64px;height:64px;object-fit:cover" src="' +
          esc(r.result) + '" alt="">';
      };
      r.readAsDataURL(f);
    });
    const clearBtn = boxEl.querySelector("#cf-photo-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      photoData = null; photoCleared = true;
      boxEl.querySelector("#cf-avatar-preview").innerHTML = avatarHTML(
        Object.assign({}, c, { photoData: null, photo: null }), 64);
    });

    boxEl.querySelector("#cf-save").addEventListener("click", async () => {
      const errEl = boxEl.querySelector("#cf-error");
      try {
        const readLv = kind =>
          Array.from(boxEl.querySelectorAll('[data-list="' + kind + '"] .lv-row'))
            .map(row => ({
              id: uid(),
              label: row.querySelector(".lv-label").value.trim(),
              value: row.querySelector(".lv-value").value.trim(),
            })).filter(x => x.value);
        const socials = readLv("socials").map(s =>
          ({ id: uid(), service: s.label, username: s.value }));

        const contact = Object.assign({}, c, {
          firstName: val("cf-first"),
          lastName: val("cf-last"),
          nickname: val("cf-nick"),
          organization: val("cf-org"),
          jobTitle: val("cf-title"),
          department: val("cf-dept"),
          birthday: val("cf-bday") || null,
          phones: readLv("phones"),
          emails: readLv("emails"),
          urls: readLv("urls"),
          socials,
          relatedNames: readLv("relatedNames"),
          notes: boxEl.querySelector("#cf-notes").value,
        });
        if (photoCleared) contact.photoData = null;
        else if (photoData) contact.photoData = photoData;
        if (!contact.firstName && !contact.lastName && !contact.organization) {
          throw new Error("Give them at least a name.");
        }
        const saved = await saveContact(contact);
        renderDetail(boxEl, saved.id);
      } catch (e) {
        errEl.style.display = "";
        errEl.textContent = e.message;
      }
    });

    function val(id) {
      return (boxEl.querySelector("#" + id).value || "").trim();
    }
    function field(label, id, value, type) {
      return '<div class="form-group"><label>' + esc(label) + "</label>" +
        '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(value || "") + '"></div>';
    }
    function wireLvDel(root) {
      root.querySelectorAll(".lv-del").forEach(b => {
        if (b._wired) return;
        b._wired = true;
        b.addEventListener("click", () => b.closest(".lv-row").remove());
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. You-vs-coworker compare flow
  // ---------------------------------------------------------------------------

  /**
   * Compare flow (mirrors CoworkerCompareView):
   *  1. Pick a coworker (favorites first, searchable) or type a name
   *  2. Pick the day, enter their hours (optional)
   *  3. Paste their Sales Lookup screen → parse → review their tickets
   *  4. Save → CoworkerComparison in data.comparisons (their tickets live
   *     ONLY on the comparison, never in your own sales history)
   */
  async function renderCompare(boxEl, dayKey, preselectId) {
    boxEl.innerHTML = spinner("Loading…");
    const state = {
      contactId: preselectId || null,
      name: "",
      dayKey: dayKey || PayEngine.dayKey(new Date()),
      hours: "",
      pasted: "",
      tickets: [],
      reviewing: false,
      parseMessage: null,
    };
    if (preselectId) {
      const c = await findContact(preselectId);
      if (c) state.name = preferredName(c);
    }
    renderCompareInput(boxEl, state);
  }

  async function renderCompareInput(boxEl, state) {
    const contacts = await getContacts();
    const favs = contacts.filter(c => c.isFavorite)
      .sort((a, b) => (a.favoriteRank || 0) - (b.favoriteRank || 0));

    let html = '<div class="cw-detail-nav">' +
      '<button class="btn ghost" id="cmp-back">' + Icon("chevron-left", { size: 14 }) + ' Coworkers</button>' +
      "<h2>Compare sales</h2></div>" +
      '<div class="panel"><p class="muted">Pick a coworker — their numbers go head-to-head ' +
      "with yours and never mix into your own sales.</p>";

    // Opponent picker.
    html += '<div class="form-group"><label>Who are you up against?</label>' +
      '<div class="opp-row">';
    if (state.contactId) {
      const c = contacts.find(x => String(x.id) === String(state.contactId));
      if (c) {
        html += '<div class="opp-picked">' + avatarHTML(c, 40) +
          "<div><strong>" + esc(preferredName(c)) + "</strong>" +
          '<div class="muted">' + esc(workLine(c) || "From your Coworkers") + "</div></div>" +
          '<button class="btn ghost sm" id="cmp-change">Change</button></div>';
      }
    } else {
      html += '<select id="cmp-contact"><option value="">— Choose from your Coworkers —</option>';
      const sorted = contacts.slice().sort((a, b) => {
        if (!!a.isFavorite !== !!b.isFavorite) return a.isFavorite ? -1 : 1;
        return sortName(a).toLowerCase().localeCompare(sortName(b).toLowerCase());
      });
      sorted.forEach(c => {
        html += '<option value="' + esc(c.id) + '"' +
          (String(state.contactId) === String(c.id) ? " selected" : "") + ">" +
          esc(preferredName(c)) + (c.isFavorite ? " (favorite)" : "") + "</option>";
      });
      html += "</select>";
    }
    html += "</div>";
    if (!state.contactId) {
      html += '<input id="cmp-name" placeholder="Or type a name not in your contacts" value="' +
        esc(state.name) + '"></div>';
    } else {
      html += "</div>";
    }

    if (favs.length && !state.contactId) {
      html += '<div class="fav-strip">';
      favs.forEach(c => {
        html += '<button class="fav-pick" data-pick="' + esc(c.id) + '">' +
          avatarHTML(c, 44) + '<span>' + esc(preferredName(c)) + "</span></button>";
      });
      html += "</div>";
    }

    html += '<div class="form-row2">' +
      '<div class="form-group"><label>Day</label><input type="date" id="cmp-day" value="' +
      esc(state.dayKey) + '"></div>' +
      '<div class="form-group"><label>Their hours (optional)</label>' +
      '<input id="cmp-hours" inputmode="decimal" placeholder="Unlocks hourly compare" value="' +
      esc(state.hours) + '"></div></div>' +
      '<div class="form-group"><label>Paste their Sales Lookup screen</label>' +
      '<textarea id="cmp-paste" rows="6" placeholder="Same format as yours — transaction rows."></textarea></div>' +
      (state.parseMessage ? '<div class="form-error">' + esc(state.parseMessage) + "</div>" : "") +
      '<button class="btn primary" id="cmp-read">Read their sales</button></div>';

    boxEl.innerHTML = html;

    boxEl.querySelector("#cmp-back").addEventListener("click", () => renderGrid(boxEl));
    const sel = boxEl.querySelector("#cmp-contact");
    if (sel) sel.addEventListener("change", async () => {
      state.contactId = sel.value || null;
      const c = sel.value ? await findContact(sel.value) : null;
      state.name = c ? preferredName(c) : "";
      renderCompareInput(boxEl, state);
    });
    const nameInput = boxEl.querySelector("#cmp-name");
    if (nameInput) nameInput.addEventListener("input", () => { state.name = nameInput.value; });
    boxEl.querySelectorAll(".fav-pick").forEach(b => {
      b.addEventListener("click", async () => {
        state.contactId = b.dataset.pick;
        const c = await findContact(state.contactId);
        state.name = c ? preferredName(c) : "";
        renderCompareInput(boxEl, state);
      });
    });
    const chg = boxEl.querySelector("#cmp-change");
    if (chg) chg.addEventListener("click", () => {
      state.contactId = null; state.name = "";
      renderCompareInput(boxEl, state);
    });
    boxEl.querySelector("#cmp-day").addEventListener("change", e => { state.dayKey = e.target.value; });
    boxEl.querySelector("#cmp-hours").addEventListener("input", e => { state.hours = e.target.value; });

    boxEl.querySelector("#cmp-read").addEventListener("click", () => {
      state.pasted = boxEl.querySelector("#cmp-paste").value;
      parseTheirSales(boxEl, state);
    });
  }

  function parseTheirSales(boxEl, state) {
    const name = (state.name || "").trim();
    if (!name) {
      state.parseMessage = "Pick a coworker or type a name first.";
      return renderCompareInput(boxEl, state);
    }
    let lines = [];
    try {
      lines = SalesTextParser.parse(state.pasted || "").lines || [];
    } catch (e) {
      lines = [];
    }
    if (!lines.length) {
      state.parseMessage = "No sales found in that text. Copy their Sales Lookup screen and try again.";
      return renderCompareInput(boxEl, state);
    }
    state.parseMessage = null;
    state.tickets = groupTheirTickets(lines, state.dayKey);
    state.reviewing = true;
    renderCompareReview(boxEl, state);
  }

  /// One transaction number = one customer (same grouping as your own imports).
  function groupTheirTickets(lines, dayKey) {
    const order = [], buckets = {};
    lines.forEach(l => {
      const key = l.transactionID || l.transactionId || "";
      if (!buckets[key]) { buckets[key] = []; order.push(key); }
      buckets[key].push(l);
    });
    const base = new Date(dayKey + "T12:00:00").getTime();
    return order.map((key, i) => ({
      id: uid(),
      time: new Date(base + i * 60000).toISOString(),
      customerNote: key,
      lines: (buckets[key] || []).map(l => ({
        id: uid(),
        product: l.product || "",
        brand: l.brand || "",
        unitPrice: l.price != null ? l.price : (l.unitPrice || 0),
        quantity: l.quantity || 1,
        kind: l.kind || "sale",
        isReturn: !!l.isReturn,
        sku: l.sku || "",
        isExchange: !!l.isExchange,
      })),
    }));
  }

  // ---- ComparisonSide.capture (port of CoworkerComparison.swift) ----

  function captureSide(tickets, table, hours) {
    const lines = (tickets || []).flatMap(t => t.lines || []);
    const revenueByProduct = {};
    lines.forEach(l => {
      if (l.isReturn) return;
      const rev = PayEngine.lineRevenue(l);
      revenueByProduct[l.product || "Unknown"] = (revenueByProduct[l.product || "Unknown"] || 0) + rev;
    });
    const revenue = (tickets || []).reduce((s, t) =>
      s + (t.lines || []).reduce((x, l) => x + PayEngine.lineRevenue(l), 0), 0);
    const commission = (tickets || []).reduce((s, t) =>
      s + PayEngine.ticketCommission(t, table), 0);
    const items = (tickets || []).reduce((s, t) =>
      s + (t.lines || []).reduce((x, l) => x + (l.isReturn ? 0 : (l.quantity || 0)), 0), 0);
    const plans = lines
      .filter(l => l.kind === "servicePlan" && !l.isReturn)
      .reduce((s, l) => s + (l.quantity || 0), 0);
    const topProducts = Object.entries(revenueByProduct)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, rev]) => name + " — " + fmtMoney(rev));
    return {
      revenue, commission, items, plans,
      customers: (tickets || []).length,
      hours: hours != null ? hours : null,
      topProducts,
    };
  }

  function avgTicket(side) {
    return side.customers > 0 ? side.revenue / side.customers : 0;
  }

  function cph(side) {
    return side.hours && side.hours > 0 ? side.customers / side.hours : null;
  }

  function anHour(side) {
    return side.hours && side.hours > 0 ? side.commission / side.hours : null;
  }

  async function yourSideForDay(dayKey) {
    const backup = await SyncEngine.getLocalBackup();
    const profile = (backup && backup.data && backup.data.profile) || {};
    const table = PayEngine.tableForProfile(profile);
    const days = (backup && backup.data && backup.data.days) || {};
    const day = days[dayKey];
    const tickets = (day && day.tickets) || [];
    let hours = null;
    if (day && day.workedHours > 0) hours = day.workedHours;
    else if (day && day.shifts) {
      hours = day.shifts.reduce((s, sh) => s + (shiftHours(sh) || 0), 0) || null;
    }
    return captureSide(tickets, table, hours);
  }

  function shiftHours(sh) {
    if (sh.hours != null) return sh.hours;
    if (sh.start && sh.end) {
      const ms = new Date(sh.end) - new Date(sh.start);
      return ms > 0 ? ms / 3600000 : 0;
    }
    return 0;
  }

  async function renderCompareReview(boxEl, state) {
    boxEl.innerHTML = spinner("Crunching numbers…");
    try {
      const backup = await SyncEngine.getLocalBackup();
      const profile = (backup && backup.data && backup.data.profile) || {};
      const table = PayEngine.tableForProfile(profile);
      const yours = await yourSideForDay(state.dayKey);
      const theirHours = parseFloat(state.hours);
      const theirs = captureSide(state.tickets, table,
        isNaN(theirHours) ? null : theirHours);
      const name = (state.name || "").trim();

      let html = '<div class="cw-detail-nav">' +
        '<button class="btn ghost" id="cmp-back2">' + Icon("chevron-left", { size: 14 }) + ' Re-paste</button>' +
        "<h2>You vs " + esc(name) + "</h2></div>";

      html += totalsGridHTML(yours, theirs, name);
      html += insightsHTML(yours, theirs, name);

      html += '<div class="section-title">Confirm ' + esc(firstName(name)) +
        "'s lines</div><p class=\"muted\">Fix anything that parsed wrong before saving.</p>";
      state.tickets.forEach(t => {
        const rev = (t.lines || []).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
        html += '<div class="panel ticket-card"><div class="ticket-head"><strong>' +
          esc(t.customerNote || "Ticket") + '</strong><span class="' +
          (rev < 0 ? "neg" : "") + '">' + fmtMoney(rev) + "</span></div>";
        (t.lines || []).forEach(l => {
          const lr = PayEngine.lineRevenue(l);
          html += '<div class="ticket-line"><span class="dot ' +
            (l.isReturn ? "ret" : "") + '"></span>' +
            '<span class="tl-product">' + esc(l.product) + "</span>" +
            '<span class="muted">×' + l.quantity + "</span>" +
            '<span class="' + (lr < 0 ? "neg" : "muted") + '">' + fmtMoney(lr) + "</span></div>";
        });
        html += "</div>";
      });

      html += '<button class="btn primary" id="cmp-save">Save comparison</button> ' +
        '<span class="muted">* Their commission is estimated at your rates.</span>';

      boxEl.innerHTML = html;
      boxEl.querySelector("#cmp-back2").addEventListener("click", () => {
        state.reviewing = false;
        renderCompareInput(boxEl, state);
      });
      boxEl.querySelector("#cmp-save").addEventListener("click", async () => {
        const comparison = {
          id: uid(),
          coworkerName: name,
          contactId: state.contactId,
          dayKey: state.dayKey,
          date: new Date(state.dayKey + "T12:00:00").toISOString(),
          createdAt: new Date().toISOString(),
          yours, theirs,
          theirTickets: state.tickets,
        };
        await SyncEngine.queueWrite({ type: "addComparison", comparison });
        renderComparisonDetail(boxEl, comparison.id, comparison);
      });
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t build the comparison: ' +
        esc(e.message) + "</div>";
    }
  }

  function firstName(name) {
    return String(name || "").trim().split(/\s+/)[0] || "Them";
  }

  function fmtMoney(n) {
    const v = Math.round((n || 0) * 100) / 100;
    const abs = Math.abs(v).toLocaleString(undefined,
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? "−$" : "$") + abs;
  }

  /// Every headline stat side by side — winning side highlighted mint.
  function totalsGridHTML(yours, theirs, coworkerName) {
    const win = (a, b) => a === b ? null : a > b;
    const rows = [
      { label: "Money sold", y: fmtMoney(yours.revenue), t: fmtMoney(theirs.revenue), w: win(yours.revenue, theirs.revenue) },
      { label: "Commission*", y: fmtMoney(yours.commission), t: fmtMoney(theirs.commission), w: win(yours.commission, theirs.commission) },
      { label: "Items", y: String(yours.items), t: String(theirs.items), w: win(yours.items, theirs.items) },
      { label: "Customers", y: String(yours.customers), t: String(theirs.customers), w: win(yours.customers, theirs.customers) },
    ];
    const yc = cph(yours), tc = cph(theirs);
    if (yc != null && tc != null) {
      rows.push({ label: "CPH", y: yc.toFixed(1), t: tc.toFixed(1), w: win(yc, tc) });
    }
    rows.push({ label: "Service plans", y: String(yours.plans), t: String(theirs.plans), w: win(yours.plans, theirs.plans) });
    const ya = avgTicket(yours), ta = avgTicket(theirs);
    rows.push({ label: "Avg ticket", y: fmtMoney(ya), t: fmtMoney(ta), w: win(ya, ta) });
    const yh = anHour(yours), th = anHour(theirs);
    if (yh != null && th != null) {
      rows.push({ label: "An Hour", y: fmtMoney(yh), t: fmtMoney(th), w: win(yh, th) });
    }
    let html = '<div class="panel"><div class="cmp-head"><span></span><span>YOU</span>' +
      "<span>" + esc(coworkerName.toUpperCase()) + "</span></div>";
    rows.forEach((r, i) => {
      const yc2 = r.w === true ? "win" : "", tc2 = r.w === false ? "win" : "";
      html += '<div class="cmp-row' + (i ? " divided" : "") + '">' +
        '<span class="cmp-label">' + esc(r.label) + "</span>" +
        '<span class="cmp-val ' + yc2 + '">' + esc(r.y) + "</span>" +
        '<span class="cmp-val ' + tc2 + '">' + esc(r.t) + "</span></div>";
    });
    return html + "</div>";
  }

  /// "What decided it": who won first, then the gap lines.
  function insightsHTML(yours, theirs, coworkerName) {
    const wins = [
      yours.revenue > theirs.revenue,
      yours.commission > theirs.commission,
      yours.items > theirs.items,
      yours.customers > theirs.customers,
    ].filter(Boolean).length;
    const losses = [
      yours.revenue < theirs.revenue,
      yours.commission < theirs.commission,
      yours.items < theirs.items,
      yours.customers < theirs.customers,
    ].filter(Boolean).length;
    let verdict;
    if (wins > losses) verdict = "You took it.";
    else if (losses > wins) verdict = esc(coworkerName) + " took it.";
    else verdict = "Dead even.";
    let html = '<div class="panel"><div class="section-title">What decided it</div>' +
      '<div class="cmp-verdict">' + verdict + "</div>";
    const gap = (label, a, b, fmt) => {
      if (a === b) return "";
      const lead = a > b ? "You" : esc(coworkerName);
      return '<div class="cmp-gap">' + lead + " led " + esc(label) + " by " +
        esc(fmt(Math.abs(a - b))) + ".</div>";
    };
    html += gap("money sold", yours.revenue, theirs.revenue, fmtMoney);
    html += gap("commission", yours.commission, theirs.commission, fmtMoney);
    html += gap("customers", yours.customers, theirs.customers, n => n + "");
    const yc = cph(yours), tc = cph(theirs);
    if (yc != null && tc != null) html += gap("CPH", yc, tc, n => n.toFixed(1));
    if (yours.topProducts.length || theirs.topProducts.length) {
      html += '<div class="cmp-tops"><div><strong>Your top sellers</strong><ul>' +
        yours.topProducts.map(p => "<li>" + esc(p) + "</li>").join("") + "</ul></div>" +
        "<div><strong>" + esc(firstName(coworkerName)) + "'s top sellers</strong><ul>" +
        theirs.topProducts.map(p => "<li>" + esc(p) + "</li>").join("") + "</ul></div></div>";
    }
    return html + "</div>";
  }

  // ---------------------------------------------------------------------------
  // Saved comparisons
  // ---------------------------------------------------------------------------

  async function renderComparisonsList(boxEl) {
    const comps = (await getComparisons()).slice()
      .sort((a, b) => String(b.date || b.dayKey).localeCompare(String(a.date || a.dayKey)));
    if (!comps.length) {
      boxEl.innerHTML = '<div class="muted">No saved comparisons yet.</div>';
      return;
    }
    let html = '<div class="comp-list">';
    comps.forEach(cp => {
      const yw = cp.yours && cp.theirs && cp.yours.revenue >= cp.theirs.revenue;
      html += '<button class="comp-row" data-comp="' + esc(cp.id) + '">' +
        '<span class="comp-vs">You vs ' + esc(cp.coworkerName || "?") + "</span>" +
        '<span class="muted">' + esc(shortDate(cp.dayKey || "")) + "</span>" +
        '<span class="comp-score">' + fmtMoney(cp.yours ? cp.yours.revenue : 0) +
        " <span class='muted'>vs</span> " + fmtMoney(cp.theirs ? cp.theirs.revenue : 0) + "</span>" +
        '<span class="comp-badge ' + (yw ? "win" : "") + '">' + (yw ? "W" : "L") + "</span>" +
        "</button>";
    });
    boxEl.innerHTML = html + "</div>";
    boxEl.querySelectorAll(".comp-row").forEach(b => {
      b.addEventListener("click", () => renderComparisonDetail(
        boxEl.closest("#coworkers-body") || boxEl.parentElement, b.dataset.comp));
    });
  }

  /**
   * Saved comparison detail: header, totals grid, insights, both people's
   * ticket lists. Edit their sales or delete (never touches your history).
   */
  async function renderComparisonDetail(boxEl, comparisonId, preloaded) {
    boxEl.innerHTML = spinner("Loading…");
    try {
      let cp = preloaded;
      if (!cp) {
        const comps = await getComparisons();
        cp = comps.find(x => String(x.id) === String(comparisonId));
      }
      if (!cp) {
        boxEl.innerHTML = '<div class="empty-box">Comparison not found.</div>';
        return;
      }
      const name = cp.coworkerName || "Them";
      let html = '<div class="cw-detail-nav">' +
        '<button class="btn ghost" id="cp-back">' + Icon("chevron-left", { size: 14 }) + ' Coworkers</button>' +
        '<div><button class="btn ghost" id="cp-del">Delete</button></div></div>' +
        '<div class="panel"><h2>You vs ' + esc(name) + "</h2>" +
        '<div class="muted">' + esc(longDate(cp.dayKey || cp.date)) + "</div></div>";
      html += totalsGridHTML(cp.yours || {}, cp.theirs || {}, name);
      html += insightsHTML(cp.yours || {}, cp.theirs || {}, name);

      // Your tickets come live from that day's sales history.
      const backup = await SyncEngine.getLocalBackup();
      const days = (backup && backup.data && backup.data.days) || {};
      const day = days[cp.dayKey];
      const yourTickets = (day && day.tickets) || [];
      html += ticketListHTML("Your tickets", yourTickets);
      html += ticketListHTML(name + "'s tickets", cp.theirTickets || []);

      boxEl.innerHTML = html;
      boxEl.querySelector("#cp-back").addEventListener("click", () => renderGrid(boxEl));
      boxEl.querySelector("#cp-del").addEventListener("click", async () => {
        if (!confirm("Delete this comparison? Your own sales history is not touched.")) return;
        await SyncEngine.queueWrite({ type: "deleteComparison", comparisonId: cp.id });
        renderGrid(boxEl);
      });
    } catch (e) {
      boxEl.innerHTML = '<div class="form-error">Couldn\'t load comparison: ' + esc(e.message) + "</div>";
    }
  }

  function ticketListHTML(title, tickets) {
    let html = '<div class="section-title">' + esc(title) + "</div>";
    if (!tickets.length) return html + '<div class="muted">No tickets.</div>';
    tickets.forEach(t => {
      const rev = (t.lines || []).reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
      html += '<div class="panel ticket-card"><div class="ticket-head"><strong>' +
        esc(t.customerNote || t.id || "Ticket") + '</strong><span class="' +
        (rev < 0 ? "neg" : "") + '">' + fmtMoney(rev) + "</span></div>";
      (t.lines || []).forEach(l => {
        const lr = PayEngine.lineRevenue(l);
        html += '<div class="ticket-line"><span class="dot' + (l.isReturn ? " ret" : "") + '"></span>' +
          '<span class="tl-product">' + esc(l.product || "") + "</span>" +
          '<span class="muted">×' + (l.quantity || 1) + "</span>" +
          '<span class="' + (lr < 0 ? "neg" : "muted") + '">' + fmtMoney(lr) + "</span></div>";
      });
      html += "</div>";
    });
    return html;
  }

  function longDate(iso) {
    try {
      return new Date(String(iso).slice(0, 10) + "T12:00:00")
        .toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    } catch (e) { return String(iso || ""); }
  }

  // ---------------------------------------------------------------------------
  // Leaderboard link
  // ---------------------------------------------------------------------------

  /**
   * Link a contact to a leaderboard peer (their Micro Buddy account).
   * Exact-name peers link automatically elsewhere; this is the manual path.
   */
  async function linkToLeaderboardPeer(contactId, peerUserID, peerPhotoBase64) {
    await SyncEngine.queueWrite({
      type: "updateContact",
      contactId,
      updates: {
        linkedUserID: peerUserID,
        linkedPhotoData: peerPhotoBase64 || null,
      },
    });
  }

  async function unlinkLeaderboardPeer(contactId) {
    await SyncEngine.queueWrite({
      type: "updateContact",
      contactId,
      updates: { linkedUserID: null, linkedPhotoData: null },
    });
  }

  // ---------------------------------------------------------------------------

  return {
    renderGrid,
    renderDetail,
    renderContactForm,
    renderCompare,
    renderComparisonDetail,
    renderComparisonsList,
    linkToLeaderboardPeer,
    unlinkLeaderboardPeer,
    // model helpers (for reuse by other modules)
    fullName,
    preferredName,
    workLine,
    sortName,
    initials,
    avatarHTML,
    formattedPhone,
    normalizeContact,
    getContacts,
    getComparisons,
    saveContact,
    deleteContact,
  };
})();
