// Which side a UPI failure code points to ("Party" on the Automatic Payments Dashboard), ported from
// third_party/apd_installer …/automatic_payments/reference/error_code_owner.py `owner()` (same rules):
//   Payer bank · Beneficiary handle · Payer PSP · Depends on flow · NPCI / switch · Internal (Paytm)
// A combined app code (U30-B3, UM8-ZM) follows its leading NPCI code; INT-xxxx is Paytm internal; U16 / M16 = NPCI EFRM.

const PB = "Payer bank";
const BH = "Beneficiary handle";
const PP = "Payer PSP";
const DEP = "Depends on flow";
const NP = "NPCI / switch";
const INT = "Internal (Paytm)";

const SVC = {};
const set = (party, codes, why) => {
  for (const c of codes.split(/\s+/)) SVC[c] = { party, why };
};
set(PB, "U02 U03", "Amount / net-debit cap on the payer (remitter) side");
set(PB, "U28 U30 U33 U47 U53 U67 U74 U76 U83 U85 U86 U87 U90 S96 S98 S99", "Debit leg / remitter (payer) bank");
set(PB, "UA7 UA8 UA9 UB9 UM7 UM8 UM9 UN0 UN1 UN7 UO0", "Mandate request to remitter (payer) bank");
set(BH, "U26 U29 U31 U32 U46 U68 U71 U75 U77 U78 U82 U84 U88 U89 U91 U93 U94 U95 S93 S94 S95 S97", "Credit leg / address resolution / payee PSP or beneficiary bank");
set(BH, "U09", "ReqAuth timeout for Pay — ReqAuthDetails goes to the payee PSP");
set(BH, "UB1 UB2 UB3 UC2 UO1 UN6 UN9", "Beneficiary bank / payee PSP version or registration");
set(PP, "U11 U63 U64 U65 U66 U69 U80 U92 UB8 UN3 UN4 UN5 UN8 UM0 UM1 UM2 UM3 UM4 UM5 UM6", "Payer PSP (app / device / credentials / collect / mandate auth)");
set(DEP, "U18 U19 U20 U21", "ReqAuth leg — payee PSP in Pay, payer PSP in Collect");
set(
  NP,
  "U01 U04 U05 U06 U07 U08 U10 U12 U13 U14 U15 U16 U17 U22 U23 U24 U25 U34 U35 U36 U37 U38 U39 U40 U41 U42 U43 U44 U45 U48 U49 U50 U51 U52 U54 U55 U56 U57 U58 U59 U60 U61 U62 U70 U72 U79 U81 U96 U97 U98 U99 UA1 UA2 UA3 UA4 UA5 UA6 UB7 UN2",
  "NPCI switch / risk / message validation — not one bank",
);

/** { party, why } for an app / NPCI code such as "U30-B3", "UM8-ZM", "U16-00972", "INT-1928". */
export function codeParty(code) {
  const c = String(code || "").replace(/^UPI-/, "");
  if (c.startsWith("INT-")) return { party: INT, why: "Paytm internal error" };
  const m = c.match(/^([A-Z]+\d+)(?:-(.+))?$/);
  if (!m) return { party: DEP, why: "Unknown code" };
  if (m[1] === "U16" || m[1] === "M16") return { party: NP, why: "NPCI EFRM risk rule — check payer bank and payee handle" };
  return SVC[m[1]] || { party: DEP, why: "Not in NPCI service-code list" };
}
