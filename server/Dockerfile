# Backend de Manglara: FastAPI + Gemini Live + bot de reuniones (Playwright).
#
# Se parte de python:3.13-slim y no de la imagen oficial de Playwright a
# proposito: requirements.txt pide `playwright>=1.51.0`, asi que pip puede
# resolver una version mas nueva que la del tag de la imagen oficial y el
# navegador ya no coincidiria. Con `playwright install --with-deps` el
# navegador se descarga en el build con la version exacta que quedo instalada.
FROM python:3.13-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Primero las dependencias: esta capa se cachea mientras no cambien.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# Chromium + librerias de sistema (el bot de reuniones necesita el navegador).
RUN python -m playwright install --with-deps chromium

# Usuario sin privilegios: Chromium (vía Playwright) se niega a arrancar como
# root salvo que se le pase --no-sandbox, y no queremos bajar el aislamiento
# del navegador que entra a reuniones ajenas. Chromium necesita un HOME
# escribible para su perfil temporal.
RUN useradd --create-home --uid 1000 --shell /bin/bash manglara

COPY --chown=manglara:manglara . .

USER manglara

EXPOSE 8000

# Dokploy asigna $PORT; 8000 es el default de server/config.py.
# --proxy-headers para que uvicorn use X-Forwarded-For (Traefik va delante).
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips=*"]
