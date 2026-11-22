from app.db import Database
from app.models.activity import TaskActivity
from app.models.common import utcnow
from app.models.task import Task
from app.models.wiki import WikiPage

# 변경 이력에 남기는 필드 (설명·체크리스트는 잦은 편집으로 이력이 넘치므로 제외)
TRACKED_FIELDS = ("title", "stage", "priority", "parent_id", "cycle_id", "milestone_id", "version", "assignee_id", "start_date", "due_date", "estimate", "tags")


def record_created(db: Database, task: Task, actor_id: str, *, via_client: str | None = None) -> None:
    db.task_activities.create(
        TaskActivity(project_id=task.project_id, task_id=task.id, actor_id=actor_id, kind="created", via_client=via_client)
    )


def record_changes(db: Database, before: Task, after: Task, actor_id: str, *, via_client: str | None = None) -> None:
    old, new = before.model_dump(mode="json"), after.model_dump(mode="json")
    for field in TRACKED_FIELDS:
        if old[field] != new[field]:
            db.task_activities.create(
                TaskActivity(
                    project_id=after.project_id,
                    task_id=after.id,
                    actor_id=actor_id,
                    kind="updated",
                    field=field,
                    old=old[field],
                    new=new[field],
                    via_client=via_client,
                )
            )


def soft_delete_task(db: Database, task: Task, actor_id: str) -> Task:
    """일감을 휴지통으로 이동한다 (덧글·활동 이력은 복구용으로 유지, 하위 일감 parent_id 는 해제)."""
    for child in db.tasks.list(lambda t: t.parent_id == task.id and t.deleted_at is None):
        db.tasks.update(child.model_copy(update={"parent_id": None}))
    trashed = task.model_copy(update={"deleted_at": utcnow(), "deleted_by": actor_id})
    db.tasks.update(trashed)
    return trashed


def soft_delete_wiki_page(db: Database, page: WikiPage, actor_id: str) -> WikiPage:
    """위키 페이지를 휴지통으로 이동한다 (버전 히스토리·댓글은 복구용으로 유지)."""
    trashed = page.model_copy(update={"deleted_at": utcnow(), "deleted_by": actor_id})
    db.wiki_pages.update(trashed)
    return trashed


def delete_wiki_page_cascade(db: Database, page_id: str) -> bool:
    """위키 페이지와 그 버전 히스토리·댓글을 영구 삭제한다."""
    for rev in db.wiki_revisions.list(lambda r: r.page_id == page_id):
        db.wiki_revisions.delete(rev.id)
    for cmt in db.wiki_comments.list(lambda c: c.page_id == page_id):
        db.wiki_comments.delete(cmt.id)
    return db.wiki_pages.delete(page_id)


def delete_task_cascade(db: Database, task_id: str) -> bool:
    """일감과 그 덧글·변경 이력·일감 간 링크를 영구 삭제하고 하위 일감의 parent_id 를 해제한다."""
    for comment in db.comments.list(lambda c: c.task_id == task_id):
        db.comments.delete(comment.id)
    for activity in db.task_activities.list(lambda a: a.task_id == task_id):
        db.task_activities.delete(activity.id)
    for link in db.task_links.list(lambda l: l.source_id == task_id or l.target_id == task_id):
        db.task_links.delete(link.id)
    for child in db.tasks.list(lambda t: t.parent_id == task_id):
        db.tasks.update(child.model_copy(update={"parent_id": None}))
    return db.tasks.delete(task_id)
