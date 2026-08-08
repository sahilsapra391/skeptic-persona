import { describe, expect, it } from "vitest";
import { caseToken, deriveDisplayName, displayIsDerivable } from "../src/lib/names";

// p6-01 (A1). THE CORPUS IS REAL. The 49 person names and every entity below
// were pulled from 60 live Form 4 ownership documents on 2026-08-07 (declared
// UA, <7 req/s), plus the shapes the owner named from cards #1227-#1248.
// Synthetic cases are marked and cover only particles, suffixes, hyphenation
// and Mc/O' — the shapes the live sample happened not to contain.

// The whole corpus below is EDGAR CONFORMED names (ATOM `(Reporting)` titles
// and Form 4 `rptOwnerName`), which is the only input a reorder is licensed
// from (B-12.3). `conformed` is stated on every call rather than defaulted,
// because the default is deliberately the safe one.
const CONFORMED = { conformed: true, isOfficer: true } as const;

const shows = (filed: string, expected: string) =>
  it(`${filed} -> ${expected}`, () => {
    expect(deriveDisplayName(filed, CONFORMED).display).toBe(expected);
  });

describe("the owner's six kill-tests (A1)", () => {
  shows("Blecharczyk Nathan", "Nathan Blecharczyk");
  shows("FALTISCHEK DENISE M", "Denise M. Faltischek");
  shows("Merton Carl A", "Carl A. Merton");
  shows("THE FORTUNA TRUST U/T/A DTD 06/01/2018", "The Fortuna Trust");
  shows("GIC Private Ltd", "GIC Private Ltd");
  shows("Refo SCSp", "Refo SCSp");

  it("classifies each of the six correctly", () => {
    const shape = (s: string) => deriveDisplayName(s, CONFORMED).shape;
    expect(shape("Blecharczyk Nathan")).toBe("person");
    expect(shape("FALTISCHEK DENISE M")).toBe("person");
    expect(shape("Merton Carl A")).toBe("person");
    expect(shape("THE FORTUNA TRUST U/T/A DTD 06/01/2018")).toBe("entity");
    expect(shape("GIC Private Ltd")).toBe("entity");
    expect(shape("Refo SCSp")).toBe("entity");
  });
});

describe("the names the owner saw on live cards", () => {
  shows("Bancel Stephane", "Stephane Bancel");
  shows("Pomel Olivier", "Olivier Pomel");
  shows("Melwani Praveer", "Praveer Melwani");
  shows("Sheena Jonathan", "Jonathan Sheena");
  shows("Gendel Mitchell", "Mitchell Gendel");
  shows("ROBBINS LARRY", "Larry Robbins");
  shows("ARCHER TIMOTHY", "Timothy Archer");
  shows("LEMONIS MARCUS", "Marcus Lemonis");
  shows("Hakim Anat", "Anat Hakim");
  shows("Stifano Mario", "Mario Stifano");
});

describe("middle initials take a period; the period is typography, not a claim", () => {
  shows("FEGO PAUL J", "Paul J. Fego");
  shows("CREVISTON STEVEN E", "Steven E. Creviston");
  shows("BRUGGEWORTH ROBERT A", "Robert A. Bruggeworth");
  shows("KRAMER RONALD J", "Ronald J. Kramer");
  shows("MEHMEL ROBERT F", "Robert F. Mehmel");
  shows("PRAW ALBERT Z", "Albert Z. Praw");
  shows("Knopper Douglas S", "Douglas S. Knopper");
  shows("Shah Rutul R", "Rutul R. Shah");
  shows("Harris Brian G", "Brian G. Harris");
  shows("Ostling Danita K", "Danita K. Ostling");
  shows("Charney Laurence N", "Laurence N. Charney");
  shows("Sullivan Michael C", "Michael C. Sullivan");
  shows("Leuba Sean P", "Sean P. Leuba");
  shows("Spessard Matthew P", "Matthew P. Spessard");

  it("an initial that already carries its period is not doubled", () => {
    expect(deriveDisplayName("Lizzul Paul F.", CONFORMED).display).toBe("Paul F. Lizzul");
    expect(deriveDisplayName("Stewart Frank P.", CONFORMED).display).toBe("Frank P. Stewart");
    expect(deriveDisplayName("Kale Aaron M.", CONFORMED).display).toBe("Aaron M. Kale");
    expect(deriveDisplayName("Yuan Eric S.", CONFORMED).display).toBe("Eric S. Yuan");
  });

  it("a run of dotted initials keeps its own shape", () => {
    expect(deriveDisplayName("Wunsch E.J.", CONFORMED).display).toBe("E.J. Wunsch");
  });
});

