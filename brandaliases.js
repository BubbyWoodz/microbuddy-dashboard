/* BrandAliases — port of iOS Models/BrandAliases.swift (Batch 22).
 * Product-line names folded into their parent brand. Keep in sync with iOS. */
const BrandAliases = (() => {
  const version = 1;
  const lines = {
    "unifi": "Ubiquiti", "rog": "ASUS", "wd": "Western Digital", "macbook": "Apple",
    "surface": "Microsoft", "xbox": "Microsoft", "pixel": "Google", "predator": "Acer",
    "ttgo": "LILYGO", "soundcore": "Anker",
  };
  const parents = {
    "ubiquiti": "Ubiquiti", "asus": "ASUS", "western digital": "Western Digital", "apple": "Apple",
    "microsoft": "Microsoft", "google": "Google", "acer": "Acer", "lilygo": "LILYGO", "anker": "Anker",
  };
  // Swift .whitespaces = spaces/tabs only (not newlines).
  const trim = s => String(s == null ? "" : s).replace(/^[ \t\u00a0]+|[ \t\u00a0]+$/g, "");
  const key = b => trim(b).toLowerCase();
  function canonical(brand) {
    const t = trim(brand);
    if (!t) return "";
    const k = t.toLowerCase();
    return lines[k] || parents[k] || t;
  }
  function matches(a, b) { const l = canonical(a), r = canonical(b); return !!l && key(l) === key(r); }
  return { version, canonical, matches, key };
})();
if (typeof module !== "undefined") module.exports = BrandAliases;
