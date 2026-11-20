from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import AccessDep, CurrentUser, DbDep, ProjectDep, TaskDep, apply_patch, require
from app.models.activity import TaskActivity
from app.models.comment import Comment, CommentCreate, CommentUpdate
from app.models.member import Permission
from app.services.notifications import notify_mentions, notify_user

router = APIRouter(prefix="/projects/{project_id}/tasks/{task_id}", tags=["comments"])


@router.get("/comments", response_model=list[Comment])
def list_comments(task: TaskDep, db: DbDep) -> list[Comment]:
    return sorted(db.comments.list(lambda c: c.task_id == task.id), key=lambda c: c.created_at)


@router.post("/comments", response_model=Comment, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_comment(project: ProjectDep, task: TaskDep, body: CommentCreate, user: CurrentUser, db: DbDep) -> Comment:
    comment = db.comments.create(
        Comment(project_id=task.project_id, task_id=task.id, author_id=user.id, body=body.body)
    )
    link = f"/projects/{project.id}/tasks/{task.id}"
    key = f"{project.key}-{task.number}"
    mentioned = notify_mentions(
        db,
        project=project,
        actor=user,
        text=comment.body,
        title=f"{key} '{task.title}' 덧글에서 나를 언급했습니다",
        link=link,
    )
    already = {n.user_id for n in mentioned}
    for uid in {task.assignee_id, task.created_by}:
        if uid and uid not in already:
            notify_user(
                db,
                user_id=uid,
                project_id=project.id,
                actor_id=user.id,
                kind="comment",
                title=f"{key} '{task.title}' 에 새 덧글이 달렸습니다",
                body=" ".join(comment.body.split())[:140],
                link=link,
            )
    return comment


def _own_comment(db: DbDep, task_id: str, comment_id: str, user_id: str, admin_ok: bool = False) -> Comment:
    """작성자 본인만 (삭제는 관리자도) 접근."""
    comment = db.comments.get(comment_id)
    if comment is None or comment.task_id != task_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Comment not found")
    if comment.author_id != user_id and not admin_ok:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the author can modify this comment")
    return comment


@router.patch("/comments/{comment_id}", response_model=Comment)
def update_comment(task: TaskDep, comment_id: str, body: CommentUpdate, user: CurrentUser, db: DbDep) -> Comment:
    updated = apply_patch(_own_comment(db, task.id, comment_id, user.id), body)
    db.comments.update(updated)
    return updated


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_comment(access: AccessDep, task: TaskDep, comment_id: str, user: CurrentUser, db: DbDep) -> Response:
    db.comments.delete(_own_comment(db, task.id, comment_id, user.id, admin_ok=access.can(Permission.ADMIN)).id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/activity", response_model=list[TaskActivity])
def list_activity(task: TaskDep, db: DbDep) -> list[TaskActivity]:
    """변경 이력(생성, 상태·담당자·날짜 등 변경)."""
    return sorted(db.task_activities.list(lambda a: a.task_id == task.id), key=lambda a: a.created_at)