describe("full middle names are not initials and keep their spelling", () => {
  shows("ADLER JASON MARC", "Jason Marc Adler");
  shows("Evans Katie Seitz", "Katie Seitz Evans");
  shows("Collins Arthur Reginald", "Arthur Reginald Collins");
  shows("Shapiro Robert Jacob", "Robert Jacob Shapiro");
  shows("Somaratne Ransi Mudalinayake", "Ransi Mudalinayake Somaratne");
});

describe("suffixes stay at the end (A1)", () => {
  shows("Pooler Joseph W. Jr.", "Joseph W. Pooler Jr.");
  shows("TABACCO JOSEPH J JR", "Joseph J. Tabacco Jr.");
  // synthetic: the roman-numeral shapes the live sample lacked
  shows("WASHINGTON GEORGE III", "George Washington III");
  shows("OSBORNE OZZY SR", "Ozzy Osborne Sr.");

  it("a roman numeral never takes a period and is never title-cased to Iii", () => {
    expect(deriveDisplayName("ADAMS JOHN II", CONFORMED).display).toBe("John Adams II");
    expect(deriveDisplayName("GATES HORATIO IV", CONFORMED).display).toBe("Horatio Gates IV");
  });
});

describe("casing rule 1: an ALL-CAPS filing carries no case information, so it is rebuilt", () => {
  shows("SRINIVASAN MALLIKA", "Mallika Srinivasan");
  shows("BARRETT MICHAEL G.", "Michael G. Barrett");
  shows("DONEGAL MUTUAL INSURANCE CO", "Donegal Mutual Insurance Co");
  // synthetic: Mc and O', which only need handling in the shouted branch
  shows("MCDONALD ANGUS", "Angus McDonald");
  shows("O'BRIEN SEAN", "Sean O'Brien");
  shows("SMITH-JONES ALICE", "Alice Smith-Jones");

  it("Mac is NOT Mc: there is no safe rule, so MACK stays Mack", () => {
    expect(deriveDisplayName("MACK RONALD", CONFORMED).display).toBe("Ronald Mack");
    expect(deriveDisplayName("MACDONALD IAN", CONFORMED).display).toBe("Ian Macdonald");
  });
});

describe("casing rule 2: a filing that MIXES case chose its casing and keeps it", () => {
  shows("McNulty Matthew J", "Matthew J. McNulty");
  shows("Shu Lee-Lean", "Lee-Lean Shu");
  shows("Radkoski Lindsay J.", "Lindsay J. Radkoski");
  shows("Rubenstein Andrew H.", "Andrew H. Rubenstein");
  shows("Werner Ryan D.", "Ryan D. Werner");
  shows("Stewart Andrew J.", "Andrew J. Stewart");

  it("mixed-case surnames are never destroyed by a lowercase-then-capitalize pass", () => {
    // The bug this rule exists to prevent: McNulty -> Mcnulty, DeLuca -> Deluca.
    expect(caseToken("McNulty", false)).toBe("McNulty");
    expect(caseToken("DeLuca", false)).toBe("DeLuca");
    expect(caseToken("O'Brien", false)).toBe("O'Brien");
    expect(caseToken("Lee-Lean", false)).toBe("Lee-Lean");
  });

  it("short all-caps tokens inside a mixed string are acronyms and survive", () => {
    expect(deriveDisplayName("TAFE Motors & Tractors Ltd", CONFORMED).display).toBe("TAFE Motors & Tractors Ltd");
    expect(deriveDisplayName("GIC Private Ltd", CONFORMED).display).toBe("GIC Private Ltd");
  });
});

