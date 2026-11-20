FROM python:3.12-slim

# kordoc(한글 HWPX/HWP 변환·문서 가져오기)용 Node.js 20 및 uv 설치
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv

WORKDIR /app

# Python 의존성
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# kordoc 변환 엔진 (버전 고정)
COPY tools/kordoc/package.json tools/kordoc/package-lock.json ./tools/kordoc/
RUN cd tools/kordoc && npm ci --omit=dev

# 앱 소스
COPY app ./app

RUN useradd -m -u 1000 appuser && mkdir -p /app/data && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
