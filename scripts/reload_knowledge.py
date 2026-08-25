"""Re-ingest the curriculum documents into Supabase and show the resulting prompt.

Why a script and not the HTTP API: `/api/documents/upload` always INSERTs, so
calling it again for a document that is already stored leaves two rows, two sets
of chunks and two digests - and `build_knowledge_context` would then feed the
same cartilla to the Live session twice, burning the 60k-char knowledge budget on
duplicates. This walks the same ingest path but archives the superseded row first.

Read-only by default. Nothing is written to Supabase and no Gemini quota is spent
unless `--apply` is passed.

    python scripts/reload_knowledge.py              # what would change
    python scripts/reload_knowledge.py --apply      # do it
    python scripts/reload_knowledge.py --prompt     # print the system prompt
"""

import argparse
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from google import genai as genai_module  # noqa: E402

from config import (  # noqa: E402
    GEMINI_API_KEY,
    SUPABASE_SERVICE_KEY,
    SUPABASE_STORAGE_BUCKET,
    SUPABASE_URL,
)
from db import list_documents, set_document_status  # noqa: E402
from pdf.digest import build_knowledge_context  # noqa: E402
from pdf.ingest import ingest_document  # noqa: E402
from prompt import build_system_prompt  # noqa: E402
from storage import StorageClient  # noqa: E402

CARTILLAS = ROOT / "cartillas"

# `Info_Evento_Curriculo_Verde_Ampliado.pdf` is deliberately absent: the agenda
# and minute-by-minute documents superseded it, and re-ingesting it would put
# stale event details back in front of the model.
SOURCES = [
    "Introduccion_Curriculo_Verde.docx",
    "2_Modulo1_HabilidadesVerdes.docx",
    "3_Modulo2_HabilidadesVerdes.docx",
    "4_Modulo3_HabilidadesVerdes.docx",
    "5_Modulo4_HabilidadesVerdes.docx",
    "6_Modulo5_HabilidadesVerdes.docx",
    "Agenda_Lanzamiento_Curriculo_Verde.docx",
    "Minuto_a_Minuto_Lanzamiento_Curriculo_Verde.docx",
]


async def show_state() -> list[dict]:
    docs = await list_documents()
    print(f"\n=== Supabase: {len(docs)} documentos ===")
    for d in docs:
        digest = d.get("digest") or ""
        print(
            f"  [{d['status']:>8}] {d['name']:<52} "
            f"paginas={d.get('page_count'):<4} digest={len(digest):>6} chars  "
            f"{d.get('created_at', '')[:19]}"
        )
    return docs


async def reload(apply: bool) -> None:
    docs = await show_state()
    by_name: dict[str, list[dict]] = {}
    for d in docs:
        by_name.setdefault(d["name"], []).append(d)

    missing = [s for s in SOURCES if not (CARTILLAS / s).exists()]
    if missing:
        print(f"\n!! faltan en cartillas/: {', '.join(missing)}")
        return

    print(f"\n=== Plan ({'APLICAR' if apply else 'simulacion'}) ===")
    for name in SOURCES:
        existing = by_name.get(name, [])
        live = [d for d in existing if d["status"] != "archived"]
        print(
            f"  {name:<52} "
            f"{'reingesta, archiva ' + str(len(live)) + ' fila(s)' if live else 'ingesta nueva'}"
        )
    orphans = [
        d
        for d in docs
        if d["name"] not in SOURCES and d["status"] != "archived"
    ]
    for d in orphans:
        print(f"  {d['name']:<52} archivar (ya no es fuente canonica)")

    if not apply:
        print("\n(simulacion: no se escribio nada. Repite con --apply)")
        return

    storage = StorageClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET)
    genai_client = genai_module.Client(api_key=GEMINI_API_KEY)

    for name in SOURCES:
        data = (CARTILLAS / name).read_bytes()
        print(f"\n-> ingestando {name} ({len(data) / 1e6:.1f} MB)")
        result = await ingest_document(data, name, storage, genai_client)
        if result["status"] == "error":
            print(f"   ERROR: {result['message']}")
            continue
        print(
            f"   ok: {result['chunks_count']} chunks, {result['pages']} paginas, "
            f"id={result['document_id']}"
        )
        # Only archive the old rows once the replacement is stored, so a failure
        # halfway through never leaves the model with no copy of a cartilla.
        for old in by_name.get(name, []):
            if old["status"] == "archived":
                continue
            await set_document_status(
                old["id"], "archived", message=f"Reemplazado por reingesta de {name}"
            )
            print(f"   archivada fila anterior {old['id']}")

    for d in orphans:
        await set_document_status(
            d["id"], "archived", message="No forma parte de las fuentes canonicas"
        )
        print(f"-> archivado {d['name']}")

    await show_state()


async def show_prompt(out: str | None) -> None:
    docs = await list_documents()
    ready = [d["id"] for d in docs if d["status"] == "ready"]
    knowledge = await build_knowledge_context(ready)
    prompt = build_system_prompt(knowledge)
    if out:
        # Written here rather than by shell redirection: on Windows, Python's
        # stdout falls back to the ANSI codepage when redirected, so `> file`
        # produces a cp1252 file and every accent in the prompt is misread by
        # anything that assumes UTF-8.
        Path(out).write_text(prompt, encoding="utf-8")
        print(f"escrito en {out}", file=sys.stderr)
    else:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(prompt)
    print(
        f"=== {len(ready)} documentos activos | conocimiento {len(knowledge)} chars "
        f"| system prompt {len(prompt)} chars ===",
        file=sys.stderr,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="escribir en Supabase")
    ap.add_argument("--prompt", action="store_true", help="imprimir el system prompt")
    ap.add_argument("--out", help="escribir el system prompt en un archivo UTF-8")
    args = ap.parse_args()
    if args.prompt or args.out:
        asyncio.run(show_prompt(args.out))
    else:
        asyncio.run(reload(args.apply))


if __name__ == "__main__":
    main()