describe("ENTITIES ARE NEVER REORDERED (A1) — the rule that protects identity", () => {
  shows("Tractors & Farm Equipment Ltd", "Tractors & Farm Equipment Ltd");
  shows("Robinhood Markets, Inc.", "Robinhood Markets, Inc.");
  shows("Sit Investment Associates, Inc.", "Sit Investment Associates, Inc.");

  it("every entity keyword class is detected", () => {
    for (const filed of [
      "BENDER INVESTMENT COMPANY",
      "About Investment Pte. Ltd.",
      "Baupost Group LLC",
      "SOME FAMILY FOUNDATION",
      "Acme Capital Partners LP",
      "Widget Holdings PLC",
      "Northern Asset Management",
      "State Pension System",
    ]) {
      expect(deriveDisplayName(filed).shape).toBe("entity");
    }
  });

  it("a digit anywhere means entity, because people are not filed with digits", () => {
    expect(deriveDisplayName("THE 2018 SMITH TRUST", CONFORMED).shape).toBe("entity");
    expect(deriveDisplayName("FUND III LP", CONFORMED).shape).toBe("entity");
  });

  it("the boilerplate tail drops from the DISPLAY only", () => {
    const filed = "THE FORTUNA TRUST U/T/A DTD 06/01/2018";
    expect(deriveDisplayName(filed).display).toBe("The Fortuna Trust");
    // and the derivation is still provable against the full filed string
    expect(displayIsDerivable(filed, deriveDisplayName(filed).display)).toBe(true);
  });
});

describe("FAIL SAFE TOWARD NOT FLIPPING (A1) — the governing instinct", () => {
  it("one token cannot be reordered", () => {
    expect(deriveDisplayName("Cher", CONFORMED)).toEqual({ display: "Cher", shape: "as-filed" });
  });

  it("five or more tokens is likelier an unflagged institution than a person", () => {
    const r = deriveDisplayName("SOME LONG UNFLAGGED NAME HERE", CONFORMED);
    expect(r.shape).toBe("as-filed");
    expect(r.display).toBe("Some Long Unflagged Name Here");
  });

  it("a keyword-free two-token name is NOT flipped without a natural-person signal", () => {
    // "Pershing Square" is the shape the keyword list cannot catch. Flipping it
    // would invent "Square Pershing" — a person who does not exist.
    const noSignal = deriveDisplayName("Pershing Square", { conformed: true, isOfficer: false, isDirector: false });
    expect(noSignal).toEqual({ display: "Pershing Square", shape: "as-filed" });
  });

  it("the filing's own relationship flags RELEASE the flip, they do not create it", () => {
    expect(deriveDisplayName("Hite Christopher", { conformed: true, isOfficer: true }).display).toBe("Christopher Hite");
    expect(deriveDisplayName("Hite Christopher", { conformed: true, isDirector: true }).display).toBe("Christopher Hite");
    // A three-token name is already unambiguous enough not to need the hint.
    expect(deriveDisplayName("FALTISCHEK DENISE M", { conformed: true, isOfficer: false, isDirector: false }).display).toBe(
      "Denise M. Faltischek",
    );
  });

  it("never throws and never empties a non-empty name", () => {
    for (const s of ["", "   ", "X", "A B", "...", "-", "Ünal Deniz", "李 明"]) {
      const r = deriveDisplayName(s, CONFORMED);
      expect(typeof r.display).toBe("string");
      if (s.trim() !== "") expect(r.display.length).toBeGreaterThan(0);
    }
  });
});

