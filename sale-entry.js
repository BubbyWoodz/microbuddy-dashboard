"use strict";
/* ============ sale-entry.js — log / edit a sale (manual or pasted report) ============
 * SaleEntry.open({ dayKey, mode, ticketIndex, lineIndex })
 *   mode "manual" (default): one line. With no ticketIndex it starts a NEW
 *     ticket (like tapping "+ Add ticket" on the phone); "Add to last ticket"
 *     appends to the day's latest ticket instead.
 *   ticketIndex + lineIndex >= 0: edit that line (updateLine / deleteLine).
 *   ticketIndex + lineIndex -1: add a line to that ticket.
 *   mode "paste": Sales Lookup text -> SalesTextParser -> pasteSalesReport op
 *     (replaces the day's previously pasted tickets, exactly like the phone).
 * Every write goes through SyncEngine.queueWrite, then fires mb:data-changed.
 */
/* ============ SALES TEXT PARSER (port of iOS SalesTextParser.swift) ============ */
// Parses text copied from the Micro Center Sales Lookup screen.
// Structured row: `101-PO-14573672 Sale 1 068320 Keychron V1 ULTR BK 1 $99.99 $99.99`
// Returns/exchanges use negative qty and parenthesized prices.
const SalesTextParser = (() => {
  const REPORT_PARSE_VERSION = 1;

  const ROW_RE = /^\s*(?<txn>\d{2,4}-[A-Za-z]{2}-\d{4,})\s+(?<saleType>Sale|Return|Exchange)\s+(?<line>\d{1,3})\s+(?<sku>[0-9A-Za-z]{3,})\s+(?<description>.+?)\s+(?<qty>-?\d{1,4})\s+\(?\$?(?<unit>[\d,]+\.\d{2})\)?\s+\(?\$?(?<total>[\d,]+\.\d{2})\)?\s*$/i;
  const PLAN_SUMMARY_RE = /^\s*Service\s+Plans?\s+Sold\s+(?<count>\d{1,4})\s+\$?(?<amount>[\d,]+\.\d{2})/i;
  const REPORT_DATE_RE = /Sales\s+Lookup\s*[–—:\-]*\s*(?<date>\d{1,2}\/\d{1,2}\/\d{2,4})/i;

  const BRANDS = ["Acer","Alienware","AMD","Anker","Apple","Arduino","ASUS","Beats","Bose","Brother","Canon","Casio","CLX","Cooler Master","Corsair","Crucial","CyberPower","Couchmaster","Dell","DJI","Dyson","Elegoo","Epson","Flipper","Fractal","Fujifilm","Garmin","Gigabyte","GoPro","Google","Hisense","HP","HTC","HyperDrive","HyperX","iBuyPower","Intel","iRobot","JBL","Keychron","Kingston","Kodak","Lian Li","LILYGO","Lenovo","Lexar","LG","Logitech","MacBook","Marshall","Microsoft","MSI","Netgear","Nintendo","Nikon","Noctua","NZXT","Panasonic","Pebble","Philips","Pixel","Pokemon","PowerSpec","Predator","Raspberry Pi","Razer","Roku","ROG","Samsung","SanDisk","Scimitar","Seagate","Shark","Skullcandy","Sonos","Sony","Soundcore","SteelSeries","Surface","Targus","TCL","Thermaltake","Toshiba","TP-Link","TTGO","UniFi","Ubiquiti","Utilitech","Vizio","WD","Western Digital","Xbox","Yubikey"];
  const brandRe = new RegExp("\\b(" + BRANDS.map(b => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");

  const PLAN_PHRASES = ["protection plan","service plan","care plan","coverage plan","replacement plan","maintenance plan","support plan","accident plan","year plan","yr plan","priority care"];
  const WEAK_PLAN_HINTS = ["warranty","protection","membership","insider","geek squad"];
  const NOISE = ["total","subtotal","tax","tender","change due","balance due","payment","cash","credit card","debit","visa","mastercard","amex","american express","gift card","thank you","customer copy","cashier","register","store #","store:","invoice","receipt","sold by","salesperson","associate","phone:","address","date:","time:","order #","ticket #","member #","rewards","purchase order","tran #","reg #"];

  function moneyValue(raw) { return parseFloat(String(raw).replace(/[^0-9.]/g, "")) || 0; }
  function isServicePlan(lowered) { return PLAN_PHRASES.some(p => lowered.includes(p)); }
  function planTier(line) {
    const lowered = (line.product || "").toLowerCase();
    if (isServicePlan(lowered)) return 0;
    if (WEAK_PLAN_HINTS.some(h => lowered.includes(h))) return 1;
    return 2;
  }
  function detectBrand(text) { const m = String(text || "").match(brandRe); return m ? m[1] : ""; }

  function structuredRows(text) {
    const results = [];
    for (const rawLine of String(text || "").split("\n")) {
      const line = rawLine.trim();
      const m = line.match(ROW_RE);
      if (!m || !m.groups) continue;
      const g = m.groups;
      const description = (g.description || "").trim();
      if (!description) continue;
      const rawQty = parseInt(g.qty, 10) || 1;
      let unit = moneyValue(g.unit);
      const total = moneyValue(g.total);
      if (unit === 0 && total > 0) unit = total / Math.max(1, Math.abs(rawQty));
      if (unit <= 0) continue;
      const saleType = (g.saleType || "").toLowerCase();
      const isReturn = rawQty < 0;
      const isExchange = saleType === "exchange";
      const lowered = description.toLowerCase();
      results.push({
        product: description, brand: detectBrand(description),
        price: Math.round(unit * 100) / 100,
        quantity: Math.max(1, Math.abs(rawQty)),
        kind: isServicePlan(lowered) ? "servicePlan" : "inDepartment",
        isReturn, transactionID: g.txn, sku: g.sku, isExchange,
      });
    }
    return results;
  }

  function reportDate(text) {
    const m = String(text || "").match(REPORT_DATE_RE);
    if (!m || !m.groups) return null;
    const parts = m.groups.date.split("/").map(Number);
    if (parts.length < 3) return null;
    let [mo, da, yr] = parts;
    if (yr < 100) yr += 2000;
    const d = new Date(yr, mo - 1, da);
    return isNaN(d.getTime()) ? null : d;
  }

  function planSummaryCount(text) {
    for (const line of String(text || "").split("\n")) {
      const m = line.match(PLAN_SUMMARY_RE);
      if (m && m.groups) return parseInt(m.groups.count, 10);
    }
    return null;
  }

  function reconcilePlans(lines, reportedCount) {
    if (!(reportedCount > 0)) {
      lines.forEach(l => { if (l.kind === "servicePlan") l.kind = "inDepartment"; });
      return;
    }
    const ranked = lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.isReturn)
      .sort((a, b) => {
        const ta = planTier(a.l), tb = planTier(b.l);
        if (ta !== tb) return ta - tb;
        return (b.l.price * b.l.quantity) - (a.l.price * a.l.quantity);
      });
    let remaining = reportedCount;
    const planIdx = new Set();
    for (const { l, i } of ranked) {
      if (remaining <= 0) break;
      planIdx.add(i); remaining -= l.quantity;
    }
    lines.forEach((l, i) => { l.kind = planIdx.has(i) ? "servicePlan" : "inDepartment"; });
  }

  function legacyParse(text) {
    const results = [];
    const priceRe = /(?:\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)|(?:\d{1,6}(?:,\d{3})*\.\d{2})/g;
    for (const rawLine of String(text || "").split("\n")) {
      const line = rawLine.trim();
      if (line.length < 4) continue;
      const prices = (line.match(priceRe) || []).map(moneyValue).filter(v => v > 0);
      if (!prices.length) continue;
      const lowered = line.toLowerCase();
      if (NOISE.some(k => lowered.includes(k))) continue;
      if (/^[\d\s.,$-]+$/.test(line)) continue;
      let qty = 1;
      const qm = line.match(/(?:^|\s)(\d{1,3})\s*[xX×]\s*|\bqty\.?\s*[:#]?\s*(\d{1,3})\b|[xX×]\s*(\d{1,3})(?![\d.])/i);
      if (qm) qty = parseInt(qm[1] || qm[2] || qm[3], 10) || 1;
      let unit = prices[0];
      if (prices.length >= 2 && qty > 1) {
        if (Math.abs(prices[1] - prices[0] * qty) < 0.02) unit = prices[0];
        else if (Math.abs(prices[0] - prices[1] * qty) < 0.02) unit = prices[1];
      }
      const remainder = line.replace(priceRe, " ")
        .replace(/\bqty\.?\s*[:#]?\s*\d{1,3}\b/gi, " ")
        .replace(/(?:^|\s)\d{1,3}\s*[xX×]\s*/g, " ").replace(/[xX×]\s*\d{1,3}(?![\d.])/g, " ")
        .replace(/\b\d{5,}\b/g, " ").replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
        .split(/[|\u00B7\u2022]/).join(" ").replace(/ - /g, " ")
        .split(/\s+/).filter(Boolean).join(" ").replace(/^[\s-]+|[\s-]+$/g, "");
      if ((remainder.match(/[A-Za-z]/g) || []).length < 2) continue;
      const isReturn = /return|refund|\brtn\b/i.test(lowered) || line.startsWith("-");
      results.push({
        product: remainder, brand: detectBrand(line),
        price: Math.round(unit * 100) / 100, quantity: Math.max(1, qty),
        kind: isServicePlan(lowered) ? "servicePlan" : "inDepartment",
        isReturn, transactionID: null,
        sku: (line.match(/\b\d{5,}\b/) || [])[0] || null, isExchange: false,
      });
    }
    return results;
  }

  function parse(text) {
    const result = { lines: [], customerCount: 0, detectedDate: null, reportedPlanCount: null };
    result.detectedDate = reportDate(text);
    const rows = structuredRows(text);
    if (rows.length) {
      result.lines = rows;
      result.customerCount = new Set(rows.map(r => r.transactionID).filter(Boolean)).size;
    } else {
      result.lines = legacyParse(text);
    }
    result.reportedPlanCount = planSummaryCount(text);
    if (result.reportedPlanCount != null) reconcilePlans(result.lines, result.reportedPlanCount);
    return result;
  }

  return { parse, REPORT_PARSE_VERSION };
})();

// PastedSaleApplier port: groups parsed lines by transaction into tickets,
// replacing any previously pasted tickets for the day (no doubles).
const PastedSaleApplier = {
  TXN_RE: /^\d{2,4}-[A-Za-z]{2}-\d{4,}$/,
  apply(parsedLines, day, rawReport, parseVersion, now) {
    now = now || new Date();
    day = day || { tickets: [] };
    // Remove previously pasted tickets.
    day.tickets = (day.tickets || []).filter(t =>
      t.customerNote !== "Pasted from the system" && !this.TXN_RE.test(t.customerNote || ""));
    // Group by transaction: one transaction = one customer = one ticket.
    const order = [], buckets = {};
    for (const line of parsedLines) {
      const key = line.transactionID || "";
      if (!(key in buckets)) { order.push(key); buckets[key] = []; }
      buckets[key].push(line);
    }
    const isToday = day.id === PayEngine.dayKey(now);
    order.forEach((key, index) => {
      const group = buckets[key];
      const note = key === "" ? "Pasted from the system" : key;
      const lines = group.map(l => ({
        id: "line-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        product: l.product, brand: l.brand || "",
        unitPrice: l.price, quantity: l.quantity,
        kind: l.kind || "inDepartment",
        isReturn: !!l.isReturn, sku: l.sku || null, isExchange: !!l.isExchange,
      }));
      let time;
      if (isToday) {
        time = new Date(now.getTime() - index * 60000).toISOString();
      } else {
        const d = new Date(day.id + "T12:00:00");
        time = new Date(d.getTime() + index * 60000).toISOString();
      }
      day.tickets.push({
        id: "ticket-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        time, customerNote: note, lines,
      });
    });
    day.rawReport = rawReport;
    day.reportParseVersion = parseVersion;
    return day;
  }
};

function parseReceiptText(text) {
  return SalesTextParser.parse(text).lines;
}

const SaleEntry = (() => {
  const I = (n, o) => (typeof Icon === "function" ? Icon(n, o) : "");
  const e = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const KINDS = [
    { id: "inDepartment", t: "In department" },
    { id: "outOfDepartment", t: "Out of department" },
    { id: "servicePlan", t: "Service plan" },
  ];
  let el = null, st = null, parsed = null;

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function keyOf(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const $ = id => el.querySelector("#" + id);

  function ensure() {
    if (el) return el;
    el = document.createElement("div");
    el.id = "sale-modal";
    el.className = "hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML =
      '<div class="modal-card wide">' +
        '<h2 id="se-title">Log a sale</h2>' +
        '<div class="segmented" id="se-mode" style="margin-bottom:14px">' +
          '<button data-mode="manual" class="active">' + I("edit", { size: 14 }) + ' Manual</button>' +
          '<button data-mode="paste">' + I("clipboard", { size: 14 }) + ' Paste sales report</button>' +
        "</div>" +
        '<div class="field-row"><div class="field"><label>Day</label><input type="date" id="se-date"></div>' +
          '<div class="field" id="se-target-wrap"><label>Ticket</label><select id="se-target">' +
            '<option value="new">New ticket</option><option value="last">Add to the last ticket</option></select></div></div>' +
        '<div id="se-manual">' +
          '<div class="field"><label>Product</label><input type="text" id="se-product" placeholder="Product name" autocomplete="off"></div>' +
          '<div class="field-row"><div class="field"><label>Brand</label><input type="text" id="se-brand" placeholder="Brand" autocomplete="off"></div>' +
            '<div class="field"><label>SKU</label><input type="text" id="se-sku" placeholder="Optional" autocomplete="off"></div></div>' +
          '<div class="field-row"><div class="field"><label>Unit price ($)</label><input type="number" id="se-price" placeholder="0.00" step="0.01" min="0"></div>' +
            '<div class="field"><label>Quantity</label><input type="number" id="se-qty" value="1" min="1" step="1"></div></div>' +
          '<div class="field-row"><div class="field"><label>Kind</label><select id="se-kind">' +
            KINDS.map(k => '<option value="' + k.id + '">' + k.t + "</option>").join("") + "</select></div>" +
            '<div class="field" style="justify-content:flex-end;gap:10px">' +
              '<label class="check"><input type="checkbox" id="se-return"> Return</label>' +
              '<label class="check"><input type="checkbox" id="se-exchange"> Exchange</label></div></div>' +
          '<div class="field"><label>Customer note</label><input type="text" id="se-note" placeholder="Optional — saved on the ticket" autocomplete="off"></div>' +
        "</div>" +
        '<div id="se-paste" class="hidden">' +
          '<div class="field"><label>Paste the Sales Lookup page</label>' +
            '<textarea id="se-text" rows="8" placeholder="Select all on the Sales Lookup screen, copy, and paste it here"></textarea>' +
            '<div class="hint">Pasting replaces the tickets from this day\'s previous paste — hand-entered tickets stay.</div></div>' +
          '<button class="btn ghost" id="se-scan">' + I("search", { size: 14 }) + " Scan text</button>" +
          '<div id="se-parsed"></div>' +
        "</div>" +
        '<div class="form-error" id="se-error"></div>' +
        '<div class="modal-actions">' +
          '<button class="btn danger hidden" id="se-delete" style="margin-right:auto">' + I("trash", { size: 14 }) + " Delete line</button>" +
          '<button class="btn ghost" id="se-cancel">Cancel</button>' +
          '<button class="btn primary" id="se-save">' + I("check", { size: 14 }) + " Save</button>" +
        "</div>" +
      "</div>";
    document.body.appendChild(el);
    el.addEventListener("click", ev => { if (ev.target === el) close(); });
    document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !el.classList.contains("hidden")) close(); });
    el.querySelectorAll("#se-mode button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
    $("se-cancel").addEventListener("click", close);
    $("se-scan").addEventListener("click", scan);
    $("se-save").addEventListener("click", save);
    $("se-delete").addEventListener("click", del);
    return el;
  }

  function setMode(m) {
    st.mode = m;
    el.querySelectorAll("#se-mode button").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
    $("se-manual").classList.toggle("hidden", m !== "manual");
    $("se-paste").classList.toggle("hidden", m !== "paste");
    $("se-target-wrap").classList.toggle("hidden", m !== "manual" || st.ticketIndex != null);
    $("se-error").textContent = "";
    $("se-save").innerHTML = I("check", { size: 14 }) + (m === "paste" ? " Import sales" : " Save");
  }

  async function open(opts) {
    opts = opts || {};
    ensure();
    st = {
      dayKey: opts.dayKey || todayKey(),
      mode: opts.mode === "paste" ? "paste" : "manual",
      ticketIndex: Number.isInteger(opts.ticketIndex) ? opts.ticketIndex : null,
      lineIndex: Number.isInteger(opts.lineIndex) ? opts.lineIndex : -1,
    };
    parsed = null;
    const editing = st.ticketIndex != null && st.lineIndex >= 0;
    $("se-title").textContent = editing ? "Edit sale" : (st.ticketIndex != null ? "Add a line" : "Log a sale");
    $("se-mode").classList.toggle("hidden", st.ticketIndex != null);
    $("se-delete").classList.toggle("hidden", !editing);
    $("se-date").value = st.dayKey;
    $("se-date").disabled = st.ticketIndex != null;
    ["se-product", "se-brand", "se-sku", "se-price", "se-note", "se-text"].forEach(id => { $(id).value = ""; });
    $("se-qty").value = "1"; $("se-kind").value = "inDepartment";
    $("se-return").checked = false; $("se-exchange").checked = false;
    $("se-target").value = "new";
    $("se-parsed").innerHTML = "";
    if (st.ticketIndex != null) {
      const backup = await SyncEngine.getLocalBackup().catch(() => null);
      const day = backup && backup.data && (backup.data.days || []).find(d => d.id === st.dayKey);
      const t = day && day.tickets && day.tickets[st.ticketIndex];
      if (t) {
        $("se-note").value = t.customerNote || "";
        const l = editing && t.lines && t.lines[st.lineIndex];
        if (l) {
          $("se-product").value = l.product || ""; $("se-brand").value = l.brand || ""; $("se-sku").value = l.sku || "";
          $("se-price").value = Number(l.unitPrice || 0).toFixed(2); $("se-qty").value = String(l.quantity || 1);
          $("se-kind").value = l.kind || "inDepartment";
          $("se-return").checked = !!l.isReturn; $("se-exchange").checked = !!l.isExchange;
        }
      }
      $("se-note").closest(".field").classList.add("hidden");
    } else {
      $("se-note").closest(".field").classList.remove("hidden");
    }
    setMode(st.mode);
    el.classList.remove("hidden");
    setTimeout(() => (st.mode === "paste" ? $("se-text") : $("se-product")).focus(), 40);
  }

  function close() { if (el) el.classList.add("hidden"); }

  function scan() {
    const text = $("se-text").value;
    const box = $("se-parsed");
    parsed = SalesTextParser.parse(text);
    if (!parsed.lines.length) {
      box.innerHTML = '<div class="form-error">No line items found. Copy the text straight from the Sales Lookup screen and paste it here.</div>';
      return;
    }
    const order = [], buckets = {};
    parsed.lines.forEach((l, i) => {
      const k = l.transactionID || "";
      if (!(k in buckets)) { order.push(k); buckets[k] = []; }
      buckets[k].push(Object.assign({}, l, { _i: i }));
    });
    let h = '<div class="section-title" style="margin-top:12px">Found ' + parsed.lines.length + " item" + (parsed.lines.length === 1 ? "" : "s") +
      (parsed.customerCount ? " across " + parsed.customerCount + " customer" + (parsed.customerCount === 1 ? "" : "s") : "") + " — uncheck any to skip</div>";
    if (parsed.detectedDate) {
      h += '<div class="parsed-date">Report date <b>' + e(keyOf(parsed.detectedDate)) + '</b> <button class="btn ghost sm" id="se-use-date">Use this date</button></div>';
    }
    h += '<div class="parsed-list">';
    order.forEach(k => {
      if (k) h += '<div class="parsed-txn">' + I("receipt", { size: 13 }) + " " + e(k) + "</div>";
      buckets[k].forEach(l => {
        const flags = (l.isReturn ? ' <span class="flag-return">RETURN</span>' : "") +
          (l.isExchange ? ' <span class="flag-exchange">EXCHANGE</span>' : "") +
          (l.kind === "servicePlan" ? ' <span class="flag-plan">PLAN</span>' : "");
        h += '<label class="parsed-row"><input type="checkbox" data-i="' + l._i + '" checked> <strong>' + e(l.product) + "</strong>" + flags +
          '<span class="parsed-meta">' + l.quantity + " × $" + Number(l.price).toFixed(2) + (l.sku ? " · " + e(l.sku) : "") + (l.brand ? " · " + e(l.brand) : "") + "</span></label>";
      });
    });
    box.innerHTML = h + "</div>";
    const ud = box.querySelector("#se-use-date");
    if (ud) ud.addEventListener("click", () => { $("se-date").value = keyOf(parsed.detectedDate); });
  }

  function done(dayKey, msg) {
    close();
    if (typeof window.toast === "function") window.toast(msg);
    try { window.dispatchEvent(new CustomEvent("mb:data-changed", { detail: { local: true, dayKey } })); } catch (err) {}
    try { if (typeof DayDetailUI !== "undefined") DayDetailUI.refresh(); } catch (err) {}
  }

  async function save() {
    const err = $("se-error");
    err.textContent = "";
    const dayId = $("se-date").value;
    if (!dayId) { err.textContent = "Pick a day."; return; }
    const btn = $("se-save");
    btn.disabled = true;
    try {
      if (st.mode === "paste") {
        if (!parsed) scan();
        const kept = [...el.querySelectorAll("#se-parsed input[type=checkbox]:checked")].map(c => parseInt(c.dataset.i, 10));
        if (!parsed || !kept.length) { err.textContent = "Scan the pasted text and keep at least one item."; return; }
        const keep = new Set(kept);
        await SyncEngine.queueWrite({
          type: "pasteSalesReport", dayId,
          lines: parsed.lines.filter((_, i) => keep.has(i)),
          rawReport: $("se-text").value,
          parseVersion: SalesTextParser.REPORT_PARSE_VERSION,
        });
        done(dayId, "Imported " + kept.length + " item" + (kept.length === 1 ? "" : "s"));
        return;
      }
      const product = $("se-product").value.trim();
      const price = parseFloat($("se-price").value);
      if (!product) { err.textContent = "Enter a product name."; return; }
      if (!(price >= 0)) { err.textContent = "Enter a unit price."; return; }
      const line = {
        product, brand: $("se-brand").value.trim(), sku: $("se-sku").value.trim(),
        unitPrice: Math.round(price * 100) / 100,
        quantity: Math.max(1, parseInt($("se-qty").value, 10) || 1),
        kind: $("se-kind").value, isReturn: $("se-return").checked, isExchange: $("se-exchange").checked,
      };
      if (st.ticketIndex != null && st.lineIndex >= 0) {
        await SyncEngine.queueWrite({ type: "updateLine", dayId, ticketIndex: st.ticketIndex, lineIndex: st.lineIndex, line });
        done(dayId, "Sale updated");
      } else if (st.ticketIndex != null) {
        await SyncEngine.queueWrite({ type: "addLine", dayId, ticketIndex: st.ticketIndex, line });
        done(dayId, "Line added");
      } else {
        const backup = await SyncEngine.getLocalBackup().catch(() => null);
        const day = backup && backup.data && (backup.data.days || []).find(d => d.id === dayId);
        if ($("se-target").value === "last" && day && day.tickets && day.tickets.length) {
          await SyncEngine.queueWrite({ type: "addLine", dayId, ticketIndex: day.tickets.length - 1, line });
        } else {
          await SyncEngine.queueWrite({ type: "addTicket", dayId, ticket: { customerNote: $("se-note").value.trim(), lines: [line] } });
        }
        done(dayId, "Sale logged");
      }
    } catch (ex) {
      err.textContent = (ex && ex.message) || "Couldn't save the sale.";
    } finally { btn.disabled = false; }
  }

  async function del() {
    if (!confirm("Delete this sale line?")) return;
    try {
      await SyncEngine.queueWrite({ type: "deleteLine", dayId: st.dayKey, ticketIndex: st.ticketIndex, lineIndex: st.lineIndex });
      done(st.dayKey, "Line deleted");
    } catch (ex) { $("se-error").textContent = (ex && ex.message) || "Couldn't delete."; }
  }

  return { open, close };
})();
