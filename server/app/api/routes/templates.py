"""일감 템플릿 CRUD API (/api/projects/{project_id}/task-templates)."""

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import CurrentUser, DbDep, ProjectDep, apply_patch, require
from app.models.member import Permission
from app.models.template import TaskTemplate, TaskTemplateCreate, TaskTemplateUpdate

router = APIRouter(prefix="/projects/{project_id}/task-templates", tags=["templates"])


@router.get("", response_model=list[TaskTemplate])
def list_templates(project: ProjectDep, db: DbDep) -> list[TaskTemplate]:
    return sorted(db.task_templates.list(lambda t: t.project_id == project.id), key=lambda t: t.created_at)


@router.post("", response_model=TaskTemplate, status_code=status.HTTP_201_CREATED, dependencies=[require(Permission.CREATE)])
def create_template(project: ProjectDep, body: TaskTemplateCreate, user: CurrentUser, db: DbDep) -> TaskTemplate:
    clean = body.model_copy(
        update={
            "tags": [t.strip() for t in body.tags if t.strip()],
            "checklist": [c.strip() for c in body.checklist if c.strip()],
        }
    )
    return db.task_templates.create(TaskTemplate(**clean.model_dump(), project_id=project.id, created_by=user.id))


@router.patch("/{template_id}", response_model=TaskTemplate, dependencies=[require(Permission.EDIT)])
def update_template(project: ProjectDep, template_id: str, body: TaskTemplateUpdate, db: DbDep) -> TaskTemplate:
    tpl = db.task_templates.get(template_id)
    if tpl is None or tpl.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    updated = apply_patch(tpl, body)
    db.task_templates.update(updated)
    return updated


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[require(Permission.DELETE)])
def delete_template(project: ProjectDep, template_id: str, db: DbDep) -> Response:
    tpl = db.task_templates.get(template_id)
    if tpl is None or tpl.project_id != project.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found")
    db.task_templates.delete(tpl.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
