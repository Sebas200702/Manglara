"""Fuente de verdad del conocimiento activo: la BD (documents.active),
no un allowlist de filenames ni el estado en memoria del proceso.

El orden de lectura del prompt lo fija documents.sort_order. La lista
canónica de archivos en disco (`cartillas/`) se conserva para el script
de re-ingesta, porque él necesita saber QUÉ archivos abrir; no puede
decir qué entra en la sesión (eso lo decide el gestor en la BD).
"""

CURRENT_SOURCES = (
    "Introduccion_Curriculo_Verde.docx",
    "2_Modulo1_HabilidadesVerdes.docx",
    "3_Modulo2_HabilidadesVerdes.docx",
    "4_Modulo3_HabilidadesVerdes.docx",
    "5_Modulo4_HabilidadesVerdes.docx",
    "6_Modulo5_HabilidadesVerdes.docx",
)


def active_document_ids(documents: list[dict]) -> list[str]:
    return [
        d["id"]
        for d in documents
        if d.get("active") and d.get("status") == "ready"
    ]
