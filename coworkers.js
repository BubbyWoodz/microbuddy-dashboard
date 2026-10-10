"use strict";
/* ============ coworkers.js — Coworkers (Settings > Workday > Coworkers) ============
 *
 * Port of the iPhone Coworkers feature:
 *   Models/CoworkerContact.swift     — contact shape, computed names, phone format
 *   Views/CoworkersView.swift        — list (favorites, A-Z sections, search),
 *                                      detail page, editor
 *   Views/InteractionTimelineView    — journal moments about the coworker
 *   Stores/AppStore+Contacts.swift   — upsert / delete / favorite
 *
 * Desktop layout: the list sits on the left, the selected coworker (or the
 * editor) on the right. The You-vs-coworker compare flow and saved
 * comparisons live on the day detail page, exactly where iOS has them.
 *
 * Avatar precedence (CoworkerContact.displayPhotoData): the photo the user set
 * (photoData) → the photo synced from their linked Micro Buddy account
 * (linkedPhotoData) → initials. Photos are raw image bytes, base64 in the blob;
 * iPhone imports are often HEIC, which desktop browsers can't draw, so those
 * are converted to JPEG on the fly (heic2any, loaded only when needed).
 *
 * DATA MODEL: data.contacts is [CoworkerContact] with the Swift Codable keys:
 *   { id, firstName, lastName, organization, phone, email, photoData?,
 *     isFavorite, favoriteRank, notes, shiftNotes[], createdAt, linkedUserID?,
 *     linkedPhotoData?, namePrefix, middleName, nameSuffix, nickname, jobTitle,
 *     department, birthday?, phones[], emails[], urls[], addresses[],
 *     socials[], relatedNames[], customDates[], dismissedSuggestions[] }
 * Writes go through SyncEngine.queueWrite (addContact / updateContact /
 * deleteContact); AppDataSanitizer makes every field decodable by the phone.
 * ==================================================================================== */

