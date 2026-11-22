"""SQLite 저장소 — WAL 모드 + FTS5(trigram) 전문 검색 + 프로세스 안전한 일감 번호 발급 + 영속 OAuth 스토어.

- 단일 파일(mightywork.db)에 모든 컬렉션을 저장해 멀티 워커(uvicorn --workers > 1)에서도 안전하게 동작한다.
- 기존 JSON 파일 DB(data/*.json)가 있고 mightywork.db 가 아직 없으면 최초 기동 시 자동으로 이전한다(원본 JSON 은 보존).
"""

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable

from app.db.base import Repository, T

_FTS_TABLES = {"tasks", "comments", "wiki_pages"}


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _index_entry(table: str, entity) -> tuple[str, str, str, str] | None:
    """(row_key, kind, project_id, target_id, text) 중 인덱스 대상이면 반환."""
    if table == "tasks":
        parts = [entity.title, entity.version or "", *entity.tags, entity.description, *(i.text for i in entity.checklist)]
        return ("task", entity.project_id, entity.id, " ".join(p for p in parts if p).casefold())
    if table == "comments":
        return ("task", entity.project_id, entity.task_id, entity.body.casefold())
    if table == "wiki_pages":
        parts = [entity.title, *entity.aliases, *entity.tags, entity.content]
        return ("wiki", entity.project_id, entity.id, " ".join(p for p in parts if p).casefold())
    return None


class SqliteEngine:
    """스레드별 SQLite 커넥션 풀 (WAL 모드, busy_timeout 설정)."""

    def __init__(self, db_path: Path):
        self.path = db_path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._init_schema()

    def conn(self) -> sqlite3.Connection:
        con: sqlite3.Connection | None = getattr(self._local, "con", None)
        if con is None:
            con = sqlite3.connect(str(self.path), timeout=30.0, isolation_level=None)
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA synchronous=NORMAL")
            con.execute("PRAGMA busy_timeout=5000")
            self._local.con = con
        return con

    def _init_schema(self) -> None:
        con = self.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS search_docs (
                    row_key TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    project_id TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    text TEXT NOT NULL
                )
                """
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_search_docs_project ON search_docs (project_id)")
            con.execute(
                """
                CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                    row_key UNINDEXED,
                    kind UNINDEXED,
                    project_id UNINDEXED,
                    target_id UNINDEXED,
                    text,
                    tokenize='trigram'
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_pending (
                    id TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    expires REAL NOT NULL
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_codes (
                    code_hash TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    expires REAL NOT NULL
                )
                """
            )
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS oauth_dcr_rate (
                    ip TEXT NOT NULL,
                    ts REAL NOT NULL
                )
                """
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_oauth_dcr_rate_ip_ts ON oauth_dcr_rate (ip, ts)")
            con.execute(
                """
                CREATE TABLE IF NOT EXISTS project_events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    channel TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    ts REAL NOT NULL
                )
                """
            )
            con.execute("CREATE INDEX IF NOT EXISTS idx_project_events_chan_seq ON project_events (channel, seq)")
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise

    def ensure_table(self, table: str) -> None:
        con = self.conn()
        con.execute(
            f'CREATE TABLE IF NOT EXISTS "{table}" (id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL)'
        )
        con.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table}_project" ON "{table}" (project_id)')

    def upsert_search(self, con: sqlite3.Connection, row_key: str, entry: tuple[str, str, str, str]) -> None:
        kind, project_id, target_id, text = entry
        con.execute("DELETE FROM search_fts WHERE row_key = ?", (row_key,))
        con.execute(
            "INSERT OR REPLACE INTO search_docs (row_key, kind, project_id, target_id, text) VALUES (?, ?, ?, ?, ?)",
            (row_key, kind, project_id, target_id, text),
        )
        con.execute(
            "INSERT INTO search_fts (row_key, kind, project_id, target_id, text) VALUES (?, ?, ?, ?, ?)",
            (row_key, kind, project_id, target_id, text),
        )

    def delete_search(self, con: sqlite3.Connection, row_key: str) -> None:
        con.execute("DELETE FROM search_docs WHERE row_key = ?", (row_key,))
        con.execute("DELETE FROM search_fts WHERE row_key = ?", (row_key,))

    def search_candidates(self, project_id: str, query_cf: str) -> tuple[set[str], set[str]]:
        """FTS5(trigram, 3글자 이상) 또는 LIKE(1~2글자)로 후보 (task_ids, wiki_ids)를 빠르게 추린다."""
        con = self.conn()
        if len(query_cf) >= 3:
            escaped = '"' + query_cf.replace('"', '""') + '"'
            rows = con.execute(
                "SELECT DISTINCT kind, target_id FROM search_fts WHERE project_id = ? AND text MATCH ?",
                (project_id, escaped),
            ).fetchall()
        else:
            like = "%" + query_cf.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            rows = con.execute(
                "SELECT DISTINCT kind, target_id FROM search_docs WHERE project_id = ? AND text LIKE ? ESCAPE '\\'",
                (project_id, like),
            ).fetchall()
        task_ids = {tid for kind, tid in rows if kind == "task"}
        wiki_ids = {tid for kind, tid in rows if kind == "wiki"}
        return task_ids, wiki_ids

    def allocate_task_number(self, project_id: str) -> int:
        """BEGIN IMMEDIATE 트랜잭션으로 멀티 워커 환경에서도 안전하게 일감 번호를 발급한다."""
        con = self.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            row = con.execute('SELECT data FROM "projects" WHERE id = ?', (project_id,)).fetchone()
            if row is None:
                con.execute("ROLLBACK")
                raise LookupError(project_id)
            data = json.loads(row[0])
            number = int(data.get("task_seq", 0)) + 1
            data["task_seq"] = number
            con.execute(
                'UPDATE "projects" SET data = ? WHERE id = ?',
                (json.dumps(data, ensure_ascii=False), project_id),
            )
            con.execute("COMMIT")
            return number
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def append_event(self, channel: str, kind: str, payload: dict) -> int:
        now = time.time()
        con = self.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            cur = con.execute(
                "INSERT INTO project_events (channel, kind, payload, ts) VALUES (?, ?, ?, ?)",
                (channel, kind, json.dumps(payload, ensure_ascii=False), now),
            )
            seq = int(cur.lastrowid or 0)
            if seq % 100 == 0:
                con.execute("DELETE FROM project_events WHERE ts < ?", (now - 3600.0,))
            con.execute("COMMIT")
            return seq
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def latest_event_seq(self) -> int:
        row = self.conn().execute("SELECT COALESCE(MAX(seq), 0) FROM project_events").fetchone()
        return int(row[0]) if row else 0

    def fetch_events(self, channels: list[str], after_seq: int, limit: int = 50) -> list[tuple[int, str, dict]]:
        if not channels:
            return []
        placeholders = ",".join("?" for _ in channels)
        rows = self.conn().execute(
            f"SELECT seq, kind, payload FROM project_events WHERE seq > ? AND channel IN ({placeholders}) ORDER BY seq ASC LIMIT ?",
            (after_seq, *channels, limit),
        ).fetchall()
        return [(int(seq), kind, json.loads(raw)) for seq, kind, raw in rows]


