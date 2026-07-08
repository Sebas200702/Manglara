"""Quick script to preview PDF content."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from pdf.ingest import extract_text_pdf

pages = extract_text_pdf(str(Path(__file__).resolve().parent.parent / "cartillas/Info_Evento_Curriculo_Verde_Ampliado.pdf"))
for p in pages[:5]:
    print(f"--- Pagina {p['page_num']} ---")
    print(p["text"][:800])
    print()
