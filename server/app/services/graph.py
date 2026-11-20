"""로컬 그래프 (옵시디언 Local graph): 한 문서를 중심으로 1~2단계 이웃.

간선 종류
- link:    [[위키 링크]] (위키 → 위키, 일감 설명 → 위키)
- mention: 일감 키 언급 (위키 → 일감, 일감 설명 → 일감)
- parent:  위키 상하위 페이지
"""

from collections import deque
from typing import Literal

from pydantic import BaseModel

from app.db import Database
from app.models.project import Project
from app.services.links import link_targets, norm_title, pages_by_title, project_pages, task_numbers

NodeKind = Literal["wiki", "task"]


class GraphNode(BaseModel):
    id: str  # "wiki:<id>" | "task:<id>"
    kind: NodeKind
    ref_id: str
    label: str
    depth: int  # 중심 0
    status: str | None = None  # 위키 상태 또는 일감 단계
    number: int | None = None  # 일감 번호


class GraphEdge(BaseModel):
    source: str
    target: str
    kind: Literal["link", "mention", "parent"]


class LocalGraph(BaseModel):
    center: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool  # 노드 수 제한으로 잘렸는지


def project_edges(db: Database, project: Project) -> tuple[dict[str, GraphNode], list[GraphEdge]]:
    pages = project_pages(db, project)
    tasks = db.tasks.list(lambda t: t.project_id == project.id)
    by_title = pages_by_title(pages)
    by_number = {t.number: t for t in tasks}

    nodes: dict[str, GraphNode] = {}
    for p in pages:
        nodes[f"wiki:{p.id}"] = GraphNode(id=f"wiki:{p.id}", kind="wiki", ref_id=p.id, label=p.title, depth=-1, status=p.status.value if p.status else None)
    for t in tasks:
        nodes[f"task:{t.id}"] = GraphNode(id=f"task:{t.id}", kind="task", ref_id=t.id, label=t.title, depth=-1, status=t.stage.value, number=t.number)

    edges: set[tuple[str, str, str]] = set()

    def add(src: str, dst: str, kind: str) -> None:
        if src != dst:
            edges.add((src, dst, kind))

    def from_text(src: str, md: str) -> None:
        for title in link_targets(md):
            if (target := by_title.get(norm_title(title))) is not None:
                add(src, f"wiki:{target.id}", "link")
        for n in task_numbers(md, project.key):
            if n in by_number:
                add(src, f"task:{by_number[n].id}", "mention")

    for p in pages:
        from_text(f"wiki:{p.id}", p.content)
        if p.parent_id:
            add(f"wiki:{p.id}", f"wiki:{p.parent_id}", "parent")
    for t in tasks:
        from_text(f"task:{t.id}", t.description)

    return nodes, [GraphEdge(source=s, target=d, kind=k) for s, d, k in sorted(edges)]


def local_graph(db: Database, project: Project, center: str, depth: int = 1, max_nodes: int = 60) -> LocalGraph:
    nodes, edges = project_edges(db, project)
    neighbors: dict[str, set[str]] = {}
    for e in edges:  # 방향 무시하고 이웃 탐색
        neighbors.setdefault(e.source, set()).add(e.target)
        neighbors.setdefault(e.target, set()).add(e.source)

    seen = {center: 0}
    queue, truncated = deque([center]), False
    while queue:
        cur = queue.popleft()
        if seen[cur] >= depth:
            continue
        for nxt in sorted(neighbors.get(cur, ())):
            if nxt in seen:
                continue
            if len(seen) >= max_nodes:
                truncated = True
                break
            seen[nxt] = seen[cur] + 1
            queue.append(nxt)

    picked = [nodes[n].model_copy(update={"depth": d}) for n, d in seen.items()]
    sub_edges = [e for e in edges if e.source in seen and e.target in seen]
    return LocalGraph(center=center, nodes=sorted(picked, key=lambda n: (n.depth, n.kind, n.label)), edges=sub_edges, truncated=truncated)