class SqliteRepository(Repository[T]):
    """컬렉션 하나를 SQLite 테이블 하나에 저장하는 저장소."""

    def __init__(self, engine: SqliteEngine, table: str, model: type[T]):
        self._engine = engine
        self._table = table
        self._model = model
        self._engine.ensure_table(table)

    def _dump(self, entity: T) -> str:
        return json.dumps(entity.model_dump(mode="json"), ensure_ascii=False)

    def _load(self, raw: str) -> T:
        return self._model.model_validate(json.loads(raw))

    def list(self, where: Callable[[T], bool] | None = None) -> list[T]:
        rows = self._engine.conn().execute(f'SELECT data FROM "{self._table}"').fetchall()
        items = [self._load(r[0]) for r in rows]
        return [i for i in items if where is None or where(i)]

    def get(self, entity_id: str) -> T | None:
        row = self._engine.conn().execute(f'SELECT data FROM "{self._table}" WHERE id = ?', (entity_id,)).fetchone()
        return self._load(row[0]) if row else None

    def create(self, entity: T) -> T:
        con = self._engine.conn()
        project_id = getattr(entity, "project_id", None)
        con.execute("BEGIN IMMEDIATE")
        try:
            try:
                con.execute(
                    f'INSERT INTO "{self._table}" (id, project_id, data) VALUES (?, ?, ?)',
                    (entity.id, project_id, self._dump(entity)),
                )
            except sqlite3.IntegrityError as e:
                raise ValueError(f"duplicate id: {entity.id}") from e
            if self._table in _FTS_TABLES and (entry := _index_entry(self._table, entity)) is not None:
                self._engine.upsert_search(con, f"{self._table}:{entity.id}", entry)
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        return entity

    def update(self, entity: T) -> T | None:
        con = self._engine.conn()
        project_id = getattr(entity, "project_id", None)
        con.execute("BEGIN IMMEDIATE")
        try:
            cur = con.execute(
                f'UPDATE "{self._table}" SET project_id = ?, data = ? WHERE id = ?',
                (project_id, self._dump(entity), entity.id),
            )
            if cur.rowcount == 0:
                con.execute("ROLLBACK")
                return None
            if self._table in _FTS_TABLES and (entry := _index_entry(self._table, entity)) is not None:
                self._engine.upsert_search(con, f"{self._table}:{entity.id}", entry)
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        return entity

    def delete(self, entity_id: str) -> bool:
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            cur = con.execute(f'DELETE FROM "{self._table}" WHERE id = ?', (entity_id,))
            if cur.rowcount == 0:
                con.execute("ROLLBACK")
                return False
            if self._table in _FTS_TABLES:
                self._engine.delete_search(con, f"{self._table}:{entity_id}")
            con.execute("COMMIT")
            return True
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise


