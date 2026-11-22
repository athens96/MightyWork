"""@멘션·작업자 배정·소유권 이전 알림 모델."""

from typing import Literal

from app.models.common import Entity

NotificationKind = Literal["mention", "assigned", "comment", "ownership", "invite", "watched"]


class Notification(Entity):
    user_id: str
    project_id: str
    actor_id: str
    kind: NotificationKind
    title: str
    body: str = ""
    link: str = ""  # 앱 내부 경로 (예: /projects/<pid>/tasks/<tid>)
    read: bool = False
