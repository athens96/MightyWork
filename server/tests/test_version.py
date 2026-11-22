"""버전 단일 소스(VERSION · pyproject.toml · client/package.json · API 응답) 일관성 검증."""

import json
import tomllib
from pathlib import Path

from app.core.version import APP_VERSION


def test_version_single_source_consistency(client):
    root = Path(__file__).resolve().parents[2]
    root_ver = (root / "VERSION").read_text(encoding="utf-8").strip()
    server_ver = tomllib.loads((root / "server/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    client_ver = json.loads((root / "client/package.json").read_text(encoding="utf-8"))["version"]

    assert root_ver == "0.1.0"
    assert APP_VERSION == root_ver == server_ver == client_ver

    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {"status": "ok", "version": root_ver}

    ver = client.get("/api/version")
    assert ver.status_code == 200
    assert ver.json()["version"] == root_ver