describe("EDGAR IS NOT UNIFORMLY LAST-FIRST — measured on 115 live production filers", () => {
  // A minority of filer agents ignore the field convention and type the name
  // the human way. Flipping those invents a person, so both signals below
  // exist only to WITHHOLD a flip.

  it("a periodled MIDDLE initial means the name is already natural", () => {
    expect(deriveDisplayName("Nigel W. Morris", CONFORMED).display).toBe("Nigel W. Morris");
    expect(deriveDisplayName("KEVIN J. KRAUS", CONFORMED).display).toBe("Kevin J. Kraus");
    expect(deriveDisplayName("Paul B. Murphy Jr.", CONFORMED).display).toBe("Paul B. Murphy Jr.");
  });

  it("a BARE middle initial does not, and this is the counterexample that bounds the rule", () => {
    // `Ponder L Barbee IV` is EDGAR order with `L` as the given name.
    expect(deriveDisplayName("Ponder L Barbee IV", CONFORMED).display).toBe("L. Barbee Ponder IV");
  });

  it("in EDGAR order the initial lands LAST, and that stays conclusive", () => {
    expect(deriveDisplayName("Dhillon Mannik S.", CONFORMED).display).toBe("Mannik S. Dhillon");
    expect(deriveDisplayName("Craig Jonathan M.", CONFORMED).display).toBe("Jonathan M. Craig");
    // `Stewart` is a fine given name; the trailing initial outranks the list.
    expect(deriveDisplayName("Stewart Frank P.", CONFORMED).display).toBe("Frank P. Stewart");
  });

  it("a leading given name with a non-given surname means natural order", () => {
    expect(deriveDisplayName("KATHERINE ANN MAHER", CONFORMED).display).toBe("Katherine Ann Maher");
    expect(deriveDisplayName("Mat Ishbia", CONFORMED).display).toBe("Mat Ishbia");
    expect(deriveDisplayName("David Zeiden", CONFORMED).display).toBe("David Zeiden");
    expect(deriveDisplayName("Cheryl de Mesa Graziano", CONFORMED).display).toBe("Cheryl de Mesa Graziano");
    expect(deriveDisplayName("GEORGE H POSTE", CONFORMED).display).toBe("George H. Poste");
  });

  it("a given name at BOTH ends still flips, because that is not the signature", () => {
    expect(deriveDisplayName("Sheena Jonathan", CONFORMED).display).toBe("Jonathan Sheena");
    expect(deriveDisplayName("Harrison Gina", CONFORMED).display).toBe("Gina Harrison");
    expect(deriveDisplayName("Carter Donald Chad", CONFORMED).display).toBe("Donald Chad Carter");
  });

  it("the given-name list NEVER creates a flip, only withholds one", () => {
    // A surname absent from the list is flipped on EDGAR's convention, which is
    // the right default for the large majority.
    expect(deriveDisplayName("Blecharczyk Nathan", CONFORMED).display).toBe("Nathan Blecharczyk");
    expect(deriveDisplayName("Bancel Stephane", CONFORMED).display).toBe("Stephane Bancel");
    expect(deriveDisplayName("Somaratne Ransi Mudalinayake", CONFORMED).display).toBe("Ransi Mudalinayake Somaratne");
  });
});

describe("live entity shapes the synthetic corpus missed", () => {
  it("a bracketed jurisdiction is an entity marker, and brackets do not eat the capital", () => {
    expect(deriveDisplayName("YUCCA (JERSEY) SLP", CONFORMED)).toEqual({
      display: "Yucca (Jersey) Slp",
      shape: "entity",
    });
    expect(deriveDisplayName("INDEX VENTURES GROWTH III (JERSEY), L.P.", CONFORMED).display).toBe(
      "Index Ventures Growth III (Jersey), L.P.",
    );
  });

  it("mixed-case fund names keep their own styling", () => {
    expect(deriveDisplayName("CapitalG IV LP", CONFORMED).display).toBe("CapitalG IV LP");
    expect(deriveDisplayName("Gen IV Investment Opportunities, LLC", CONFORMED).display).toBe(
      "Gen IV Investment Opportunities, LLC",
    );
  });
});

describe("THE MISUSE HAZARD, pinned so it stays visible", () => {
  it("a name already in NATURAL order is flipped, because the module cannot tell", () => {
    // This is not a bug to fix, it is the premise: EDGAR files LAST FIRST and
    // no heuristic separates "Doe Jane" from "Jane Doe". The guard is the CALL
    // SITE — only sources with a verified LAST-FIRST convention may call this.
    expect(deriveDisplayName("Jane Doe", { conformed: true, isOfficer: true }).display).toBe("Doe Jane");
  });

  it("the only two licensed call sites are the two EDGAR name fields", () => {
    // rptOwnerName (Form 4) and nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold
    // (Form 144), both live-verified LAST FIRST on 2026-08-07.
    expect(deriveDisplayName("Hermance David F.", CONFORMED).display).toBe("David F. Hermance");
    expect(deriveDisplayName("Knopper Douglas S", CONFORMED).display).toBe("Douglas S. Knopper");
  });
});

describe("particles (A1)", () => {
  // Synthetic: no particle surname appeared in the 60-filing live sample.
  shows("VAN HALEN EDWARD", "Edward van Halen");
  shows("DEL TORO GUILLERMO", "Guillermo del Toro");
  shows("Van Der Berg John", "John Van Der Berg");

  it("a particle run stays with the surname it belongs to", () => {
    expect(deriveDisplayName("VAN DER BERG JOHN", CONFORMED).display).toBe("John van der Berg");
  });

  it("a mixed-case filing keeps the particle casing the filer chose", () => {
    expect(deriveDisplayName("De Niro Robert", CONFORMED).display).toBe("Robert De Niro");
  });
});

