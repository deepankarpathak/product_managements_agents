// Payee PSP grouping for the Unified SR Dashboard. The backend keeps every payee handle
// named by either source report as its own key (lower-cased) and folds the rest into
// "others"; these maps turn keys into the groups each old dashboard showed.

// Morning Dashboard ("Payee PSP SR" Looker report): Paytm handles stay separate.
// okpayaxis is added to GooglePay (the Snippet counts it there; Morning sent it to OTHERS).
const DETAILED = {
  ybl: "PhonePe",
  ibl: "PhonePe",
  axl: "PhonePe",
  okbizaxis: "GooglePay",
  okbizicici: "GooglePay",
  okbizhdfcbank: "GooglePay",
  okbizsbi: "GooglePay",
  okaxis: "GooglePay",
  okicici: "GooglePay",
  okhdfcbank: "GooglePay",
  oksbi: "GooglePay",
  okpayaxis: "GooglePay",
  apl: "AmazonPay",
  yapl: "AmazonPay",
  rapl: "AmazonPay",
  axisb: "CRED",
  yescred: "CRED",
  naviaxis: "Navi",
  superyes: "SuperMoney",
  fkaxis: "Flipkart UPI",
};
const PAYTM_HANDLES = new Set(["paytm", "ptyes", "ptsbi", "pthdfc", "ptaxis", "ptybl", "pty", "ptys"]);

// Success Rate Snippet (Superset dashboard 575): four groups.
const SNIPPET = {
  ybl: "PhonePe",
  axl: "PhonePe",
  ibl: "PhonePe",
  okbizaxis: "Google Pay",
  okbizicici: "Google Pay",
  okpayaxis: "Google Pay",
  pty: "Paytm",
  ptybl: "Paytm",
  ptys: "Paytm",
  paytm: "Paytm",
};

// handle: one row per payee handle (ybl / ibl / axl, okaxis / okicici / …) — each is a
// different sponsor bank, which is who an escalation goes to.
export const PSP_MODES = [
  ["detailed", "Detailed (Morning)"],
  ["handle", "Handles (sponsor bank)"],
  ["snippet", "4 groups (Snippet)"],
];

export const PSP_ORDER = {
  detailed: ["PhonePe", "GooglePay", "ptyes", "ptaxis", "ptsbi", "pthdfc", "ptybl", "pty", "ptys", "paytm", "AmazonPay", "CRED", "Navi", "SuperMoney", "Flipkart UPI", "OTHERS"],
  snippet: ["PhonePe", "Google Pay", "Paytm", "Others"],
  handle: [],
};

// Group a handle belongs to, for labels in handle mode ("ybl · PhonePe").
export const pspParent = (key) => DETAILED[String(key || "").toLowerCase()] || (PAYTM_HANDLES.has(String(key || "").toLowerCase()) ? "Paytm" : "");

export function pspGroup(key, mode) {
  const k = String(key || "").toLowerCase();
  if (mode === "snippet") return SNIPPET[k] || "Others";
  if (mode === "handle") return k && k !== "others" ? k : "OTHERS";
  if (PAYTM_HANDLES.has(k)) return k;
  return DETAILED[k] || "OTHERS";
}

// Every payee handle the backend keeps as its own key (= backend PSP_HANDLES).
export const KNOWN_PSP_HANDLES = [...PAYTM_HANDLES, ...Object.keys(DETAILED)];

/** Payee-handle filter for a group: { values, exclude } (catch-all groups exclude every named handle). */
export function handlesForGroup(group, mode) {
  if (mode === "handle") return group === "OTHERS" ? { values: KNOWN_PSP_HANDLES, exclude: true } : { values: [group], exclude: false };
  if (mode === "snippet") {
    if (group === "Others") return { values: Object.keys(SNIPPET), exclude: true };
    return { values: Object.keys(SNIPPET).filter((h) => SNIPPET[h] === group), exclude: false };
  }
  if (group === "OTHERS") return { values: KNOWN_PSP_HANDLES, exclude: true };
  if (PAYTM_HANDLES.has(group)) return { values: [group], exclude: false };
  return { values: Object.keys(DETAILED).filter((h) => DETAILED[h] === group), exclude: false };
}
