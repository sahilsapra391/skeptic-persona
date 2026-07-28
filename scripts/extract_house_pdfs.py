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
7-digit DocIDs) decrypt fine and yield nothing.

EVERY OFFERED DOCUMENT IS REPORTED, including ones that failed to download or
failed to open, as an empty-text entry. That is what terminates the retry
loop: the Worker counts an attempt per document it hears about, and stops
offering a document after three. A document dropped silently here is one the
Worker re-offers every single day forever.
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
        # fails and the document is reported empty rather than half-read.
        if reader.decrypt("") == 0:
            raise ValueError("encrypted with a non-empty password")
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def main(pending_path: str, pdf_dir: str, out_path: str) -> int:
    offered = [d["docId"] for d in json.loads(Path(pending_path).read_text())["docs"]]

    docs = []
    problems = []
    for doc_id in offered:
        pdf = Path(pdf_dir) / f"{doc_id}.pdf"
        if not pdf.exists():
            # Download failed outright (connection error, or a non-2xx that
            # curl -f refused to write). Still reported, so it counts.
            problems.append((doc_id, "not downloaded"))
            docs.append({"docId": doc_id, "text": ""})
            continue
        try:
            text = extract(pdf)
        except Exception as exc:  # noqa: BLE001 - one bad PDF must not sink the run
            problems.append((doc_id, str(exc)))
            print(f"::warning::{doc_id}: {exc}", file=sys.stderr)
            docs.append({"docId": doc_id, "text": ""})
            continue
        if not text.strip():
            problems.append((doc_id, "no text layer (scan)"))
        docs.append({"docId": doc_id, "text": text})

    Path(out_path).write_text(json.dumps({"docs": docs}), encoding="utf-8")
    usable = sum(1 for d in docs if d["text"].strip())
    print(f"offered {len(offered)}, reported {len(docs)}, {usable} with usable text")
    for doc_id, why in problems:
        print(f"  {doc_id}: {why}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: extract_house_pdfs.py <pending.json> <pdf_dir> <out.json>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
