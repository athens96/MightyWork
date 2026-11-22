"""데이터 마이그레이션 도우미 (서버 기동 시 자동 실행 · 멱등성 보장)."""

import logging
import re

from app.db import Database

logger = logging.getLogger("mightywork.migrations")

# v0.5.9, v0.5.10, v0.6.0, v0.6.x, v1.0, v2.x, 0.1.0, 1.2.3-rc.1, version:v0.1.0, ver:0.2.0 등 매칭
# (p0/p1/p2, versioning, cycle:2026-11, e2e 같은 일반 레이블은 제외)
_VERSION_TAG_RE = re.compile(
    r"^(?:(?:version|ver)\s*:\s*)?([vV]?\d+\.\d+(?:\.(?:\d+|x|X|\*))?(?:-[0-9A-Za-z.-]+)?|[vV]\d+\.[xX*])$",
    re.IGNORECASE,
)


def extract_version_from_tag(tag: str) -> str | None:
    """레이블 문자열이 버전 표기이면 정규화된 버전 문자열을 반환하고, 아니면 None."""
    cleaned = tag.strip()
    m = _VERSION_TAG_RE.fullmatch(cleaned)
    if not m:
        return None
    ver = m.group(1)
    if ver.startswith("V"):
        ver = "v" + ver[1:]
    # 와일드카드 대문자 X 는 소문자 x 로 통일 (예: v0.6.X -> v0.6.x)
    ver = re.sub(r"\.X(?=$|-)", ".x", ver)
    return ver[:40]


def migrate_version_tags(db: Database) -> int:
    """기존 일감의 tags 에 들어 있던 버전 레이블을 전용 version 필드로 이전한다 (updated_at 보존, 멱등)."""
    migrated = 0
    for task in db.tasks.list():
        if not task.tags:
            continue

        new_version = task.version
        new_tags: list[str] = []
        changed = False

        for tag in task.tags:
            extracted = extract_version_from_tag(tag)
            if extracted is None:
                new_tags.append(tag)
                continue

            if new_version is None:
                new_version = extracted
                changed = True
                continue

            # 이미 version 필드가 동일한 버전으로 채워져 있으면 중복 태그만 제거
            if new_version.casefold() == extracted.casefold():
                changed = True
                continue

            # 다른 추가 버전 태그는 정보 유실을 막기 위해 유지
            new_tags.append(tag)

        if changed:
            # updated_at 은 보존하여 완료 월별 묶음 정렬에 영향을 주지 않는다
            db.tasks.update(task.model_copy(update={"version": new_version, "tags": new_tags}))
            migrated += 1

    if migrated:
        logger.info("Migrated version tags to dedicated task.version field for %d task(s).", migrated)
    return migrated


if __name__ == "__main__":
    from app.core.config import Settings

    logging.basicConfig(level=logging.INFO)
    settings = Settings()
    database = (
        Database.from_sqlite(settings.data_dir)
        if settings.db_backend == "sqlite"
        else Database.from_json_files(settings.data_dir)
    )
    count = migrate_version_tags(database)
    print(f"Migrated {count} task(s).")
