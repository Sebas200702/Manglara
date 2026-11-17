FROM python:3.13-slim@sha256:2d44738ebf4ce5f63b9d9ea871e9c7cfdc0426f7b0c97cac915fd88ded1d86bb
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY academic/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY academic /app/academic
COPY academic_app.py gemini_client.py prompt.py /app/
USER 10001:10001
EXPOSE 8000
CMD ["uvicorn", "academic_app:app", "--host", "0.0.0.0", "--port", "8000"]
