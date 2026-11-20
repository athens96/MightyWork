"""프로젝트 멤버 초대 메일 발송 (SMTP 설정 시 발송, 미설정 시 안전하게 건너뜀)."""

import logging
import smtplib
from email.message import EmailMessage
from typing import Callable

from app.core.config import Settings
from app.models.member import Permission
from app.models.project import Project
from app.models.user import User

logger = logging.getLogger("mightywork.email")

PERM_KO = {
    Permission.VIEW: "보기",
    Permission.CREATE: "생성",
    Permission.EDIT: "편집",
    Permission.DELETE: "삭제",
    Permission.ADMIN: "관리자",
}

InviteSender = Callable[[Settings, str, Project, User, list[Permission]], str]


def send_invite_email(
    settings: Settings,
    to_email: str,
    project: Project,
    inviter: User,
    permissions: list[Permission],
) -> str:
    """초대 메일 발송. 반환값: 'sent' | 'skipped_unconfigured' | 'failed'."""
    if not settings.smtp_host:
        return "skipped_unconfigured"

    sender = settings.smtp_from or settings.smtp_user or "noreply@mightywork.local"
    inviter_name = inviter.name or inviter.email
    perms_text = ", ".join(PERM_KO.get(p, p.value) for p in permissions)
    project_url = f"{settings.app_url.rstrip('/')}/projects/{project.id}/tasks"

    msg = EmailMessage()
    msg["Subject"] = f"[{settings.app_name}] '{project.name}' ({project.key}) 프로젝트에 초대되었습니다"
    msg["From"] = sender
    msg["To"] = to_email
    msg.set_content(
        f"안녕하세요.\n\n"
        f"{inviter_name} 님이 MightyWork '{project.name}' ({project.key}) 프로젝트에 초대했습니다.\n"
        f"- 부여된 권한: {perms_text}\n"
        f"- 바로가기: {project_url}\n\n"
        f"초대받은 구글 계정({to_email})으로 로그인하면 바로 참여할 수 있습니다.\n"
    )

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
            if settings.smtp_use_tls:
                smtp.starttls()
            if settings.smtp_user:
                smtp.login(settings.smtp_user, settings.smtp_password)
            smtp.send_message(msg)
        return "sent"
    except Exception:
        logger.exception("Failed to send invite email to %s", to_email)
        return "failed"
