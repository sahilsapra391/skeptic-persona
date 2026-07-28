#!/usr/bin/env python3
"""Turn House PTR PDFs into text for the Worker to parse.

DELIBERATELY DUMB. This script knows how to open an encrypted PDF and read
its text layer. It knows nothing about transactions, owners, amount bands or
tickers, and it must stay that way: the Worker owns the parser, that parser
has live fixtures and a completeness check, and a second implementation here
would drift from it the first time either changed. Drift in this file means a
wrong number in a post about a member of Congress's trades.

Live-verified 2026-07-28: e-filed House PTR PDFs are RC4-encrypted with an
EMPTY owner password and carry a real text layer. Scanned filings (older
7-digit DocIDs) decrypt fine and yield nothing, which is why empty output is
reported rather than treated as an error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from pypdf import PdfReader


def extract(path: Path) -> str:
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        # Empty owner password. If a future filing carries a real one, decrypt
        # fails and the document is skipped rather than silently half-read.
        if reader.decrypt("") == 0:
            raise ValueError("encrypted with a non-empty password")
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def main(pdf_dir: str, out_path: str) -> int:
    docs = []
    skipped = []
    for pdf in sorted(Path(pdf_dir).glob("*.pdf")):
        doc_id = pdf.stem
        try:
            text = extract(pdf)
        except Exception as exc:  # noqa: BLE001 - one bad PDF must not sink the run
            skipped.append((doc_id, str(exc)))
            print(f"::warning::{doc_id}: {exc}", file=sys.stderr)
            continue
        if not text.strip():
            # A scan. Sent anyway: the Worker counts the attempt and stops
            # offering the document, which is how the retry loop terminates.
            skipped.append((doc_id, "no text layer"))
        docs.append({"docId": doc_id, "text": text})

    Path(out_path).write_text(json.dumps({"docs": docs}), encoding="utf-8")
    print(f"extracted {len(docs)} document(s), {len(skipped)} without usable text")
    for doc_id, why in skipped:
        print(f"  {doc_id}: {why}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: extract_house_pdfs.py <pdf_dir> <out.json>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
