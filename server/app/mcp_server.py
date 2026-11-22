"""MightyWork MCP 서버 (Streamable HTTP, /mcp).

- 프로토콜·전송·Protected Resource Metadata(RFC 9728)·401 응답은 MCP Python SDK(MCPServer)가 처리
- 토큰은 이 서버에 내장된 OAuth 인가 서버(app/services/oauth)가 발급, 여기서는 검증만 (리소스 서버)
- 모든 도구는 토큰 scope(읽기/쓰기) + 사용자의 실제 프로젝트 권한(보기/생성/편집)을 함께 확인
"""

from datetime import date
from typing import Any
from urllib.parse import urlsplit

from mcp.server import MCPServer
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import Icon, ToolAnnotations
from pydantic import AnyHttpUrl, ValidationError

from app.core.config import Settings
from app.core.version import APP_VERSION
from app.db import Database
from app.models.comment import Comment
from app.models.common import utcnow
from app.models.member import Permission
from app.models.oauth import SCOPE_READ, SCOPE_WRITE
from app.models.project import Project
from app.models.task import PIPELINE_LABELS, PipelineStage, Priority, Task, TaskLink, TaskLinkKind
from app.models.user import User
from app.models.wiki import PageStatus, PageType, WikiPage
from app.services.access import Access, accessible_projects, is_member_user, resolve_access
from app.services.events import publish_event
from app.services.knowledge_qa import answer_question
from app.services.links import norm_title, pages_by_title, project_pages, propagate_rename
from app.services.oauth import server as oauth
from app.services.projects import allocate_task_number
from app.services.search import search as search_project
from app.services.tasks import record_changes, record_created
from app.services.wiki_revisions import record_revision

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
CREATE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
UPDATE = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False)

INSTRUCTIONS = """MightyWork 는 프로젝트별 일감(파이프라인 보드)과 위키(Markdown)를 관리하는 협업 도구입니다.
- 먼저 list_projects 로 접근 가능한 프로젝트와 키(예: MW)를 확인하세요. project 인자에는 키나 id 를 씁니다.
- 일감은 'MW-12' 같은 키로 가리킵니다. 단계: backlog → todo → in_progress → review → qa → done.
- 위키 본문의 [[페이지 제목]] 은 다른 위키 페이지 링크, MW-12 는 일감 링크입니다.
- 쓰기 도구는 토큰에 쓰기 권한(mightywork:write)이 있고 프로젝트 권한(생성/편집)이 있을 때만 동작합니다."""


class MightyWorkTokenVerifier(TokenVerifier):
    def __init__(self, settings: Settings, db: Database):
        self.settings, self.db = settings, db

    async def verify_token(self, token: str) -> AccessToken | None:
        claims = oauth.verify_access_token(self.settings, self.db, token)
        if claims is None:
            return None
        return AccessToken(
            token=token,
            client_id=claims["client_id"],
            scopes=claims["scope"].split(),
            expires_at=int(claims["exp"]),
            resource=claims["aud"],
            subject=claims["sub"],
            claims={"grant": claims["grant"]},
        )


