"""HTTP académico: canje de un uso, cookie protegida y contexto sin identidad pública."""
import os

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import RedirectResponse

from academic.gateway import COOKIE, gateway_call, valid_token
from academic.context_types import AcademicContext
from academic.view_context import require_view, view_key

router = APIRouter()


@router.post("/academic/launch")
async def launch(request: Request, code: str = Form(..., min_length=64, max_length=64)):
    if request.headers.get("origin") != os.environ["ACADEMIC_ORIGIN"] or not valid_token(code):
        raise HTTPException(403, "ACADEMIC_LAUNCH_DENIED")
    try:
        session = await gateway_call("/internal/exchange", {"code": code})
        token = session["token"]
        if not valid_token(token):
            raise ValueError("ACADEMIC_SESSION_INVALID")
        academic = AcademicContext.model_validate(session["academic"]).model_dump()
    except Exception:
        raise HTTPException(401, "ACADEMIC_LAUNCH_EXPIRED") from None
    response = RedirectResponse("/academic?view=" + view_key(academic), status_code=303)
    response.set_cookie(COOKIE, token, secure=True, httponly=True, samesite="lax", max_age=1800)
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/academic/api/context")
async def context(request: Request):
    token = request.cookies.get(COOKIE)
    if not valid_token(token):
        raise HTTPException(401, "ACADEMIC_SESSION_REQUIRED")
    try:
        academic = AcademicContext.model_validate(await gateway_call("/internal/session", {"token": token})).model_dump()
        require_view(academic, request.query_params.get("view"))
    except Exception:
        raise HTTPException(401, "ACADEMIC_SESSION_EXPIRED") from None
    title = academic["source"]["title"] if academic.get("source") else academic["lessonCode"]
    return {"lessonCode": academic["lessonCode"], "lessonTitle": title, "mode": academic["mode"], "sourceVersion": academic["sourceVersion"], "parentOrigin": os.environ["ACADEMIC_PARENT_ORIGIN"], "viewKey": view_key(academic)}
