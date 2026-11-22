"""데이터 마이그레이션 도우미 (서버 기동 시 자동 실행 · 멱등성 보장)."""

import calendar
from datetime import date, timedelta
import logging
import re

from app.db import Database
from app.models.cycle import Cycle, CycleStatus

logger = logging.getLogger("mightywork.migrations")

# v0.5.9, v0.5.10, v0.6.0, v0.6.x, v1.0, v2.x, 0.1.0, 1.2.3-rc.1, version:v0.1.0, ver:0.2.0 등 매칭
# (p0/p1/p2, versioning, cycle:2026-11, e2e 같은 일반 레이블은 제외)
_VERSION_TAG_RE = re.compile(
    r"^(?:(?:version|ver)\s*:\s*)?([vV]?\d+\.\d+(?:\.(?:\d+|x|X|\*))?(?:-[0-9A-Za-z.-]+)?|[vV]\d+\.[xX*])$",
    re.IGNORECASE,
)

# cycle:2026-11, cycle:2026-12, cycle:sprint-1, sprint:2026-11 등 매칭
_CYCLE_TAG_RE = re.compile(r"^(?:cycle|sprint)\s*:\s*(.+)$", re.IGNORECASE)
_YYYY_MM_RE = re.compile(r"^(\d{4})-(\d{2})$")


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


def extract_cycle_from_tag(tag: str) -> str | None:
    """레이블 문자열이 cycle:/sprint: 표기이면 사이클 이름을 반환하고, 아니면 None."""
    m = _CYCLE_TAG_RE.fullmatch(tag.strip())
    if not m:
        return None
    name = m.group(1).strip()
    return name[:120] if name else None


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


def _cycle_dates_and_status(cycle_name: str, today: date) -> tuple[date, date, CycleStatus, str]:
    m = _YYYY_MM_RE.fullmatch(cycle_name)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
        if 1 <= month <= 12:
            last_day = calendar.monthrange(year, month)[1]
            start = date(year, month, 1)
            end = date(year, month, last_day)
            if end < today:
                status: CycleStatus = "completed"
            elif start <= today <= end:
                status = "active"
            else:
                status = "upcoming"
            return start, end, status, f"{year}년 {month}월 사이클"
    return today, today + timedelta(days=13), "active", ""


def migrate_cycle_tags(db: Database, *, today: date | None = None) -> tuple[int, int]:
    """
    기존 일감의 cycle:/sprint: 레거시 태그를 정식 Cycle 엔티티와 task.cycle_id 로 이전한다.
    - 같은 프로젝트 내 동일 이름 사이클이 있으면 재사용하고, 없으면 월(YYYY-MM) 기준 기간·상태로 생성한다.
    - task.updated_at 을 보존하며 여러 번 실행해도 멱등하다.
    - 반환값: (생성된 사이클 수, 갱신된 일감 수)
    """
    ref_today = today or date.today()
    cycles_by_project: dict[str, dict[str, Cycle]] = {}
    for c in db.cycles.list():
        cycles_by_project.setdefault(c.project_id, {})[c.name.casefold()] = c

    created_cycles = 0
    migrated_tasks = 0

    for task in db.tasks.list():
        if not task.tags:
            continue

        new_cycle_id = task.cycle_id
        new_tags: list[str] = []
        changed = False
        proj_cycles = cycles_by_project.setdefault(task.project_id, {})

        for tag in task.tags:
            cycle_name = extract_cycle_from_tag(tag)
            if cycle_name is None:
                new_tags.append(tag)
                continue

            key = cycle_name.casefold()
            cycle = proj_cycles.get(key)
            if cycle is None:
                start_d, end_d, status, goal = _cycle_dates_and_status(cycle_name, ref_today)
                cycle = db.cycles.create(
                    Cycle(
                        project_id=task.project_id,
                        name=cycle_name,
                        goal=goal,
                        start_date=start_d,
                        end_date=end_d,
                        status=status,
                        created_by=task.created_by,
                    )
                )
                proj_cycles[key] = cycle
                created_cycles += 1

            if new_cycle_id is None:
                new_cycle_id = cycle.id
                changed = True
                continue

            if new_cycle_id == cycle.id:
                changed = True
                continue

            # 이미 다른 사이클에 배정되어 있으면 기존 배정을 덮어쓰지 않고 태그 보존
            new_tags.append(tag)

        if changed:
            db.tasks.update(task.model_copy(update={"cycle_id": new_cycle_id, "tags": new_tags}))
            migrated_tasks += 1

    if created_cycles or migrated_tasks:
        logger.info(
            "Migrated legacy cycle tags: created %d cycle(s), updated %d task(s).",
            created_cycles,
            migrated_tasks,
        )
    return created_cycles, migrated_tasks


def run_startup_migrations(db: Database) -> dict[str, int]:
    """서버 기동 시 실행되는 모든 멱등 데이터 마이그레이션 묶음."""
    ver_tasks = migrate_version_tags(db)
    created_cycles, cycle_tasks = migrate_cycle_tags(db)
    return {
        "version_tasks": ver_tasks,
        "created_cycles": created_cycles,
        "cycle_tasks": cycle_tasks,
    }


if __name__ == "__main__":
    from app.core.config import Settings

    logging.basicConfig(level=logging.INFO)
    settings = Settings()
    database = (
        Database.from_sqlite(settings.data_dir)
        if settings.db_backend == "sqlite"
        else Database.from_json_files(settings.data_dir)
    )
    summary = run_startup_migrations(database)
    print(f"Migrations complete: {summary}")
