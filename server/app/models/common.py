import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, Field


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Entity(BaseModel):
    """저장소에 보관되는 모든 도메인 객체의 공통 필드."""

    id: str = Field(default_factory=new_id)
    created_at: datetime = Field(default_factory=utcnow)
    # 생성 시 created_at 과 같은 값 (따로 now() 를 부르면 마이크로초가 달라 '수정됨'으로 보임)
    updated_at: datetime = Field(default_factory=lambda data: data["created_at"])
