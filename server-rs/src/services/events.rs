use serde_json::Value;
use tokio::sync::broadcast;

use crate::db::Database;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<i64>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<i64> {
        self.tx.subscribe()
    }

    pub fn notify(&self, seq: i64) {
        let _ = self.tx.send(seq);
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

pub fn publish_event(db: &Database, bus: &EventBus, project_id: &str, kind: &str, payload: Value) -> i64 {
    let seq = db.append_event(project_id, kind, &payload).unwrap_or(0);
    bus.notify(seq);
    seq
}

pub fn publish_user_event(db: &Database, bus: &EventBus, user_id: &str, kind: &str, payload: Value) -> i64 {
    let seq = db
        .append_event(&format!("user:{user_id}"), kind, &payload)
        .unwrap_or(0);
    bus.notify(seq);
    seq
}
