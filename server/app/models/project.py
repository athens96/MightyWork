from pydantic import BaseModel, Field, field_validator

from app.models.common import Entity
from app.models.member import Permission


class ProjectBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""


class Project(Entity, ProjectBase):
    key: str  # 일감 번호 접두어 (예: MW → MW-1). 생성 후 변경 불가
    created_by: str
    task_seq: int = 0  # 마지막으로 발급한 일감 번호 (삭제돼도 재사용하지 않음)


class ProjectRead(Project):
    """응답용: 현재 사용자의 권한 포함 (클라이언트가 버튼 표시 여부 결정)."""

    my_permissions: list[Permission]
    is_owner: bool


class ProjectCreate(ProjectBase):
    key: str = Field(pattern=r"^[A-Z][A-Z0-9]{1,9}$", description="영문 대문자로 시작, 2~10자")

    @field_validator("key", mode="before")
    @classmethod
    def _upper(cls, v: object) -> object:
        return v.strip().upper() if isinstance(v, str) else v


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
