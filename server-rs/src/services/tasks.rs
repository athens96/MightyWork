use serde_json::Value;

use crate::db::{Database, PROJECT_SCOPED_TABLES};
use crate::error::ApiResult;
use crate::models::{new_id, utcnow, Task, TaskActivity, WikiPage};

const TRACKED_FIELDS: &[&str] = &[
    "title",
    "stage",
    "priority",
    "parent_id",
    "cycle_id",
    "milestone_id",
    "version",
    "assignee_id",
    "start_date",
    "due_date",
    "estimate",
    "tags",
];

pub fn record_created(db: &Database, task: &Task, actor_id: &str, via_client: Option<String>) {
    let now = utcnow();
    let act = TaskActivity {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: task.project_id.clone(),
        task_id: task.id.clone(),
        actor_id: actor_id.to_string(),
        kind: "created".into(),
        field: None,
        old: Value::Null,
        new: Value::Null,
        via_client,
    };
    let _ = db.task_activities.create(&act);
}

pub fn record_changes(db: &Database, before: &Task, after: &Task, actor_id: &str, via_client: Option<String>) {
    let old_map = serde_json::to_value(before).unwrap_or(Value::Null);
    let new_map = serde_json::to_value(after).unwrap_or(Value::Null);
    for &field in TRACKED_FIELDS {
        let old_v = old_map.get(field).cloned().unwrap_or(Value::Null);
        let new_v = new_map.get(field).cloned().unwrap_or(Value::Null);
        if old_v != new_v {
            let now = utcnow();
            let act = TaskActivity {
                id: new_id(),
                created_at: now,
                updated_at: now,
                project_id: after.project_id.clone(),
                task_id: after.id.clone(),
                actor_id: actor_id.to_string(),
                kind: "updated".into(),
                field: Some(field.to_string()),
                old: old_v,
                new: new_v,
                via_client: via_client.clone(),
            };
            let _ = db.task_activities.create(&act);
        }
    }
}

pub fn soft_delete_task(db: &Database, task: &Task, actor_id: &str) -> ApiResult<Task> {
    for mut child in db
        .tasks
        .list_by_project(&task.project_id)?
        .into_iter()
        .filter(|t| t.parent_id.as_deref() == Some(&task.id) && t.deleted_at.is_none())
    {
        child.parent_id = None;
        db.tasks.update(&child)?;
    }
    let mut trashed = task.clone();
    trashed.deleted_at = Some(utcnow());
    trashed.deleted_by = Some(actor_id.to_string());
    db.tasks.update(&trashed)?;
    Ok(trashed)
}

pub fn soft_delete_wiki_page(db: &Database, page: &WikiPage, actor_id: &str) -> ApiResult<WikiPage> {
    let mut trashed = page.clone();
    trashed.deleted_at = Some(utcnow());
    trashed.deleted_by = Some(actor_id.to_string());
    db.wiki_pages.update(&trashed)?;
    Ok(trashed)
}

pub fn delete_wiki_page_cascade(db: &Database, project_id: &str, page_id: &str) -> ApiResult<bool> {
    for rev in db
        .wiki_revisions
        .list_by_project(project_id)?
        .into_iter()
        .filter(|r| r.page_id == page_id)
    {
        db.wiki_revisions.delete(&rev.id)?;
    }
    for cmt in db
        .wiki_comments
        .list_by_project(project_id)?
        .into_iter()
        .filter(|c| c.page_id == page_id)
    {
        db.wiki_comments.delete(&cmt.id)?;
    }
    Ok(db.wiki_pages.delete(page_id)?)
}

pub fn delete_task_cascade(db: &Database, project_id: &str, task_id: &str) -> ApiResult<bool> {
    for c in db
        .comments
        .list_by_project(project_id)?
        .into_iter()
        .filter(|c| c.task_id == task_id)
    {
        db.comments.delete(&c.id)?;
    }
    for a in db
        .task_activities
        .list_by_project(project_id)?
        .into_iter()
        .filter(|a| a.task_id == task_id)
    {
        db.task_activities.delete(&a.id)?;
    }
    for l in db
        .task_links
        .list_by_project(project_id)?
        .into_iter()
        .filter(|l| l.source_id == task_id || l.target_id == task_id)
    {
        db.task_links.delete(&l.id)?;
    }
    for mut child in db
        .tasks
        .list_by_project(project_id)?
        .into_iter()
        .filter(|t| t.parent_id.as_deref() == Some(task_id))
    {
        child.parent_id = None;
        db.tasks.update(&child)?;
    }
    Ok(db.tasks.delete(task_id)?)
}

pub fn delete_project_cascade(db: &Database, project_id: &str) -> ApiResult<bool> {
    if db.projects.get(project_id)?.is_none() {
        return Ok(false);
    }
    for &table in PROJECT_SCOPED_TABLES {
        db.engine.delete_by_project(table, project_id)?;
    }
    let att_dir = db.data_dir.join("attachments").join(project_id);
    if att_dir.exists() {
        let _ = std::fs::remove_dir_all(att_dir);
    }
    Ok(db.projects.delete(project_id)?)
}
