from datetime import datetime
from enum import Enum
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field

from app.models.common import Entity


def _clean_aliases(values: list[str]) -> list[str]:
    """공백 정리, 빈 값·중복(대소문자 무시) 제거."""
    seen, out = set(), []
    for v in values:
        v = " ".join(v.split())
        if v and v.casefold() not in seen:
            seen.add(v.casefold())
            out.append(v[:100])
    return out


# 별칭(동의어): [[별칭]] 링크, 검색, 링크 안 된 언급 찾기에 제목과 같이 쓰인다
Aliases = Annotated[list[str], Field(max_length=20), AfterValidator(_clean_aliases)]
# 태그: 같은 정리 규칙
Tags = Annotated[list[str], Field(max_length=20), AfterValidator(_clean_aliases)]


class PageType(str, Enum):
    """문서 종류 (옵시디언 Properties 의 type 에 해당)."""

    GUIDE = "guide"  # 가이드
    SPEC = "spec"  # 명세
    DECISION = "decision"  # 결정 기록
    MEETING = "meeting"  # 회의록
    REFERENCE = "reference"  # 참고 자료
    NOTE = "note"  # 메모


class PageStatus(str, Enum):
    DRAFT = "draft"  # 초안
    REVIEW = "review"  # 검토 중
    PUBLISHED = "published"  # 확정
    DEPRECATED = "deprecated"  # 폐기


class WikiPageBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = ""  # Markdown
    parent_id: str | None = None  # 계층 구조(노션/컨플루언스 스타일 트리)
    aliases: Aliases = []
    # Properties — 비워 두면 '미지정'
    page_type: PageType | None = None
    status: PageStatus | None = None
    owner_id: str | None = None  # 문서 담당자 (프로젝트 멤버)
    tags: Tags = []


class WikiPage(Entity, WikiPageBase):
    project_id: str
    created_by: str
    updated_by: str


class WikiPageCreate(WikiPageBase):
    pass


class WikiPageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None
    parent_id: str | None = None
    aliases: Aliases | None = None
    page_type: PageType | None = None
    status: PageStatus | None = None
    owner_id: str | None = None
    tags: Tags | None = None


class WikiPageSummary(BaseModel):
    """트리(사이드바)·링크 해석용 경량 응답 — 본문 제외."""

    id: str
    title: str
    parent_id: str | None
    aliases: list[str] = []
    page_type: PageType | None = None
    status: PageStatus | None = None
    owner_id: str | None = None
    tags: list[str] = []
    updated_at: datetime