describe("THE LICENSING PROPERTY — display_name is derivable, not invented", () => {
  // entityCheck licenses whatever appears in the payload JSON, and display_name
  // now lives in that JSON, so the validator cannot be what proves this honest.
  // This is the independent proof.
  const CORPUS = [
    "Blecharczyk Nathan", "FALTISCHEK DENISE M", "Merton Carl A",
    "THE FORTUNA TRUST U/T/A DTD 06/01/2018", "GIC Private Ltd", "Refo SCSp",
    "Lizzul Paul F.", "Hite Christopher", "Faga Daniel", "Stewart Frank P.",
    "Harrison Gina", "FEGO PAUL J", "Urist Marshall", "Knopper Douglas S",
    "CREVISTON STEVEN E", "ADLER JASON MARC", "Chesley Philip", "BRUGGEWORTH ROBERT A",
    "Buonasera David", "Brown Grant", "Rubenstein Andrew H.", "Shu Lee-Lean",
    "Pooler Joseph W. Jr.", "Esposito Liliana", "Evans Katie Seitz", "Kale Aaron M.",
    "Ahuja Amrita", "Phillips Amy", "McNulty Matthew J", "Shah Rutul R",
    "Yuan Eric S.", "Harris Brian G", "KRAMER RONALD J", "MEHMEL ROBERT F",
    "Ostling Danita K", "Radkoski Lindsay J.", "Charney Laurence N",
    "Tractors & Farm Equipment Ltd", "TAFE Motors & Tractors Ltd", "SRINIVASAN MALLIKA",
    "Allaire Jeremy", "BARRETT MICHAEL G.", "Werner Ryan D.", "Robinhood Markets, Inc.",
    "Spessard Matthew P", "Sanborn Scott", "Collins Arthur Reginald", "Wunsch E.J.",
    "Leuba Sean P", "Sullivan Michael C", "PRAW ALBERT Z", "Stewart Andrew J.",
    "Somaratne Ransi Mudalinayake", "Bartholomew Meghan", "Munsch Frederick",
    "Bancel Stephane", "Pomel Olivier", "Melwani Praveer", "Sheena Jonathan",
    "Gendel Mitchell", "ROBBINS LARRY", "ARCHER TIMOTHY", "LEMONIS MARCUS",
    "TABACCO JOSEPH J JR", "Shapiro Robert Jacob", "Hakim Anat", "Stifano Mario",
    "DONEGAL MUTUAL INSURANCE CO", "Sit Investment Associates, Inc.",
  ];

  it("every display over the whole live corpus is derivable from its filed name", () => {
    const bad = CORPUS.filter((f) => !displayIsDerivable(f, deriveDisplayName(f, CONFORMED).display));
    expect(bad).toEqual([]);
  });

  it("the whole live corpus is a token permutation, never a token invention", () => {
    for (const filed of CORPUS) {
      const { display } = deriveDisplayName(filed, CONFORMED);
      // Every alphabetic run in the output traces to one in the input.
      for (const run of display.toUpperCase().match(/[A-Z]+/g) ?? []) {
        expect(filed.toUpperCase()).toContain(run);
      }
    }
  });

  it("rejects an invented token, which is what the property is for", () => {
    expect(displayIsDerivable("Merton Carl A", "Carl A. Merton")).toBe(true);
    expect(displayIsDerivable("Merton Carl A", "Carl Anthony Merton")).toBe(false);
    expect(displayIsDerivable("GIC Private Ltd", "GIC Private Limited")).toBe(false);
  });

  it("is deterministic: the same filed name always yields the same display", () => {
    for (const filed of CORPUS) {
      expect(deriveDisplayName(filed, CONFORMED)).toEqual(deriveDisplayName(filed, CONFORMED));
    }
  });
});

// ---------------------------------------------------------------------------
// B-12: what the adversarial pass found, each pinned by the real filer that
// produced it. None of these are hypotheses; every input below is a verbatim
// name from a live SEC filing or from EDGAR's conformed-name index.