class SqliteOAuthStore:
    """SQLite 기반 OAuth 인가 요청·인가 코드·DCR 속도 제한 저장소 (멀티 워커·재시작 안전)."""

    def __init__(self, engine: SqliteEngine):
        self._engine = engine

    def _sweep(self, con: sqlite3.Connection, now: float) -> None:
        con.execute("DELETE FROM oauth_pending WHERE expires <= ?", (now,))
        con.execute("DELETE FROM oauth_codes WHERE expires <= ?", (now,))

    def check_dcr_rate_limit(self, key: str, limit_per_min: int) -> bool:
        if limit_per_min <= 0:
            return True
        now = time.time()
        cutoff = now - 60.0
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute("DELETE FROM oauth_dcr_rate WHERE ts <= ?", (cutoff,))
            count = con.execute("SELECT COUNT(*) FROM oauth_dcr_rate WHERE ip = ?", (key,)).fetchone()[0]
            if count >= limit_per_min:
                con.execute("COMMIT")
                return False
            con.execute("INSERT INTO oauth_dcr_rate (ip, ts) VALUES (?, ?)", (key, now))
            con.execute("COMMIT")
            return True
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def add_pending(self, p) -> None:
        from app.services.oauth.server import AUTH_REQUEST_TTL_SEC

        now = time.time()
        payload = {
            "id": p.id,
            "client": {
                "client_id": p.client.client_id,
                "client_name": p.client.client_name,
                "redirect_uris": p.client.redirect_uris,
                "auth_method": p.client.auth_method,
                "secret_hash": p.client.secret_hash,
                "via": p.client.via,
            },
            "redirect_uri": p.redirect_uri,
            "state": p.state,
            "code_challenge": p.code_challenge,
            "scopes": p.scopes,
            "resource": p.resource,
        }
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            self._sweep(con, now)
            con.execute(
                "INSERT OR REPLACE INTO oauth_pending (id, payload, expires) VALUES (?, ?, ?)",
                (p.id, json.dumps(payload, ensure_ascii=False), now + AUTH_REQUEST_TTL_SEC),
            )
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def _deserialize_pending(self, raw: str):
        from app.services.oauth.server import ClientInfo, PendingAuthorization

        d = json.loads(raw)
        c = d["client"]
        return PendingAuthorization(
            id=d["id"],
            client=ClientInfo(c["client_id"], c["client_name"], c["redirect_uris"], c["auth_method"], c.get("secret_hash"), c.get("via", "dcr")),
            redirect_uri=d["redirect_uri"],
            state=d["state"],
            code_challenge=d["code_challenge"],
            scopes=d["scopes"],
            resource=d["resource"],
        )

    def get_pending(self, pid: str):
        now = time.time()
        con = self._engine.conn()
        row = con.execute("SELECT payload, expires FROM oauth_pending WHERE id = ?", (pid,)).fetchone()
        if row is None or row[1] <= now:
            return None
        return self._deserialize_pending(row[0])

    def pop_pending(self, pid: str):
        now = time.time()
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            self._sweep(con, now)
            row = con.execute("SELECT payload FROM oauth_pending WHERE id = ?", (pid,)).fetchone()
            if row is None:
                con.execute("COMMIT")
                return None
            con.execute("DELETE FROM oauth_pending WHERE id = ?", (pid,))
            con.execute("COMMIT")
            return self._deserialize_pending(row[0])
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def add_code(self, code: str, data) -> None:
        from app.services.oauth.server import CODE_TTL_SEC

        now = time.time()
        payload = {
            "user_id": data.user_id,
            "grant_id": data.grant_id,
            "client_id": data.client_id,
            "redirect_uri": data.redirect_uri,
            "code_challenge": data.code_challenge,
            "scopes": data.scopes,
            "resource": data.resource,
        }
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            con.execute(
                "INSERT OR REPLACE INTO oauth_codes (code_hash, payload, expires) VALUES (?, ?, ?)",
                (_sha256(code), json.dumps(payload, ensure_ascii=False), now + CODE_TTL_SEC),
            )
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise

    def pop_code(self, code: str):
        from app.services.oauth.server import AuthorizationCode

        now = time.time()
        code_hash = _sha256(code)
        con = self._engine.conn()
        con.execute("BEGIN IMMEDIATE")
        try:
            self._sweep(con, now)
            row = con.execute("SELECT payload FROM oauth_codes WHERE code_hash = ?", (code_hash,)).fetchone()
            if row is None:
                con.execute("COMMIT")
                return None
            con.execute("DELETE FROM oauth_codes WHERE code_hash = ?", (code_hash,))
            con.execute("COMMIT")
            d = json.loads(row[0])
            return AuthorizationCode(**d)
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
