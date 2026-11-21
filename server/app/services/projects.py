import shutil
import threading

from app.db import Database

# JSON 백엔드용 락 (SQLite 백엔드는 BEGIN IMMEDIATE 트랜잭션 사용)
project_write_lock = threading.RLock()


def allocate_task_number(db: Database, project_id: str) -> int:
    with project_write_lock:
        return db.allocate_task_number(project_id)


def delete_project_cascade(db: Database, project_id: str) -> bool:
    """프로젝트와 그 하위 모든 데이터(일감·링크·덧글·이력·위키·버전·첨부·알림·감사로그·지식)를 삭제한다."""
    with project_write_lock:
        if db.projects.get(project_id) is None:
            return False
        for repo in (
            db.tasks,
            db.task_links,
            db.saved_views,
            db.comments,
            db.task_activities,
            db.project_members,
            db.wiki_pages,
            db.wiki_revisions,
            db.attachments,
            db.notifications,
            db.audit_logs,
            db.glossary_terms,
            db.knowledge_entities,
            db.knowledge_relations,
            db.github_integrations,
            db.github_links,
        ):
            for item in repo.list(lambda x: x.project_id == project_id):
                repo.delete(item.id)
        if db.data_dir is not None:
            shutil.rmtree(db.data_dir / "attachments" / project_id, ignore_errors=True)
        return db.projects.delete(project_id)
