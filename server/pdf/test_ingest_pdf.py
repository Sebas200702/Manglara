"""Tests of PDF text extraction used by knowledge ingestion.

Run without pytest or network, from `server/`: `python -m pdf.test_ingest_pdf`.
They need the required env of config.py (dummy values are enough).
"""

import sys
import tempfile

from pdf.ingest import extract_text_pdf

_passed = 0


def check(cond, label):
    global _passed
    if not cond:
        raise AssertionError(label)
    _passed += 1
    print(f"  ok  {label}")


def build_pdf(page_texts: list[str]) -> bytes:
    """Minimal valid PDF, one Helvetica text line per page ('' = blank page)."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for text in page_texts:
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET" if text else ""
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        content_id = len(objs)
        objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                    f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>")
        kids.append(f"{len(objs)} 0 R")
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>"

    out = b"%PDF-1.4\n"
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{body}\nendobj\n".encode("latin-1")
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return out


def test_extracts_text_per_page_and_skips_blank_pages():
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(build_pdf(["Hola desde el manglar", "", "Modulo 5 IKIGAI"]))
        f.flush()
        pages = extract_text_pdf(f.name)
    check([p["page_num"] for p in pages] == [1, 3], "blank pages are skipped, page numbers kept 1-based")
    check("Hola desde el manglar" in pages[0]["text"], "text of page 1 is extracted")
    check("Modulo 5 IKIGAI" in pages[1]["text"], "text of page 3 is extracted")


def test_does_not_depend_on_pymupdf():
    check("fitz" not in sys.modules and "pymupdf" not in sys.modules,
          "ingestion does not load PyMuPDF (AGPL)")


if __name__ == "__main__":
    test_extracts_text_per_page_and_skips_blank_pages()
    test_does_not_depend_on_pymupdf()
    print(f"{_passed} checks OK")
