"use strict";
/* ============ profile.js — Account, Pay settings and Home layout ============
 *
 * Account (port of AccountInfoEditorView.swift):
 *   photo, first/last name, username, Buddy nickname live in public.profiles
 *   (SB.getProfile / SB.updateProfile — the same row the phone edits);
 *   department + home state live in the backup blob's profile. Saving writes
 *   both, exactly like the phone: profiles PATCH first (409 = username taken),
 *   then blob { department, nickname, state, name }.
 *   The photo is profiles.profile_photo — a base64 JPEG data URL, max side
 *   480 px, quality 0.7 (same encoding the phone uses).
 * Pay (Settings > Pay & Goals): commission tier tables + CA tax estimate.
 * Home layout (Settings > Appearance): widget order/visibility.
 *
 * Sync: blob edits go through SyncEngine.queueWrite({type:"updateProfile"}).
 */
const ProfileUI = (() => {
  // ---- App constants -------------------------------------------------------
  const DEPARTMENTS = [
    { id: "gsa",       title: "GSA",       subtitle: "General Sales Associate" },
    { id: "systems",   title: "Systems",   subtitle: "PC Systems" },
    { id: "byo",       title: "BYO",       subtitle: "Build Your Own" },
    { id: "ce",        title: "CE",        subtitle: "Consumer Electronics" },
    { id: "warehouse", title: "Warehouse", subtitle: "Warehouse" },
  ];
  const CONFIRMED_RATES = ["gsa", "ce"]; // Department.hasConfirmedRates

  // HomeWidget (HomeLayout.swift) — title, subtitle, default order.
  const HOME_WIDGETS = [
    { id: "goal",           title: "Goal",                subtitle: "Your active sales goal and progress" },
    { id: "payPeriod",      title: "Pay period",          subtitle: "This period's est. take-home and pre-tax pay" },
    { id: "monthSoFar",     title: "Month so far",        subtitle: "Top items, brands, plans, and biggest sale" },
    { id: "commissionMonth",title: "Commission this month",subtitle: "Commission total and per-hour this month" },
    { id: "topDays",        title: "Top 5 days",          subtitle: "Your five best days, ranked by commission" },
  ];
  const DEFAULT_WIDGET_ORDER = HOME_WIDGETS.map(w => w.id);

  // GSA defaults — CommissionTable.gsa (CommissionTable.swift:49-58),
  // identical to CE. Every other department starts here (default(for:)).
  function gsaDefaults() {
    return {
      tiers: [
        { minPrice: 0,   maxPrice: 9.99,  rate: 0.12 },
        { minPrice: 10,  maxPrice: 99.99, rate: 0.06 },
        { minPrice: 100, maxPrice: 199.99,rate: 0.03 },
        { minPrice: 200, maxPrice: null,   rate: 0.02 }, // null = "and up"
      ],
      outOfDepartmentRate: 0.01,
      servicePlanRate: 0.10,
    };
  }

  const US_STATES = [
    ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],["CA","California"],
    ["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],["FL","Florida"],["GA","Georgia"],
    ["HI","Hawaii"],["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
    ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],["MD","Maryland"],
    ["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],["MS","Mississippi"],["MO","Missouri"],
    ["MT","Montana"],["NE","Nebraska"],["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],
    ["NM","New Mexico"],["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
    ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],["SC","South Carolina"],
    ["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],["UT","Utah"],["VT","Vermont"],
    ["VA","Virginia"],["WA","Washington"],["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],
  ];


  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
  let profile = {};
  let account = null;      // normalized public.profiles row (SB)
  let commDept = "gsa";
  let commDraft = null;
  let saveTimer = null;
  let photoDraft;          // undefined = unchanged, string = new data URL, null = removed

  function deptTitle(id) {
    const d = DEPARTMENTS.find(x => x.id === id);
    return d ? d.title : id;
  }
  function getBlobProfile(backup) { return (backup && backup.data && backup.data.profile) || {}; }
  function splitName(full) {
    const parts = String(full || "").trim().split(/\s+/);
    if (!parts.length || !parts[0]) return { first: "", last: "" };
    return { first: parts[0], last: parts.slice(1).join(" ") };
  }
  function note(msg, kind) {
    if (typeof window.toast === "function") window.toast(msg, kind);
    else alert(msg);
  }
  function showError(msg) { note(msg, "error"); }
  function widgetState() {
    const order = (profile.homeWidgetOrder && profile.homeWidgetOrder.length)
      ? profile.homeWidgetOrder.slice() : DEFAULT_WIDGET_ORDER.slice();
    const off = new Set(profile.homeWidgetsOff || []);
    const known = new Set(HOME_WIDGETS.map(w => w.id));
    let visible = order.filter(id => known.has(id) && !off.has(id));
    for (const w of HOME_WIDGETS) if (!visible.includes(w.id) && !off.has(w.id)) visible.push(w.id);
    return { visible, off };
  }
  async function saveProfile(updates, immediate) {
    Object.assign(profile, updates);
    const write = () => SyncEngine.queueWrite({ type: "updateProfile", updates }).catch(e => {
      showError("Couldn't save: " + (e.message || e));
    });
    if (immediate) return write();
    clearTimeout(saveTimer);
    return new Promise(resolve => { saveTimer = setTimeout(() => write().then(resolve, resolve), 600); });
  }
  function tierLabel(t) {
    const lo = "$" + Number(t.minPrice).toFixed(2);
    return (t.maxPrice === null || t.maxPrice === undefined) ? lo + " and up" : lo + " – $" + Number(t.maxPrice).toFixed(2);
  }
  async function loadAll() {
    const backup = await SyncEngine.getLocalBackup();
    profile = getBlobProfile(backup);
    try { account = await SB.getProfile(); } catch (e) { account = SB.cachedProfile(); }
  }

  // ---- Account ---------------------------------------------------------------
  function avatarBig(photo, initials) {
    if (photo) return '<span class="avatar" style="width:96px;height:96px"><img src="' + esc(photo) + '" alt="Profile photo"></span>';
    if (initials) return '<span class="avatar initials" style="width:96px;height:96px;font-size:34px">' + esc(initials) + "</span>";
    return '<span class="avatar placeholder" style="width:96px;height:96px">' + I("user", { size: 48 }) + "</span>";
  }

  function accountHTML() {
    const a = account || {};
    const blobName = splitName(profile.name);
    const first = a.firstName || blobName.first;
    const last = a.lastName || blobName.last;
    const username = a.username || "";
    const buddy = a.buddyName || profile.nickname || "";
    const photo = photoDraft === undefined ? (a.photo || "") : (photoDraft || "");
    const initials = ((first[0] || "") + (last[0] || "")).toUpperCase();
    const dept = profile.department || "gsa";
    const state = profile.state || "";
    return (
      '<div class="grid">' +
      '<div class="panel col-4" style="text-align:center">' +
        '<div style="display:flex;justify-content:center;margin:8px 0 12px" id="pf-photo-preview">' + avatarBig(photo, initials) + "</div>" +
        '<div class="sec-title" id="pf-display-name">' + esc([first, last].filter(Boolean).join(" ") || "Your name") + "</div>" +
        (username ? '<button class="link-btn" id="pf-username-copy" title="Copy username">@' + esc(username) + " " + I("copy", { size: 13 }) + "</button>" : '<div class="caption">No username yet</div>') +
        '<div class="caption" style="margin-top:4px">' + esc(deptTitle(dept)) + "</div>" +
        '<div class="btn-row" style="justify-content:center;margin-top:14px">' +
          '<label class="btn ghost sm" style="cursor:pointer">' + I("camera", { size: 14 }) + ' Change photo<input type="file" id="pf-photo" accept="image/*" hidden></label>' +
          (photo ? '<button class="btn ghost sm danger" id="pf-photo-remove">' + I("trash", { size: 14 }) + " Remove</button>" : "") +
        "</div>" +
        '<div class="hint" style="margin-top:10px">Your photo and name come from your Micro Buddy account — the same ones your phone shows.</div>' +
      "</div>" +
      '<div class="panel col-8"><div class="sec-head"><div class="grow"><div class="sec-title">Account info</div>' +
        '<div class="sec-sub">Photo, name, username, Buddy nickname and department — all in one place</div></div></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>First name</label><input type="text" id="pf-first" value="' + esc(first) + '" placeholder="First name" autocomplete="given-name"></div>' +
          '<div class="field"><label>Last name</label><input type="text" id="pf-last" value="' + esc(last) + '" placeholder="Last name" autocomplete="family-name"></div>' +
        "</div>" +
        '<div class="field"><label>Username</label>' +
          '<div class="input-prefix"><span>@</span><input type="text" id="pf-username" value="' + esc(username) + '" placeholder="username" autocomplete="off" spellcheck="false" autocapitalize="off"></div>' +
          '<div class="hint" id="pf-username-hint">3–20 characters — letters, numbers, dots or underscores.</div></div>' +
        '<div class="field"><label>Buddy nickname</label>' +
          '<input type="text" id="pf-nick" value="' + esc(buddy) + '" placeholder="' + esc(first || "Buddy") + '" autocomplete="off">' +
          '<div class="hint">What Buddy calls you in chat and greetings. Defaults to your first name.</div></div>' +
        '<div class="field-row">' +
          '<div class="field"><label>Department</label><select id="pf-dept">' +
            DEPARTMENTS.map(d => '<option value="' + d.id + '"' + (dept === d.id ? " selected" : "") + ">" +
              esc(d.title) + " — " + esc(d.subtitle) + "</option>").join("") + "</select></div>" +
          '<div class="field"><label>Home state</label><select id="pf-acct-state"><option value="">Select…</option>' +
            US_STATES.map(s => '<option value="' + s[0] + '"' + (state === s[0] ? " selected" : "") + ">" + esc(s[1]) + "</option>").join("") +
          "</select></div>" +
        "</div>" +
        '<div class="btn-row" style="margin-top:14px"><button class="btn primary" id="pf-save">' + I("check") + " Save</button>" +
        '<span class="form-status" id="pf-status"></span></div>' +
      "</div>" +
      '<div class="panel col-12" id="pf-device"></div>' +
      "</div>"
    );
  }

  function validUsername(v) { return /^[A-Za-z0-9_.]{3,20}$/.test(v); }

  function bindAccount(root) {
    const $q = sel => root.querySelector(sel);
    const uname = $q("#pf-username"), hint = $q("#pf-username-hint");
    uname.addEventListener("input", () => {
      const v = uname.value.trim().replace(/^@/, "");
      const ok = !v || validUsername(v);
      hint.textContent = ok ? "3–20 characters — letters, numbers, dots or underscores." : "3–20 characters — letters, numbers, dots or underscores.";
      hint.classList.toggle("red", !ok);
    });
    const copyBtn = $q("#pf-username-copy");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText("@" + ((account && account.username) || "")); note("Username copied"); }
      catch (e) { showError("Couldn't copy"); }
    });
    $q("#pf-photo").addEventListener("change", e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = new Image();
      const url = URL.createObjectURL(f);
      img.onload = () => {
        URL.revokeObjectURL(url);
        // Same as the phone: downscale to max side 480, JPEG quality 0.7.
        const ratio = Math.min(1, 480 / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        photoDraft = canvas.toDataURL("image/jpeg", 0.7);
        $q("#pf-photo-preview").innerHTML = avatarBig(photoDraft, "");
        $q("#pf-status").textContent = "New photo — press Save to keep it.";
      };
      img.onerror = () => { URL.revokeObjectURL(url); showError("Couldn't read that image."); };
      img.src = url;
    });
    const rm = $q("#pf-photo-remove");
    if (rm) rm.addEventListener("click", () => {
      photoDraft = null;
      $q("#pf-photo-preview").innerHTML = avatarBig("", "");
      $q("#pf-status").textContent = "Photo removed — press Save to keep it.";
    });
    $q("#pf-save").addEventListener("click", async () => {
      const status = $q("#pf-status");
      const first = $q("#pf-first").value.trim(), last = $q("#pf-last").value.trim();
      const username = $q("#pf-username").value.trim().replace(/^@/, "");
      const nickIn = $q("#pf-nick").value.trim();
      const dept = $q("#pf-dept").value, state = $q("#pf-acct-state").value;
      if (!validUsername(username)) { status.textContent = "Usernames are 3–20 letters, numbers, dots or underscores."; status.className = "form-status error"; return; }
      if (!first || !last) { status.textContent = "Enter your first and last name."; status.className = "form-status error"; return; }
      const buddy = nickIn || first;
      const btn = $q("#pf-save");
      btn.disabled = true;
      status.textContent = "Saving…"; status.className = "form-status";
      try {
        const fields = { username, firstName: first, lastName: last, buddyName: buddy };
        if (photoDraft !== undefined) fields.profilePhoto = photoDraft;
        account = await SB.updateProfile(fields);
        photoDraft = undefined;
        // Mirror into the blob like AccountInfoEditorView.save().
        const updates = { department: dept, nickname: buddy, state, name: [first, last].join(" ") };
        const tables = Object.assign({}, profile.commissionTables || {});
        if (!tables[dept]) { tables[dept] = gsaDefaults(); updates.commissionTables = tables; }
        await saveProfile(updates, true);
        status.textContent = "Saved"; status.className = "form-status ok";
        if (typeof window.onProfileChanged === "function") window.onProfileChanged();
        renderAccount(root);
        note("Account saved — your phone picks it up on its next sync");
      } catch (e) {
        status.textContent = e && e.code === "taken" ? "That username is taken — try another."
          : (e && e.message) || "Couldn't save.";
        status.className = "form-status error";
      } finally { btn.disabled = false; }
    });
  }

  function renderAccount(root) {
    root.innerHTML = accountHTML();
    bindAccount(root);
    try { SettingsUI.renderDevice(root.querySelector("#pf-device")); } catch (e) {}
  }

  async function open(container) {
    const root = container || document.getElementById("profile-body");
    if (!root) return;
    root.innerHTML = '<div class="spinner">Loading your account…</div>';
    try { await loadAll(); }
    catch (e) { root.innerHTML = '<div class="panel error-box">Couldn\'t load your profile: ' + esc(e.message || e) + "</div>"; return; }
    photoDraft = undefined;
    renderAccount(root);
  }

  // ---- Pay settings (commission + tax) -----------------------------------------
  async function renderPay(container) {
    if (!container) return;
    container.innerHTML = '<div class="spinner">Loading pay settings…</div>';
    try { await loadAll(); } catch (e) {}
    commDept = profile.department || "gsa";
    commDraft = tableFor(commDept);
    container.innerHTML = '<div class="grid"><div class="col-7 stack" id="pf-comm-wrap">' + commissionHTML() + "</div>" +
      '<div class="col-5 stack" id="pf-tax-panel">' + taxHTML() + "</div></div>";
    bindCommission();
    bindTax();
  }

  // ---- Home layout -------------------------------------------------------------
  async function renderLayout(container) {
    if (!container) return;
    try { await loadAll(); } catch (e) {}
    container.innerHTML = '<div id="pf-layout-panel">' + layoutHTML() + "</div>";
    bindLayout();
  }

  // ---- Render: Commission ---------------------------------------------------------
  function tableFor(dept) {
    const tables = profile.commissionTables || {};
    const t = tables[dept] || gsaDefaults();
    return {
      tiers: (t.tiers || []).map(x => ({
        minPrice: Number(x.minPrice) || 0,
        maxPrice: (x.maxPrice === null || x.maxPrice === undefined) ? null : Number(x.maxPrice),
        rate: Number(x.rate) || 0,
      })),
      outOfDepartmentRate: Number(t.outOfDepartmentRate) || 0,
      servicePlanRate: Number(t.servicePlanRate) || 0,
    };
  }

  function commissionHTML() {
    const t = commDraft;
    const rows = t.tiers.map((tier, i) =>
      '<div class="comm-tier" data-i="' + i + '">' +
        '<input type="number" min="0" step="0.01" data-f="minPrice" value="' + tier.minPrice + '" title="Min price">' +
        '<span class="comm-dash">–</span>' +
        (tier.maxPrice === null
          ? '<span class="comm-andup">and up <button class="link-btn" data-setmax="' + i + '">set max</button></span>'
          : '<input type="number" min="0" step="0.01" data-f="maxPrice" value="' + tier.maxPrice + '" title="Max price">') +
        '<input type="number" min="0" max="100" step="0.1" data-f="rate" value="' + (tier.rate * 100).toFixed(1) + '" title="Rate %"><span class="comm-pct">%</span>' +
        '<button class="icon-btn" data-deltier="' + i + '" title="Remove tier" aria-label="Remove tier">' + I("close", { size: 14 }) + '</button>' +
      "</div>"
    ).join("");
    return (
            '<div class="panel" id="pf-comm-panel"><div class="sec-head"><div class="grow"><div class="sec-title">Commission rates</div><div class="sec-sub">Per-department tier tables — edits sync to your phone</div></div></div>' +
        '<div class="field-row"><label>Department</label><div class="seg-pills">' +
          DEPARTMENTS.map(d =>
            '<button class="seg-pill' + (commDept === d.id ? " selected" : "") +
            '" data-comm-dept="' + d.id + '">' + esc(d.title) + "</button>"
          ).join("") +
        "</div></div>" +
        (CONFIRMED_RATES.includes(commDept)
          ? '<div class="hint" style="margin-bottom:8px">Confirmed rates for ' + esc(deptTitle(commDept)) + ". Edits sync to your phone.</div>"
          : '<div class="warn-inline">' + esc(deptTitle(commDept)) + ' runs the GSA table until its own rates are confirmed. ' +
            "These are fully editable here until the real numbers are known.</div>") +
        '<div class="comm-head"><span>Price range</span><span>Rate</span></div>' +
        rows +
        '<div class="btn-row"><button class="btn ghost sm" id="pf-add-tier">' + I("plus", { size: 14 }) + ' Add tier</button>' +
        '<button class="btn ghost sm" id="pf-reset-table">Reset to defaults</button></div>' +
        '<div class="section-title" style="margin-top:14px">Special rates</div>' +
        '<div class="field-row"><label>Out-of-department sales</label>' +
          '<div class="pct-wrap"><input type="number" min="0" max="100" step="0.1" id="pf-ood" value="' +
          (t.outOfDepartmentRate * 100).toFixed(1) + '"><span>%</span></div></div>' +
        '<div class="field-row"><label>Service plans</label>' +
          '<div class="pct-wrap"><input type="number" min="0" max="100" step="0.1" id="pf-sp" value="' +
          (t.servicePlanRate * 100).toFixed(1) + '"><span>%</span></div></div>' +
        '<div class="btn-row"><button class="btn primary" id="pf-save-table">Save ' + esc(deptTitle(commDept)) + ' table</button>' +
        '<span id="pf-comm-status" class="form-status"></span></div>' +
      "</div>"
    );
  }

  function refreshCommissionSection() {
    commDraft = tableFor(commDept);
    const panel = document.querySelector("#pf-comm-panel");
    if (panel) {
      panel.outerHTML = commissionHTML();
      bindCommission();
    }
  }

  function bindCommission() {
    document.querySelectorAll("[data-comm-dept]").forEach(btn => {
      btn.addEventListener("click", () => { commDept = btn.dataset.commDept; refreshCommissionSection(); });
    });
    document.querySelectorAll(".comm-tier input[data-f]").forEach(inp => {
      inp.addEventListener("change", () => {
        const row = inp.closest(".comm-tier");
        const i = Number(row.dataset.i);
        const f = inp.dataset.f;
        let v = parseFloat(inp.value);
        if (isNaN(v)) v = 0;
        if (f === "rate") v = v / 100;
        commDraft.tiers[i][f] = v;
      });
    });
    document.querySelectorAll("[data-setmax]").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.setmax);
        const cur = commDraft.tiers[i];
        cur.maxPrice = (cur.minPrice || 0) + 0.01;
        refreshCommissionSection();
      });
    });
    document.querySelectorAll("[data-deltier]").forEach(btn => {
      btn.addEventListener("click", () => {
        commDraft.tiers.splice(Number(btn.dataset.deltier), 1);
        refreshCommissionSection();
      });
    });
    document.querySelector("#pf-add-tier").addEventListener("click", () => {
      const tiers = commDraft.tiers;
      const top = tiers.length ? tiers[tiers.length - 1] : null;
      const min = top && top.maxPrice !== null ? top.maxPrice : (top ? top.minPrice + 100 : 0);
      tiers.push({ minPrice: min, maxPrice: null, rate: 0.02 });
      refreshCommissionSection();
    });
    document.querySelector("#pf-reset-table").addEventListener("click", () => {
      if (!confirm("Reset the " + deptTitle(commDept) + " table to the default GSA rates?")) return;
      commDraft = gsaDefaults();
      saveTable(true);
    });
    document.querySelector("#pf-save-table").addEventListener("click", () => saveTable(false));
  }

  async function saveTable(silent) {
    const status = document.querySelector("#pf-comm-status");
    // Validate: tiers sorted, non-overlapping, at least one "and up".
    const tiers = commDraft.tiers.slice().sort((a, b) => a.minPrice - b.minPrice);
    commDraft.tiers = tiers;
    const ood = clampPct(document.querySelector("#pf-ood").value);
    const sp = clampPct(document.querySelector("#pf-sp").value);
    commDraft.outOfDepartmentRate = ood / 100;
    commDraft.servicePlanRate = sp / 100;
    if (!tiers.length) { showError("Add at least one tier."); return; }
    const hasOpen = tiers.some(t => t.maxPrice === null);
    if (!hasOpen) {
      // App behavior: the top tier is open-ended ("and up").
      tiers[tiers.length - 1].maxPrice = null;
    }
    for (const t of tiers) {
      if (t.maxPrice !== null && t.maxPrice <= t.minPrice) {
        showError("A tier's max must be above its min (" + tierLabel(t) + ").");
        return;
      }
    }
    const tables = Object.assign({}, profile.commissionTables);
    tables[commDept] = commDraft;
    if (status) { status.textContent = "Saving…"; status.className = "form-status"; }
    try {
      await saveProfile({ commissionTables: tables }, true);
      if (status) { status.textContent = "Saved"; status.className = "form-status ok"; }
    } catch (e) {
      if (status) { status.textContent = "Save failed"; status.className = "form-status err"; }
    }
    refreshCommissionSection();
  }
  function clampPct(v) {
    let n = parseFloat(v);
    if (isNaN(n)) return 0;
    return Math.min(100, Math.max(0, n));
  }

  // ---- Render: Tax ----------------------------------------------------------------
  function taxHTML() {
    const state = profile.state || "";
    const pct = ((profile.incomeTaxEstimate !== undefined && profile.incomeTaxEstimate !== null)
      ? profile.incomeTaxEstimate * 100 : 10.5);
    const isCA = state === "CA";
    // CaliforniaTaxes.swift 2026 estimates.
    const SS = 6.2, MED = 1.45, SDI = 1.3;
    const example = 1000;
    const breakdown = isCA ? PayEngine.taxBreakdown(example, pct / 100) : null;
    return (
            '<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Tax settings</div><div class="sec-sub">Estimated take-home (California)</div></div></div>' +
        '<div class="field-row"><label>Home state</label>' +
          '<select id="pf-state">' +
            '<option value="">Choose…</option>' +
            US_STATES.map(s => '<option value="' + s[0] + '"' + (state === s[0] ? " selected" : "") + ">" +
              esc(s[1]) + "</option>").join("") +
          "</select>" +
          '<div class="hint">Take-home estimates are only shown for California (the state ' +
          "the app has payroll numbers for).</div></div>" +
        '<div class="field-row"><label>Income tax estimate</label>' +
          '<div class="pct-wrap"><input type="number" min="0" max="40" step="0.5" id="pf-taxrate" value="' +
          pct.toFixed(1) + '"><span>%</span></div>' +
          '<div class="hint">Combined federal + CA income-tax estimate (default 10.5%). Clamped 0–40%.</div></div>' +
        (isCA
          ? '<div class="section-title" style="margin-top:10px">California payroll, 2026</div>' +
            '<div class="list-item"><div class="li-main">Social Security</div><div class="li-val">' + SS.toFixed(2) + "%</div></div>" +
            '<div class="list-item"><div class="li-main">Medicare</div><div class="li-val">' + MED.toFixed(2) + "%</div></div>" +
            '<div class="list-item"><div class="li-main">CA SDI</div><div class="li-val">' + SDI.toFixed(2) + "%</div></div>" +
            '<div class="list-item"><div class="li-main">Income tax (your estimate)</div><div class="li-val">' + pct.toFixed(1) + "%</div></div>" +
            (breakdown
              ? '<div class="tax-example">On a <b>' + money(example) + '</b> paycheck: take-home about <b class="money">' +
                money(breakdown.net) + "</b> (" + money(breakdown.totalTaxes) + " in taxes)</div>"
              : "") +
            '<div class="hint" style="margin-top:8px">Estimate only — your actual withholding may differ.</div>'
          : '<div class="hint">Set your home state to California to see the CA payroll breakdown ' +
            "and estimated take-home.</div>") +
      "</div>"
    );
  }

  function bindTax() {
    document.querySelector("#pf-state").addEventListener("change", (e) => {
      saveProfile({ state: e.target.value }, true).then(() => {
        const panel = document.querySelector("#pf-tax-panel");
        if (panel) { panel.innerHTML = taxHTML(); bindTax(); }
      });
    });
    const rateInput = document.querySelector("#pf-taxrate");
    rateInput.addEventListener("change", () => {
      let v = parseFloat(rateInput.value);
      if (isNaN(v)) v = 10.5;
      // Mirrors CATaxEstimate.clampIncomeTax: 0–40%.
      v = Math.min(40, Math.max(0, v));
      rateInput.value = v.toFixed(1);
      saveProfile({ incomeTaxEstimate: v / 100 }, true).then(() => {
        const panel = document.querySelector("#pf-tax-panel");
        if (panel) { panel.innerHTML = taxHTML(); bindTax(); }
      });
    });
  }

  // ---- Render: Home layout --------------------------------------------------------------
  function layoutHTML() {
    const { visible, off } = widgetState();
    const hidden = HOME_WIDGETS.filter(w => off.has(w.id));
    const rowHTML = (w, idx, total) =>
      '<div class="widget-row" data-w="' + w.id + '">' +
        '<span class="widget-grip">' + I("grip", { size: 16 }) + '</span>' +
        '<div class="li-main">' + esc(w.title) + '<div class="li-sub">' + esc(w.subtitle) + "</div></div>" +
        (idx > 0 ? '<button class="icon-btn" data-wup="' + idx + '" title="Move up" aria-label="Move up">' + I("chevron-up", { size: 16 }) + '</button>' : '<span class="icon-btn ph"></span>') +
        (idx < total - 1 ? '<button class="icon-btn" data-wdown="' + idx + '" title="Move down" aria-label="Move down">' + I("chevron-down", { size: 16 }) + '</button>' : '<span class="icon-btn ph"></span>') +
        '<button class="icon-btn" data-whide="' + w.id + '" title="Hide" aria-label="Hide">' + I("eye-off", { size: 16 }) + '</button>' +
      "</div>";
    return (
      '<div class="panel"><div class="sec-head"><div class="grow"><div class="sec-title">Home layout</div><div class="sec-sub">Synced with the phone\'s Home layout</div></div></div>' +
        '<div class="li-sub" style="margin-bottom:8px">Reorder and hide widgets on your Home page. ' +
        "The greeting, payday recap, and your photo stay fixed.</div>" +
        visible.map((id, i) => {
          const w = HOME_WIDGETS.find(x => x.id === id);
          return rowHTML(w, i, visible.length);
        }).join("") +
        (hidden.length
          ? '<div class="section-title" style="margin-top:10px">Hidden</div>' +
            hidden.map(w =>
              '<div class="widget-row dimmed"><div class="li-main">' + esc(w.title) + "</div>" +
              '<button class="btn ghost sm" data-wshow="' + w.id + '">Show</button></div>'
            ).join("")
          : "") +
        '<div class="btn-row"><button class="btn ghost sm" id="pf-layout-reset">Reset to default</button></div>' +
      "</div>"
    );
  }

  function bindLayout() {
    const { visible, off } = widgetState();
    async function persist(newVisible, newOff) {
      await saveProfile({
        homeWidgetOrder: newVisible,
        homeWidgetsOff: Array.from(newOff),
      }, true);
      const panel = document.querySelector("#pf-layout-panel");
      if (panel) { panel.outerHTML = '<div id="pf-layout-panel">' + layoutHTML() + "</div>"; bindLayout(); }
    }
    document.querySelectorAll("[data-wup]").forEach(b => b.addEventListener("click", () => {
      const i = Number(b.dataset.wup);
      if (i <= 0) return;
      const v = visible.slice();
      [v[i - 1], v[i]] = [v[i], v[i - 1]];
      persist(v, off);
    }));
    document.querySelectorAll("[data-wdown]").forEach(b => b.addEventListener("click", () => {
      const i = Number(b.dataset.wdown);
      const v = visible.slice();
      if (i >= v.length - 1) return;
      [v[i + 1], v[i]] = [v[i], v[i + 1]];
      persist(v, off);
    }));
    document.querySelectorAll("[data-whide]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.whide;
      const newOff = new Set(off); newOff.add(id);
      persist(visible.filter(x => x !== id), newOff);
    }));
    document.querySelectorAll("[data-wshow]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.wshow;
      const newOff = new Set(off); newOff.delete(id);
      const v = visible.slice(); v.push(id);
      persist(v, newOff);
    }));
    document.querySelector("#pf-layout-reset").addEventListener("click", () => {
      persist(DEFAULT_WIDGET_ORDER.slice(), new Set());
    });
  }


  return { open, renderPay, renderLayout };
})();
