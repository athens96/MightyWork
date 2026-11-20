"""OAuth Client ID Metadata Document (draft-ietf-oauth-client-id-metadata-document).

client_id 가 HTTPS URL 이면 그 URL 의 JSON 문서가 클라이언트 등록 정보다.
서버가 임의 URL 을 가져오므로 SSRF 방어:
- https 만, 리디렉트 금지, 크기·시간 제한
- DNS 를 한 번만 해석해 모든 주소가 공개 IP 인지 검사한 뒤, 검증된 IP 에 직접 연결(DNS 리바인딩 TOCTOU 차단)
- 캐시는 스레드 안전하며 항목 수 상한을 둔다
"""

import ipaddress
import json
import socket
import threading
import time
from urllib.parse import urlsplit

import requests.certs
import urllib3

MAX_BYTES = 64 * 1024
TIMEOUT_SEC = 5
CACHE_TTL_SEC = 600
MAX_CACHE_ENTRIES = 256

_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


class CimdError(ValueError):
    pass


def is_cimd_client_id(client_id: str) -> bool:
    parts = urlsplit(client_id)
    return parts.scheme == "https" and bool(parts.netloc) and parts.path not in ("", "/")


def _resolve_ip(host: str, port: int, *, allow_private: bool) -> str:
    """호스트의 모든 IP 를 확인하고(allow_private=False 면 전부 공개 IP 여야 함) 연결할 IP 를 반환."""
    if not host:
        raise CimdError("호스트가 비어 있습니다")
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise CimdError(f"호스트를 찾을 수 없습니다: {host}") from e
    if not infos:
        raise CimdError(f"호스트를 찾을 수 없습니다: {host}")
    ips: list[str] = []
    for info in infos:
        addr = info[4][0]
        ip = ipaddress.ip_address(addr)
        if not allow_private and not ip.is_global:
            raise CimdError(f"공개 주소가 아닌 호스트는 허용하지 않습니다: {host}")
        ips.append(addr)
    return ips[0]


def _read_limited(response: urllib3.BaseHTTPResponse, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    for chunk in response.stream(8192, decode_content=True):
        total += len(chunk)
        if total > limit:
            raise CimdError("클라이언트 메타데이터 문서가 너무 큽니다")
        chunks.append(chunk)
    return b"".join(chunks)


def _fetch_pinned(client_id: str, *, allow_private: bool) -> bytes:
    parts = urlsplit(client_id)
    host = parts.hostname or ""
    port = parts.port or 443
    pinned_ip = _resolve_ip(host, port, allow_private=allow_private)
    target = parts.path + (f"?{parts.query}" if parts.query else "")
    # 검증한 IP 에 직접 연결하면서 SNI·인증서 호스트명 검증은 원래 도메인으로 유지
    pool = urllib3.HTTPSConnectionPool(
        host=pinned_ip,
        port=port,
        server_hostname=host,
        assert_hostname=host,
        cert_reqs="CERT_REQUIRED",
        ca_certs=requests.certs.where(),
        timeout=urllib3.Timeout(connect=TIMEOUT_SEC, read=TIMEOUT_SEC),
    )
    try:
        res = pool.request(
            "GET",
            target,
            headers={"Host": parts.netloc, "Accept": "application/json"},
            redirect=False,
            retries=False,
            preload_content=False,
        )
        try:
            if res.status != 200:
                raise CimdError(f"클라이언트 메타데이터를 가져오지 못했습니다 (HTTP {res.status})")
            return _read_limited(res, MAX_BYTES)
        finally:
            res.release_conn()
    except CimdError:
        raise
    except urllib3.exceptions.HTTPError as e:
        raise CimdError("클라이언트 메타데이터를 가져오지 못했습니다") from e
    finally:
        pool.close()


def _cache_get(client_id: str) -> dict | None:
    now = time.monotonic()
    with _cache_lock:
        entry = _cache.get(client_id)
        if entry is None:
            return None
        if entry[0] <= now:
            _cache.pop(client_id, None)
            return None
        return entry[1]


def _cache_put(client_id: str, doc: dict) -> None:
    now = time.monotonic()
    with _cache_lock:
        expired = [k for k, (exp, _) in _cache.items() if exp <= now]
        for k in expired:
            _cache.pop(k, None)
        while len(_cache) >= MAX_CACHE_ENTRIES:
            _cache.pop(next(iter(_cache)))
        _cache[client_id] = (now + CACHE_TTL_SEC, doc)


def fetch_metadata(client_id: str, *, allow_private: bool = False) -> dict:
    cached = _cache_get(client_id)
    if cached is not None:
        return cached
    if not is_cimd_client_id(client_id):
        raise CimdError("client_id 는 경로가 있는 https URL 이어야 합니다")
    body = _fetch_pinned(client_id, allow_private=allow_private)
    try:
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
    _cache_put(client_id, doc)
    return doc
