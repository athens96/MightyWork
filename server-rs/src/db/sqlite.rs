use std::collections::HashSet;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::models::{Comment, HasMeta, Task, WikiPage};

pub struct SqliteEngine {
    pub path: PathBuf,
    conn: Mutex<Connection>,
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn index_entry_from_json(table: &str, raw_json: &str) -> Option<(String, String, String, String)> {
    match table {
        "tasks" => {
            let t: Task = serde_json::from_str(raw_json).ok()?;
            if t.deleted_at.is_some() {
                return None;
            }
            let mut parts = vec![t.title];
            if let Some(v) = t.version {
                parts.push(v);
            }
            parts.extend(t.tags);
            parts.push(t.description);
            for item in t.checklist {
                parts.push(item.text);
            }
            let text = parts
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            Some(("task".into(), t.project_id, t.id, text))
        }
        "comments" => {
            let c: Comment = serde_json::from_str(raw_json).ok()?;
            Some(("task".into(), c.project_id, c.task_id, c.body.to_lowercase()))
        }
        "wiki_pages" => {
            let p: WikiPage = serde_json::from_str(raw_json).ok()?;
            if p.deleted_at.is_some() {
                return None;
            }
            let mut parts = vec![p.title];
            parts.extend(p.aliases);
            parts.extend(p.tags);
            parts.push(p.content);
            let text = parts
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            Some(("wiki".into(), p.project_id, p.id, text))
        }
        _ => None,
    }
}

fn is_fts_table(table: &str) -> bool {
    matches!(table, "tasks" | "comments" | "wiki_pages")
}

impl SqliteEngine {
    pub fn open(db_path: &Path) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let con = Connection::open(db_path)?;
        con.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;",
        )?;
        let engine = Self {
            path: db_path.to_path_buf(),
            conn: Mutex::new(con),
        };
        engine.init_schema()?;
        Ok(engine)
    }

    pub fn with_conn<F, R>(&self, f: F) -> rusqlite::Result<R>
    where
        F: FnOnce(&Connection) -> rusqlite::Result<R>,
    {
        let con = self.conn.lock().unwrap();
        f(&con)
    }

    fn init_schema(&self) -> rusqlite::Result<()> {
        let con = self.conn.lock().unwrap();
        con.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS search_docs (
                 row_key TEXT PRIMARY KEY,
                 kind TEXT NOT NULL,
                 project_id TEXT NOT NULL,
                 target_id TEXT NOT NULL,
                 text TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_search_docs_project ON search_docs (project_id);
             CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                 row_key UNINDEXED,
                 kind UNINDEXED,
                 project_id UNINDEXED,
                 target_id UNINDEXED,
                 text,
                 tokenize='trigram'
             );
             CREATE TABLE IF NOT EXISTS oauth_pending (
                 id TEXT PRIMARY KEY,
                 payload TEXT NOT NULL,
                 expires REAL NOT NULL
             );
             CREATE TABLE IF NOT EXISTS oauth_codes (
                 code_hash TEXT PRIMARY KEY,
                 payload TEXT NOT NULL,
                 expires REAL NOT NULL
             );
             CREATE TABLE IF NOT EXISTS oauth_dcr_rate (
                 ip TEXT NOT NULL,
                 ts REAL NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_oauth_dcr_rate_ip_ts ON oauth_dcr_rate (ip, ts);
             CREATE TABLE IF NOT EXISTS project_events (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 channel TEXT NOT NULL,
                 kind TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 ts REAL NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_project_events_chan_seq ON project_events (channel, seq);
             COMMIT;",
        )?;
        Ok(())
    }

    pub fn ensure_table(&self, table: &str) -> rusqlite::Result<()> {
        let con = self.conn.lock().unwrap();
        con.execute(
            &format!(
                r#"CREATE TABLE IF NOT EXISTS "{table}" (id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL)"#
            ),
            [],
        )?;
        con.execute(
            &format!(r#"CREATE INDEX IF NOT EXISTS "idx_{table}_project" ON "{table}" (project_id)"#),
            [],
        )?;
        Ok(())
    }

    fn upsert_search(con: &Connection, row_key: &str, entry: &(String, String, String, String)) -> rusqlite::Result<()> {
        let (kind, project_id, target_id, text) = entry;
        con.execute("DELETE FROM search_fts WHERE row_key = ?1", params![row_key])?;
        con.execute(
            "INSERT OR REPLACE INTO search_docs (row_key, kind, project_id, target_id, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row_key, kind, project_id, target_id, text],
        )?;
        con.execute(
            "INSERT INTO search_fts (row_key, kind, project_id, target_id, text) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row_key, kind, project_id, target_id, text],
        )?;
        Ok(())
    }

    fn delete_search(con: &Connection, row_key: &str) -> rusqlite::Result<()> {
        con.execute("DELETE FROM search_docs WHERE row_key = ?1", params![row_key])?;
        con.execute("DELETE FROM search_fts WHERE row_key = ?1", params![row_key])?;
        Ok(())
    }

    pub fn search_candidates(&self, project_id: &str, query_cf: &str) -> rusqlite::Result<(HashSet<String>, HashSet<String>)> {
        let con = self.conn.lock().unwrap();
        let mut task_ids = HashSet::new();
        let mut wiki_ids = HashSet::new();
        if query_cf.chars().count() >= 3 {
            let escaped = format!(r#""{}""#, query_cf.replace('"', "\"\""));
            let mut stmt = con.prepare(
                "SELECT DISTINCT kind, target_id FROM search_fts WHERE project_id = ?1 AND text MATCH ?2",
            )?;
            let rows = stmt.query_map(params![project_id, escaped], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (kind, tid) = row?;
                if kind == "task" {
                    task_ids.insert(tid);
                } else if kind == "wiki" {
                    wiki_ids.insert(tid);
                }
            }
        } else {
            let escaped = query_cf
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            let like = format!("%{escaped}%");
            let mut stmt = con.prepare(
                r"SELECT DISTINCT kind, target_id FROM search_docs WHERE project_id = ?1 AND text LIKE ?2 ESCAPE '\'",
            )?;
            let rows = stmt.query_map(params![project_id, like], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (kind, tid) = row?;
                if kind == "task" {
                    task_ids.insert(tid);
                } else if kind == "wiki" {
                    wiki_ids.insert(tid);
                }
            }
        }
        Ok((task_ids, wiki_ids))
    }

    pub fn allocate_task_number(&self, project_id: &str) -> rusqlite::Result<Option<i64>> {
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<Option<i64>> {
            let raw: Option<String> = con
                .query_row(
                    r#"SELECT data FROM "projects" WHERE id = ?1"#,
                    params![project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(raw) = raw else {
                return Ok(None);
            };
            let mut data: Value = serde_json::from_str(&raw).unwrap_or(Value::Object(Default::default()));
            let next_num = data.get("task_seq").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            if let Some(obj) = data.as_object_mut() {
                obj.insert("task_seq".into(), Value::Number(next_num.into()));
            }
            let updated_json = serde_json::to_string(&data).unwrap();
            con.execute(
                r#"UPDATE "projects" SET data = ?1 WHERE id = ?2"#,
                params![updated_json, project_id],
            )?;
            Ok(Some(next_num))
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn append_event(&self, channel: &str, kind: &str, payload: &Value) -> rusqlite::Result<i64> {
        let now = unix_now();
        let payload_str = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<i64> {
            con.execute(
                "INSERT INTO project_events (channel, kind, payload, ts) VALUES (?1, ?2, ?3, ?4)",
                params![channel, kind, payload_str, now],
            )?;
            let seq = con.last_insert_rowid();
            if seq % 100 == 0 {
                con.execute("DELETE FROM project_events WHERE ts < ?1", params![now - 3600.0])?;
            }
            Ok(seq)
        })();
        match res {
            Ok(seq) => {
                con.execute_batch("COMMIT")?;
                Ok(seq)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn latest_event_seq(&self) -> rusqlite::Result<i64> {
        let con = self.conn.lock().unwrap();
        con.query_row("SELECT COALESCE(MAX(seq), 0) FROM project_events", [], |r| r.get(0))
    }

    pub fn fetch_events(&self, channels: &[String], after_seq: i64, limit: i64) -> rusqlite::Result<Vec<(i64, String, Value)>> {
        if channels.is_empty() {
            return Ok(vec![]);
        }
        let con = self.conn.lock().unwrap();
        let placeholders = (0..channels.len())
            .map(|i| format!("?{}", i + 2))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT seq, kind, payload FROM project_events WHERE seq > ?1 AND channel IN ({placeholders}) ORDER BY seq ASC LIMIT ?{}",
            channels.len() + 2
        );
        let mut stmt = con.prepare(&sql)?;
        let mut args: Vec<rusqlite::types::Value> = Vec::with_capacity(channels.len() + 2);
        args.push(rusqlite::types::Value::Integer(after_seq));
        for ch in channels {
            args.push(rusqlite::types::Value::Text(ch.clone()));
        }
        args.push(rusqlite::types::Value::Integer(limit));
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
            let seq: i64 = r.get(0)?;
            let kind: String = r.get(1)?;
            let raw: String = r.get(2)?;
            let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Object(Default::default()));
            Ok((seq, kind, payload))
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn delete_by_project(&self, table: &str, project_id: &str) -> rusqlite::Result<()> {
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<()> {
            if is_fts_table(table) {
                let mut stmt = con.prepare(&format!(r#"SELECT id FROM "{table}" WHERE project_id = ?1"#))?;
                let ids: Vec<String> = stmt
                    .query_map(params![project_id], |r| r.get(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                for id in ids {
                    Self::delete_search(&con, &format!("{table}:{id}"))?;
                }
            }
            con.execute(
                &format!(r#"DELETE FROM "{table}" WHERE project_id = ?1"#),
                params![project_id],
            )?;
            Ok(())
        })();
        match res {
            Ok(()) => con.execute_batch("COMMIT"),
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn check_dcr_rate_limit(&self, key: &str, limit_per_min: usize) -> rusqlite::Result<bool> {
        if limit_per_min == 0 {
            return Ok(true);
        }
        let now = unix_now();
        let cutoff = now - 60.0;
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<bool> {
            con.execute("DELETE FROM oauth_dcr_rate WHERE ts <= ?1", params![cutoff])?;
            let count: i64 = con.query_row(
                "SELECT COUNT(*) FROM oauth_dcr_rate WHERE ip = ?1",
                params![key],
                |r| r.get(0),
            )?;
            if count >= limit_per_min as i64 {
                return Ok(false);
            }
            con.execute("INSERT INTO oauth_dcr_rate (ip, ts) VALUES (?1, ?2)", params![key, now])?;
            Ok(true)
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn put_oauth_pending(&self, id: &str, payload: &str, ttl_sec: f64) -> rusqlite::Result<()> {
        let now = unix_now();
        let con = self.conn.lock().unwrap();
        con.execute("DELETE FROM oauth_pending WHERE expires <= ?1", params![now])?;
        con.execute(
            "INSERT OR REPLACE INTO oauth_pending (id, payload, expires) VALUES (?1, ?2, ?3)",
            params![id, payload, now + ttl_sec],
        )?;
        Ok(())
    }

    pub fn get_oauth_pending(&self, id: &str) -> rusqlite::Result<Option<String>> {
        let now = unix_now();
        let con = self.conn.lock().unwrap();
        con.execute("DELETE FROM oauth_pending WHERE expires <= ?1", params![now])?;
        con.query_row(
            "SELECT payload FROM oauth_pending WHERE id = ?1 AND expires > ?2",
            params![id, now],
            |r| r.get(0),
        )
        .optional()
    }

    pub fn pop_oauth_pending(&self, id: &str) -> rusqlite::Result<Option<String>> {
        let now = unix_now();
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<Option<String>> {
            con.execute("DELETE FROM oauth_pending WHERE expires <= ?1", params![now])?;
            let row: Option<String> = con
                .query_row(
                    "SELECT payload FROM oauth_pending WHERE id = ?1 AND expires > ?2",
                    params![id, now],
                    |r| r.get(0),
                )
                .optional()?;
            if row.is_some() {
                con.execute("DELETE FROM oauth_pending WHERE id = ?1", params![id])?;
            }
            Ok(row)
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn put_oauth_code(&self, code_hash: &str, payload: &str, ttl_sec: f64) -> rusqlite::Result<()> {
        let now = unix_now();
        let con = self.conn.lock().unwrap();
        con.execute("DELETE FROM oauth_codes WHERE expires <= ?1", params![now])?;
        con.execute(
            "INSERT OR REPLACE INTO oauth_codes (code_hash, payload, expires) VALUES (?1, ?2, ?3)",
            params![code_hash, payload, now + ttl_sec],
        )?;
        Ok(())
    }

    pub fn pop_oauth_code(&self, code_hash: &str) -> rusqlite::Result<Option<String>> {
        let now = unix_now();
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<Option<String>> {
            con.execute("DELETE FROM oauth_codes WHERE expires <= ?1", params![now])?;
            let row: Option<String> = con
                .query_row(
                    "SELECT payload FROM oauth_codes WHERE code_hash = ?1 AND expires > ?2",
                    params![code_hash, now],
                    |r| r.get(0),
                )
                .optional()?;
            if row.is_some() {
                con.execute("DELETE FROM oauth_codes WHERE code_hash = ?1", params![code_hash])?;
            }
            Ok(row)
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn raw_list(&self, table: &str, project_id: Option<&str>) -> rusqlite::Result<Vec<String>> {
        let con = self.conn.lock().unwrap();
        let mut out = Vec::new();
        if let Some(pid) = project_id {
            let mut stmt = con.prepare(&format!(r#"SELECT data FROM "{table}" WHERE project_id = ?1"#))?;
            let rows = stmt.query_map(params![pid], |r| r.get::<_, String>(0))?;
            for r in rows {
                out.push(r?);
            }
        } else {
            let mut stmt = con.prepare(&format!(r#"SELECT data FROM "{table}""#))?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    pub fn raw_get(&self, table: &str, id: &str) -> rusqlite::Result<Option<String>> {
        let con = self.conn.lock().unwrap();
        con.query_row(
            &format!(r#"SELECT data FROM "{table}" WHERE id = ?1"#),
            params![id],
            |r| r.get(0),
        )
        .optional()
    }

    pub fn raw_create(&self, table: &str, id: &str, project_id: Option<&str>, data: &str) -> rusqlite::Result<()> {
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<()> {
            con.execute(
                &format!(r#"INSERT INTO "{table}" (id, project_id, data) VALUES (?1, ?2, ?3)"#),
                params![id, project_id, data],
            )?;
            if is_fts_table(table) {
                let key = format!("{table}:{id}");
                if let Some(entry) = index_entry_from_json(table, data) {
                    Self::upsert_search(&con, &key, &entry)?;
                } else {
                    Self::delete_search(&con, &key)?;
                }
            }
            Ok(())
        })();
        match res {
            Ok(()) => con.execute_batch("COMMIT"),
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn raw_update(&self, table: &str, id: &str, project_id: Option<&str>, data: &str) -> rusqlite::Result<bool> {
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<bool> {
            let changed = con.execute(
                &format!(r#"UPDATE "{table}" SET project_id = ?1, data = ?2 WHERE id = ?3"#),
                params![project_id, data, id],
            )?;
            if changed == 0 {
                return Ok(false);
            }
            if is_fts_table(table) {
                let key = format!("{table}:{id}");
                if let Some(entry) = index_entry_from_json(table, data) {
                    Self::upsert_search(&con, &key, &entry)?;
                } else {
                    Self::delete_search(&con, &key)?;
                }
            }
            Ok(true)
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    pub fn raw_delete(&self, table: &str, id: &str) -> rusqlite::Result<bool> {
        let con = self.conn.lock().unwrap();
        con.execute_batch("BEGIN IMMEDIATE")?;
        let res = (|| -> rusqlite::Result<bool> {
            let changed = con.execute(&format!(r#"DELETE FROM "{table}" WHERE id = ?1"#), params![id])?;
            if changed == 0 {
                return Ok(false);
            }
            if is_fts_table(table) {
                Self::delete_search(&con, &format!("{table}:{id}"))?;
            }
            Ok(true)
        })();
        match res {
            Ok(v) => {
                con.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = con.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
}

#[derive(Clone)]
pub struct SqliteRepo<T> {
    engine: Arc<SqliteEngine>,
    table: &'static str,
    _marker: PhantomData<T>,
}

impl<T> SqliteRepo<T>
where
    T: Serialize + DeserializeOwned + HasMeta,
{
    pub fn new(engine: Arc<SqliteEngine>, table: &'static str) -> rusqlite::Result<Self> {
        engine.ensure_table(table)?;
        Ok(Self {
            engine,
            table,
            _marker: PhantomData,
        })
    }

    pub fn table(&self) -> &'static str {
        self.table
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<T>> {
        match self.engine.raw_get(self.table, id)? {
            Some(raw) => Ok(Some(serde_json::from_str(&raw).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
            })?)),
            None => Ok(None),
        }
    }

    pub fn list(&self) -> rusqlite::Result<Vec<T>> {
        let rows = self.engine.raw_list(self.table, None)?;
        let mut out = Vec::with_capacity(rows.len());
        for raw in rows {
            if let Ok(v) = serde_json::from_str::<T>(&raw) {
                out.push(v);
            }
        }
        Ok(out)
    }

    pub fn list_by_project(&self, project_id: &str) -> rusqlite::Result<Vec<T>> {
        let rows = self.engine.raw_list(self.table, Some(project_id))?;
        let mut out = Vec::with_capacity(rows.len());
        for raw in rows {
            if let Ok(v) = serde_json::from_str::<T>(&raw) {
                out.push(v);
            }
        }
        Ok(out)
    }

    pub fn list_where<F>(&self, pred: F) -> rusqlite::Result<Vec<T>>
    where
        F: Fn(&T) -> bool,
    {
        Ok(self.list()?.into_iter().filter(|x| pred(x)).collect())
    }

    pub fn create(&self, entity: &T) -> rusqlite::Result<T>
    where
        T: Clone,
    {
        let raw = serde_json::to_string(entity).expect("serialize entity");
        self.engine
            .raw_create(self.table, entity.id(), entity.project_id(), &raw)?;
        Ok(entity.clone())
    }

    pub fn update(&self, entity: &T) -> rusqlite::Result<bool> {
        let raw = serde_json::to_string(entity).expect("serialize entity");
        self.engine
            .raw_update(self.table, entity.id(), entity.project_id(), &raw)
    }

    pub fn delete(&self, id: &str) -> rusqlite::Result<bool> {
        self.engine.raw_delete(self.table, id)
    }
}
