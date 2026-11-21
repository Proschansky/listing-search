# syntax=docker/dockerfile:1
# Backend image: the FastAPI service on uvicorn.
#
# Build:  docker build -t listing-search-api backend
# Run:    docker run -p 8000:8000 listing-search-api
#
# Choices, and why:
#  * python:3.12-slim   - small Debian base with a current CPython.
#  * Two stages         - dependencies are installed into a virtualenv in a
#                         "builder" stage and only that venv is copied into the
#                         final image, so no pip cache or build tools ship.
#  * Non-root user      - if the process is ever compromised it can't modify
#                         the image's files or bind privileged ports.
#  * HEALTHCHECK        - Docker (and compose's depends_on) can tell a running
#                         container from a *ready* one via /health/ready.

FROM python:3.12-slim AS builder
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# Copy only the requirements first: this layer is cached until they change,
# so editing application code doesn't trigger a full reinstall.
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM python:3.12-slim
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LISTING_ENVIRONMENT=production \
    LISTING_LOG_FORMAT=json
RUN useradd --create-home --uid 10001 app
COPY --from=builder /opt/venv /opt/venv
WORKDIR /srv
COPY --chown=app:app app ./app
COPY --chown=app:app data ./data
USER app
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health/ready', timeout=2).status == 200 else 1)"
# --proxy-headers: trust X-Forwarded-For from the reverse proxy so rate
# limiting sees real client IPs. Only safe when the API isn't exposed directly.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
