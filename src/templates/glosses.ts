// p6-02 (A4): plain-English glosses for 8-K item codes and officer titles.
//
// THE DEFECT, verbatim from live card #1248:
//
//   Neonode Inc.: Item 3.01, Notice of Delisting or Failure to Satisfy a
//   Continued Listing Rule or Standard…, per SEC
//
// A raw filing header, truncated mid-title by `firstClause`, with no plain
// meaning and no cashtag. SEC's compound titles run to 145 characters; Item
// 5.02's is four clauses long. Cutting one at a semicolon and marking the cut
// was an honest fix for LENGTH, and it never addressed READABILITY.
//
// SOURCED, NOT REMEMBERED. Every gloss below was written against the SEC's own
// Form 8-K (https://www.sec.gov/files/form8-k.pdf, HTTP 200, 1,022,559 bytes,
// retrieved 2026-08-08) with the item titles cross-checked against the 866
// item rows our own lake holds. The codes covered are the ones that actually
// arrive: those 18 codes account for every item in a 400-filing sample.
//
// THE LINE THIS DOES NOT CROSS. A gloss says what the FORM says the item is
// for. It never says what a particular filing means, never characterises the
// company's situation, and never adds a fact the filing did not state. "Got a
// delisting or listing-deficiency notice" is Item 3.01's own subject; "is in
// trouble" would be commentary the record does not license.

export interface ItemGloss {
  /** SEC's own title, for the payload and for audit. */
  readonly title: string;
  /** What the desk prints. Lower-case, verb-first, completes "filed an 8-K:". */
  readonly gloss: string;
}

/**
 * Codes are the SEC's. Frequencies are ours, from a 400-filing sample on
 * 2026-08-08, and they are recorded because they say which glosses matter:
 * 9.01 and 2.02 alone are half of all item rows.
 */
export const ITEM_GLOSSES: Readonly<Record<string, ItemGloss>> = {
  "1.01": { title: "Entry into a Material Definitive Agreement", gloss: "signed a material agreement" },
  "1.02": { title: "Termination of a Material Definitive Agreement", gloss: "terminated a material agreement" },
  "1.05": { title: "Material Cybersecurity Incidents", gloss: "reported a material cybersecurity incident" },
  "2.01": { title: "Completion of Acquisition or Disposition of Assets", gloss: "completed an acquisition or disposal" },
  "2.02": { title: "Results of Operations and Financial Condition", gloss: "reported results" },
  "2.03": {
    title: "Creation of a Direct Financial Obligation or an Obligation under an Off-Balance Sheet Arrangement",
    gloss: "took on a direct financial obligation",
  },
  "2.04": {
    title: "Triggering Events That Accelerate or Increase a Direct Financial Obligation",
    gloss: "hit a triggering event on a financial obligation",
  },
  "3.01": {
    title: "Notice of Delisting or Failure to Satisfy a Continued Listing Rule or Standard",
    gloss: "got a delisting or listing-deficiency notice",
  },
  "3.02": { title: "Unregistered Sales of Equity Securities", gloss: "sold unregistered equity" },
  "3.03": { title: "Material Modifications to Rights of Security Holders", gloss: "changed security holders' rights" },
  "4.01": { title: "Changes in Registrant's Certifying Accountant", gloss: "changed auditor" },
  "4.02": {
    title: "Non-Reliance on Previously Issued Financial Statements or a Related Audit Report or Completed Interim Review",
    gloss: "said prior financials can no longer be relied on",
  },
  "5.01": { title: "Changes in Control of Registrant", gloss: "reported a change in control" },
  "5.02": {
    title: "Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers",
    gloss: "changed directors or officers",
  },
  "5.03": {
    title: "Amendments to Articles of Incorporation or Bylaws; Change in Fiscal Year",
    gloss: "amended its charter or bylaws",
  },
  "5.07": { title: "Submission of Matters to a Vote of Security Holders", gloss: "put matters to a shareholder vote" },
  "5.08": { title: "Shareholder Nominations Pursuant to Exchange Act Rule 14a-11", gloss: "reported shareholder nominations" },
  "7.01": { title: "Regulation FD Disclosure", gloss: "made a Regulation FD disclosure" },
  "8.01": { title: "Other Events", gloss: "filed under Other Events" },
  "9.01": { title: "Financial Statements and Exhibits", gloss: "attached financial statements and exhibits" },
};

/**
 * The plain-English form, or null when the code is not in the registry.
 *
 * NULL IS THE IMPORTANT RETURN. An unknown code means SEC added or renumbered
 * an item and nobody has read it yet, and inventing a gloss from the title
 * would be exactly the fabrication this registry exists to prevent. The caller
 * falls back to the SEC's own title, which is always honest and only ever ugly.
 */
export function itemGloss(code: string): string | null {
  return ITEM_GLOSSES[code.trim()]?.gloss ?? null;
}

// ---------------------------------------------------------------------------
// Officer titles (A4)
//
// `officerTitle` is free text from the filing agent, and the same role arrives
// as "Chief Executive Officer", "CEO", "Chief Executive Officer & President"
// and "President and CEO" across filings on one day. Only the exact,
// unambiguous long forms are shortened; anything else is printed as filed.
//
// NOT NORMALIZATION. "EVP, General Counsel and Secretary" stays exactly as the
// filing wrote it. Compressing it would be the desk deciding which of a
// person's three roles matters, which is a judgement the record does not make.

const TITLE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  "chief executive officer": "CEO",
  "chief financial officer": "CFO",
  "chief operating officer": "COO",
  "chief technology officer": "CTO",
  "chief information officer": "CIO",
  "chief legal officer": "CLO",
  "chief marketing officer": "CMO",
  "chief accounting officer": "CAO",
  "chief medical officer": "CMO",
  "chief scientific officer": "CSO",
  "chief compliance officer": "CCO",
  "chief human resources officer": "CHRO",
  "chief revenue officer": "CRO",
  "chief product officer": "CPO",
  "chief security officer": "CSO",
  "principal executive officer": "principal executive officer",
  "principal financial officer": "principal financial officer",
};

/**
 * `Chief Executive Officer` becomes `CEO`; everything else is printed as filed.
 *
 * The multi-role case gets its own rule because it is the common one:
 * `Officer, Director` reads as a list of form checkboxes rather than English,
 * so it becomes `an officer and director` (owner, A4). That is the only
 * REPHRASING here; every other output is either the filed string or a
 * one-to-one abbreviation of it.
 */
export function roleGloss(title: string | null | undefined): string | null {
  const raw = (title ?? "").trim();
  if (raw === "") return null;
  const key = raw.toLowerCase().replace(/\s+/g, " ");
  const exact = TITLE_ABBREVIATIONS[key];
  if (exact) return exact;
  if (key === "officer, director" || key === "director, officer") return "an officer and director";
  return raw;
}
