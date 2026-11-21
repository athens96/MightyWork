"""@멘션 파싱 및 사용자 알림 생성."""

import re

from app.db import Database
from app.models.notification import Notification, NotificationKind
from app.models.project import Project
from app.models.user import User
from app.services.access import project_related_users
from app.services.events import publish_user_event
from app.services.webhooks import dispatch_project_webhooks

_CODE = re.compile(r"```.*?```|`[^`\n]*`", re.S)
# @email@domain.com 또는 @이름/로컬파트 (앞이 단어 문자나 이메일 중간이 아닌 경우)
_MENTION_EMAIL = re.compile(r"(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
_MENTION_TOKEN = re.compile(r"(?<![A-Za-z0-9._%+-])@([^\s@,;:\[\]()\"'`<>]{2,40})")


def parse_mentioned_users(db: Database, project: Project, text: str) -> list[User]:
    """텍스트에서 프로젝트 멤버를 가리키는 @이메일 / @로컬파트 / @이름 멘션을 찾아 중복 없이 반환."""
    if "@" not in text:
        return []
    clean = _CODE.sub(" ", text)
    candidates = project_related_users(db, project)
    by_email = {u.email.lower(): u for u in candidates}
    by_local: dict[str, User] = {}
    by_name: dict[str, User] = {}
    for u in candidates:
        local = u.email.split("@", 1)[0].lower()
        by_local.setdefault(local, u)
        if u.name.strip():
            by_name.setdefault(u.name.strip().casefold(), u)

    found: dict[str, User] = {}
    for m in _MENTION_EMAIL.finditer(clean):
        if (u := by_email.get(m.group(1).lower())) is not None:
            found[u.id] = u
    for m in _MENTION_TOKEN.finditer(clean):
        raw = m.group(1).rstrip(".,!?:;)")
        key = raw.casefold()
        if key in by_email:
            found[by_email[key].id] = by_email[key]
        elif key in by_local:
            found[by_local[key].id] = by_local[key]
        elif key in by_name:
            found[by_name[key].id] = by_name[key]
    return list(found.values())


def notify_user(
    db: Database,
    *,
    user_id: str,
    project_id: str,
    actor_id: str,
    kind: NotificationKind,
    title: str,
    body: str = "",
    link: str = "",
) -> Notification | None:
    if user_id == actor_id:
        return None
    created = db.notifications.create(
        Notification(
            user_id=user_id,
            project_id=project_id,
            actor_id=actor_id,
            kind=kind,
            title=title[:200],
            body=body[:500],
            link=link,
        )
    )
    publish_user_event(db, user_id, "notification.created", {"notification_id": created.id, "project_id": project_id, "kind": kind})
    return created


def notify_mentions(
    db: Database,
    *,
    project: Project,
    actor: User,
    text: str,
    title: str,
    link: str,
    exclude_user_ids: set[str] | None = None,
) -> list[Notification]:
    excluded = (exclude_user_ids or set()) | {actor.id}
    excerpt = " ".join(text.split())[:140]
    created: list[Notification] = []
    for target in parse_mentioned_users(db, project, text):
        if target.id in excluded:
            continue
        n = notify_user(
            db,
            user_id=target.id,
            project_id=project.id,
            actor_id=actor.id,
            kind="mention",
            title=title,
            body=excerpt,
            link=link,
        )
        if n is not None:
            created.append(n)
    if created:
        dispatch_project_webhooks(
            db,
            project,
            event="mention",
            title=title,
            body=excerpt,
            link=link,
            extra={"mentioned_user_ids": [n.user_id for n in created]},
        )
    return created