describe("B-12.3 — reorder is licensed ONLY from a conformed name", () => {
  it("Form 144 free text is never reordered, and this is the case that proved it", () => {
    // CIK 0001514725 filed BOTH on 2026-08-07. The Form 144 free-text field and
    // the Form 4 conformed name disagree, and reordering the free text produced
    // `D. Miller Kendra` — a person who does not exist — on a card linking to
    // the filing that contradicts it.
    expect(deriveDisplayName("KENDRA D MILLER", { isOfficer: true }).display).toBe("Kendra D Miller");
    expect(deriveDisplayName("Miller Kendra D", CONFORMED).display).toBe("Kendra D. Miller");
  });

  it("conformed defaults to FALSE, so a caller who has not thought about it is safe", () => {
    expect(deriveDisplayName("Blecharczyk Nathan").display).toBe("Blecharczyk Nathan");
    expect(deriveDisplayName("Blecharczyk Nathan").shape).toBe("as-filed");
  });

  it("the other verified same-day contradiction, Dianthus Therapeutics", () => {
    expect(deriveDisplayName("MARINO GARCIA", { isOfficer: true }).display).toBe("Marino Garcia");
    expect(deriveDisplayName("Garcia Marino", CONFORMED).display).toBe("Marino Garcia");
  });
});

describe("B-12.4(a) — ambiguity suppresses the flip", () => {
  it("a two-word surname is indistinguishable from a middle name, so it is not guessed", () => {
    // Caryn Seidman-Becker (CLEAR) and Julia Brau Donnelly (Pinterest). Both
    // rendered as invented people before this rule.
    expect(deriveDisplayName("Seidman Becker Caryn", CONFORMED)).toEqual({
      display: "Seidman Becker Caryn",
      shape: "as-filed",
    });
    expect(deriveDisplayName("Brau Donnelly Julia", CONFORMED).shape).toBe("as-filed");
  });

  it("but the identical token shape with a given name at position 1 still flips", () => {
    expect(deriveDisplayName("Adler Jason Marc", CONFORMED).display).toBe("Jason Marc Adler");
    expect(deriveDisplayName("Evans Katie Seitz", CONFORMED).display).toBe("Katie Seitz Evans");
    expect(deriveDisplayName("Collins Arthur Reginald", CONFORMED).display).toBe("Arthur Reginald Collins");
  });

  it("an initial at position 1 is never a two-word surname", () => {
    expect(deriveDisplayName("CUBLEY H DEAN DR", CONFORMED).display).toBe("H. Dean Cubley Dr.");
  });

  it("THE INVARIANT: no path may emit a token the filing did not contain", () => {
    const CASES = [
      "Seidman Becker Caryn", "SCHMIDT UTA", "O BRIEN DANIEL B", "TAYLOR THOMAS V",
      "Mc Carthy Liam", "VAN HALEN EDWARD", "G.M. JOHNSTON FAMILY, LLLP",
      "Flammer Martina M.D.", "DR TORSTEN G KREINDL", "ÖZTÜRK MEHMET",
    ];
    for (const filed of CASES) {
      const { display } = deriveDisplayName(filed, CONFORMED);
      expect(displayIsDerivable(filed, display)).toBe(true);
    }
  });
});

