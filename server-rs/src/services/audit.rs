use std::collections::HashMap;

use serde_json::Value;

use crate::db::Database;
use crate::models::{new_id, utcnow, AuditLog};

pub fn record_audit(
    db: &Database,
    project_id: &str,
    actor_id: &str,
    action: &str,
    target_type: &str,
    target_id: &str,
    summary: impl Into<String>,
    details: HashMap<String, Value>,
) {
    let now = utcnow();
    let entry = AuditLog {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: project_id.to_string(),
        actor_id: actor_id.to_string(),
        action: action.to_string(),
        target_type: target_type.to_string(),
        target_id: target_id.to_string(),
        summary: summary.into(),
        details,
    };
    let _ = db.audit_logs.create(&entry);
}
