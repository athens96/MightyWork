import logging
import threading
from pathlib import Path

from app.db.base import Repository
from app.db.json_store import JsonFileRepository
from app.db.sqlite_store import SqliteEngine, SqliteOAuthStore, SqliteRepository
from app.models.activity import TaskActivity
from app.models.attachment import Attachment
from app.models.audit import AuditLog
from app.models.comment import Comment
from app.models.cycle import Cycle
from app.models.integration import GitHubIntegration, GitHubLink, ProjectWebhook, WebhookDelivery
from app.models.knowledge import GlossaryTerm, KnowledgeEntity, KnowledgeRelation
from app.models.member import ProjectMember
from app.models.notification import Notification
from app.models.oauth import OAuthClient, OAuthGrant, RefreshToken
from app.models.project import Project
from app.models.task import ProjectPipeline, Task, TaskLink
from app.models.template import TaskTemplate
from app.models.user import User
from app.models.view import SavedView
from app.models.wiki import WikiPage, WikiRevision

logger = logging.getLogger("mightywork.db")

_COLLECTIONS = (
    ("users", "users.json", User),
    ("projects", "projects.json", Project),
    ("project_members", "project_members.json", ProjectMember),
    ("tasks", "tasks.json", Task),
    ("task_links", "task_links.json", TaskLink),
    ("saved_views", "saved_views.json", SavedView),
    ("cycles", "cycles.json", Cycle),
    ("task_templates", "task_templates.json", TaskTemplate),
    ("project_pipelines", "project_pipelines.json", ProjectPipeline),
    ("comments", "comments.json", Comment),
    ("task_activities", "task_activities.json", TaskActivity),
    ("wiki_pages", "wiki_pages.json", WikiPage),
    ("wiki_revisions", "wiki_revisions.json", WikiRevision),
    ("attachments", "attachments.json", Attachment),
    ("notifications", "notifications.json", Notification),
    ("audit_logs", "audit_logs.json", AuditLog),
    ("glossary_terms", "glossary_terms.json", GlossaryTerm),
    ("knowledge_entities", "knowledge_entities.json", KnowledgeEntity),
    ("knowledge_relations", "knowledge_relations.json", KnowledgeRelation),
    ("github_integrations", "github_integrations.json", GitHubIntegration),
    ("github_links", "github_links.json", GitHubLink),
    ("project_webhooks", "project_webhooks.json", ProjectWebhook),
    ("webhook_deliveries", "webhook_deliveries.json", WebhookDelivery),
    ("oauth_clients", "oauth_clients.json", OAuthClient),
    ("oauth_grants", "oauth_grants.json", OAuthGrant),
    ("refresh_tokens", "refresh_tokens.json", RefreshToken),
)


