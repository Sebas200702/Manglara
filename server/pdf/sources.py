"""Documents that may provide knowledge to Manglara's curriculum conversations."""

CURRICULUM_SOURCES = (
    "Introduccion_Curriculo_Verde.docx",
    "2_Modulo1_HabilidadesVerdes.docx",
    "3_Modulo2_HabilidadesVerdes.docx",
    "4_Modulo3_HabilidadesVerdes.docx",
    "5_Modulo4_HabilidadesVerdes.docx",
    "6_Modulo5_HabilidadesVerdes.docx",
)


def is_curriculum_source(name: str) -> bool:
    return name in CURRICULUM_SOURCES


def ready_curriculum_document_ids(documents: list[dict]) -> list[str]:
    return [
        document["id"]
        for document in documents
        if document["status"] == "ready" and is_curriculum_source(document["name"])
    ]
