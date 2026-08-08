import { describe, expect, it } from "vitest";
import MANIFEST from "../docs/governance.manifest.json";
import CLAUDE_MD from "../CLAUDE.md?raw";
import LEDGER from "../docs/p5-ledger.md?raw";
import PERSONA from "../docs/persona.md?raw";
import SOURCE_REGISTRY from "../docs/SOURCE_REGISTRY.md?raw";
import EXCLUSIONS from "../docs/EXCLUSIONS.md?raw";
import DATA_USE from "../docs/DATA_USE_POLICY.md?raw";
import PUBLIC_DOC from "../docs/PUBLIC.md?raw";
import RUNBOOK from "../docs/RUNBOOK.md?raw";
import IMAGE_POLICY from "../docs/IMAGE_POLICY.md?raw";

// p6-02 / B-18.1. THE GUARD THAT DID NOT EXIST.
//
// CLAUDE.md went 6,835 bytes -> 0 and MERGED at f8e515e with the whole suite
// green, because nothing in the repo asserted on it. The five non-negotiables,
// the relay protocol and every engineering-discipline rule went with it, and
// both sessions kept citing rules that no longer existed in the tree.
//
// TWO CHECKS, ONE MANIFEST. `scripts/check-governance.mjs` is the CI gate and
// runs unconditionally, because ci.yml's docs-only short-circuit would skip
// this very suite on a PR that touches only markdown — which is every PR that
// can empty these files. This suite covers the same ground for local runs and
// for any change that does reach it. Both read docs/governance.manifest.json,
// so they cannot drift.

const BODIES: Record<string, string> = {
  "CLAUDE.md": CLAUDE_MD,
  "docs/p5-ledger.md": LEDGER,
  "docs/persona.md": PERSONA,
  "docs/SOURCE_REGISTRY.md": SOURCE_REGISTRY,
  "docs/EXCLUSIONS.md": EXCLUSIONS,
  "docs/DATA_USE_POLICY.md": DATA_USE,
  "docs/PUBLIC.md": PUBLIC_DOC,
  "docs/RUNBOOK.md": RUNBOOK,
  "docs/IMAGE_POLICY.md": IMAGE_POLICY,
};

describe("the manifest and this suite cannot drift", () => {
  it("every manifest file is imported here", () => {
    // Adding a file to the manifest without wiring it in fails LOUDLY rather
    // than silently going unchecked by the local suite.
    const missing = MANIFEST.files.map((f) => f.path).filter((p) => BODIES[p] === undefined);
    expect(missing).toEqual([]);
  });

  it("every fingerprint names a file the manifest covers", () => {
    const known = new Set(MANIFEST.files.map((f) => f.path));
    expect(MANIFEST.fingerprint.filter((f) => !known.has(f.file))).toEqual([]);
  });

  it("no anchor spans a line break, which a reflow would break", () => {
    const spanning = [
      ...MANIFEST.files.flatMap((f) => f.anchors),
      ...MANIFEST.fingerprint.map((f) => f.contains),
    ].filter((a) => a.includes("\n"));
    expect(spanning).toEqual([]);
  });
});

describe("governance files are intact", () => {
  for (const spec of MANIFEST.files) {
    describe(spec.path, () => {
      const body = BODIES[spec.path]!;

      it("is not empty", () => {
        expect(body.trim().length).toBeGreaterThan(0);
      });

      it(`is at least ${spec.minBytes} bytes`, () => {
        expect(body.length).toBeGreaterThanOrEqual(spec.minBytes);
      });

      for (const anchor of spec.anchors) {
        it(`still contains ${JSON.stringify(anchor)}`, () => {
          expect(body).toContain(anchor);
        });
      }
    });
  }
});

describe("named rules survive by name (B-18.1 fingerprint)", () => {
  // Each is cited by commit messages that outlive any one session. Losing one
  // silently makes the record reference doctrine nobody can read.
  for (const fp of MANIFEST.fingerprint) {
    it(`${fp.name} — in ${fp.file}`, () => {
      expect(BODIES[fp.file]!).toContain(fp.contains);
    });
  }
});