describe("B-12.5 — the ten defects, by the filer that produced each", () => {
  it("the trust-marker tail cut deleted a person's given name (SCHMIDT UTA)", () => {
    expect(deriveDisplayName("SCHMIDT UTA", CONFORMED).display).toBe("Uta Schmidt");
    expect(deriveDisplayName("BAUER UTA K", CONFORMED).display).toBe("Uta K. Bauer");
    // the punctuated marker still trims, because no given name collides with it
    expect(deriveDisplayName("THE FORTUNA TRUST U/T/A DTD 06/01/2018", CONFORMED).display).toBe("The Fortuna Trust");
  });

  it("EDGAR space-splits apostrophe surnames (O BRIEN DANIEL B, D AMATO ALFONSE M)", () => {
    // The apostrophe is NOT restored: that would add a character the filing
    // does not contain. Ugly and true beats pretty and invented.
    expect(deriveDisplayName("O BRIEN DANIEL B", CONFORMED).display).toBe("Daniel B. O Brien");
    expect(deriveDisplayName("O BRIEN BETTY M", CONFORMED).display).toBe("Betty M. O Brien");
    expect(deriveDisplayName("D AMATO ALFONSE M", CONFORMED).display).toBe("Alfonse M. D Amato");
  });

  it("and space-splits Mc surnames too (Mc Carthy Liam)", () => {
    expect(deriveDisplayName("Mc Carthy Liam", { conformed: true, isDirector: true }).display).toBe("Liam Mc Carthy");
  });

  it("the suffix stripper ate a middle initial (TAYLOR THOMAS V)", () => {
    expect(deriveDisplayName("TAYLOR THOMAS V", CONFORMED).display).toBe("Thomas V. Taylor");
    // the unambiguous numerals are still suffixes
    expect(deriveDisplayName("WASHINGTON GEORGE III", CONFORMED).display).toBe("George Washington III");
    expect(deriveDisplayName("Ponder L Barbee IV", CONFORMED).display).toBe("L. Barbee Ponder IV");
  });

  it("LLLP and other legal forms were missing (G.M. JOHNSTON FAMILY, LLLP)", () => {
    const r = deriveDisplayName("G.M. JOHNSTON FAMILY, LLLP", { conformed: true, isOfficer: false, isDirector: false });
    expect(r.shape).toBe("entity");
    expect(r.display).toBe("G.M. Johnston Family, LLLP");
    expect(deriveDisplayName("EQUINOX PARTNERS LP", CONFORMED).display).toBe("Equinox Partners LP");
    expect(deriveDisplayName("SESSIONS, LLC", CONFORMED).display).toBe("Sessions, LLC");
  });

  it("a leading initial means natural order (R BENTLEY OFFUTT, C FREDERICK LANE)", () => {
    expect(deriveDisplayName("R BENTLEY OFFUTT", CONFORMED).display).toBe("R. Bentley Offutt");
    expect(deriveDisplayName("C FREDERICK LANE", CONFORMED).display).toBe("C. Frederick Lane");
    expect(deriveDisplayName("D ATRI E LANG", CONFORMED).display).toBe("D. Atri E. Lang");
  });

  it("two-token natural order is suppressed (Biju Nair, Mat Ishbia)", () => {
    expect(deriveDisplayName("Biju Nair", CONFORMED).shape).toBe("as-filed");
    expect(deriveDisplayName("Mat Ishbia", CONFORMED).shape).toBe("as-filed");
  });

  it("credentials are not middle names (Flammer Martina M.D., BUCALO LOUIS R MD)", () => {
    expect(deriveDisplayName("Flammer Martina M.D.", CONFORMED).display).toBe("Martina Flammer M.D.");
    expect(deriveDisplayName("BUCALO LOUIS R MD", CONFORMED).display).toBe("Louis R. Bucalo MD");
    expect(deriveDisplayName("YAKATAN GERALD J PHD", CONFORMED).display).toBe("Gerald J. Yakatan PhD");
    expect(deriveDisplayName("DR TORSTEN G KREINDL", CONFORMED).display).toBe("Dr. Torsten G. Kreindl");
  });

  it("displayIsDerivable was ASCII-only, so a wholly foreign display passed", () => {
    // The regression case, verbatim from the review.
    expect(displayIsDerivable("Smith John", "Иванов Иван")).toBe(false);
    expect(displayIsDerivable("Smith John", "李明")).toBe(false);
    expect(displayIsDerivable("Smith John", "محمد بن سلمان")).toBe(false);
    expect(displayIsDerivable("Smith John", "😀")).toBe(true); // no letters at all is still vacuous, and harmless
    // and it still accepts a genuine reordering of non-ASCII names
    expect(displayIsDerivable("ÖZTÜRK MEHMET", "Mehmet Öztürk")).toBe(true);
  });

  it("casing is Unicode-aware (ÖZTÜRK MEHMET, ÅKERSON DANIEL)", () => {
    expect(deriveDisplayName("ÖZTÜRK MEHMET", CONFORMED).display).toBe("Mehmet Öztürk");
    expect(deriveDisplayName("ÅKERSON DANIEL", CONFORMED).display).toBe("Daniel Åkerson");
  });

  it("Saint is never lower-cased (ST JOHN JONELLE, ST JOHN THOMAS P)", () => {
    expect(deriveDisplayName("ST JOHN JONELLE", CONFORMED).display).toBe("Jonelle St John");
    expect(deriveDisplayName("ST JOHN THOMAS P", CONFORMED).display).toBe("Thomas P. St John");
    // an ordinary particle still lowers
    expect(deriveDisplayName("VAN HALEN EDWARD", CONFORMED).display).toBe("Edward van Halen");
  });

  it("ampersands and slashes survive folding (R&G CAPITAL TRUST V)", () => {
    expect(deriveDisplayName("R&G CAPITAL TRUST V", CONFORMED).display).toBe("R&G Capital Trust V");
  });
});
