"use strict";
/* ============ microcharm.js — MicroCharm tab: full port of the iOS MicroCharm feature ============

 * Matches the app's MicroCharm models exactly (MicroCharm.swift):
 *   MicroCharmLook: { bodyId, earsId, antennaId, armsId, cheeksId, hatId,
 *     shadesId, bowId, eyesId, mouthId, noseId, accentHex, updatedAt }
 *   MicroCharmReactions: { cphStepsEnabled, salesStepsEnabled, daySalesTarget,
 *     voiceVibe ("bro"|"bestFriend"|"soft"|"coach"|"deadpan"), vibeNote, updatedAt }
 *   CharmCheer: { id, dayKey, kind ("cphStep"|"salesStep"|"target"|"test"),
 *     message, createdAt }
 *
 * App behaviors ported (MicroCharmEngine.swift):
 *  - checkMicroCharmMilestones: CPH whole steps (1.0, 2.0, …), sales $1K steps,
 *    one-time day sales target; each threshold fires at most once per day.
 *  - Enabling triggers mid-shift pre-marks already-crossed thresholds (no backlog).
 *  - Last 10 cheers kept on the profile; overlay queue capped at 3.
 *  - Test cheer: "2.0 CPH" sample in the current vibe, doesn't touch real numbers
 *    (but IS kept in the cheers list, like the app).
 *  - CharmVoice lines are verbatim ports — same text, same random pick from 2.
 *  - Stats packet preview: sold today, take-home (CA estimate when CA), CPH,
 *    items sold, pure return lines.
 *  - Connection card is locked until hardware exists ("Pair" disabled).
 *
 * Creator (MicroCharmCreatorView.swift): 12 categories, live preview, Save /
 * Reset to default. The robot is drawn as inline SVG in the app's 120×140
 * design space — every rect/path from CharmRobotView.swift mapped 1:1
 * (body variants, arms, antenna poles + tips + nub, round/bunny ears,
 * shaded head + gloss, 4 eye styles, nose, 4 mouths, cheek dots, 2 sunglass
 * styles, cap/beanie, bow).
 *
 * Sync: everything lives on data.profile (microCharmLook / microCharmReactions /
 * microCharmCheers) and rides the existing updateProfile op — NO new op types.
 * The app's decoders default every missing key, and legacy Head-top/Sides keys
 * migrate on the app side, so dashboard writes stay compatible.
 *
 * Milestone checks: call MicroCharmUI.checkMilestones() after data loads and
 * after any sale write (the parent should hook it into the sales write path).
 * Per-day fired thresholds are tracked in localStorage (mc_fired_v1) so the
 * dashboard never double-fires within a day.
 *
 * Depends on globals from dashboard.html: $, esc?, todayISO, SyncEngine,
 * PayEngine. (Local esc is defined below so the module is self-contained.)
 */