def build_mcp(settings: Settings, db: Database) -> MCPServer:
    mcp = MCPServer(
        "MightyWork",
        version=APP_VERSION,
        instructions=INSTRUCTIONS,
        website_url=settings.app_url,
        icons=[Icon(src=f"{oauth.base_url(settings)}/icon.png", mime_type="image/png", sizes=["192x192"])],
        token_verifier=MightyWorkTokenVerifier(settings, db),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(oauth.issuer(settings)),
            resource_server_url=AnyHttpUrl(oauth.resource_url(settings)),
            required_scopes=[SCOPE_READ],
            validate_token_resource=True,
        ),
    )

    # ------------------------------------------------------------ 공통 도우미

    def me(write: bool = False) -> User:
        token = get_access_token()
        if token is None or token.subject is None:
            raise ToolError("인증이 필요합니다")
        if write and SCOPE_WRITE not in token.scopes:
            raise ToolError("이 연결에는 쓰기 권한(mightywork:write)이 없습니다. 앱 연결을 다시 하면서 '쓰기 허용'을 선택하세요.")
        user = db.users.get(token.subject)
        if user is None:
            raise ToolError("사용자를 찾을 수 없습니다")
        return user

    def actor_client() -> str | None:
        """현재 MCP 호출을 수행 중인 OAuth 클라이언트(AI 에이전트) 이름 조회."""
        token = get_access_token()
        if token is None:
            return None
        grant_id = (token.claims or {}).get("grant")
        if grant_id:
            grant = db.oauth_grants.get(grant_id)
            if grant and grant.client_name:
                return grant.client_name
        return token.client_id or "MCP"

    def project_access(user: User, project: str, need: Permission = Permission.VIEW) -> Access:
        key = project.strip()
        found = [p for p in db.projects.list() if p.id == key or p.key.casefold() == key.casefold()]
        access = resolve_access(db, found[0], user) if found else None
        if access is None or not access.can(Permission.VIEW):
            raise ToolError(f"프로젝트 '{project}' 를 찾을 수 없거나 접근 권한이 없습니다")
        if not access.can(need):
            raise ToolError(f"프로젝트 '{access.project.key}' 에 '{need.value}' 권한이 없습니다")
        return access

    def find_task(p: Project, ref: str) -> Task:
        ref = ref.strip()
        num = ref.rsplit("-", 1)[-1] if "-" in ref else ref
        if not num.isdigit() or ("-" in ref and ref.rsplit("-", 1)[0].casefold() != p.key.casefold()):
            raise ToolError(f"일감 키 형식이 잘못되었습니다: {ref} (예: {p.key}-12)")
        found = db.tasks.list(lambda t: t.project_id == p.id and t.number == int(num))
        if not found:
            raise ToolError(f"일감 {p.key}-{num} 을 찾을 수 없습니다")
        return found[0]

    def find_page(p: Project, ref: str) -> WikiPage:
        page = db.wiki_pages.get(ref)
        if page is not None and page.project_id == p.id:
            return page
        page = pages_by_title(project_pages(db, p)).get(norm_title(ref))
        if page is None:
            raise ToolError(f"위키 페이지 '{ref}' 를 찾을 수 없습니다 (제목·별칭·id)")
        return page

    def user_by_email(p: Project, email: str | None) -> str | None:
        if not email:
            return None
        found = db.users.list(lambda u: u.email.casefold() == email.strip().casefold())
        if not found or not is_member_user(db, p, found[0].id):
            raise ToolError(f"'{email}' 은 이 프로젝트의 (로그인한) 멤버가 아닙니다")
        return found[0].id

    def email_of(user_id: str | None) -> str | None:
        u = db.users.get(user_id) if user_id else None
        return u.email if u else None

    def task_summary(p: Project, t: Task) -> dict[str, Any]:
        return {
            "key": f"{p.key}-{t.number}", "title": t.title, "stage": t.stage.value, "priority": t.priority.value,
            "version": t.version,
            "assignee": email_of(t.assignee_id), "due_date": t.due_date.isoformat() if t.due_date else None, "tags": t.tags,
            "checklist": f"{sum(i.done for i in t.checklist)}/{len(t.checklist)}" if t.checklist else None,
        }

    def task_detail(p: Project, t: Task) -> dict[str, Any]:
        comments = sorted(db.comments.list(lambda c: c.task_id == t.id), key=lambda c: c.created_at)
        return task_summary(p, t) | {
            "description": t.description,
            "start_date": t.start_date.isoformat() if t.start_date else None,
            "estimate": t.estimate,
            "checklist": [{"text": i.text, "done": i.done} for i in t.checklist],
            "reporter": email_of(t.created_by),
            "comments": [{"author": email_of(c.author_id), "at": c.created_at.isoformat(timespec="minutes"), "body": c.body} for c in comments],
            "updated_at": t.updated_at.isoformat(timespec="minutes"),
            "url": f"{settings.app_url.rstrip('/')}/projects/{p.id}/tasks/{t.id}",
        }

    def page_summary(pg: WikiPage) -> dict[str, Any]:
        return {
            "id": pg.id, "title": pg.title, "aliases": pg.aliases, "type": pg.page_type.value if pg.page_type else None,
            "status": pg.status.value if pg.status else None, "tags": pg.tags, "parent_id": pg.parent_id,
            "updated_at": pg.updated_at.isoformat(timespec="minutes"),
        }

    def save_task(before: Task, after: Task, user: User) -> Task:
        try:
            after = Task.model_validate(after.model_dump() | {"updated_at": utcnow()})
        except ValidationError as e:
            raise ToolError(f"값이 올바르지 않습니다: {e.errors(include_url=False)[0]['msg']}") from e
        db.tasks.update(after)
        record_changes(db, before, after, user.id, via_client=actor_client())
        publish_event(db, after.project_id, "task.updated", {"task_id": after.id, "stage": after.stage.value})
        return after

    # ------------------------------------------------------------ 읽기 도구

    @mcp.tool(annotations=READ)
    def list_projects() -> list[dict[str, Any]]:
        """내가 볼 수 있는 프로젝트 목록 (키·이름·내 권한)."""
        user = me()
        return [
            {"key": a.project.key, "id": a.project.id, "name": a.project.name, "description": a.project.description,
             "my_permissions": [p.value for p in a.permissions], "owner": a.is_owner}
            for a in sorted(accessible_projects(db, user), key=lambda a: a.project.created_at)
        ]

    @mcp.tool(annotations=READ)
    def search(project: str, query: str) -> list[dict[str, Any]]:
        """프로젝트의 일감(제목·설명·할 일·덧글·레이블)과 위키(제목·별칭·본문·태그) 검색. 'MW-12' 처럼 키로도 찾습니다."""
        a = project_access(me(), project)
        hits = search_project(db, a.project, query, limit=20)
        return [
            {"kind": h.kind, "ref": f"{a.project.key}-{h.number}" if h.kind == "task" else h.id, "title": h.title, "snippet": h.snippet}
            for h in hits
        ]

    @mcp.tool(annotations=READ)
    def list_tasks(
        project: str,
        stage: PipelineStage | None = None,
        version: str | None = None,
        assignee_email: str | None = None,
        mine: bool = False,
        limit: int = 50,
    ) -> dict[str, Any]:
        """일감 목록. stage(backlog/todo/in_progress/review/qa/done)·버전(version)·작업자 이메일·내 일감(mine)으로 거릅니다."""
        user = me()
        a = project_access(user, project)
        assignee = user.id if mine else (user_by_email(a.project, assignee_email) if assignee_email else None)
        ver_cf = version.strip().casefold() if version else None
        tasks = sorted(
            db.tasks.list(
                lambda t: t.project_id == a.project.id
                and (stage is None or t.stage == stage)
                and (ver_cf is None or (t.version or "").casefold() == ver_cf)
                and (assignee is None or t.assignee_id == assignee)
            ),
            key=lambda t: t.number,
        )
        return {"pipeline": {s.value: PIPELINE_LABELS[s] for s in PipelineStage}, "total": len(tasks),
                "tasks": [task_summary(a.project, t) for t in tasks[: max(1, min(limit, 200))]]}

    @mcp.tool(annotations=READ)
    def get_task(project: str, task: str) -> dict[str, Any]:
        """일감 상세 (설명·할 일·덧글 포함). task 는 'MW-12' 또는 번호."""
        a = project_access(me(), project)
        return task_detail(a.project, find_task(a.project, task))

    @mcp.tool(annotations=READ)
    def list_wiki_pages(project: str, page_type: PageType | None = None, status: PageStatus | None = None, tag: str | None = None) -> list[dict[str, Any]]:
        """위키 페이지 목록 (본문 제외). 타입·상태·태그로 거릅니다."""
        a = project_access(me(), project)
        pages = [
            pg for pg in sorted(project_pages(db, a.project), key=lambda pg: pg.created_at)
            if (page_type is None or pg.page_type == page_type) and (status is None or pg.status == status)
            and (tag is None or tag.casefold() in {t.casefold() for t in pg.tags})
        ]
        return [page_summary(pg) for pg in pages]

    @mcp.tool(annotations=READ)
    def get_wiki_page(project: str, page: str) -> dict[str, Any]:
        """위키 페이지 본문(Markdown)과 속성. page 는 제목·별칭·id."""
        a = project_access(me(), project)
        pg = find_page(a.project, page)
        return page_summary(pg) | {"content": pg.content, "url": f"{settings.app_url.rstrip('/')}/projects/{a.project.id}/wiki/{pg.id}"}

    @mcp.tool(annotations=READ)
    def list_glossary(project: str, query: str | None = None) -> list[dict[str, Any]]:
        """프로젝트 용어집(표제어·정의·동의어·상위 용어) 조회."""
        a = project_access(me(), project)
        terms = db.glossary_terms.list(lambda g: g.project_id == a.project.id)
        by_id = {g.id: g.term for g in terms}
        if query and query.strip():
            q = query.strip().casefold()
            terms = [g for g in terms if q in g.term.casefold() or q in g.definition.casefold() or any(q in s.casefold() for s in g.synonyms)]
        return [
            {"id": g.id, "term": g.term, "definition": g.definition, "synonyms": g.synonyms, "broader": by_id.get(g.broader_id) if g.broader_id else None}
            for g in sorted(terms, key=lambda g: g.term.casefold())
        ]

    @mcp.tool(annotations=READ)
    def ask_knowledge_graph(project: str, question: str) -> dict[str, Any]:
        """프로젝트 용어집·지식 그래프·위키·일감을 기반으로 질문에 답하고 근거를 반환."""
        a = project_access(me(), project)
        res = answer_question(db, a.project, question)
        return {
            "answer": res.answer,
            "expanded_terms": res.expanded_terms,
            "related_facts": res.related_facts,
            "citations": [c.model_dump() for c in res.citations],
        }

    # ------------------------------------------------------------ 쓰기 도구

    @mcp.tool(annotations=CREATE)
    def create_task(
        project: str,
        title: str,
        description: str = "",
        stage: PipelineStage = PipelineStage.BACKLOG,
        priority: Priority = Priority.MEDIUM,
        version: str | None = None,
        parent: str | None = None,
        assignee_email: str | None = None,
        start_date: date | None = None,
        due_date: date | None = None,
        tags: list[str] | None = None,
        checklist: list[str] | None = None,
    ) -> dict[str, Any]:
        """일감 만들기. 설명은 Markdown, version 은 목표 버전('v0.6.0'), parent 는 상위 일감 키('MW-1'), checklist 는 할 일 항목 문자열 목록."""
        user = me(write=True)
        a = project_access(user, project, Permission.CREATE)
        parent_id = find_task(a.project, parent).id if parent else None
        data = dict(title=title, description=description, stage=stage, priority=priority, version=version, parent_id=parent_id, assignee_id=user_by_email(a.project, assignee_email),
                    start_date=start_date, due_date=due_date, tags=tags or [], checklist=[{"text": c} for c in checklist or []])
        try:
            Task.model_validate(data | {"project_id": a.project.id, "number": 0, "created_by": user.id})
        except ValidationError as e:
            raise ToolError(f"값이 올바르지 않습니다: {e.errors(include_url=False)[0]['msg']}") from e
        number = allocate_task_number(db, a.project.id)
        via = actor_client()
        t = db.tasks.create(Task.model_validate(data | {"project_id": a.project.id, "number": number, "created_by": user.id, "via_client": via}))
        record_created(db, t, user.id, via_client=via)
        publish_event(db, a.project.id, "task.created", {"task_id": t.id, "stage": t.stage.value})
        return task_detail(a.project, t)

    @mcp.tool(annotations=CREATE)
    def link_tasks(project: str, source_task: str, target_task: str, kind: TaskLinkKind = TaskLinkKind.RELATES_TO) -> dict[str, Any]:
        """두 일감 사이에 관계(blocks / relates_to / duplicates)를 연결."""
        user = me(write=True)
        a = project_access(user, project, Permission.EDIT)
        src = find_task(a.project, source_task)
        dst = find_task(a.project, target_task)
        if src.id == dst.id:
            raise ToolError("자기 자신과 연결할 수 없습니다")
        existing = db.task_links.list(lambda l: l.project_id == a.project.id and l.source_id == src.id and l.target_id == dst.id and l.kind == kind)
        if existing:
            return {"id": existing[0].id, "source": f"{a.project.key}-{src.number}", "target": f"{a.project.key}-{dst.number}", "kind": kind.value}
        created = db.task_links.create(TaskLink(project_id=a.project.id, source_id=src.id, target_id=dst.id, kind=kind, created_by=user.id))
        return {"id": created.id, "source": f"{a.project.key}-{src.number}", "target": f"{a.project.key}-{dst.number}", "kind": kind.value}

    @mcp.tool(annotations=UPDATE)
    def update_task(
        project: str,
        task: str,
        title: str | None = None,
        description: str | None = None,
        stage: PipelineStage | None = None,
        priority: Priority | None = None,
        version: str | None = None,
        clear_version: bool = False,
        assignee_email: str | None = None,
        unassign: bool = False,
        start_date: date | None = None,
        due_date: date | None = None,
        tags: list[str] | None = None,
        check_items: list[str] | None = None,
    ) -> dict[str, Any]:
        """일감 수정 (보낸 값만 바뀜). 단계 이동은 stage, 버전 지정은 version(해제는 clear_version=true), 작업자 해제는 unassign=true, check_items 는 완료 처리할 할 일 문구."""
        user = me(write=True)
        a = project_access(user, project, Permission.EDIT)
        before = find_task(a.project, task)
        changes: dict[str, Any] = {k: v for k, v in dict(title=title, description=description, stage=stage, priority=priority,
                                   start_date=start_date, due_date=due_date, tags=tags).items() if v is not None}
        if clear_version:
            changes["version"] = None
        elif version is not None:
            changes["version"] = version.strip() or None
        if unassign:
            changes["assignee_id"] = None
        elif assignee_email:
            changes["assignee_id"] = user_by_email(a.project, assignee_email)
        if check_items:
            wanted = {c.strip().casefold() for c in check_items}
            changes["checklist"] = [i.model_copy(update={"done": True}) if i.text.casefold() in wanted else i for i in before.checklist]
        after = save_task(before, before.model_copy(update=changes), user)
        return task_detail(a.project, after)

    @mcp.tool(annotations=CREATE)
    def add_comment(project: str, task: str, body: str) -> dict[str, Any]:
        """일감에 덧글 남기기 (Markdown)."""
        user = me(write=True)
        a = project_access(user, project, Permission.CREATE)
        t = find_task(a.project, task)
        if not body.strip():
            raise ToolError("덧글 내용이 비어 있습니다")
        comment = db.comments.create(
            Comment(project_id=a.project.id, task_id=t.id, author_id=user.id, body=body[:20000], via_client=actor_client())
        )
        publish_event(db, a.project.id, "comment.created", {"task_id": t.id, "comment_id": comment.id})
        return task_detail(a.project, t)

    @mcp.tool(annotations=CREATE)
    def create_wiki_page(
        project: str,
        title: str,
        content: str = "",
        parent: str | None = None,
        page_type: PageType | None = None,
        status: PageStatus | None = None,
        tags: list[str] | None = None,
        aliases: list[str] | None = None,
    ) -> dict[str, Any]:
        """위키 페이지 만들기. content 는 Markdown([[다른 페이지]], MW-12 링크 가능), parent 는 상위 페이지 제목·id."""
        user = me(write=True)
        a = project_access(user, project, Permission.CREATE)
        parent_id = find_page(a.project, parent).id if parent else None
        try:
            pg = WikiPage(project_id=a.project.id, title=title, content=content, parent_id=parent_id, page_type=page_type, status=status,
                          tags=tags or [], aliases=aliases or [], created_by=user.id, updated_by=user.id)
        except ValidationError as e:
            raise ToolError(f"값이 올바르지 않습니다: {e.errors(include_url=False)[0]['msg']}") from e
        db.wiki_pages.create(pg)
        via = actor_client()
        record_revision(db, pg, user.id, note=f"MCP 작성 ({via})" if via else "MCP 작성", via_client=via)
        return page_summary(pg) | {"content": pg.content}

    @mcp.tool(annotations=UPDATE)
    def update_wiki_page(
        project: str,
        page: str,
        title: str | None = None,
        content: str | None = None,
        append: str | None = None,
        page_type: PageType | None = None,
        status: PageStatus | None = None,
        tags: list[str] | None = None,
        aliases: list[str] | None = None,
    ) -> dict[str, Any]:
        """위키 페이지 수정 (보낸 값만). content 는 본문 전체 교체, append 는 본문 끝에 덧붙이기. 제목을 바꾸면 다른 문서의 [[링크]]도 갱신."""
        user = me(write=True)
        a = project_access(user, project, Permission.EDIT)
        before = find_page(a.project, page)
        changes: dict[str, Any] = {k: v for k, v in dict(title=title, content=content, page_type=page_type, status=status, tags=tags, aliases=aliases).items() if v is not None}
        if append:
            changes["content"] = (changes.get("content", before.content).rstrip() + "\n\n" + append).lstrip()
        try:
            after = WikiPage.model_validate(before.model_dump() | changes | {"updated_by": user.id, "updated_at": utcnow()})
        except ValidationError as e:
            raise ToolError(f"값이 올바르지 않습니다: {e.errors(include_url=False)[0]['msg']}") from e
        db.wiki_pages.update(after)
        via = actor_client()
        record_revision(db, after, user.id, note=f"MCP 수정 ({via})" if via else "MCP 수정", via_client=via)
        propagate_rename(db, a.project, after, before.title)
        return page_summary(after) | {"content": after.content}

    return mcp


def transport_security(settings: Settings) -> TransportSecuritySettings:
    """DNS 리바인딩 방어: 공개 주소의 Host 와 로컬 개발 주소만 허용."""
    public = urlsplit(settings.public_url)
    hosts = {public.netloc, f"{public.hostname}:*", "localhost:*", "127.0.0.1:*"}
    if public.port is None:
        hosts.add(public.hostname or "")
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(h for h in hosts if h),
        allowed_origins=[settings.public_url.rstrip("/"), settings.app_url.rstrip("/")],
    )
