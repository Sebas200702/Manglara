"""Contrato estricto de contexto recibido desde pasarela autenticada."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field


class AcademicContext(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    issuer: str = Field(min_length=1, max_length=256)
    clientId: str = Field(min_length=1, max_length=256)
    deploymentId: str = Field(min_length=1, max_length=128)
    courseId: str = Field(min_length=1, max_length=128)
    resourceId: str = Field(min_length=1, max_length=128)
    lessonCode: str = Field(pattern=r"^HV-M[1-5]-L[1-3]$")
    sourceVersion: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    subject: str = Field(min_length=1, max_length=256)
    mode: Literal["learner", "instructor"]