const MicroCharmUI = (() => {
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const esc = s => String(s == null ? "" : s)
    .replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const isoNow = () => new Date().toISOString();
  const todayKey = () => (typeof todayISO === "function")
    ? todayISO()
    : (() => { const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" +
               String(d.getDate()).padStart(2,"0"); })();
  const uid = () => "ch" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const money = n => "$" + Number(n || 0).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ---------------------------------------------------------------------------
  // Part catalogs — verbatim port of CharmParts
  // ---------------------------------------------------------------------------
  const PARTS = {
    bodies: [
      { id: "body_classic", title: "Classic" },
      { id: "body_compact", title: "Compact" },
      { id: "body_slim",    title: "Slim" },
    ],
    ears: [
      { id: "ears_none",  title: "None" },
      { id: "ears_round", title: "Round ears" },
      { id: "ears_bunny", title: "Bunny ears" },
    ],
    antennas: [
      { id: "antenna_none",   title: "None" },
      { id: "antenna_center", title: "Antenna" },
      { id: "antenna_left",   title: "Tilted left" },
      { id: "antenna_right",  title: "Tilted right" },
      { id: "antenna_nub",    title: "Single nub" },
    ],
    arms: [
      { id: "arms_none", title: "None" },
      { id: "arms_nubs", title: "Small nubs" },
    ],
    cheeks: [
      { id: "cheeks_none", title: "None" },
      { id: "cheeks_dots", title: "Cheek dots" },
    ],
    hats: [
      { id: "hat_none",   title: "None" },
      { id: "hat_cap",    title: "Cap" },
      { id: "hat_beanie", title: "Beanie" },
    ],
    shades: [
      { id: "shades_none",    title: "None" },
      { id: "shades_classic", title: "Classic" },
      { id: "shades_round",   title: "Round" },
    ],
    bows: [
      { id: "bow_none", title: "None" },
      { id: "bow_bow",  title: "Bow" },
    ],
    eyes: [
      { id: "eyes_round", title: "Round eyes" },
      { id: "eyes_happy", title: "Happy eyes" },
      { id: "eyes_wide",  title: "Wide eyes" },
      { id: "eyes_calm",  title: "Calm eyes" },
    ],
    mouths: [
      { id: "mouth_neutral", title: "Neutral" },
      { id: "mouth_smile",   title: "Soft smile" },
      { id: "mouth_open",    title: "Tiny open" },
      { id: "mouth_grin",    title: "Big grin" },
    ],
    noses: [
      { id: "nose_none",  title: "None" },
      { id: "nose_dot",   title: "Dot nose" },
      { id: "nose_round", title: "Round nose" },
    ],
    accents: [
      { id: "accent_sky",    hex: "#2965C8", title: "Sky" },
      { id: "accent_navy",   hex: "#000080", title: "Navy" },
      { id: "accent_teal",   hex: "#008080", title: "Teal" },
      { id: "accent_mint",   hex: "#058C61", title: "Mint" },
      { id: "accent_amber",  hex: "#C77800", title: "Amber" },
      { id: "accent_red",    hex: "#CA2429", title: "Red" },
      { id: "accent_purple", hex: "#6B4FBB", title: "Purple" },
      { id: "accent_pink",   hex: "#E85A8B", title: "Pink" },
    ],
  };
  const CATEGORIES = [
    { key: "body",    title: "Body",    lookKey: "bodyId",    catalog: "bodies" },
    { key: "ears",    title: "Ears",    lookKey: "earsId",    catalog: "ears" },
    { key: "antenna", title: "Antenna", lookKey: "antennaId", catalog: "antennas" },
    { key: "hat",     title: "Hat",     lookKey: "hatId",     catalog: "hats" },
    { key: "shades",  title: "Shades",  lookKey: "shadesId",  catalog: "shades" },
    { key: "bow",     title: "Bow",     lookKey: "bowId",     catalog: "bows" },
    { key: "arms",    title: "Arms",    lookKey: "armsId",    catalog: "arms" },
    { key: "cheeks",  title: "Cheeks",  lookKey: "cheeksId",  catalog: "cheeks" },
    { key: "eyes",    title: "Eyes",    lookKey: "eyesId",    catalog: "eyes" },
    { key: "mouth",   title: "Mouth",   lookKey: "mouthId",   catalog: "mouths" },
    { key: "nose",    title: "Nose",    lookKey: "noseId",    catalog: "noses" },
    { key: "accent",  title: "Accent",  lookKey: "accentHex", catalog: "accents", isAccent: true },
  ];
  const STANDARD_LOOK = {
    bodyId: "body_classic", earsId: "ears_none", antennaId: "antenna_center",
    armsId: "arms_none", cheeksId: "cheeks_none", hatId: "hat_none",
    shadesId: "shades_none", bowId: "bow_none", eyesId: "eyes_round",
    mouthId: "mouth_smile", noseId: "nose_none", accentHex: "#2965C8",
  };
  const VIBES = [
    { id: "bro",        title: "Bro" },
    { id: "bestFriend", title: "Best friend" },
    { id: "soft",       title: "Soft" },
    { id: "coach",      title: "Coach" },
    { id: "deadpan",    title: "Deadpan" },
  ];

  function partTitle(id, catalog) {
    const o = (PARTS[catalog] || []).find(p => p.id === id);
    return o ? o.title : (PARTS[catalog][0] || {}).title || "";
  }
  function accentHexFor(id) {
    const a = PARTS.accents.find(a => a.id === id);
    return a ? a.hex : "#2965C8";
  }

  // ---------------------------------------------------------------------------
  // Summary text — port of MicroCharmLook.summaryText / MicroCharmReactions.summaryText
  // ---------------------------------------------------------------------------
  function lookSummary(look) {
    const parts = [];
    if (look.earsId && look.earsId !== "ears_none") parts.push(partTitle(look.earsId, "ears"));
    if (look.antennaId && look.antennaId !== "antenna_none") parts.push(partTitle(look.antennaId, "antennas"));
    parts.push(partTitle(look.eyesId || "eyes_round", "eyes"));
    parts.push(partTitle(look.mouthId || "mouth_smile", "mouths"));
    if (look.armsId && look.armsId !== "arms_none") parts.push(partTitle(look.armsId, "arms"));
    if (look.cheeksId && look.cheeksId !== "cheeks_none") parts.push(partTitle(look.cheeksId, "cheeks"));
    if (look.hatId && look.hatId !== "hat_none") parts.push(partTitle(look.hatId, "hats"));
    if (look.shadesId && look.shadesId !== "shades_none") parts.push("Sunglasses");
    if (look.bowId && look.bowId !== "bow_none") parts.push("Bow");
    return parts.join(" · ");
  }
  function reactionsSummary(r) {
    const parts = [];
    if (r.cphStepsEnabled) parts.push("CPH steps");
    if (r.salesStepsEnabled) parts.push("Every $1K");
    if (r.daySalesTarget && r.daySalesTarget > 0) parts.push("Target $" + Math.round(r.daySalesTarget));
    parts.push((VIBES.find(v => v.id === r.voiceVibe) || {}).title || "Best friend");
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------------------
  // Robot SVG — port of CharmRobotView.swift (design space 120 × 140)
  // ---------------------------------------------------------------------------
  const INK = "#213040", SHELL = "#EBF0F5", SHADE = "#C7D1E0", SCREEN = "#17212E";

  function rr(x, y, w, h, r, fill, stroke, sw) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"` +
      (stroke ? ` stroke="${stroke}" stroke-width="${sw || 2}"` : "") + "/>";
  }
  function rect(x, y, w, h, fill, opacity) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"` +
      (opacity != null ? ` opacity="${opacity}"` : "") + "/>";
  }
  function line(x1, y1, x2, y2, w, color, cap) {
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" ` +
      `stroke-width="${w}" stroke-linecap="${cap || "square"}"/>`;
  }
  // Dither: sparse checker pattern, like the app's pixel-shading bands.
  const DITHER_DEF = `<pattern id="mcd" width="10.5" height="7" patternUnits="userSpaceOnUse">` +
    `<rect x="0" y="0" width="3.5" height="3.5" fill="${SHADE}"/>` +
    `<rect x="5.25" y="3.5" width="3.5" height="3.5" fill="${SHADE}"/></pattern>`;

  function robotSVG(look, opts) {
    const L = { ...STANDARD_LOOK, ...(look || {}) };
    const accent = /^#[0-9a-fA-F]{6}$/.test(L.accentHex || "") ? L.accentHex : "#2965C8";
    const hasHat = L.hatId !== "hat_none";
    const S = [];

    // ---- Arms (behind body) ----
    if (L.armsId === "arms_nubs") {
      const spread = L.bodyId === "body_compact" ? 38 : (L.bodyId === "body_slim" ? 26 : 34);
      for (const side of [-1, 1]) {
        const cx = 60 + side * spread;
        S.push(rr(cx - 6, 93, 12, 22, 3, SHADE, INK, 3));
      }
    }

    // ---- Body ----
    let bx, by, bw, bh;
    if (L.bodyId === "body_compact")      { bx = 24; by = 86; bw = 72; bh = 42; }
    else if (L.bodyId === "body_slim")   { bx = 38; by = 80; bw = 44; bh = 54; }
    else                                 { bx = 28; by = 80; bw = 64; bh = 52; }
    const bodyClip = `mcbody${uid().slice(2, 8)}`;
    S.push(`<clipPath id="${bodyClip}"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5"/></clipPath>`);
    S.push(rr(bx, by, bw, bh, 5, SHELL));
    S.push(`<g clip-path="url(#${bodyClip})">` +
      rect(bx + bw - 14, by, 14, bh, SHADE, 0.6) +
      rect(bx + bw - 10, by + 2, 10, bh - 4, "url(#mcd)") +
      rect(bx + 2, by + bh - 10, bw - 4, 10, SHADE, 0.6) +
      rect(bx + 2, by + bh - 8, bw - 4, 8, "url(#mcd)") +
      `</g>`);
    S.push(rr(bx, by, bw, bh, 5, "none", INK, 3));
    // Chest screen
    const sx = bx + bw / 2 - 13, sy = by + 12;
    S.push(rr(sx, sy, 26, 16, 2, SCREEN));
    S.push(rect(sx + 3, sy + 4, 20, 4, accent));
    S.push(rect(sx + 3, sy + 10, 14, 3, "#FFFFFF", 0.5));
    // Corner screws
    S.push(rect(bx + 6, by + 6, 4, 4, INK));
    S.push(rect(bx + bw - 10, by + 6, 4, 4, INK));

    // ---- Antenna ----
    const abY = hasHat ? 22 : 28;
    function antennaPole(fx, fy, tx, ty, tipx, tipy) {
      S.push(rr(fx - 5, fy - 2, 10, 6, 1.5, SHADE, INK, 2));
      S.push(line(fx, fy, tx, ty, 3.5, INK));
      S.push(rr(tipx - 5, tipy - 4.5, 10, 9, 2, accent, INK, 2.5));
    }
    if (L.antennaId === "antenna_center")      antennaPole(60, abY, 60, hasHat ? 8 : 12, 60, hasHat ? 6 : 9);
    else if (L.antennaId === "antenna_left")   antennaPole(54, abY, 42, hasHat ? 8 : 12, 40, hasHat ? 5 : 8);
    else if (L.antennaId === "antenna_right")  antennaPole(66, abY, 78, hasHat ? 8 : 12, 80, hasHat ? 5 : 8);
    else if (L.antennaId === "antenna_nub") {
      const ny = hasHat ? 6 : 14;
      S.push(rr(50, ny, 20, 14, 4, SHELL, INK, 3));
      S.push(rect(54, ny + 4, 12, 6, SHADE));
    }

    // ---- Ears ----
    if (L.earsId === "ears_round") {
      for (const x of [24, 88]) {
        S.push(rr(x, 38, 8, 18, 2, SHELL, INK, 3));
        S.push(rect(x + 2, 44, 4, 6, SHADE));
      }
    } else if (L.earsId === "ears_bunny") {
      const ebY = hasHat ? 22 : 30, etY = hasHat ? 8 : 10;
      for (const [bx2, tx] of [[48, 44], [72, 76]]) {
        S.push(line(bx2, ebY, tx, etY, 3.5, INK));
        S.push(rect(tx - 2.5, etY - 3, 5, 5, accent));
      }
    }

    // ---- Head ----
    const hx = 30, hy = 26, hw = 60, hh = 48;
    const headClip = `mchead${uid().slice(2, 8)}`;
    S.push(`<clipPath id="${headClip}"><rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="5"/></clipPath>`);
    S.push(rr(hx, hy, hw, hh, 5, SHELL));
    S.push(`<g clip-path="url(#${headClip})">` +
      rect(hx + hw - 18, hy, 18, hh, SHADE, 0.6) +
      rect(hx + hw - 14, hy + 2, 14, hh - 4, "url(#mcd)") +
      `</g>`);
    S.push(rr(hx, hy, hw, hh, 5, "none", INK, 3));
    S.push(rect(34, 30, 26, 6, "#FFFFFF", 0.35)); // gloss block

    // ---- Eyes ----
    if (L.eyesId === "eyes_happy") {
      S.push(`<path d="M 41 48 A 5 5 0 0 1 51 48" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="square"/>`);
      S.push(`<path d="M 69 48 A 5 5 0 0 1 79 48" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="square"/>`);
    } else if (L.eyesId === "eyes_wide") {
      for (const x of [40, 68]) {
        S.push(rr(x, 40, 12, 11, 2, "#FFFFFF", INK, 2.5));
        S.push(rect(x + 4, 44, 4, 4, INK));
      }
    } else if (L.eyesId === "eyes_calm") {
      S.push(line(41, 46, 51, 46, 3.5, INK));
      S.push(line(69, 46, 79, 46, 3.5, INK));
    } else { // eyes_round — blocky eyes with catchlight pixel
      for (const x of [41, 69]) {
        S.push(rr(x, 42, 10, 9, 2, INK));
        S.push(rect(x + 2, 44, 3, 3, "#FFFFFF"));
      }
    }

    // ---- Nose ----
    if (L.noseId === "nose_dot") {
      S.push(rr(57.5, 52.5, 5, 5, 1, accent));
    } else if (L.noseId === "nose_round") {
      S.push(`<rect x="56" y="51" width="8" height="8" rx="2" fill="${accent}" opacity="0.35" stroke="${accent}" stroke-width="1.5"/>`);
    }

    // ---- Mouth ----
    if (L.mouthId === "mouth_smile") {
      S.push(`<path d="M 52 58 A 8 8 0 0 0 68 58" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="square"/>`);
    } else if (L.mouthId === "mouth_open") {
      S.push(rr(55, 60, 10, 7, 2, INK));
    } else if (L.mouthId === "mouth_grin") {
      S.push(`<path d="M 49.2 57.9 A 11 11 0 0 0 70.8 57.9" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="square"/>`);
    } else { // mouth_neutral
      S.push(line(52, 63, 68, 63, 3.5, INK));
    }

    // ---- Cheeks ----
    if (L.cheeksId === "cheeks_dots") {
      S.push(rr(33, 51, 6, 6, 1, accent, null, null).replace("/>", ` opacity="0.55"/>`));
      S.push(rr(81, 51, 6, 6, 1, accent, null, null).replace("/>", ` opacity="0.55"/>`));
    }

    // ---- Sunglasses ----
    if (L.shadesId === "shades_classic") {
      for (const x of [36, 64]) S.push(rr(x, 40, 20, 13, 2, INK));
      S.push(line(56, 45, 64, 45, 2.5, INK));
      S.push(line(36, 45, 31, 44, 2.5, INK));
      S.push(line(84, 45, 89, 44, 2.5, INK));
    } else if (L.shadesId === "shades_round") {
      for (const cx of [46, 74]) S.push(`<circle cx="${cx}" cy="47" r="7" fill="${INK}"/>`);
      S.push(line(53, 47, 67, 47, 2.5, INK));
      S.push(line(39, 47, 31, 44, 2.5, INK));
      S.push(line(81, 47, 89, 44, 2.5, INK));
    }

    // ---- Hat ----
    if (L.hatId === "hat_cap") {
      S.push(rr(38, 16, 44, 16, 4, accent, INK, 3));
      S.push(rr(56, 26, 44, 8, 3, accent, INK, 3));
      for (const x of [64, 76, 88]) S.push(rect(x, 29, 6, 2, INK, 0.3));
      S.push(rr(57, 13, 6, 4, 1, SHADE, INK, 2));
    } else if (L.hatId === "hat_beanie") {
      S.push(rr(38, 14, 44, 18, 5, accent, INK, 3));
      S.push(rr(36, 26, 48, 8, 3, SHELL, INK, 3));
      for (const x of [42, 54, 66, 78]) S.push(rect(x, 29, 5, 2, INK, 0.25));
      S.push(rr(55, 6, 10, 8, 3, SHELL, INK, 2.5));
    }

    // ---- Bow (drawn last, over everything) ----
    if (L.bowId === "bow_bow") {
      for (const x of [24, 37]) S.push(rr(x, 20, 15, 12, 3, accent, INK, 2.5));
      S.push(rr(35, 23, 7, 7, 2, accent, INK, 2.5));
    }

    const o = opts || {};
    const w = o.width || 120, h = o.height || 140;
    return `<svg viewBox="0 0 120 140" width="${w}" height="${h}" ` +
      `role="img" aria-label="MicroCharm buddy" style="display:block">` +
      `<defs>${DITHER_DEF}</defs>${S.join("")}</svg>`;
  }

  // ---------------------------------------------------------------------------
  // CharmVoice — verbatim port of the cheer line generator
  // ---------------------------------------------------------------------------
  const VOICE_LINES = {
    cph: {
      bro:        ["{f} CPH — keep cooking.", "{f} CPH. On pace, legend."],
      bestFriend: ["{f} CPH! You're cruising today.", "{f} CPH — so proud of you!"],
      soft:       ["{f} CPH — nice and steady.", "{f} CPH. Gentle pace, keep going."],
      coach:      ["{f} CPH. Stay moving, next customer.", "{f} CPH. Lock in and repeat."],
      deadpan:    ["{f} CPH. Statistically acceptable.", "{f} CPH. The queue trembles."],
    },
    sales: {
      bro:        ["Hit {k} sold. Let's go.", "{k} sold. Built different."],
      bestFriend: ["{k} sold today — amazing!", "{k} sold. You're killing it!"],
      soft:       ["{k} sold. Quietly great work.", "{k} sold — smooth and steady."],
      coach:      ["{k} sold. Stack the next one.", "{k} sold. Keep the streak honest."],
      deadpan:    ["{k} sold. The register noticed.", "{k} sold. As predicted."],
    },
    target: {
      bro:        ["Day target hit. That's the one.", "Target smashed. Go take a breather."],
      bestFriend: ["Day target hit! Big moment!", "You hit your target — so happy for you!"],
      soft:       ["Day target reached. Lovely work.", "Target met. Take a soft breath."],
      coach:      ["Day target hit. Now raise it.", "Target reached. Finish strong."],
      deadpan:    ["Day target hit. As forecast.", "Target reached. Acceptable performance."],
    },
  };
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  function personalName(note) {
    if (!note) return null;
    const m = String(note).match(/call me ([A-Za-z]+)/);
    return m ? m[1] : null;
  }
  // kind: "cphStep"|"salesStep"|"target"|"test"; value: number (CPH or dollars)
  function voiceMessage(kind, vibe, note, value) {
    const v = vibe || "bestFriend";
    let base;
    if (kind === "cphStep" || kind === "test") {
      base = pick(VOICE_LINES.cph[v] || VOICE_LINES.cph.bestFriend).replace("{f}", Number(value).toFixed(1));
    } else if (kind === "salesStep") {
      const k = "$" + Math.max(1, Math.round(value / 1000)) + "K";
      base = pick(VOICE_LINES.sales[v] || VOICE_LINES.sales.bestFriend).replace(/\{k\}/g, k);
    } else {
      base = pick(VOICE_LINES.target[v] || VOICE_LINES.target.bestFriend);
    }
    const name = personalName(note);
    return name ? name + " — " + base : base;
  }

  // ---------------------------------------------------------------------------
  // Data access — profile fields ride data.profile via the updateProfile op
  // ---------------------------------------------------------------------------
  async function getData() {
    try {
      const b = await SyncEngine.getLocalBackup();
      return (b && b.data) || {};
    } catch (e) { return {}; }
  }
  const getLook = p => ({ ...STANDARD_LOOK, ...((p || {}).microCharmLook || {}) });
  const getReactions = p => ({
    cphStepsEnabled: false, salesStepsEnabled: false,
    daySalesTarget: null, voiceVibe: "bestFriend", vibeNote: null,
    ...((p || {}).microCharmReactions || {}),
  });
  const getCheers = p => Array.isArray((p || {}).microCharmCheers) ? p.microCharmCheers : [];

  async function saveLook(look) {
    await SyncEngine.queueWrite({
      type: "updateProfile",
      updates: { microCharmLook: { ...look, updatedAt: isoNow() } },
    });
  }
  async function saveReactions(r) {
    await SyncEngine.queueWrite({
      type: "updateProfile",
      updates: { microCharmReactions: { ...r, updatedAt: isoNow() } },
    });
  }
  async function saveCheers(cheers) {
    await SyncEngine.queueWrite({
      type: "updateProfile",
      updates: { microCharmCheers: cheers.slice(-10) },
    });
  }

  function findToday(data, key) {
    const days = Array.isArray(data.days) ? data.days : [];
    return days.find(d =>
      (d.id || "") === key ||
      (d.date && PayEngine.dayKey(d.date) === key) ||
      d.date === key) || null;
  }
  // Today's numbers in the shape the paired charm will render (CharmStatsPacket).
  function todayStats(day, profile) {
    const tickets = (day && day.tickets) || [];
    const lines = tickets.flatMap(t => t.lines || []);
    const revenue = lines.reduce((s, l) => s + PayEngine.lineRevenue(l), 0);
    const items = lines.reduce((s, l) => s + (l.isReturn ? 0 : (l.quantity || 0)), 0);
    const returns = lines.filter(l => l.isReturn).length;
    const table = PayEngine.tableForProfile(profile || {});
    const commission = PayEngine.dayCommission(day || { tickets: [] }, table);
    const takeHome = PayEngine.commissionTakeHome(commission, profile || {});
    const hours = PayEngine.workedHours(day || { tickets: [] });
    const cph = hours > 0 ? tickets.length / hours : 0;
    return { revenue, items, returns, commission, takeHome, cph, hours,
             isEstimate: PayEngine.isCalifornia(profile || {}) };
  }

  // ---------------------------------------------------------------------------
  // Fired-threshold tracking (session-safe: once per day per threshold)
  // ---------------------------------------------------------------------------
  const FIRED_KEY = "mc_fired_v1";
  let firedDay = null, firedSet = new Set();
  function rollFired(key) {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(FIRED_KEY) || "null"); } catch (e) {}
    if (stored && stored.dayKey === key) {
      firedDay = key; firedSet = new Set(stored.fired || []);
    } else {
      firedDay = key; firedSet = new Set();
      try { localStorage.setItem(FIRED_KEY, JSON.stringify({ dayKey: key, fired: [] })); } catch (e) {}
    }
  }
  function markFired(k) {
    firedSet.add(k);
    try { localStorage.setItem(FIRED_KEY, JSON.stringify({ dayKey: firedDay, fired: [...firedSet] })); } catch (e) {}
  }
  function preMarkCrossed(reactions, stats) {
    if (reactions.cphStepsEnabled) {
      const top = Math.floor(stats.cph);
      for (let s = 1; s <= top; s++) markFired("cph-" + s);
    }
    if (reactions.salesStepsEnabled) {
      const k = Math.floor(stats.revenue / 1000);
      for (let i = 1; i <= k; i++) markFired("sales-" + i);
    }
    if (reactions.daySalesTarget && reactions.daySalesTarget > 0 &&
        stats.revenue >= reactions.daySalesTarget) markFired("target");
  }

  // ---------------------------------------------------------------------------
  // Milestone engine — port of AppStore.checkMicroCharmMilestones
  // ---------------------------------------------------------------------------
  function makeCheer(kind, value, reactions) {
    return {
      id: uid(),
      dayKey: todayKey(),
      kind,
      message: voiceMessage(kind, reactions.voiceVibe, reactions.vibeNote, value),
      createdAt: isoNow(),
    };
  }
  async function enqueueCheer(cheer) {
    try {
      const data = await getData();
      const cheers = getCheers(data.profile);
      cheers.push(cheer);
      await saveCheers(cheers.slice(-10));
    } catch (e) { console.warn("microcharm: cheer save failed:", e.message); }
    pushOverlay(cheer);
  }
  async function checkMilestones() {
    try {
      const data = await getData();
      const profile = data.profile || {};
      const reactions = getReactions(profile);
      if (!(reactions.cphStepsEnabled || reactions.salesStepsEnabled || reactions.daySalesTarget)) return;
      const key = todayKey();
      rollFired(key);
      const day = findToday(data, key);
      if (!day) return;
      const stats = todayStats(day, profile);
      const pending = [];
      if (reactions.cphStepsEnabled) {
        const topStep = Math.floor(stats.cph);
        if (topStep >= 1) {
          const crossed = [];
          for (let s = 1; s <= topStep; s++) if (!firedSet.has("cph-" + s)) crossed.push(s);
          crossed.forEach(s => markFired("cph-" + s));
          const newest = Math.max.apply(null, crossed);
          if (crossed.length) pending.push(makeCheer("cphStep", newest, reactions));
        }
      }
      if (reactions.salesStepsEnabled) {
        const thousands = Math.floor(stats.revenue / 1000);
        if (thousands >= 1) {
          const crossed = [];
          for (let i = 1; i <= thousands; i++) if (!firedSet.has("sales-" + i)) crossed.push(i);
          crossed.forEach(i => markFired("sales-" + i));
          const newest = Math.max.apply(null, crossed);
          if (crossed.length) pending.push(makeCheer("salesStep", newest * 1000, reactions));
        }
      }
      if (reactions.daySalesTarget && reactions.daySalesTarget > 0 &&
          stats.revenue >= reactions.daySalesTarget && !firedSet.has("target")) {
        markFired("target");
        pending.push(makeCheer("target", reactions.daySalesTarget, reactions));
      }
      for (const c of pending) await enqueueCheer(c);
    } catch (e) { console.warn("microcharm: milestone check failed:", e.message); }
  }
  async function fireTestCheer() {
    try {
      const data = await getData();
      const reactions = getReactions(data.profile);
      await enqueueCheer(makeCheer("test", 2.0, reactions));
    } catch (e) { console.warn("microcharm: test cheer failed:", e.message); }
  }

  // ---------------------------------------------------------------------------
  // Cheer overlay — "MICROCHARM WOULD SAY" bubble (auto-dismiss 5s, tap to close)
  // ---------------------------------------------------------------------------
  const overlayQueue = [];
  let overlayTimer = null;
  function ensureOverlayHost() {
    let host = document.getElementById("mc-cheer-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "mc-cheer-host";
      document.body.appendChild(host);
    }
    return host;
  }
  function pushOverlay(cheer) {
    overlayQueue.push(cheer);
    if (overlayQueue.length > 3) overlayQueue.splice(0, overlayQueue.length - 3);
    if (overlayQueue.length === 1) renderOverlay();
  }
  async function renderOverlay() {
    const host = ensureOverlayHost();
    const cheer = overlayQueue[0];
    if (!cheer) { host.innerHTML = ""; return; }
    const data = await getData();
    const look = getLook(data.profile);
    host.innerHTML =
      `<button class="mc-cheer" id="mc-cheer-btn" aria-label="MicroCharm would say: ${esc(cheer.message)}">` +
      `<span class="mc-cheer-bot">${robotSVG(look, { width: 36, height: 42 })}</span>` +
      `<span class="mc-cheer-text"><span class="mc-cheer-kicker">MicroCharm would say</span>` +
      `<span class="mc-cheer-msg">${esc(cheer.message)}</span></span></button>`;
    document.getElementById("mc-cheer-btn").addEventListener("click", dismissCheer);
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(dismissCheer, 5000);
  }
  function dismissCheer() {
    clearTimeout(overlayTimer);
    overlayQueue.shift();
    if (overlayQueue.length) renderOverlay();
    else { const h = document.getElementById("mc-cheer-host"); if (h) h.innerHTML = ""; }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  let view = "hub"; // hub | creator | reactions
  let creatorDraft = null, creatorCat = "body";

  async function open() {
    injectCSS();
    const box = document.getElementById("microcharm-body");
    if (!box) return;
    box.innerHTML = '<div class="spinner">Loading MicroCharm…</div>';
    try {
      await render();
      // Best-effort milestone check whenever the tab opens.
      checkMilestones().catch(() => {});
    } catch (e) {
      box.innerHTML = '<div class="panel">Couldn\'t load MicroCharm.</div>';
    }
  }
  async function render() {
    const box = document.getElementById("microcharm-body");
    if (!box) return;
    if (view === "creator") return renderCreator(box);
    if (view === "reactions") return renderReactions(box);
    return renderHub(box);
  }
  function setView(v) { view = v; render(); window.scrollTo({ top: 0 }); }

  function sectionHeader(title, subtitle) {
    return `<div class="mc-sec"><div class="mc-sec-title">${esc(title)}</div>` +
      (subtitle ? `<div class="mc-sec-sub">${esc(subtitle)}</div>` : "") + `</div>`;
  }

  // ---- Hub ----
  async function renderHub(box) {
    const data = await getData();
    const profile = data.profile || {};
    const look = getLook(profile);
    const reactions = getReactions(profile);
    const cheers = getCheers(profile).slice(-10).reverse();
    const key = todayKey();
    const day = findToday(data, key);
    const stats = day ? todayStats(day, profile) : null;

    let html = "";
    // 1. Connection (locked until hardware)
    html += `<div class="panel">` + sectionHeader("Connection", "Your keychain buddy") +
      `<div class="mc-conn"><span class="mc-dot"></span><strong>Not connected</strong></div>` +
      `<p class="mc-muted">Pairing unlocks when your MicroCharm arrives. You can still design your buddy and set reactions.</p>` +
      `<button class="btn mc-pair" disabled>${Icon("link", { size: 14 })} Pair</button>` +
      `<div class="mc-tiny">Last synced —</div></div>`;
    // 2. Your Buddy
    html += `<button class="panel mc-rowbtn" id="mc-to-creator">` +
      `<span class="mc-thumb">${robotSVG(look, { width: 44, height: 52 })}</span>` +
      `<span class="mc-rowmain"><span class="mc-rowtitle">Your Buddy</span>` +
      `<span class="mc-rowsub">${esc(lookSummary(look))}</span></span>` +
      `<span class="mc-chev">${Icon("chevron-right", { size: 14 })}</span></button>`;
    // 3. Reactions
    html += `<button class="panel mc-rowbtn" id="mc-to-reactions">` +
      `<span class="mc-party">${Icon("sparkles", { size: 22 })}</span>` +
      `<span class="mc-rowmain"><span class="mc-rowtitle">Reactions</span>` +
      `<span class="mc-rowsub">${esc(reactionsSummary(reactions))}</span></span>` +
      `<span class="mc-chev">${Icon("chevron-right", { size: 14 })}</span></button>`;
    // 4. Stats preview
    html += `<div class="panel">` + sectionHeader("What your MicroCharm will show", "Live on device when paired");
    if (stats && day) {
      html += mcStatRow("Sold today", money(stats.revenue)) +
        mcStatRow(stats.isEstimate ? "Est. take-home" : "Take-home", money(stats.takeHome)) +
        mcStatRow("CPH", stats.hours > 0 ? stats.cph.toFixed(1) : "—") +
        mcStatRow("Items sold", String(stats.items)) +
        mcStatRow("Returns today", String(stats.returns));
      if (stats.isEstimate)
        html += `<div class="mc-tiny">Take-home uses your CA tax estimate — same math as Sales.</div>`;
    } else {
      html += `<p class="mc-muted">Log a sale to see today's numbers here.</p>`;
    }
    html += `</div>`;
    // 5. Today's cheers
    html += `<div class="panel">` + sectionHeader("Today's cheers", "Last 10");
    if (!cheers.length) {
      html += `<p class="mc-muted">When a CPH step or sales milestone lands, what your MicroCharm would say shows up here.</p>`;
    } else {
      html += cheers.map((c, i) => {
        let time = "";
        try { time = new Date(c.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); } catch (e) {}
        return `<div class="mc-cheerrow"><span class="mc-cheertime">${esc(time)}</span>` +
          `<span>${esc(c.message)}</span></div>` +
          (i < cheers.length - 1 ? `<div class="mc-hr"></div>` : "");
      }).join("");
    }
    html += `</div>`;

    box.innerHTML = html;
    document.getElementById("mc-to-creator").addEventListener("click", () => setView("creator"));
    document.getElementById("mc-to-reactions").addEventListener("click", () => setView("reactions"));
  }
  function mcStatRow(title, value) {
    return `<div class="mc-statrow"><span>${esc(title)}</span><strong class="money">${esc(value)}</strong></div>`;
  }

  // ---- Character creator ----
  async function renderCreator(box) {
    if (!creatorDraft) {
      const data = await getData();
      creatorDraft = getLook(data.profile);
    }
    const cat = CATEGORIES.find(c => c.key === creatorCat) || CATEGORIES[0];
    const opts = PARTS[cat.catalog];
    const currentVal = cat.isAccent ? creatorDraft.accentHex : creatorDraft[cat.lookKey];

    let html = `<div class="mc-backrow"><button class="mc-back" id="mc-creator-back">${Icon("chevron-left", { size: 14 })} MicroCharm</button></div>`;
    html += `<div class="panel mc-preview">${robotSVG(creatorDraft, { width: 180, height: 210 })}</div>`;
    html += `<div class="mc-chips">` + CATEGORIES.map(c =>
      `<button class="mc-chip${c.key === cat.key ? " sel" : ""}" data-cat="${c.key}">${esc(c.title)}</button>`
    ).join("") + `</div>`;
    html += `<div class="mc-opts">` + opts.map(o => {
      const val = cat.isAccent ? o.hex : o.id;
      const sel = String(currentVal).toLowerCase() === String(val).toLowerCase();
      const swatch = cat.isAccent
        ? `<span class="mc-swatch" style="background:${esc(o.hex)}"></span>`
        : `<span class="mc-check">${sel ? Icon("check-circle", { size: 16 }) : ""}</span>`;
      return `<button class="mc-opt${sel ? " sel" : ""}" data-val="${esc(val)}">${swatch}<span>${esc(o.title)}</span></button>`;
    }).join("") + `</div>`;
    html += `<div class="mc-foot"><button class="btn mc-primary" id="mc-save-look">Save</button>` +
      `<button class="mc-plain" id="mc-reset-look">Reset to default</button></div>`;

    box.innerHTML = html;
    document.getElementById("mc-creator-back").addEventListener("click", () => { creatorDraft = null; setView("hub"); });
    box.querySelectorAll(".mc-chip").forEach(b => b.addEventListener("click", () => {
      creatorCat = b.dataset.cat; renderCreator(box);
    }));
    box.querySelectorAll(".mc-opt").forEach(b => b.addEventListener("click", () => {
      if (cat.isAccent) creatorDraft.accentHex = b.dataset.val;
      else creatorDraft[cat.lookKey] = b.dataset.val;
      renderCreator(box);
    }));
    document.getElementById("mc-save-look").addEventListener("click", async () => {
      try { await saveLook(creatorDraft); } catch (e) {}
      creatorDraft = null; setView("hub");
    });
    document.getElementById("mc-reset-look").addEventListener("click", async () => {
      creatorDraft = { ...STANDARD_LOOK };
      try { await saveLook(creatorDraft); } catch (e) {}
      creatorDraft = null; setView("hub");
    });
  }

  // ---- Reactions settings ----
  async function renderReactions(box) {
    const data = await getData();
    let r = getReactions(data.profile);
    const key = todayKey();
    rollFired(key);
    const day = findToday(data, key);
    const stats = day ? todayStats(day, data.profile || {}) : null;

    async function persist(next, premark) {
      r = { ...next, updatedAt: isoNow() };
      await saveReactions(r);
      if (premark && stats) preMarkCrossed(r, stats); // no backlog when enabling mid-shift
      renderReactions(box);
    }

    let html = `<div class="mc-backrow"><button class="mc-back" id="mc-react-back">${Icon("chevron-left", { size: 14 })} MicroCharm</button></div>`;
    html += `<div class="panel">` + sectionHeader("Cheers", "Fires on real live numbers only") +
      mcToggle("cph", "CPH steps", "Cheer each whole CPH step crossed (1.0, 2.0, 3.0…)", r.cphStepsEnabled) +
      `<div class="mc-hr"></div>` +
      mcToggle("sales", "Sales $ steps", "Cheer every $1,000 sold today", r.salesStepsEnabled) +
      `</div>`;
    const targetVal = (r.daySalesTarget && r.daySalesTarget > 0)
      ? (r.daySalesTarget === Math.round(r.daySalesTarget) ? String(Math.round(r.daySalesTarget)) : String(r.daySalesTarget))
      : "";
    html += `<div class="panel">` + sectionHeader("Day sales target", "Optional — one cheer when you hit it") +
      `<input class="mc-input" id="mc-target" inputmode="decimal" placeholder="e.g. 8000" value="${esc(targetVal)}">` +
      `<div class="mc-tiny">Empty = no target cheer.</div></div>`;
    html += `<div class="panel">` + sectionHeader("Voice vibe", "How your buddy sounds") +
      VIBES.map((v, i) =>
        `<button class="mc-vibe${r.voiceVibe === v.id ? " sel" : ""}" data-vibe="${v.id}">` +
        `<span class="mc-rowmain"><span class="mc-rowtitle">${esc(v.title)}</span>` +
        `<span class="mc-rowsub">${esc(voiceMessage("cphStep", v.id, null, 2.0))}</span></span>` +
        (r.voiceVibe === v.id ? `<span class="mc-vibecheck">${Icon("check", { size: 14 })}</span>` : "") +
        `</button>` + (i < VIBES.length - 1 ? `<div class="mc-hr"></div>` : "")
      ).join("") +
      `<div class="mc-hr"></div>` +
      `<div class="mc-notewrap"><div class="mc-rowtitle">Extra vibe note</div>` +
      `<input class="mc-input" id="mc-note" maxlength="80" placeholder="e.g. call me Rhy, keep it short" value="${esc(r.vibeNote || "")}">` +
      `<div class="mc-tiny"><span id="mc-notecount">${(r.vibeNote || "").length}</span>/80 — a "call me &lt;name&gt;" note adds your name to cheers.</div></div></div>`;
    html += `<div class="panel">` + sectionHeader("Preview", "Hear it before your shift") +
      `<button class="btn mc-primary" id="mc-test">${Icon("sparkles", { size: 14 })} Test cheer</button>` +
      `<div class="mc-tiny">Plays a sample "2.0 CPH reached" cheer with your current vibe — doesn't touch your real numbers.</div></div>`;
    html += `<div class="mc-tiny mc-center">Changes save automatically.</div>`;

    box.innerHTML = html;
    document.getElementById("mc-react-back").addEventListener("click", () => setView("hub"));
    box.querySelectorAll("[data-mctoggle]").forEach(t => t.addEventListener("change", () => {
      const k = t.dataset.mctoggle === "cph" ? "cphStepsEnabled" : "salesStepsEnabled";
      persist({ ...r, [k]: t.checked }, t.checked);
    }));
    const targetEl = document.getElementById("mc-target");
    targetEl.addEventListener("blur", () => {
      const v = parseFloat(String(targetEl.value).trim());
      const next = (v > 0) ? v : null;
      if ((r.daySalesTarget || null) !== next) persist({ ...r, daySalesTarget: next }, false);
    });
    box.querySelectorAll("[data-vibe]").forEach(b => b.addEventListener("click", () => {
      if (r.voiceVibe !== b.dataset.vibe) persist({ ...r, voiceVibe: b.dataset.vibe }, false);
    }));
    const noteEl = document.getElementById("mc-note");
    noteEl.addEventListener("input", () => {
      document.getElementById("mc-notecount").textContent = String(noteEl.value.length);
    });
    noteEl.addEventListener("blur", () => {
      const t = String(noteEl.value).trim().slice(0, 80);
      const next = t ? t : null;
      if ((r.vibeNote || null) !== next) persist({ ...r, vibeNote: next }, false);
    });
    document.getElementById("mc-test").addEventListener("click", fireTestCheer);
  }
  function mcToggle(key, title, sub, on) {
    return `<label class="mc-toggle"><span class="mc-rowmain"><span class="mc-rowtitle">${esc(title)}</span>` +
      `<span class="mc-rowsub">${esc(sub)}</span></span>` +
      `<input type="checkbox" data-mctoggle="${key}"${on ? " checked" : ""}><span class="mc-switch"></span></label>`;
  }

  // ---------------------------------------------------------------------------
  // CSS (self-contained; uses the dashboard's theme variables)
  // ---------------------------------------------------------------------------
  let cssDone = false;
  function injectCSS() {
    if (cssDone || !document.head) return;
    cssDone = true;
    const s = document.createElement("style");
    s.textContent = `/* moved to components.css */`;
    document.head.appendChild(s);
  }

  return {
    open,
    checkMilestones,
    fireTestCheer,
    dismissCheer,
    robotSVG,
    voiceMessage,
    lookSummary,
    reactionsSummary,
    STANDARD_LOOK,
    PARTS,
    CATEGORIES,
  };
})();
