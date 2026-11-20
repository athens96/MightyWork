"""OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).

client_id 가 HTTPS URL 이면 그 URL 의 JSON 문서가 클라이언트 등록 정보다.
서버가 임의 URL 을 가져오므로 SSRF 방어: https 만, 리디렉트 금지, 크기·시간 제한, 사설/루프백 주소 차단.
"""

import ipaddress
import socket
import time
from urllib.parse import urlsplit

import requests

MAX_BYTES = 64 * 1024
TIMEOUT_SEC = 5
CACHE_TTL_SEC = 600
_cache: dict[str, tuple[float, dict]] = {}


class CimdError(ValueError):
    pass


def is_cimd_client_id(client_id: str) -> bool:
    parts = urlsplit(client_id)
    return parts.scheme == "https" and bool(parts.netloc) and parts.path not in ("", "/")


def _check_host_is_public(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise CimdError(f"호스트를 찾을 수 없습니다: {host}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise CimdError(f"공개 주소가 아닌 호스트는 허용하지 않습니다: {host}")


def fetch_metadata(client_id: str, *, allow_private: bool = False) -> dict:
    cached = _cache.get(client_id)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    if not is_cimd_client_id(client_id):
        raise CimdError("client_id 는 경로가 있는 https URL 이어야 합니다")
    if not allow_private:
        _check_host_is_public(urlsplit(client_id).hostname or "")
    try:
        with requests.get(client_id, timeout=TIMEOUT_SEC, allow_redirects=False, stream=True, headers={"Accept": "application/json"}) as res:
            if res.status_code != 200:
                raise CimdError(f"클라이언트 메타데이터를 가져오지 못했습니다 (HTTP {res.status_code})")
            body = res.raw.read(MAX_BYTES + 1, decode_content=True)
    except requests.RequestException as e:
        raise CimdError("클라이언트 메타데이터를 가져오지 못했습니다") from e
    if len(body) > MAX_BYTES:
        raise CimdError("클라이언트 메타데이터 문서가 너무 큽니다")
    try:
        import json

        doc = json.loads(body)
    except ValueError as e:
        raise CimdError("클라이언트 메타데이터가 JSON 이 아닙니다") from e
    if not isinstance(doc, dict) or doc.get("client_id") != client_id:
        raise CimdError("메타데이터의 client_id 가 문서 URL 과 다릅니다")
    if not isinstance(doc.get("redirect_uris"), list) or not doc["redirect_uris"] or not all(isinstance(u, str) for u in doc["redirect_uris"]):
        raise CimdError("메타데이터에 redirect_uris 가 없습니다")
    if not isinstance(doc.get("client_name", ""), str):
        raise CimdError("client_name 형식이 잘못되었습니다")
    if doc.get("token_endpoint_auth_method", "none") != "none":
        raise CimdError("CIMD 클라이언트는 공개 클라이언트(token_endpoint_auth_method=none)만 지원합니다")
    _cache[client_id] = (time.monotonic() + CACHE_TTL_SEC, doc)
    return doc
