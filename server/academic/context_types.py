"""Contrato estricto de contexto recibido desde pasarela autenticada."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

_STRICT = ConfigDict(extra="forbid", strict=True, frozen=True)
_FILE_TYPES = (
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
)


class PageFile(BaseModel):
    model_config = _STRICT
    id: str = Field(pattern=r"^[1-9]\d{0,19}$")
    name: str = Field(min_length=1, max_length=255)
    mimetype: Literal[_FILE_TYPES]


class PageSource(BaseModel):
    """Página Moodle firmada en el lanzamiento; texto extraído por la pasarela."""
    model_config = _STRICT
    kind: Literal["page"]
    pageId: str = Field(pattern=r"^[1-9]\d{0,19}$")
    title: str = Field(min_length=1, max_length=255)
    files: list[PageFile] = Field(max_length=20)
    text: str = Field(min_length=1, max_length=100000)


class AcademicContext(BaseModel):
    model_config = _STRICT
    issuer: str = Field(min_length=1, max_length=256)
    clientId: str = Field(min_length=1, max_length=256)
    deploymentId: str = Field(min_length=1, max_length=128)
    courseId: str = Field(min_length=1, max_length=128)
    resourceId: str = Field(min_length=1, max_length=128)
    lessonCode: str = Field(pattern=r"^(HV-M[1-5]-L[1-3]|PAGE-[1-9]\d{0,19})$")
    sourceVersion: str = Field(pattern=r"^(\d{4}-\d{2}-\d{2}|[1-9]\d{0,19})$")
    subject: str = Field(min_length=1, max_length=256)
    mode: Literal["learner", "instructor"]
    source: PageSource | None = None

    @model_validator(mode="after")
    def _source_matches_lesson(self):
        """Piloto usa cartilla con versión fechada; página exige fuente firmada del mismo id."""
        if self.lessonCode.startswith("PAGE-"):
            if not self.source or self.lessonCode != f"PAGE-{self.source.pageId}" or "-" in self.sourceVersion:
                raise ValueError("ACADEMIC_SOURCE_UNAVAILABLE")
        elif self.source is not None or "-" not in self.sourceVersion:
            raise ValueError("ACADEMIC_SOURCE_UNAVAILABLE")
        return self
