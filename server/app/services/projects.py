import threading

from app.db import Database

# 파일 DB 에는 트랜잭션이 없으므로, 프로젝트 레코드를 읽고-수정-쓰는 작업
# (일감 번호 발급, 프로젝트 수정/삭제)은 이 락으로 직렬화한다. 단일 프로세스 전제.
project_write_lock = threading.RLock()


def allocate_task_number(db: Database, project_id: str) -> int:
    with project_write_lock:
        project = db.projects.get(project_id)
        if project is None:
            raise LookupError(project_id)
        number = project.task_seq + 1
        db.projects.update(project.model_copy(update={"task_seq": number}))
        return number


def delete_project_cascade(db: Database, project_id: str) -> bool:
    """프로젝트와 그 하위 일감(덧글·이력 포함)/위키 페이지를 모두 삭제한다."""
    with project_write_lock:
        if db.projects.get(project_id) is None:
            return False
        for task in db.tasks.list(lambda t: t.project_id == project_id):
            db.tasks.delete(task.id)
        for comment in db.comments.list(lambda c: c.project_id == project_id):
            db.comments.delete(comment.id)
        for activity in db.task_activities.list(lambda a: a.project_id == project_id):
            db.task_activities.delete(activity.id)
        for member in db.project_members.list(lambda m: m.project_id == project_id):
            db.project_members.delete(member.id)
        for page in db.wiki_pages.list(lambda p: p.project_id == project_id):
            db.wiki_pages.delete(page.id)
        return db.projects.delete(project_id)