const CoworkersUI = (() => {
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");

  // ---------------------------------------------------------------------------
  // Model helpers (CoworkerContact computed properties)
  // ---------------------------------------------------------------------------
  const trim = s => String(s == null ? "" : s).trim();

  function fullName(c) {
    const n = (trim(c.firstName) + " " + trim(c.lastName)).trim();
    return n || trim(c.organization) || trim(c.name);
  }
  function displayName(c) {
    if (!fullName(c)) return trim(c.organization);
    return [c.namePrefix, c.firstName, c.middleName, c.lastName, c.nameSuffix].map(trim).filter(Boolean).join(" ");
  }
  function preferredName(c) { return trim(c.nickname) || fullName(c); }
  function workLine(c) { return [c.organization, c.jobTitle, c.department].map(trim).filter(Boolean).join(" \u00B7 "); }
  function sortName(c) {
    const last = trim(c.lastName), first = trim(c.firstName);
    if (!last && !first) return trim(c.organization);
    if (!last) return first;
    return last + " " + first;
  }
  function initials(c) {
    const words = fullName(c).split(/\s+/).filter(Boolean).slice(0, 2);
    return words.map(w => w[0]).join("").toUpperCase() || "?";
  }
  function initialsFromName(name) {
    return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  }
  function primaryPhone(c) { return (Array.isArray(c.phones) && c.phones[0] && c.phones[0].value) || c.phone || ""; }
  function primaryEmail(c) { return (Array.isArray(c.emails) && c.emails[0] && c.emails[0].value) || c.email || ""; }
  /// "+1 (714) 555-0134" — CoworkerContact.formattedPhone.
  function formattedPhone(raw) {
    const cleaned = String(raw || "").replace(/[^\d+]/g, "");
    const digits = cleaned.replace(/\D/g, "");
    let local = null;
    if (digits.length === 11 && digits[0] === "1") local = digits.slice(1);
    else if (digits.length === 10) local = digits;
    if (!local) return cleaned;
    return "+1 (" + local.slice(0, 3) + ") " + local.slice(3, 6) + "-" + local.slice(6);
  }
  const callablePhone = raw => String(raw || "").replace(/[^\d+]/g, "");
  function oneLineAddress(a) { return [a.street, a.city, a.state, a.zip].map(trim).filter(Boolean).join(", "); }
  function socialURL(service, username) {
    const h = trim(username);
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
  function webURL(s) {
    const t = trim(s);
    if (!t) return null;
    return /^https?:\/\//i.test(t) ? t : "https://" + t;
  }

  const uid = () => AppDataSanitizer.uuid();

  /// Fill the keys the phone's decoder and our UI expect (mirrors init(from:)).
  function normalizeContact(raw) {
    const c = Object.assign({}, raw);
    ["firstName", "lastName", "organization", "phone", "email", "notes", "namePrefix", "middleName",
      "nameSuffix", "nickname", "jobTitle", "department"].forEach(k => { if (typeof c[k] !== "string") c[k] = c[k] == null ? "" : String(c[k]); });
    ["shiftNotes", "phones", "emails", "urls", "addresses", "socials", "relatedNames", "customDates", "dismissedSuggestions"]
      .forEach(k => { if (!Array.isArray(c[k])) c[k] = []; });
    c.isFavorite = !!c.isFavorite;
    c.favoriteRank = Number.isFinite(+c.favoriteRank) ? Math.round(+c.favoriteRank) : 0;
    if (!c.phones.length && c.phone) c.phones = [{ id: uid(), label: "Mobile", value: c.phone }];
    if (!c.emails.length && c.email) c.emails = [{ id: uid(), label: "Email", value: c.email }];
    return c;
  }

  /// CoworkerContact.normalized(): drop blank rows, format phones, keep the
  /// legacy single phone/email in sync with the first list entries.
  function normalizedForSave(c) {
    const has = v => trim(v) !== "";
    c.phones = c.phones.filter(p => has(p.value)).map(p => ({ id: p.id || uid(), label: p.label || "", value: formattedPhone(p.value) }));
    c.emails = c.emails.filter(p => has(p.value));
    c.urls = c.urls.filter(p => has(p.value));
    c.relatedNames = c.relatedNames.filter(p => has(p.value));
    c.socials = c.socials.filter(s => has(s.username));
    c.addresses = c.addresses.filter(a => oneLineAddress(a) !== "");
    c.phone = c.phones.length ? c.phones[0].value : "";
    c.email = c.emails.length ? c.emails[0].value : "";
    return c;
  }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------
  let cache = { contacts: [], shifts: [], loaded: false };

  async function loadAll() {
    const backup = await SyncEngine.getLocalBackup();
    const data = (backup && backup.data) || {};
    const raw = Array.isArray(data.contacts) ? data.contacts : (data.contacts ? Object.values(data.contacts) : []);
    cache = { contacts: raw.filter(x => x && typeof x === "object").map(normalizeContact), shifts: (Array.isArray(data.shifts) ? data.shifts : []).filter(s => s && !s.isRemoved), loaded: true };
    return cache;
  }
  async function getContacts() { return (await loadAll()).contacts; }
  async function getComparisons() {
    const backup = await SyncEngine.getLocalBackup();
    const raw = backup && backup.data && backup.data.comparisons;
    return Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
  }
  async function findContact(id) {
    const all = await getContacts();
    return all.find(c => String(c.id) === String(id)) || null;
  }
  async function saveContact(contact) {
    const c = normalizedForSave(normalizeContact(contact));
    if (!c.id) c.id = uid();
    const existing = await findContact(c.id);
    if (existing) await SyncEngine.queueWrite({ type: "updateContact", contactId: c.id, updates: c });
    else await SyncEngine.queueWrite({ type: "addContact", contact: c });
    await loadAll();
    return c;
  }
  async function deleteContact(id) {
    await SyncEngine.queueWrite({ type: "deleteContact", contactId: id });
    await loadAll();
  }

  /// AppStore.contact(matching:) — exact name, unique partial, or swapped order.
  function contactMatching(name, list) {
    const needle = trim(name).toLowerCase();
    if (!needle) return null;
    const all = list || cache.contacts;
    const exact = all.find(c => fullName(c).toLowerCase() === needle || trim(c.nickname).toLowerCase() === needle);
    if (exact) return exact;
    const partial = all.filter(c => fullName(c).toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
    const parts = needle.split(/\s+/);
    if (parts.length === 2) {
      const swapped = parts[1] + " " + parts[0];
      const flipped = all.find(c => fullName(c).toLowerCase() === swapped);
      if (flipped) return flipped;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Photos: base64 image bytes -> object URL; HEIC converted to JPEG.
  // ---------------------------------------------------------------------------
  const photoURLs = new Map();   // key -> object URL ("" = undecodable)
  const pending = new Map();     // key -> Promise
  let heicLib = null;

  function rawPhoto(c) {
    const d = c && (c.photoData || c.linkedPhotoData);
    return typeof d === "string" && d.length > 16 ? d : null;
  }
  const photoKey = (c, d) => String(c.id) + ":" + d.length + ":" + d.slice(-24);

  function sniff(b64) {
    if (b64.startsWith("/9j/")) return "image/jpeg";
    if (b64.startsWith("iVBORw0KGgo")) return "image/png";
    if (b64.startsWith("R0lGOD")) return "image/gif";
    if (b64.startsWith("UklGR")) return "image/webp";
    try {
      const head = atob(b64.slice(0, 32).replace(/[^A-Za-z0-9+/]/g, "").slice(0, 32));
      if (head.slice(4, 8) === "ftyp") {
        const brand = head.slice(8, 12);
        if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic";
        if (/^(avif|avis)$/.test(brand)) return "image/avif";
      }
    } catch (e) { /* not base64 */ }
    return "image/jpeg";
  }

  function b64ToBlob(b64, mime) {
    const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function loadHeicLib() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (heicLib) return heicLib;
    heicLib = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/heic2any.min.js";
      s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error("heic2any missing")));
      s.onerror = () => { heicLib = null; reject(new Error("Couldn't load the HEIC decoder")); };
      document.head.appendChild(s);
    });
    return heicLib;
  }

  /// Scale an image blob down (max side) and re-encode as JPEG.
  function downscale(blob, max, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        cv.toBlob(b => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality || 0.8);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Unreadable image")); };
      img.src = url;
    });
  }

  async function heicToJpegBlob(blob) {
    // Safari can draw HEIC itself; everyone else goes through heic2any.
    try { return await downscale(blob, 512, 0.8); } catch (e) { /* fall through */ }
    const lib = await loadHeicLib();
    let out = await lib({ blob, toType: "image/jpeg", quality: 0.8 });
    if (Array.isArray(out)) out = out[0];
    return downscale(out, 512, 0.8);
  }

  /// Sync lookup: an object URL when the photo is ready, "" when there's none
  /// or it can't be decoded, null while a HEIC conversion is still running.
  function photoURL(c) {
    const d = rawPhoto(c);
    if (!d) return "";
    const key = photoKey(c, d);
    if (photoURLs.has(key)) return photoURLs.get(key);
    const mime = d.startsWith("data:") ? (d.slice(5, d.indexOf(";")) || "image/jpeg") : sniff(d);
    if (mime !== "image/heic" && mime !== "image/heif") {
      try { photoURLs.set(key, URL.createObjectURL(b64ToBlob(d, mime))); }
      catch (e) { photoURLs.set(key, ""); }
      return photoURLs.get(key);
    }
    ensureConverted(c, d, key);
    return null;
  }

  function ensureConverted(c, d, key) {
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      const kvKey = "cw-heic:" + key;
      let jpeg = null;
      try { jpeg = await MBDB.kvGet(kvKey); } catch (e) { /* no cache */ }
      let blob;
      if (jpeg && typeof jpeg === "string") blob = b64ToBlob(jpeg, "image/jpeg");
      else {
        blob = await heicToJpegBlob(b64ToBlob(d, "image/heic"));
        try {
          const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
          await MBDB.kvSet(kvKey, b64);
        } catch (e) { /* cache optional */ }
      }
      const url = URL.createObjectURL(blob);
      photoURLs.set(key, url);
      return url;
    })().catch(() => { photoURLs.set(key, ""); return ""; })
      .then(url => {
        pending.delete(key);
        if (url) document.querySelectorAll('[data-cw-av="' + CSS.escape(String(c.id)) + '"]').forEach(el => putImg(el, url));
        return url;
      });
    pending.set(key, p);
    return p;
  }

  function putImg(el, url) {
    if (!el || el.querySelector("img")) return;
    const img = document.createElement("img");
    img.alt = "";
    img.src = url;
    img.onerror = () => img.remove();
    el.appendChild(img);
  }

  /// Avatar markup. Initials always render underneath; a photo (when there is
  /// one and it decodes) covers them, so a bad image can never show broken.
  /// opts.list → beveled square in Windows 95 list rows, like iOS.
  function avatarHTML(c, size, opts) {
    size = size || 40;
    const cls = "cw-av" + (opts && opts.list ? " list" : "") + (opts && opts.cls ? " " + opts.cls : "");
    const url = c ? photoURL(c) : "";
    return '<span class="' + cls + '" data-cw-av="' + esc(c ? String(c.id) : "") + '" style="--av:' + size + 'px" aria-hidden="true">' +
      '<span class="ini">' + esc(c ? initials(c) : "?") + "</span>" +
      (url ? '<img alt="" src="' + esc(url) + '" onerror="this.remove()">' : "") + "</span>";
  }

  /// Avatar for a crew name (schedule / stats): matched contact's photo, else initials.
  function avatarForName(name, size, opts) {
    const c = contactMatching(name);
    if (c) return avatarHTML(c, size, opts);
    return '<span class="cw-av' + (opts && opts.list ? " list" : "") + '" style="--av:' + (size || 36) + 'px" aria-hidden="true"><span class="ini">' +
      esc(initialsFromName(name)) + "</span></span>";
  }

  // ---------------------------------------------------------------------------
  // Page state + routing
  // ---------------------------------------------------------------------------
  const ui = { host: null, query: "", id: null, mode: null }; // mode: null | "edit" | "new"

  function setRoute() {
    const path = "#settings/workday/coworkers" + (ui.mode === "new" ? "/new" : ui.id ? "/" + ui.id + (ui.mode === "edit" ? "/edit" : "") : "");
    try { history.replaceState(null, "", path); } catch (e) { /* ignore */ }
  }

  /// Settings > Workday > Coworkers. route: "" | "<id>" | "<id>/edit" | "new"
  async function open(host, route) {
    ui.host = host;
    const parts = String(route || "").split("/").filter(Boolean);
    ui.mode = parts[0] === "new" ? "new" : parts[1] === "edit" ? "edit" : null;
    ui.id = parts[0] && parts[0] !== "new" ? parts[0] : null;
    host.innerHTML = spinner("Loading coworkers…");
    try { await loadAll(); }
    catch (e) { host.innerHTML = '<div class="panel error-box">Couldn\'t load coworkers: ' + esc(e.message || "") + "</div>"; return; }
    if (ui.id && !cache.contacts.some(c => String(c.id) === String(ui.id))) { ui.id = null; ui.mode = null; }
    host.innerHTML = '<div class="cw-page"><div class="cw-list-col" id="cw-list"></div><div class="cw-main-col" id="cw-main"></div></div>';
    renderList();
    renderMain();
  }

  function select(id, mode) {
    ui.id = id; ui.mode = mode || null;
    setRoute();
    renderList(true);
    renderMain();
    const main = ui.host && ui.host.querySelector("#cw-main");
    if (main && main.getBoundingClientRect().top < 0) main.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  // ---------------------------------------------------------------------------
  // List (CoworkersListView)
  // ---------------------------------------------------------------------------
  function filtered() {
    const needle = ui.query.trim().toLowerCase();
    return cache.contacts.filter(c =>
      fullName(c).toLowerCase().includes(needle) || trim(c.organization).toLowerCase().includes(needle) ||
      trim(c.notes).toLowerCase().includes(needle) || primaryEmail(c).toLowerCase().includes(needle) ||
      String(c.phone || "").includes(needle) || trim(c.nickname).toLowerCase().includes(needle))
      .sort((a, b) => sortName(a).toLowerCase().localeCompare(sortName(b).toLowerCase()));
  }
  function sections() {
    const sorted = cache.contacts.slice().sort((a, b) => sortName(a).toLowerCase().localeCompare(sortName(b).toLowerCase()));
    const buckets = {};
    sorted.forEach(c => {
      const letter = sortName(c).charAt(0).toUpperCase();
      const key = /\p{L}/u.test(letter) ? letter : "#";
      (buckets[key] = buckets[key] || []).push(c);
    });
    return Object.keys(buckets).sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b))).map(k => ({ key: k, items: buckets[k] }));
  }

  function rowHTML(c) {
    const phone = callablePhone(primaryPhone(c)) ? formattedPhone(primaryPhone(c)) : "";
    return '<button class="cw-row' + (String(c.id) === String(ui.id) ? " selected" : "") + '" data-cw="' + esc(c.id) + '">' +
      avatarHTML(c, 40, { list: true }) +
      '<span class="cw-row-text"><span class="cw-row-name">' + esc(fullName(c) || "No name") + "</span>" +
      (phone ? '<span class="cw-row-sub">' + esc(phone) + "</span>" : "") + "</span>" +
      (c.isFavorite ? '<span class="cw-star on" title="Favorite">' + I("star", { size: 14 }) + "</span>" : "") +
      '<span class="cw-chev">' + I("chevron-right", { size: 16 }) + "</span></button>";
  }

  function groupHTML(title, items, foot) {
    return '<div class="cw-group"><div class="cw-letter">' + esc(title) + "</div>" +
      '<div class="cw-card">' + items.map(rowHTML).join("") + "</div>" +
      (foot ? '<div class="cw-foot">' + esc(foot) + "</div>" : "") + "</div>";
  }

  function listBodyHTML() {
    if (!cache.contacts.length) return "";
    if (ui.query.trim()) {
      const res = filtered();
      return res.length ? groupHTML("Results", res) : '<div class="cw-group"><div class="cw-letter">No matches</div></div>';
    }
    const favs = cache.contacts.filter(c => c.isFavorite).sort((a, b) => a.favoriteRank - b.favoriteRank);
    let h = favs.length ? groupHTML("Favorites", favs) : "";
    sections().forEach(s => { h += groupHTML(s.key, s.items); });
    return h;
  }

  function renderList(keepScroll) {
    const el = ui.host && ui.host.querySelector("#cw-list");
    if (!el) return;
    const scroller = el.querySelector(".cw-list-scroll");
    const top = keepScroll && scroller ? scroller.scrollTop : 0;
    const n = cache.contacts.length, nf = cache.contacts.filter(c => c.isFavorite).length;
    el.innerHTML = '<div class="cw-list-head"><div class="grow"><div class="sec-title">' + (n ? n + " coworker" + (n === 1 ? "" : "s") : "No coworkers yet") + "</div>" +
      '<div class="sec-sub">' + (n ? (nf ? nf + " favorite" + (nf === 1 ? "" : "s") + " \u00B7 " : "") + "A\u2013Z by last name" : "Add who you work with") + "</div></div>" +
      '<button class="icon-btn cw-add" id="cw-add" title="New coworker" aria-label="New coworker">' + I("plus", { size: 18 }) + "</button></div>" +
      '<div class="search-box cw-search">' + I("search") +
      '<input type="search" id="cw-q" placeholder="Search coworkers" autocomplete="off" value="' + esc(ui.query) + '"></div>' +
      '<div class="cw-list-scroll" id="cw-list-scroll">' + listBodyHTML() + "</div>";
    el.querySelector(".cw-list-scroll").scrollTop = top;
    el.querySelector("#cw-add").onclick = () => select(null, "new");
    const q = el.querySelector("#cw-q");
    q.oninput = () => {
      ui.query = q.value;
      el.querySelector("#cw-list-scroll").innerHTML = listBodyHTML();
      bindRows(el);
    };
    bindRows(el);
  }
  function bindRows(el) {
    el.querySelectorAll("[data-cw]").forEach(b => { b.onclick = () => select(b.dataset.cw); });
  }

  // ---------------------------------------------------------------------------
  // Right column: empty / detail / editor
  // ---------------------------------------------------------------------------
  function renderMain() {
    const el = ui.host && ui.host.querySelector("#cw-main");
    if (!el) return;
    if (ui.mode === "new") return renderEditor(el, null);
    const c = ui.id ? cache.contacts.find(x => String(x.id) === String(ui.id)) : null;
    if (c && ui.mode === "edit") return renderEditor(el, c);
    if (c) return renderDetail(el, c);
    renderEmpty(el);
  }

  function renderEmpty(el) {
    if (!cache.contacts.length) {
      el.innerHTML = '<div class="panel cw-empty"><div class="empty-state">' +
        '<div class="empty-ico navy">' + I("users", { size: 34 }) + '</div><div class="t">Your crew, in one place</div>' +
        "<p>Keep every coworker's number, hours, and shift stories here. Add them by hand, or bring them in from Apple Contacts in the iPhone app.</p>" +
        '<div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" id="cw-empty-add">' + I("user-plus") + " Add manually</button></div></div></div>";
      el.querySelector("#cw-empty-add").onclick = () => select(null, "new");
      return;
    }
    const withPhone = cache.contacts.filter(c => callablePhone(primaryPhone(c))).length;
    const linked = cache.contacts.filter(c => c.linkedUserID).length;
    el.innerHTML = '<div class="panel cw-empty"><div class="empty-state">' +
      '<div class="empty-ico navy">' + I("users", { size: 34 }) + '</div><div class="t">Pick a coworker</div>' +
      "<p>Choose someone on the left to see their info, notes, and the moments you've journaled about them.</p>" +
      '<div class="cw-empty-stats">' +
      '<div class="tile"><div class="t">Saved</div><div class="v">' + cache.contacts.length + "</div></div>" +
      '<div class="tile"><div class="t">With a phone</div><div class="v">' + withPhone + "</div></div>" +
      '<div class="tile"><div class="t">Linked accounts</div><div class="v">' + linked + "</div></div></div>" +
      '<div class="btn-row" style="justify-content:center;margin-top:14px"><button class="btn primary" id="cw-empty-add">' + I("user-plus") + " New coworker</button></div></div></div>";
    el.querySelector("#cw-empty-add").onclick = () => select(null, "new");
  }

  // ---- Detail (CoworkerDetailView) ----
  function infoRow(label, value, icon, href, opts) {
    const inner = '<span class="cw-info-ico">' + I(icon, { size: 18 }) + "</span>" +
      '<span class="cw-info-text"><span class="cw-info-label">' + esc(label) + '</span><span class="cw-info-value">' + esc(value) + "</span></span>";
    const copy = opts && opts.copy ? '<button class="icon-btn cw-copy" data-copy="' + esc(opts.copy) + '" title="Copy" aria-label="Copy ' + esc(label) + '">' + I("copy", { size: 15 }) + "</button>" : "";
    if (href) {
      return '<div class="cw-info-row"><a class="cw-info-link" href="' + esc(href) + '"' + (/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : "") + ">" +
        inner + '<span class="cw-chev">' + I("chevron-right", { size: 14 }) + "</span></a>" + copy + "</div>";
    }
    return '<div class="cw-info-row"><div class="cw-info-link static">' + inner + "</div>" + copy + "</div>";
  }
  function cardHTML(title, sub, rows) {
    return '<div class="panel cw-sec"><div class="sec-head"><div class="grow"><div class="sec-title">' + esc(title) + "</div>" +
      (sub ? '<div class="sec-sub">' + esc(sub) + "</div>" : "") + "</div></div>" + rows + "</div>";
  }
  const fmtDate = (iso, opts) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString("en-US", opts); };
  /// Year 2000 is the unknown-year sentinel — month and day only.
  function birthdayLine(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US", d.getFullYear() === 2000 ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  }

  /// Shifts whose crew list names this coworker (schedule data from UKG / manual).
  function shiftsTogether(c) {
    const out = [];
    for (const s of cache.shifts) {
      const crew = Array.isArray(s.coworkers) ? s.coworkers : [];
      if (crew.some(m => { const nm = typeof m === "string" ? m : m && m.name; const hit = nm && contactMatching(nm); return hit && String(hit.id) === String(c.id); })) out.push(s);
    }
    return out.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  }

  function togetherHTML(c) {
    const list = shiftsTogether(c);
    if (!list.length) return "";
    const now = Date.now();
    const past = list.filter(s => Date.parse(s.start) <= now), next = list.find(s => Date.parse(s.start) > now);
    const last = past[past.length - 1];
    const hours = past.reduce((h, s) => h + Math.max(0, (Date.parse(s.actualEnd || s.end) - Date.parse(s.actualStart || s.start)) / 3600000), 0);
    const day = s => fmtDate(s.start, { weekday: "short", month: "short", day: "numeric" });
    return cardHTML("On the schedule together", "From your synced shifts",
      '<div class="cw-together">' +
      '<div class="tile"><div class="t">Shifts together</div><div class="v">' + past.length + "</div></div>" +
      '<div class="tile"><div class="t">Hours on shift</div><div class="v">' + hours.toFixed(1) + "</div></div>" +
      '<div class="tile"><div class="t">Last together</div><div class="v sm">' + (last ? esc(day(last)) : "\u2014") + "</div></div>" +
      '<div class="tile"><div class="t">Next together</div><div class="v sm">' + (next ? esc(day(next)) : "\u2014") + "</div></div></div>");
  }

  function renderDetail(el, c) {
    const phone = callablePhone(primaryPhone(c)), email = primaryEmail(c);
    const action = (label, icon, href) => href
      ? '<a class="cw-action" href="' + esc(href) + '">' + I(icon, { size: 20 }) + "<span>" + esc(label) + "</span></a>"
      : '<span class="cw-action disabled" aria-disabled="true">' + I(icon, { size: 20 }) + "<span>" + esc(label) + "</span></span>";
    let h = '<div class="cw-detail">';
    h += '<div class="panel cw-hero">' +
      '<div class="cw-hero-tools">' +
      '<button class="btn ghost sm" id="cw-edit">' + I("edit", { size: 15 }) + " Edit</button>" +
      '<button class="btn ghost sm cw-del" id="cw-del">' + I("trash", { size: 15 }) + " Delete</button></div>" +
      avatarHTML(c, 104, { cls: "hero" }) +
      '<div class="cw-hero-name"><h2>' + esc(displayName(c) || "No name") + "</h2>" +
      '<button class="cw-star' + (c.isFavorite ? " on" : "") + '" id="cw-fav" title="' + (c.isFavorite ? "Remove from favorites" : "Add to favorites") + '" aria-label="' + (c.isFavorite ? "Remove from favorites" : "Add to favorites") + '">' + I("star", { size: 18 }) + "</button></div>" +
      (workLine(c) ? '<div class="cw-workline">' + esc(workLine(c)) + "</div>" : "") +
      (trim(c.nickname) ? '<div class="cw-nick">\u201C' + esc(c.nickname) + "\u201D</div>" : "") +
      (c.linkedUserID ? '<div class="chip navy cw-linked">' + I("link", { size: 13 }) + " Linked Micro Buddy account" + (c.photoData ? "" : c.linkedPhotoData ? " \u00B7 photo from their profile" : "") + "</div>" : "") +
      '<div class="cw-actions">' +
      action("Message", "chat", phone ? "sms:" + phone : null) +
      action("Call", "phone", phone ? "tel:" + phone : null) +
      (email ? action("Mail", "mail", "mailto:" + email) : "") + "</div></div>";

    // Info sections, Apple Contacts style.
    let left = "", right = "";
    if (c.phones.length) left += cardHTML("Phone", "Click to call", c.phones.map(p =>
      infoRow(p.label || "Phone", formattedPhone(p.value), "phone", "tel:" + callablePhone(p.value), { copy: formattedPhone(p.value) })).join(""));
    if (c.emails.length) left += cardHTML("Email", "Click to write", c.emails.map(p =>
      infoRow(p.label || "Email", p.value, "mail", "mailto:" + p.value, { copy: p.value })).join(""));
    if (c.addresses.length) left += cardHTML("Addresses", "Click for directions", c.addresses.map(a =>
      infoRow(a.label || "Address", oneLineAddress(a), "pin", "https://maps.apple.com/?q=" + encodeURIComponent(oneLineAddress(a)), { copy: oneLineAddress(a) })).join(""));
    if (c.urls.length || c.socials.length) {
      left += cardHTML("Websites & social", "Click to open",
        c.urls.filter(u => webURL(u.value)).map(u => infoRow(u.label || "Website", u.value, "link", webURL(u.value))).join("") +
        c.socials.map(s => { const url = socialURL(s.service, s.username) || webURL(s.username); return infoRow(s.service || "Social", s.username, "share", url); }).join(""));
    }
    const rows = [];
    if (c.birthday) rows.push(infoRow("Birthday", birthdayLine(c.birthday), "gift"));
    c.customDates.forEach(d => rows.push(infoRow(d.label || "Date", fmtDate(d.date, { month: "short", day: "numeric", year: "numeric" }), "calendar")));
    if (trim(c.jobTitle)) rows.push(infoRow("Job title", c.jobTitle, "briefcase"));
    if (trim(c.department)) rows.push(infoRow("Department", c.department, "store"));
    c.relatedNames.forEach(r => rows.push(infoRow(r.label || "Related", r.value, "user")));
    left += cardHTML("Details", "Everything else", rows.length ? rows.join("") :
      (!trim(c.organization) ? '<div class="caption">No extra details yet \u2014 click Edit to add birthday, addresses, socials, and more.</div>' : '<div class="caption">No extra details yet.</div>'));

    if (trim(c.notes)) right += cardHTML("Notes", "Anything else worth remembering", '<div class="cw-notes">' + esc(c.notes) + "</div>");
    right += togetherHTML(c);
    if (c.shiftNotes.length) {
      right += cardHTML("Shift notes", "Dated notes from your shifts", c.shiftNotes.slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .map(n => '<div class="cw-shiftnote"><div class="cw-shiftnote-head">' + esc(fmtDate(n.date, { weekday: "short", month: "short", day: "numeric" })) +
          (n.shiftLabel ? " \u00B7 " + esc(n.shiftLabel) : "") + '</div><div class="cw-notes">' + esc(n.text || "") + "</div></div>").join(""));
    }
    right += '<div class="panel cw-sec" id="cw-timeline"></div>';
    h += '<div class="cw-cols"><div class="cw-col">' + left + '</div><div class="cw-col">' + right + "</div></div></div>";
    el.innerHTML = h;

    el.querySelector("#cw-edit").onclick = () => select(c.id, "edit");
    el.querySelector("#cw-del").onclick = () => confirmDelete(c);
    el.querySelector("#cw-fav").onclick = () => toggleFavorite(c);
    el.querySelectorAll("[data-copy]").forEach(b => {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); toast("Copied"); } catch (e) { toast("Couldn't copy", "error"); }
      };
    });
    renderTimeline(el.querySelector("#cw-timeline"), c);
  }

  async function toggleFavorite(c) {
    const updates = { isFavorite: !c.isFavorite };
    if (!c.isFavorite) updates.favoriteRank = Math.max(-1, ...cache.contacts.filter(x => x.isFavorite).map(x => x.favoriteRank)) + 1;
    await SyncEngine.queueWrite({ type: "updateContact", contactId: c.id, updates });
    await loadAll();
    renderList(true);
    renderMain();
  }

  function confirmDelete(c) {
    const ov = document.createElement("div");
    ov.className = "modal-overlay";
    ov.innerHTML = '<div class="modal-card"><h2>Delete ' + esc(fullName(c) || "this coworker") + "?</h2>" +
      '<p class="caption" style="margin:0 0 16px">This removes them from your coworkers on every device. Journal entries that mention them stay.</p>' +
      '<div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn danger" data-go>' + I("trash", { size: 15 }) + " Delete</button></div></div>";
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("click", e => { if (e.target === ov) close(); });
    ov.querySelector("[data-x]").onclick = close;
    ov.querySelector("[data-go]").onclick = async () => {
      close();
      try { await deleteContact(c.id); toast("Coworker deleted"); }
      catch (e) { toast("Couldn't delete: " + (e.message || e), "error"); return; }
      select(null);
    };
  }

  // ---- Interactions (journal timeline) ----
  async function renderTimeline(boxEl, c) {
    if (!boxEl) return;
    boxEl.innerHTML = '<div class="sec-title">Interactions</div><div class="sec-sub">Newest first, from your journals</div>' + spinner("Loading interactions…");
    try {
      const contactRef = { id: String(c.id), firstName: c.firstName || "", fullName: fullName(c), nickname: c.nickname || "" };
      const links = await JournalStore.storiesAbout(String(c.id));
      const days = InteractionParser.days(links, contactRef);
      InteractionTimeline.render(contactRef, days, boxEl,
        async moment => {
          if (moment.openDay) { if (typeof DayDetailUI !== "undefined") DayDetailUI.open(moment.dayKey); return; }
          await openPassage(moment);
        },
        async (moment, newType) => {
          await JournalStore.updateMoment(moment.dayKey, moment.storyID, moment.id, moment.excerpt, { interactionType: newType });
          renderTimeline(boxEl, c);
        });
    } catch (e) {
      boxEl.innerHTML = '<div class="sec-title">Interactions</div><div class="caption">Couldn\'t load the timeline: ' + esc(e.message || "") + "</div>";
    }
  }

  async function openPassage(moment) {
    try {
      const backup = await SyncEngine.getLocalBackup();
      const entry = JournalStore.getAllEntries(backup).find(e => (e.dayKey || e.date) === moment.dayKey);
      if (!entry) return;
      const ov = document.createElement("div");
      ov.className = "modal-overlay";
      ov.innerHTML = '<div class="modal-card wide"><div class="settings-page-head"><h2 style="margin:0;flex:1">' +
        esc(fmtDate(moment.dayKey + "T12:00:00", { weekday: "long", month: "long", day: "numeric" })) + "</h2></div><div class=\"cw-passage\"></div></div>";
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.addEventListener("click", e => { if (e.target === ov) close(); });
      JournalPassageView.onBack = close;
      JournalPassageView.render(entry, moment, ov.querySelector(".cw-passage"));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Editor (CoworkerEditorView)
  // ---------------------------------------------------------------------------
  const PHONE_LABELS = ["Mobile", "Work", "Home", "Main", "Fax", "Other"];
  const EMAIL_LABELS = ["Work", "Home", "Other"];
  const ADDRESS_LABELS = ["Home", "Work", "Other"];
  const SOCIAL_SERVICES = ["Instagram", "X", "LinkedIn", "Facebook", "TikTok", "Snapchat", "Other"];
  const RELATED_LABELS = ["Mom", "Dad", "Partner", "Spouse", "Friend", "Manager", "Other"];
  const URL_LABELS = ["Website", "Blog"];

  /// Date input value (local) for a stored ISO date.
  function dateInputValue(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  /// Stored ISO for a picked day: keep the original instant when the day didn't
  /// change, otherwise local noon (never shifts a day across time zones).
  function isoForDateInput(value, original) {
    if (!value) return null;
    if (original && dateInputValue(original) === value) return original;
    const [y, m, d] = value.split("-").map(Number);
    return SB.isoSeconds(new Date(y, m - 1, d, 12, 0, 0));
  }

  function datalist(id, opts) { return '<datalist id="' + id + '">' + opts.map(o => '<option value="' + esc(o) + '">').join("") + "</datalist>"; }

  function lvRowHTML(kind, it, placeholder, listId, type) {
    return '<div class="cw-lv" data-kind="' + kind + '" data-id="' + esc(it.id || uid()) + '">' +
      '<input class="cw-lv-label" list="' + listId + '" placeholder="Label" value="' + esc(it.label || "") + '" aria-label="Label">' +
      '<input class="cw-lv-value" type="' + (type || "text") + '" placeholder="' + esc(placeholder) + '" value="' + esc(it.value || "") + '" aria-label="' + esc(placeholder) + '">' +
      '<button class="icon-btn cw-rm" type="button" aria-label="Remove">' + I("minus", { size: 16 }) + "</button></div>";
  }
  function addressHTML(a) {
    return '<div class="cw-addr" data-id="' + esc(a.id || uid()) + '">' +
      '<div class="cw-addr-head"><input class="cw-a-label" list="cw-dl-addr" placeholder="Label" value="' + esc(a.label || "") + '" aria-label="Address label">' +
      '<span class="spacer"></span><button class="icon-btn cw-rm" type="button" aria-label="Remove address">' + I("minus", { size: 16 }) + "</button></div>" +
      '<input class="cw-a-street" placeholder="Street" value="' + esc(a.street || "") + '">' +
      '<div class="cw-two"><input class="cw-a-city" placeholder="City" value="' + esc(a.city || "") + '"><input class="cw-a-state" placeholder="State" value="' + esc(a.state || "") + '"></div>' +
      '<div class="cw-two"><input class="cw-a-zip" placeholder="ZIP" inputmode="numeric" value="' + esc(a.zip || "") + '"><input class="cw-a-country" placeholder="Country" value="' + esc(a.country || "") + '"></div></div>';
  }
  function socialHTML(s) {
    return '<div class="cw-lv cw-social" data-id="' + esc(s.id || uid()) + '">' +
      '<select class="cw-s-service" aria-label="Service"><option value="">Service</option>' +
      SOCIAL_SERVICES.concat(s.service && !SOCIAL_SERVICES.includes(s.service) ? [s.service] : [])
        .map(x => '<option' + (x === s.service ? " selected" : "") + ">" + esc(x) + "</option>").join("") + "</select>" +
      '<input class="cw-s-user" placeholder="Username" autocapitalize="off" value="' + esc(s.username || "") + '" aria-label="Username">' +
      '<button class="icon-btn cw-rm" type="button" aria-label="Remove">' + I("minus", { size: 16 }) + "</button></div>";
  }
  function dateRowHTML(d) {
    return '<div class="cw-lv cw-date" data-id="' + esc(d.id || uid()) + '" data-orig="' + esc(d.date || "") + '">' +
      '<input class="cw-d-label" placeholder="Label" value="' + esc(d.label || "") + '" aria-label="Date label">' +
      '<input class="cw-d-date" type="date" value="' + esc(d.date ? dateInputValue(d.date) : "") + '" aria-label="Date">' +
      '<button class="icon-btn cw-rm" type="button" aria-label="Remove">' + I("minus", { size: 16 }) + "</button></div>";
  }
  function edCard(title, sub, body, addBtns) {
    return '<div class="panel cw-sec"><div class="sec-head"><div class="grow"><div class="sec-title">' + esc(title) + "</div>" +
      (sub ? '<div class="sec-sub">' + esc(sub) + "</div>" : "") + "</div></div>" + body +
      (addBtns ? '<div class="cw-adds">' + addBtns + "</div>" : "") + "</div>";
  }
  const addBtn = (kind, label) => '<button class="link-btn" type="button" data-add="' + kind + '">' + I("plus", { size: 15 }) + " " + esc(label) + "</button>";
  const fieldHTML = (id, label, value, attrs) => '<div class="field"><label for="' + id + '">' + esc(label) + '</label><input id="' + id + '" value="' + esc(value || "") + '"' + (attrs || "") + "></div>";

  function renderEditor(el, existing) {
    const c = normalizeContact(existing || {});
    let photo = { data: c.photoData || null, changed: false }; // the user's own photo only
    const h = '<form class="cw-editor" autocomplete="off">' +
      '<div class="panel cw-ed-head"><div class="grow"><div class="sec-title" style="font-size:20px">' + (existing ? "Edit coworker" : "New coworker") + "</div>" +
      '<div class="sec-sub">' + (existing ? "Changes sync to your phone" : "Every field the iPhone keeps \u2014 only a name is required") + "</div></div>" +
      '<button class="btn ghost" type="button" id="cw-cancel">Cancel</button><button class="btn primary" type="submit" id="cw-save">' + I("check", { size: 15 }) + " Save</button></div>" +
      '<div class="cw-cols"><div class="cw-col">' +
      // Photo
      '<div class="panel cw-sec cw-photo"><div class="cw-photo-av" id="cw-photo-av"></div><div class="cw-photo-side">' +
      '<div class="sec-title">Photo</div><div class="sec-sub" id="cw-photo-note"></div>' +
      '<div class="btn-row" style="margin-top:10px"><label class="btn ghost sm" for="cw-photo-file">' + I("camera", { size: 15 }) + " Choose photo</label>" +
      '<button class="btn ghost sm cw-del" type="button" id="cw-photo-rm">' + I("trash", { size: 15 }) + " <span>Remove photo</span></button></div>" +
      '<input type="file" id="cw-photo-file" accept="image/*,.heic,.heif" hidden></div></div>' +
      // Name + work
      edCard("Name", "Every part Apple Contacts keeps",
        '<div class="cw-grid3">' + fieldHTML("cw-prefix", "Prefix", c.namePrefix, ' placeholder="Mr., Dr."') + fieldHTML("cw-first", "First name", c.firstName) + fieldHTML("cw-middle", "Middle name", c.middleName) + "</div>" +
        '<div class="cw-grid3">' + fieldHTML("cw-last", "Last name", c.lastName) + fieldHTML("cw-suffix", "Suffix", c.nameSuffix, ' placeholder="Jr., III"') + fieldHTML("cw-nick", "Nickname", c.nickname) + "</div>" +
        '<div class="label" style="margin:12px 0 6px">Work</div>' +
        '<div class="cw-grid3">' + fieldHTML("cw-org", "Company", c.organization) + fieldHTML("cw-job", "Job title", c.jobTitle) + fieldHTML("cw-dept", "Department", c.department) + "</div>") +
      edCard("Phones", "Home, work, mobile \u2014 as many as you need", '<div class="cw-lvs" data-list="phones">' +
        c.phones.map(p => lvRowHTML("phones", { id: p.id, label: p.label, value: formattedPhone(p.value) }, "Number", "cw-dl-phone", "tel")).join("") + "</div>", addBtn("phones", "Add phone")) +
      edCard("Emails", "Work and personal", '<div class="cw-lvs" data-list="emails">' +
        c.emails.map(p => lvRowHTML("emails", p, "Email", "cw-dl-email", "email")).join("") + "</div>", addBtn("emails", "Add email")) +
      edCard("Addresses", "Street, city, state, ZIP", '<div class="cw-lvs" data-list="addresses">' + c.addresses.map(addressHTML).join("") + "</div>", addBtn("addresses", "Add address")) +
      '</div><div class="cw-col">' +
      edCard("Websites & social", "Links and handles", '<div class="cw-lvs" data-list="urls">' +
        c.urls.map(p => lvRowHTML("urls", p, "example.com", "cw-dl-url", "text")).join("") + '</div><div class="cw-lvs" data-list="socials">' +
        c.socials.map(socialHTML).join("") + "</div>", addBtn("urls", "Website") + addBtn("socials", "Social")) +
      edCard("Dates", "Birthday, anniversary, and more",
        '<div class="cw-bday"><label class="switch-row"><span class="grow"><b>Birthday</b></span>' +
        '<span class="switch"><input type="checkbox" id="cw-bday-on"' + (c.birthday ? " checked" : "") + "><span></span></span></label>" +
        '<input type="date" id="cw-bday" value="' + esc(c.birthday ? dateInputValue(c.birthday) : "") + '"' + (c.birthday ? "" : " hidden") + ' aria-label="Birthday"></div>' +
        '<div class="cw-lvs" data-list="dates">' + c.customDates.map(dateRowHTML).join("") + "</div>", addBtn("dates", "Add date")) +
      edCard("Related people", "Who's who \u2014 spouse, mom, kids", '<div class="cw-lvs" data-list="related">' +
        c.relatedNames.map(p => lvRowHTML("related", p, "Name", "cw-dl-related", "text")).join("") + "</div>", addBtn("related", "Add person")) +
      edCard("Notes", "General notes \u2014 shift stories go in your journal",
        '<textarea id="cw-notes" rows="5" placeholder="Favorite snack, rotation quirks, anything\u2026">' + esc(c.notes) + "</textarea>") +
      (existing ? '<button class="btn danger block" type="button" id="cw-ed-del">' + I("trash", { size: 15 }) + " Delete coworker</button>" : "") +
      '<div class="form-error" id="cw-err" hidden></div>' +
      "</div></div>" +
      datalist("cw-dl-phone", PHONE_LABELS) + datalist("cw-dl-email", EMAIL_LABELS) + datalist("cw-dl-addr", ADDRESS_LABELS) +
      datalist("cw-dl-related", RELATED_LABELS) + datalist("cw-dl-url", URL_LABELS) + "</form>";
    el.innerHTML = h;
    const form = el.querySelector("form");
    const $q = s => form.querySelector(s);

    const paintPhoto = () => {
      const shown = Object.assign({}, c, { photoData: photo.data || null });
      const av = $q("#cw-photo-av");
      av.innerHTML = avatarHTML(shown, 104, { cls: "hero" });
      const note = $q("#cw-photo-note"), rm = $q("#cw-photo-rm");
      const linked = !!c.linkedUserID;
      rm.hidden = !photo.data;
      rm.querySelector("span").textContent = linked && c.linkedPhotoData ? "Remove photo \u2014 back to their account photo" : "Remove photo";
      note.textContent = photo.data ? "Your photo for them \u2014 it always wins over their account photo"
        : linked && c.linkedPhotoData ? "Photo synced from their Micro Buddy account \u2014 set your own to replace it"
        : "Optional. Shown in your list and on their page.";
    };
    paintPhoto();
    $q("#cw-photo-file").onchange = async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      $q("#cw-photo-note").textContent = "Processing photo\u2026";
      try {
        const isHeic = /heic|heif/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
        const jpeg = isHeic ? await heicToJpegBlob(f) : await downscale(f, 512, 0.75);
        photo.data = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(jpeg); });
        photo.changed = true;
      } catch (err) { toast("Couldn't read that image", "error"); }
      e.target.value = "";
      paintPhoto();
    };
    $q("#cw-photo-rm").onclick = () => { photo.data = null; photo.changed = true; paintPhoto(); };

    $q("#cw-bday-on").onchange = e => {
      const inp = $q("#cw-bday");
      inp.hidden = !e.target.checked;
      if (e.target.checked && !inp.value) inp.value = dateInputValue(new Date().toISOString());
    };

    const wireRemove = root => root.querySelectorAll(".cw-rm").forEach(b => { b.onclick = () => b.closest(".cw-lv, .cw-addr").remove(); });
    wireRemove(form);
    form.querySelectorAll("[data-add]").forEach(b => {
      b.onclick = () => {
        const kind = b.dataset.add;
        const list = form.querySelector('[data-list="' + kind + '"]');
        const n = list.children.length;
        const html = kind === "phones" ? lvRowHTML("phones", { label: n ? "" : "Mobile" }, "Number", "cw-dl-phone", "tel")
          : kind === "emails" ? lvRowHTML("emails", { label: n ? "" : "Work" }, "Email", "cw-dl-email", "email")
          : kind === "urls" ? lvRowHTML("urls", { label: "Website" }, "example.com", "cw-dl-url", "text")
          : kind === "socials" ? socialHTML({ service: n ? "" : "Instagram" })
          : kind === "addresses" ? addressHTML({ label: n ? "" : "Home" })
          : kind === "dates" ? dateRowHTML({ label: "Anniversary" })
          : lvRowHTML("related", {}, "Name", "cw-dl-related", "text");
        list.insertAdjacentHTML("beforeend", html);
        wireRemove(list);
        const first = list.lastElementChild.querySelector(".cw-lv-value, .cw-s-user, .cw-a-street, .cw-d-date");
        if (first) first.focus();
      };
    });

    const cancel = () => select(existing ? existing.id : null);
    $q("#cw-cancel").onclick = cancel;
    const edDel = $q("#cw-ed-del");
    if (edDel) edDel.onclick = () => confirmDelete(existing);

    form.onsubmit = async e => {
      e.preventDefault();
      const v = id => trim($q("#" + id).value);
      const lv = kind => [...form.querySelectorAll('[data-list="' + kind + '"] .cw-lv')].map(r => ({
        id: r.dataset.id, label: trim(r.querySelector(".cw-lv-label").value), value: trim(r.querySelector(".cw-lv-value").value) }));
      const updated = Object.assign({}, c, {
        namePrefix: v("cw-prefix"), firstName: v("cw-first"), middleName: v("cw-middle"), lastName: v("cw-last"),
        nameSuffix: v("cw-suffix"), nickname: v("cw-nick"), organization: v("cw-org"), jobTitle: v("cw-job"), department: v("cw-dept"),
        notes: $q("#cw-notes").value,
        phones: lv("phones"), emails: lv("emails"), urls: lv("urls"), relatedNames: lv("related"),
        socials: [...form.querySelectorAll('[data-list="socials"] .cw-social')].map(r => ({ id: r.dataset.id, service: r.querySelector(".cw-s-service").value, username: trim(r.querySelector(".cw-s-user").value) })),
        addresses: [...form.querySelectorAll('[data-list="addresses"] .cw-addr')].map(r => ({ id: r.dataset.id,
          label: trim(r.querySelector(".cw-a-label").value), street: trim(r.querySelector(".cw-a-street").value), city: trim(r.querySelector(".cw-a-city").value),
          state: trim(r.querySelector(".cw-a-state").value), zip: trim(r.querySelector(".cw-a-zip").value), country: trim(r.querySelector(".cw-a-country").value) })),
        customDates: [...form.querySelectorAll('[data-list="dates"] .cw-date')].map(r => ({ id: r.dataset.id, label: trim(r.querySelector(".cw-d-label").value),
          date: isoForDateInput(r.querySelector(".cw-d-date").value, r.dataset.orig) })).filter(d => d.date),
      });
      const bdayOn = $q("#cw-bday-on").checked && $q("#cw-bday").value;
      if (bdayOn) updated.birthday = isoForDateInput($q("#cw-bday").value, c.birthday);
      else updated.birthday = null;
      if (photo.changed) updated.photoData = photo.data || null;
      const err = $q("#cw-err");
      if (!updated.firstName && !updated.lastName && !updated.organization) {
        err.hidden = false; err.textContent = "Add a first name, last name, or company to save.";
        $q("#cw-first").focus();
        return;
      }
      if (!existing) {
        updated.id = uid();
        updated.createdAt = SB.isoSeconds(new Date());
        updated.isFavorite = false; updated.favoriteRank = 0;
      }
      const btn = $q("#cw-save");
      btn.disabled = true;
      try {
        const saved = await saveContact(updated);
        toast(existing ? "Coworker saved" : "Coworker added");
        select(saved.id);
      } catch (ex) {
        btn.disabled = false;
        err.hidden = false; err.textContent = "Couldn't save: " + (ex.message || ex);
      }
    };
    const first = $q(existing ? "#cw-first" : "#cw-first");
    if (!existing && first) first.focus();
  }

  /// Warm the contact cache so crew avatars elsewhere can show photos.
  async function preload() { try { await loadAll(); } catch (e) { /* offline first run */ } }
  window.addEventListener("mb:data-changed", () => { preload(); });

  /// Compare + comparison detail open in the shared sheet; Back closes it.
  function closeHost(boxEl) {
    const modal = boxEl.closest(".modal-overlay");
    if (modal) modal.hidden = true; else boxEl.innerHTML = "";
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

    boxEl.querySelector("#cmp-back").addEventListener("click", () => closeHost(boxEl));
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
    // Same exchange rules as the day's own stats (Batch 15, ComparisonSide.capture).
    const items = (tickets || []).reduce((s, t) =>
      s + (t.lines || []).reduce((x, l) => x + ((l.isReturn || l.isExchange || l.kind === "servicePlan") ? 0 : (l.quantity || 0)), 0), 0);
    const plans = lines
      .filter(l => l.kind === "servicePlan" && !l.isReturn && !l.isExchange)
      .reduce((s, l) => s + (l.quantity || 0), 0);
    const topProducts = Object.entries(revenueByProduct)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([name, rev]) => name + " — " + fmtMoney(rev));
    return {
      revenue, commission, items, plans,
      customers: (tickets || []).filter(t => !(t.lines || []).some(l => l.isExchange)).length,
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
      const ms = new Date(sh.actualEnd || sh.end) - new Date(sh.actualStart || sh.start);
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
      boxEl.querySelector("#cp-back").addEventListener("click", () => closeHost(boxEl));
      boxEl.querySelector("#cp-del").addEventListener("click", async () => {
        if (!confirm("Delete this comparison? Your own sales history is not touched.")) return;
        await SyncEngine.queueWrite({ type: "deleteComparison", comparisonId: cp.id });
        closeHost(boxEl);
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
    open, preload, avatarHTML, avatarForName, contactMatching,
    renderCompare, renderComparisonDetail, renderComparisonsList,
    linkToLeaderboardPeer, unlinkLeaderboardPeer,
    fullName, preferredName, workLine, sortName, initials, formattedPhone,
    normalizeContact, getContacts, getComparisons, saveContact, deleteContact,
  };
})();
window.CoworkersUI = CoworkersUI;