class Database:
    """앱이 사용하는 저장소 묶음. DB 교체 시 이 클래스만 바꾸면 된다."""

    def __init__(
        self,
        users: Repository[User],
        projects: Repository[Project],
        project_members: Repository[ProjectMember],
        tasks: Repository[Task],
        comments: Repository[Comment],
        task_activities: Repository[TaskActivity],
        wiki_pages: Repository[WikiPage],
        oauth_clients: Repository[OAuthClient],
        oauth_grants: Repository[OAuthGrant],
        refresh_tokens: Repository[RefreshToken],
        attachments: Repository[Attachment] | None = None,
        task_links: Repository[TaskLink] | None = None,
        saved_views: Repository[SavedView] | None = None,
        cycles: Repository[Cycle] | None = None,
        task_templates: Repository[TaskTemplate] | None = None,
        project_pipelines: Repository[ProjectPipeline] | None = None,
        wiki_revisions: Repository[WikiRevision] | None = None,
        notifications: Repository[Notification] | None = None,
        audit_logs: Repository[AuditLog] | None = None,
        glossary_terms: Repository[GlossaryTerm] | None = None,
        knowledge_entities: Repository[KnowledgeEntity] | None = None,
        knowledge_relations: Repository[KnowledgeRelation] | None = None,
        github_integrations: Repository[GitHubIntegration] | None = None,
        github_links: Repository[GitHubLink] | None = None,
        project_webhooks: Repository[ProjectWebhook] | None = None,
        webhook_deliveries: Repository[WebhookDelivery] | None = None,
        *,
        data_dir: Path | None = None,
        sqlite_engine: SqliteEngine | None = None,
    ):
        base = data_dir or Path("data")
        self.users = users
        self.projects = projects
        self.project_members = project_members
        self.tasks = tasks
        self.task_links = task_links or JsonFileRepository(base / "task_links.json", TaskLink)
        self.saved_views = saved_views or JsonFileRepository(base / "saved_views.json", SavedView)
        self.cycles = cycles or JsonFileRepository(base / "cycles.json", Cycle)
        self.task_templates = task_templates or JsonFileRepository(base / "task_templates.json", TaskTemplate)
        self.project_pipelines = project_pipelines or JsonFileRepository(base / "project_pipelines.json", ProjectPipeline)
        self.comments = comments
        self.task_activities = task_activities
        self.wiki_pages = wiki_pages
        self.wiki_revisions = wiki_revisions or JsonFileRepository(base / "wiki_revisions.json", WikiRevision)
        self.attachments = attachments or JsonFileRepository(base / "attachments.json", Attachment)
        self.notifications = notifications or JsonFileRepository(base / "notifications.json", Notification)
        self.audit_logs = audit_logs or JsonFileRepository(base / "audit_logs.json", AuditLog)
        self.glossary_terms = glossary_terms or JsonFileRepository(base / "glossary_terms.json", GlossaryTerm)
        self.knowledge_entities = knowledge_entities or JsonFileRepository(base / "knowledge_entities.json", KnowledgeEntity)
        self.knowledge_relations = knowledge_relations or JsonFileRepository(base / "knowledge_relations.json", KnowledgeRelation)
        self.github_integrations = github_integrations or JsonFileRepository(base / "github_integrations.json", GitHubIntegration)
        self.github_links = github_links or JsonFileRepository(base / "github_links.json", GitHubLink)
        self.project_webhooks = project_webhooks or JsonFileRepository(base / "project_webhooks.json", ProjectWebhook)
        self.webhook_deliveries = webhook_deliveries or JsonFileRepository(base / "webhook_deliveries.json", WebhookDelivery)
        self.oauth_clients = oauth_clients
        self.oauth_grants = oauth_grants
        self.refresh_tokens = refresh_tokens
        self.data_dir = data_dir
        self._sqlite = sqlite_engine
        self._seq_lock = threading.RLock()
        self._events: list[tuple[int, str, str, dict]] = []
        self._event_seq = 0

    def append_event(self, channel: str, kind: str, payload: dict) -> int:
        if self._sqlite is not None:
            return self._sqlite.append_event(channel, kind, payload)
        with self._seq_lock:
            self._event_seq += 1
            self._events.append((self._event_seq, channel, kind, payload))
            if len(self._events) > 1000:
                self._events = self._events[-500:]
            return self._event_seq

    def latest_event_seq(self) -> int:
        if self._sqlite is not None:
            return self._sqlite.latest_event_seq()
        with self._seq_lock:
            return self._event_seq

    def fetch_events(self, channels: list[str], after_seq: int, limit: int = 50) -> list[tuple[int, str, dict]]:
        if self._sqlite is not None:
            return self._sqlite.fetch_events(channels, after_seq, limit)
        wanted = set(channels)
        with self._seq_lock:
            matched = [(seq, kind, payload) for seq, ch, kind, payload in self._events if seq > after_seq and ch in wanted]
            return matched[:limit]

    def allocate_task_number(self, project_id: str) -> int:
        if self._sqlite is not None:
            return self._sqlite.allocate_task_number(project_id)
        with self._seq_lock:
            project = self.projects.get(project_id)
            if project is None:
                raise LookupError(project_id)
            number = project.task_seq + 1
            self.projects.update(project.model_copy(update={"task_seq": number}))
            return number

    def search_candidates(self, project_id: str, query_cf: str) -> tuple[set[str], set[str]] | None:
        """SQLite 백엔드일 때 FTS5(trigram) 인덱스로 후보 ID 집합을 반환. JSON 백엔드는 None."""
        if self._sqlite is None:
            return None
        return self._sqlite.search_candidates(project_id, query_cf)

    def make_oauth_store(self):
        if self._sqlite is not None:
            return SqliteOAuthStore(self._sqlite)
        return None

    @classmethod
    def from_json_files(cls, data_dir: Path) -> "Database":
        repos = {attr: JsonFileRepository(data_dir / filename, model) for attr, filename, model in _COLLECTIONS}
        return cls(**repos, data_dir=data_dir)

    @classmethod
    def from_sqlite(cls, data_dir: Path, *, db_name: str = "mightywork.db") -> "Database":
        db_path = data_dir / db_name
        fresh = not db_path.exists()
        engine = SqliteEngine(db_path)
        repos = {attr: SqliteRepository(engine, attr, model) for attr, _, model in _COLLECTIONS}
        db = cls(**repos, data_dir=data_dir, sqlite_engine=engine)
        if fresh:
            db._migrate_from_json_if_present(data_dir)
        return db

    def _migrate_from_json_if_present(self, data_dir: Path) -> None:
        """최초 SQLite 생성 시 기존 JSON 파일 데이터가 있으면 자동 이전 (원본 JSON 파일 유지)."""
        migrated = 0
        for attr, filename, model in _COLLECTIONS:
            src = data_dir / filename
            if not src.is_file():
                continue
            repo = getattr(self, attr)
            legacy = JsonFileRepository(src, model)
            for entity in legacy.list():
                if repo.get(entity.id) is None:
                    repo.create(entity)
                    migrated += 1
        if migrated:
            logger.info("Migrated %d records from legacy JSON files in %s to SQLite.", migrated, data_dir)
