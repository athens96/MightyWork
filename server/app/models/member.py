from enum import Enum

from pydantic import BaseModel, Field, field_validator

from app.models.common import Entity
from app.models.user import User


class Permission(str, Enum):
    VIEW = "view"  # 보기
    CREATE = "create"  # 생성 (일감·위키·덧글)
    EDIT = "edit"  # 편집 (일감·위키)
    DELETE = "delete"  # 삭제 (일감·위키·남의 덧글 제외)
    ADMIN = "admin"  # 관리자: 멤버·권한 관리, 프로젝트 정보 수정 (모든 권한 포함)


def normalize_permissions(perms: list[Permission] | set[Permission]) -> list[Permission]:
    """관리자는 모든 권한, 그 외에도 보기는 항상 포함. 정해진 순서로 반환."""
    s = set(perms)
    if Permission.ADMIN in s:
        s = set(Permission)
    s.add(Permission.VIEW)
    return [p for p in Permission if p in s]


class ProjectMember(Entity):
    """프로젝트 멤버. 이메일로 초대하므로 아직 로그인한 적 없는 사람도 추가할 수 있다.
    프로젝트 생성자(소유자)는 여기 저장하지 않고 항상 관리자로 취급한다."""

    project_id: str
    email: str  # 소문자
    permissions: list[Permission]
    added_by: str


def _clean_email(v: object) -> object:
    return v.strip().lower() if isinstance(v, str) else v


class MemberCreate(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=254)
    permissions: list[Permission] = [Permission.VIEW, Permission.CREATE, Permission.EDIT]

    _email = field_validator("email", mode="before")(_clean_email)


class MemberUpdate(BaseModel):
    permissions: list[Permission]


class MemberRead(BaseModel):
    id: str  # 멤버 id, 소유자는 "owner"
    email: str
    user: User | None  # 로그인한 적 없으면 None
    permissions: list[Permission]
    is_owner: bool = False
    pending: bool = False  # 초대됐지만 아직 로그인 안 함
