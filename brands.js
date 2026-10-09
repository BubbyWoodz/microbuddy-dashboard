/* brands.js — Brand Correction page, ported from the iOS app.
 *
 * SOURCE (BubbyWoodz/micro-buddy, branch main):
 *   ios-micro-buddy/MicroBuddy/Models/BrandCorrection.swift
 *   ios-microBuddy/MicroBuddy/Stores/AppStore+Sales.swift  (unidentifiedProducts,
 *     applyBrandCorrection, skipBrandCorrection, renameBrand, updateMemoryProduct)
 *   ios-micro-buddy/MicroBuddy/Views/BrandCorrectionView.swift
 *
 * WHAT IT IS
 *   Pasted sales reports often leave lines with no brand. The app's Correction
 *   page lists every unlabeled product (deduped by product name), lets the user
 *   name the brand, and applies it to every matching line in history — then
 *   remembers the fix in profile.brandCorrections so it sticks.
 *
 * SEMANTICS PORTED EXACTLY
 *   - productKey = product name trimmed of spaces/tabs, lowercased
 *     (Swift: line.product.trimmingCharacters(in: .whitespaces).lowercased()).
 *   - Unidentified = every line whose brand is blank, deduped by productKey,
 *     sorted by unitsSold descending. Includes sold AND returned lines.
 *     revenue counts non-return lines only (unitPrice * quantity).
 *   - applyBrandCorrection: sets the brand on every UNLABELED line of that
 *     product across all days; drops day.rawReport/reportParseVersion on
 *     changed days (hand fixes are authoritative — a re-parse must not
 *     overwrite them); inserts the BrandCorrection at the FRONT of
 *     profile.brandCorrections; clears the key from skippedBrandCorrections.
 *   - skipBrandCorrection ("don't know"): parks the key in
 *     profile.skippedBrandCorrections until the user names it.
 *   - renameBrand: case-insensitive rename of a brand across every history
 *     line AND every saved BrandCorrection.
 *   - Analyze flow: paste a "product / brand / SKU / blank" list (e.g. from
 *     another AI), matched by exact SKU first then exact normalized product
 *     name; staged for review; nothing applied until confirmed.
 *
 * PROFILE BLOB KEYS (exact Swift CodingKeys — same spelling):
 *   profile.brandCorrections: [{ productKey, product, brand, correctedAt }]
 *   profile.skippedBrandCorrections: [productKey]
 *   correctedAt is written as an ISO8601 string (dashboard convention, same as
 *   goals' createdAt). NOTE: the phone's exact Date decoding strategy for blob
 *   fields is still unconfirmed — verify the phone reads this field before
 *   calling two-way sync done.
 *
 * PASTE-TIME AUTO-APPLY (matches the iOS app):
 *   remembered corrections are also applied at paste time — a future paste
 *   whose line has an empty brand gets the remembered brand filled in from
 *   profile.brandCorrections. See the pasteSalesReport note under OP TYPES.
 *
 * ============================================================================
 * OP TYPES (for SyncEngine.queueWrite — add these cases to sync.js applyOp):
 *
 *   applyBrandCorrection { productKey, brand }
 *     — Global op (no dayId). Sets brand on every unlabeled line whose
 *       productKey matches, across all days; clears rawReport +
 *       reportParseVersion on changed days; upserts (remove-then-insert-at-0)
 *       profile.brandCorrections with { productKey, product, brand,
 *       correctedAt: <ISO now> }; removes productKey from
 *       profile.skippedBrandCorrections. Ignores blank brands. Returns true.
 *
 *   skipBrandCorrection { productKey }
 *     — Global op (no dayId). Appends productKey to
 *       profile.skippedBrandCorrections if not already present. Returns true.
 *
 *   renameBrand { from, to }
 *     — Global op (no dayId). Case-insensitive: renames the brand on every
 *       history line whose trimmed-lowercased brand equals `from`, and on
 *       every profile.brandCorrections entry with the same match; clears
 *       rawReport + reportParseVersion on changed days. No-ops when either
 *       side is blank or they match case-insensitively. Returns true.
 *
 *   pasteSalesReport (edit the existing case):
 *     — When building each pasted line, if the parsed brand is blank, fill it
 *       from the remembered correction:
 *         const corr = (data.profile && data.profile.brandCorrections || [])
 *           .find(c => String(c.productKey) ===
 *             String(l.product || "").trim().toLowerCase());
 *         brand: (l.brand && l.brand.trim()) ? l.brand : (corr ? corr.brand : "")
 *
 *   NOTE ROUTING: all three new ops are GLOBAL (no dayId). sync.js applyOp
 *   currently does `if (!day) return false;` BEFORE the switch — global ops
 *   (setThemePreference, updateProfile, these) need that early return fixed
 *   or they will silently fail. Fix the router, then add the cases.
 * ============================================================================
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Pure logic (no DOM, no SyncEngine) — unit-testable.                  */
  /* ------------------------------------------------------------------ */

  // Swift: trimmingCharacters(in: .whitespaces) = spaces + tabs only.
  function trimWS(s) {
    return String(s == null ? "" : s).replace(/^[ \t]+|[ \t]+$/g, "");
  }

  function productKey(name) {
    return trimWS(name).toLowerCase();
  }

  function isBlankBrand(brand) {
    return trimWS(brand) === "";
  }

  function normName(name) {
    // Used by the analyze matcher: lowercase, collapse all whitespace runs.
    return String(name == null ? "" : name)
      .toLowerCase()
      .split(/[\s]+/)
      .filter(Boolean)
      .join(" ");
  }

  function eachLine(data, fn) {
    const days = (data && data.days) || [];
    for (const day of days) {
      const tickets = day.tickets || [];
      for (const t of tickets) {
        const lines = t.lines || [];
        for (const line of lines) fn(line, day, t);
      }
    }
  }

  /** Port of AppStore.unidentifiedProducts(). */
  function unidentifiedProducts(data) {
    const byKey = {};
    eachLine(data, (line, day) => {
      if (!isBlankBrand(line.brand)) return;
      const key = productKey(line.product);
      if (!key) return;
      let e = byKey[key];
      if (!e) {
        e = byKey[key] = {
          key, name: line.product, kind: line.kind || "inDepartment",
          unitsSold: 0, returnUnits: 0, revenue: 0, lastSold: null, sku: null,
        };
      }
      if (!e.sku && line.sku) e.sku = String(line.sku);
      if (line.isReturn) {
        e.returnUnits += Math.max(1, parseInt(line.quantity, 10) || 1);
      } else {
        e.unitsSold += Math.max(1, parseInt(line.quantity, 10) || 1);
        e.revenue += (Number(line.unitPrice) || 0) * (Math.max(1, parseInt(line.quantity, 10) || 1));
      }
      e.name = line.product;
      e.kind = line.kind || e.kind;
      const d = day.date || day.id;
      if (d && (!e.lastSold || d > e.lastSold)) e.lastSold = d;
    });
    return Object.values(byKey).sort((a, b) => b.unitsSold - a.unitsSold);
  }

  function getCorrections(data) {
    return (data && data.profile && Array.isArray(data.profile.brandCorrections))
      ? data.profile.brandCorrections : [];
  }

  function getSkipped(data) {
    return (data && data.profile && Array.isArray(data.profile.skippedBrandCorrections))
      ? data.profile.skippedBrandCorrections : [];
  }

  /** Remembered brand for a product key, or "" — used for paste auto-apply. */
  function rememberedBrand(data, key) {
    const c = getCorrections(data).find(x => String(x.productKey) === key);
    return c ? String(c.brand || "") : "";
  }

  function dropRawReport(day) {
    day.rawReport = null;
    day.reportParseVersion = null;
  }

  /**
   * Local (synchronous) half of applyBrandCorrection. Mutates `data` exactly
   * like the Swift version; sync.js applyOp should do the same for the op.
   */
  function applyCorrectionLocal(data, key, brand) {
    const cleaned = trimWS(brand);
    if (!cleaned || !key) return false;
    let changedAny = false;
    for (const day of (data && data.days) || []) {
      let changed = false;
      for (const t of (day.tickets || [])) {
        for (const line of (t.lines || [])) {
          if (isBlankBrand(line.brand) && productKey(line.product) === key) {
            line.brand = cleaned;
            changed = true;
          }
        }
      }
      if (changed) { dropRawReport(day); changedAny = true; }
    }
    if (!data.profile) data.profile = {};
    if (!Array.isArray(data.profile.brandCorrections)) data.profile.brandCorrections = [];
    if (!Array.isArray(data.profile.skippedBrandCorrections)) data.profile.skippedBrandCorrections = [];
    const corr = data.profile.brandCorrections;
    const existingIdx = corr.findIndex(c => String(c.productKey) === key);
    const name = existingIdx >= 0 ? corr[existingIdx].product
      : (unidentifiedProducts(data).find(p => p.key === key) || {}).name || key;
    const filtered = corr.filter(c => String(c.productKey) !== key);
    filtered.unshift({
      productKey: key, product: name, brand: cleaned,
      correctedAt: new Date().toISOString(),
    });
    data.profile.brandCorrections = filtered;
    data.profile.skippedBrandCorrections =
      data.profile.skippedBrandCorrections.filter(k => String(k) !== key);
    return changedAny;
  }

  function skipLocal(data, key) {
    if (!key) return false;
    if (!data.profile) data.profile = {};
    if (!Array.isArray(data.profile.skippedBrandCorrections)) data.profile.skippedBrandCorrections = [];
    if (data.profile.skippedBrandCorrections.some(k => String(k) === key)) return false;
    data.profile.skippedBrandCorrections.push(key);
    return true;
  }

  function renameBrandLocal(data, from, to) {
    const oldKey = trimWS(from).toLowerCase();
    const cleaned = trimWS(to);
    if (!oldKey || !cleaned || cleaned.toLowerCase() === oldKey) return 0;
    let renamed = 0;
    for (const day of (data && data.days) || []) {
      let changed = false;
      for (const t of (day.tickets || [])) {
        for (const line of (t.lines || [])) {
          if (trimWS(line.brand).toLowerCase() === oldKey) {
            line.brand = cleaned;
            changed = true;
            renamed++;
          }
        }
      }
      if (changed) dropRawReport(day);
    }
    for (const c of getCorrections(data)) {
      if (trimWS(c.brand).toLowerCase() === oldKey) c.brand = cleaned;
    }
    return renamed;
  }

  /* ---- Analyze-list parsing (port of BrandCorrectionView.parseAnalyzeList) */

  function isSKULine(line) {
    if (/^sku/i.test(line)) return true;
    return line.length > 0 && /^[0-9]+$/.test(line);
  }

  function cleanedSKU(line) {
    let text = String(line);
    if (/^sku/i.test(text)) text = text.slice(3);
    text = text.replace(/^[: #\s]+|[: #\s]+$/g, "");
    return text || null;
  }

  /** Parses "product / brand / SKU / blank" blocks from pasted text. */
  function parseAnalyzeList(raw) {
    let entries = [];
    let block = [];
    function flush() {
      const lines = block.map(l => l.trim()).filter(Boolean);
      block = [];
      if (lines.length < 2 || !lines[1]) return;
      let sku = null;
      if (lines.length >= 3 && isSKULine(lines[2])) sku = cleanedSKU(lines[2]);
      entries.push({ product: lines[0], brand: lines[1], sku });
    }
    for (const line of String(raw == null ? "" : raw).split("\n")) {
      if (!line.trim()) flush(); else block.push(line);
    }
    flush();
    if (entries.length <= 1) {
      // Fallback: strict 2–3-line grouping when there are no blank separators.
      entries = [];
      const lines = String(raw == null ? "" : raw).split("\n").map(l => l.trim()).filter(Boolean);
      let i = 0;
      while (i + 1 < lines.length) {
        let sku = null;
        if (i + 2 < lines.length && isSKULine(lines[i + 2])) sku = cleanedSKU(lines[i + 2]);
        entries.push({ product: lines[i], brand: lines[i + 1], sku });
        i += sku ? 3 : 2;
      }
    }
    return entries;
  }

  /**
   * Deterministic matching, no AI: exact SKU first, then exact normalized
   * product name. Returns [{ productKey, productName, sku, brand, viaSKU }].
   */
  function matchEntries(entries, products) {
    const brandBySKU = {}, brandByName = {};
    for (const e of entries) {
      if (!e.brand || !trimWS(e.brand)) continue;
      if (e.sku) brandBySKU[String(e.sku)] = e.brand;
      brandByName[normName(e.product)] = e.brand;
    }
    const matches = [];
    for (const p of products) {
      let brand = null, viaSKU = false;
      if (p.sku && brandBySKU[String(p.sku)]) { brand = brandBySKU[String(p.sku)]; viaSKU = true; }
      else if (brandByName[normName(p.name)]) brand = brandByName[normName(p.name)];
      if (brand) matches.push({ productKey: p.key, productName: p.name, sku: p.sku, brand, viaSKU });
    }
    return matches;
  }

  const BrandLogic = {
    productKey, trimWS, isBlankBrand, normName,
    unidentifiedProducts, rememberedBrand,
    applyCorrectionLocal, skipLocal, renameBrandLocal,
    parseAnalyzeList, matchEntries, isSKULine, cleanedSKU,
  };

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
  }

  const BrandsUI = {
    _tab: "unidentified",
    _editingCorrected: false,
    _editedBrands: {},
    _analyze: null,   // { entries, matches, unmatched }
    _identifyKey: null,

    /** Number of products still needing a brand — for a Sales-tab badge. */
    unidentifiedCount(data) {
      const skipped = new Set(getSkipped(data).map(String));
      return unidentifiedProducts(data).filter(p => !skipped.has(p.key)).length;
    },

    async open(container) {
      this._el = container;
      await this.render();
    },

    async _data() {
      const backup = await SyncEngine.getLocalBackup();
      return (backup && backup.data) || { days: [], profile: {} };
    },

    async render() {
      const el = this._el;
      if (!el) return;
      const data = await this._data();
      const skipped = new Set(getSkipped(data).map(String));
      const all = unidentifiedProducts(data);
      const unidentified = all.filter(p => !skipped.has(p.key));
      const uncorrected = all.filter(p => skipped.has(p.key));
      const corrected = getCorrections(data).slice().sort((a, b) =>
        String(b.correctedAt || "") < String(a.correctedAt || "") ? -1 : 1);

      const tabBtn = (id, label, n) =>
        `<button class="br-tab${this._tab === id ? " active" : ""}" data-brtab="${id}">${esc(label)}${n ? ` <span class="br-count">${n}</span>` : ""}</button>`;

      let body = "";
      if (this._tab === "unidentified") body = this._unidentifiedHTML(unidentified);
      else if (this._tab === "uncorrected") body = this._uncorrectedHTML(uncorrected);
      else body = this._correctedHTML(corrected);

      el.innerHTML = `
        <style>
          .br-tabs { display:flex; gap:8px; padding:12px 16px 4px; }
          .br-tab { flex:1; padding:10px; border-radius:12px; border:1px solid var(--border,#e2e2e2);
            background:var(--surface,#fff); color:var(--text,#111); font-weight:700; font-size:14px; cursor:pointer; }
          .br-tab.active { background:var(--accent,#0a3d62); color:#fff; border-color:var(--accent,#0a3d62); }
          .br-count { display:inline-block; min-width:22px; padding:1px 6px; border-radius:10px;
            background:var(--accent-soft,rgba(10,61,98,.12)); font-size:12px; }
          .br-tab.active .br-count { background:rgba(255,255,255,.25); }
          .br-list { display:flex; flex-direction:column; gap:12px; padding:12px 16px 24px; }
          .br-card { border:1px solid var(--border,#e2e2e2); border-radius:16px; padding:16px;
            background:var(--surface,#fff); box-shadow:0 2px 8px rgba(0,0,0,.04); }
          .br-card h3 { margin:0 0 4px; font-size:16px; color:var(--text,#111); }
          .br-meta { font-size:12px; color:var(--text2,#666); margin:6px 0; }
          .br-row { display:flex; gap:8px; margin-top:10px; }
          .br-btn { flex:1; padding:10px; border-radius:12px; border:1px solid var(--border,#e2e2e2);
            background:var(--surface2,#f5f5f5); font-weight:700; font-size:14px; cursor:pointer; color:var(--text,#111); }
          .br-btn.primary { background:var(--accent,#0a3d62); color:#fff; border-color:var(--accent,#0a3d62); }
          .br-btn:disabled { opacity:.5; }
          .br-pill { display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:700;
            background:var(--accent-soft,rgba(10,61,98,.12)); color:var(--accent,#0a3d62); }
          .br-sku { font-size:12px; font-weight:700; color:var(--accent,#0a3d62); cursor:pointer;
            background:var(--accent-soft,rgba(10,61,98,.1)); border:none; border-radius:20px; padding:5px 12px; }
          .br-empty { text-align:center; padding:40px 20px; color:var(--text2,#666); }
          .br-empty .big { font-size:40px; margin-bottom:8px; }
          .br-modal-veil { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:9990;
            display:flex; align-items:flex-end; justify-content:center; }
          .br-modal { background:var(--surface,#fff); border-radius:20px 20px 0 0; padding:20px;
            width:100%; max-width:520px; max-height:85vh; overflow:auto; }
          .br-modal h2 { margin:0 0 4px; font-size:18px; color:var(--text,#111); }
          .br-field { width:100%; padding:12px 14px; border-radius:12px; font-size:16px;
            border:1px solid var(--border,#e2e2e2); background:var(--surface2,#f7f7f7); color:var(--text,#111);
            box-sizing:border-box; margin:12px 0; }
          .br-note { font-size:12px; color:var(--text2,#666); text-align:center; margin-top:10px; }
          .br-toolbar { display:flex; gap:8px; padding:0 16px; }
          .br-review-row { display:flex; align-items:center; gap:10px; }
          textarea.br-field { min-height:120px; font-family:monospace; font-size:13px; resize:vertical; }
        </style>
        <div class="br-tabs">
          ${tabBtn("unidentified", "Unidentified", unidentified.length)}
          ${tabBtn("uncorrected", "Uncorrected", uncorrected.length)}
          ${tabBtn("corrected", "Corrected", corrected.length)}
        </div>
        ${this._tab === "unidentified" && unidentified.length ? `
        <div class="br-toolbar">
          <button class="br-btn" data-bract="export">⤴ Export list</button>
          <button class="br-btn" data-bract="analyze">${Icon("wand", { size: 14 })} Analyze</button>
        </div>` : ""}
        ${this._tab === "corrected" && corrected.length ? `
        <div class="br-toolbar">
          <button class="br-btn" data-bract="${this._editingCorrected ? "cancelEdit" : "editCorrected"}">${this._editingCorrected ? Icon("close", { size: 14 }) + " Discard" : Icon("edit", { size: 14 }) + " Edit brands"}</button>
          ${this._editingCorrected ? `<button class="br-btn primary" data-bract="saveEdits">${Icon("check", { size: 14 })} Save</button>` : ""}
        </div>` : ""}
        <div class="br-list">${body}</div>
        <div class="br-modal-root"></div>`;

      el.querySelectorAll("[data-brtab]").forEach(b =>
        b.addEventListener("click", () => { this._tab = b.dataset.brtab; this.render(); }));
      el.querySelectorAll("[data-bract]").forEach(b =>
        b.addEventListener("click", () => this._action(b.dataset.bract, data)));
      el.querySelectorAll("[data-bridentify]").forEach(b =>
        b.addEventListener("click", () => this._showIdentify(b.dataset.bridentify, unidentified.concat(uncorrected))));
      el.querySelectorAll("[data-brskip]").forEach(b =>
        b.addEventListener("click", () => this._skip(b.dataset.brskip)));
      el.querySelectorAll("[data-brsku]").forEach(b =>
        b.addEventListener("click", () => {
          const sku = b.dataset.brsku;
          (navigator.clipboard ? navigator.clipboard.writeText(sku) : Promise.reject())
            .then(() => { b.textContent = "Copied"; setTimeout(() => this.render(), 1200); })
            .catch(() => prompt("Copy SKU:", sku));
        }));
    },

    _statsLine(p) {
      const bits = [];
      if (p.unitsSold > 0) bits.push(`${p.unitsSold} sold`);
      if (p.returnUnits > 0) bits.push(`${p.returnUnits} returned`);
      bits.push(money(p.revenue));
      return bits.join(" · ");
    },

    _unidentifiedHTML(list) {
      if (!list.length) return `<div class="br-empty"><div class="big" style="color:var(--money)">${Icon("check-circle", { size: 34 })}</div>
        <b>Everything's labeled</b><br>Every product you've sold or returned has a brand.
        New unlabeled ones will show up here as you log sales.</div>`;
      return list.map(p => `
        <div class="br-card">
          <h3>${esc(p.name)}</h3>
          <div>${p.sku ? `<button class="br-sku" data-brsku="${esc(p.sku)}">SKU ${esc(p.sku)}</button> ` : ""}
            <span class="br-pill">Brand unknown</span></div>
          <div class="br-meta">${esc(this._statsLine(p))}</div>
          <div class="br-row">
            <button class="br-btn" data-brskip="${esc(p.key)}">Don't know</button>
            <button class="br-btn primary" data-bridentify="${esc(p.key)}">Know it</button>
          </div>
        </div>`).join("") +
        `<div class="br-note">${list.length} product${list.length === 1 ? "" : "s"} without a brand ·
          "Don't know" parks a product in Uncorrected until you name it</div>`;
    },

    _uncorrectedHTML(list) {
      if (!list.length) return `<div class="br-empty"><div class="big" style="color:var(--accent)">${Icon("download", { size: 34 })}</div>
        <b>Nothing waiting</b><br>Products you mark "don't know" land here until you name their brand.</div>`;
      return list.map(p => `
        <div class="br-card"><div class="br-review-row">
          <div style="flex:1"><h3>${esc(p.name)}</h3>
            <div class="br-meta">${esc(this._statsLine(p))}</div></div>
          <button class="br-btn primary" style="flex:0 0 auto" data-bridentify="${esc(p.key)}">Name brand</button>
        </div></div>`).join("");
    },

    _correctedHTML(list) {
      if (!list.length) return `<div class="br-empty"><div class="big" style="color:var(--accent)">${Icon("tag", { size: 34 })}</div>
        <b>No corrections yet</b><br>Name a brand for an unidentified product and it'll be remembered here.</div>`;
      return list.map(c => `
        <div class="br-card"><div class="br-review-row">
          <div style="flex:1"><h3>${esc(c.product)}</h3>
            <div class="br-meta">was unlabeled</div></div>
          ${this._editingCorrected
            ? `<input class="br-field" style="margin:0;max-width:150px" data-bredit="${esc(c.productKey)}" value="${esc(this._editedBrands[c.productKey] != null ? this._editedBrands[c.productKey] : c.brand)}" autocapitalize="words" autocomplete="off">`
            : `<span class="br-pill">${esc(c.brand)}</span>`}
        </div></div>`).join("") +
        (this._editingCorrected ? `<div class="br-note">Saving renames each changed brand everywhere — history, memory, and stats.</div>` : "");
    },

    /* ---------------- actions ---------------- */

    async _action(name, data) {
      if (name === "export") return this._export(data);
      if (name === "analyze") return this._showAnalyze(data);
      if (name === "editCorrected") { this._editingCorrected = true; this._editedBrands = {}; return this.render(); }
      if (name === "cancelEdit") { this._editingCorrected = false; this._editedBrands = {}; return this.render(); }
      if (name === "saveEdits") return this._saveCorrectedEdits(data);
    },

    async _skip(key) {
      await SyncEngine.queueWrite({ type: "skipBrandCorrection", productKey: key });
      await this.render();
    },

    _showIdentify(key, products) {
      const p = products.find(x => x.key === key);
      if (!p) return;
      this._identifyKey = key;
      const root = this._el.querySelector(".br-modal-root");
      root.innerHTML = `
        <div class="br-modal-veil" data-brveil>
          <div class="br-modal" style="max-width:440px">
            <h2>Identify brand</h2>
            <div class="br-meta">${esc(p.name)}${p.sku ? ` · SKU ${esc(p.sku)}` : ""} · ${esc(this._statsLine(p))}</div>
            <input class="br-field" id="br-brand-input" placeholder="Brand name" autocapitalize="words" autocomplete="off" autocorrect="off">
            <div class="br-row">
              <button class="br-btn" data-brcancel>Cancel</button>
              <button class="br-btn primary" data-brsave>${Icon("check", { size: 14 })} Save brand</button>
            </div>
            <div class="br-note">Every unlabeled line of this product gets the brand — in your history, memory, and stats.</div>
          </div>
        </div>`;
      const close = () => { root.innerHTML = ""; this._identifyKey = null; };
      root.querySelector("[data-brveil]").addEventListener("click", e => { if (e.target.dataset.brveil != null) close(); });
      root.querySelector("[data-brcancel]").addEventListener("click", close);
      const input = root.querySelector("#br-brand-input");
      input.focus();
      const save = async () => {
        const brand = input.value;
        if (!trimWS(brand)) return;
        await SyncEngine.queueWrite({ type: "applyBrandCorrection", productKey: key, brand });
        close();
        await this.render();
      };
      root.querySelector("[data-brsave]").addEventListener("click", save);
      input.addEventListener("keydown", e => { if (e.key === "Enter") save(); });
    },

    async _saveCorrectedEdits(data) {
      const inputs = this._el.querySelectorAll("[data-bredit]");
      const renames = [];
      for (const inp of inputs) {
        const key = inp.dataset.bredit;
        const corr = getCorrections(data).find(c => String(c.productKey) === key);
        if (!corr) continue;
        const nv = trimWS(inp.value);
        if (nv && nv.toLowerCase() !== trimWS(corr.brand).toLowerCase()) renames.push({ from: corr.brand, to: nv });
      }
      for (const r of renames) {
        await SyncEngine.queueWrite({ type: "renameBrand", from: r.from, to: r.to });
      }
      this._editingCorrected = false;
      this._editedBrands = {};
      await this.render();
    },

    /* ---------------- export + analyze ---------------- */

    _export(data) {
      // Port of exportUnidentifiedList: product name, SKU line, blank line.
      const lines = [];
      for (const p of unidentifiedProducts(data)) {
        lines.push(p.name, p.sku || "No SKU", "");
      }
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "unidentified-products.txt";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },

    async _showAnalyze(data) {
      const products = unidentifiedProducts(data);
      if (!products.length) return;
      const root = this._el.querySelector(".br-modal-root");
      root.innerHTML = `
        <div class="br-modal-veil" data-brveil>
          <div class="br-modal">
            <h2>Analyze brands</h2>
            <div class="br-note" style="text-align:left;margin:0 0 8px">Paste the finished brand list from another AI —
              product name, brand, SKU, then a blank line, repeated. The dashboard just reads it back for
              confirmation — it doesn't do any searching of its own.</div>
            <div class="br-meta" style="font-family:monospace;background:var(--surface2,#f5f5f5);padding:10px;border-radius:10px">
              Woven Fabric Braided Cable<br>Amazon Basics<br>SKU 14565392</div>
            <textarea class="br-field" id="br-analyze-text" placeholder="Paste the brand list here…"></textarea>
            <div class="br-row">
              <button class="br-btn" data-brcancel>Close</button>
              <button class="br-btn primary" data-brrun>${Icon("wand", { size: 14 })} Analyze</button>
            </div>
            <div class="br-note" id="br-analyze-msg"></div>
          </div>
        </div>`;
      const close = () => { root.innerHTML = ""; };
      root.querySelector("[data-brveil]").addEventListener("click", e => { if (e.target.dataset.brveil != null) close(); });
      root.querySelector("[data-brcancel]").addEventListener("click", close);
      root.querySelector("[data-brrun]").addEventListener("click", async () => {
        const text = root.querySelector("#br-analyze-text").value;
        const msg = root.querySelector("#br-analyze-msg");
        const entries = parseAnalyzeList(text);
        if (!entries.length) { msg.textContent = "Couldn't read that list — it needs product, brand, and SKU lines."; return; }
        const matches = matchEntries(entries, products);
        if (!matches.length) { msg.textContent = `None of the ${entries.length} entries matched an unidentified product — check the names and SKUs.`; return; }
        this._analyze = { matches, unmatched: products.length - matches.length };
        close();
        await this._showReview();
      });
    },

    async _showReview() {
      const st = this._analyze;
      if (!st) return;
      const root = this._el.querySelector(".br-modal-root");
      root.innerHTML = `
        <div class="br-modal-veil" data-brveil>
          <div class="br-modal">
            <h2>Confirm brands</h2>
            <div class="br-meta">${st.matches.length} product${st.matches.length === 1 ? "" : "s"} will get a brand</div>
            <div class="br-list" style="padding:8px 0">
              ${st.matches.map(m => `
                <div class="br-card"><div class="br-review-row">
                  <div style="flex:1"><h3>${esc(m.productName)}</h3>
                    ${m.sku ? `<div class="br-meta">SKU ${esc(m.sku)}</div>` : ""}</div>
                  <div style="text-align:right"><span class="br-pill">${esc(m.brand)}</span>
                    <div class="br-meta">${m.viaSKU ? "by SKU" : "by name"}</div></div>
                </div></div>`).join("")}
            </div>
            ${st.unmatched > 0 ? `<div class="br-note">${st.unmatched} unidentified product${st.unmatched === 1 ? " isn't" : "s aren't"} in this list — they'll stay unidentified.</div>` : ""}
            <div class="br-row" style="margin-top:12px">
              <button class="br-btn" data-brcancel>Back</button>
              <button class="br-btn primary" data-brconfirm>${Icon("check", { size: 14 })} Save ${st.matches.length} correction${st.matches.length === 1 ? "" : "s"}</button>
            </div>
            <div class="br-note">Saving gives every product its brand — in your history, memory, and stats.</div>
          </div>
        </div>`;
      const close = () => { root.innerHTML = ""; };
      root.querySelector("[data-brveil]").addEventListener("click", e => { if (e.target.dataset.brveil != null) close(); });
      root.querySelector("[data-brcancel]").addEventListener("click", close);
      root.querySelector("[data-brconfirm]").addEventListener("click", async () => {
        for (const m of st.matches) {
          await SyncEngine.queueWrite({ type: "applyBrandCorrection", productKey: m.productKey, brand: m.brand });
        }
        this._analyze = null;
        close();
        await this.render();
      });
    },
  };

  window.BrandLogic = BrandLogic;
  window.BrandsUI = BrandsUI;
})();
