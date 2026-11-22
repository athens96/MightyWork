"""로컬 그래프(1~2단계) 및 프로젝트 전체 그래프(위키·일감·용어집·승인된 지식 엔티티)."""

from collections import deque
from typing import Literal

from pydantic import BaseModel

from app.db import Database
from app.models.project import Project
from app.services.links import link_targets, norm_title, pages_by_title, project_pages, task_numbers

NodeKind = Literal["wiki", "task", "glossary", "entity"]
EdgeKind = Literal["link", "mention", "parent", "task_link", "broader", "relation"]


class GraphNode(BaseModel):
    id: str  # "wiki:<id>" | "task:<id>" | "glossary:<id>" | "entity:<id>"
    kind: NodeKind
    ref_id: str
    label: str
    depth: int = 0  # 로컬 그래프 중심 0
    status: str | None = None  # 위키 상태, 일감 단계, 엔티티 종류
    number: int | None = None  # 일감 번호


class GraphEdge(BaseModel):
    source: str
    target: str
    kind: EdgeKind
    label: str | None = None  # task_link / knowledge relation 세부 유형


class LocalGraph(BaseModel):
    center: str
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool  # 노드 수 제한으로 잘렸는지


class ProjectGraph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    truncated: bool = False


def project_edges(db: Database, project: Project) -> tuple[dict[str, GraphNode], list[GraphEdge]]:
    pages = project_pages(db, project)
    tasks = db.tasks.list(lambda t: t.project_id == project.id and t.deleted_at is None)
    by_title = pages_by_title(pages)
    by_number = {t.number: t for t in tasks}

    nodes: dict[str, GraphNode] = {}
    for p in pages:
        nodes[f"wiki:{p.id}"] = GraphNode(id=f"wiki:{p.id}", kind="wiki", ref_id=p.id, label=p.title, depth=-1, status=p.status.value if p.status else None)
    for t in tasks:
        nodes[f"task:{t.id}"] = GraphNode(id=f"task:{t.id}", kind="task", ref_id=t.id, label=t.title, depth=-1, status=t.stage.value, number=t.number)

    edges: set[tuple[str, str, str, str | None]] = set()

    def add(src: str, dst: str, kind: EdgeKind, label: str | None = None) -> None:
        if src != dst and src in nodes and dst in nodes:
            edges.add((src, dst, kind, label))

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
        if t.parent_id:
            add(f"task:{t.id}", f"task:{t.parent_id}", "parent")

    for tl in db.task_links.list(lambda l: l.project_id == project.id):
        add(f"task:{tl.source_id}", f"task:{tl.target_id}", "task_link", tl.kind.value)

    return nodes, [GraphEdge(source=s, target=d, kind=k, label=lbl) for s, d, k, lbl in sorted(edges, key=lambda x: (x[0], x[1], x[2], x[3] or ""))]


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


def full_project_graph(db: Database, project: Project, *, include_knowledge: bool = True, max_nodes: int = 250) -> ProjectGraph:
    """프로젝트 전체 그래프: 위키·일감(+하위/링크) + 용어집 + 승인된 지식 엔티티/관계."""
    nodes, edges_list = project_edges(db, project)
    edges = {(e.source, e.target, e.kind, e.label) for e in edges_list}

    if include_knowledge:
        terms = db.glossary_terms.list(lambda g: g.project_id == project.id)
        for g in terms:
            nodes[f"glossary:{g.id}"] = GraphNode(id=f"glossary:{g.id}", kind="glossary", ref_id=g.id, label=g.term, depth=0)
        for g in terms:
            if g.broader_id and f"glossary:{g.broader_id}" in nodes:
                edges.add((f"glossary:{g.id}", f"glossary:{g.broader_id}", "broader", "상위"))
            if g.wiki_page_id and f"wiki:{g.wiki_page_id}" in nodes:
                edges.add((f"glossary:{g.id}", f"wiki:{g.wiki_page_id}", "link", "정의"))

        entities = db.knowledge_entities.list(lambda e: e.project_id == project.id and e.status == "approved")
        for e in entities:
            nodes[f"entity:{e.id}"] = GraphNode(id=f"entity:{e.id}", kind="entity", ref_id=e.id, label=e.name, depth=0, status=e.kind.value)
            for s in e.sources:
                src_node = f"{s.source_type}:{s.source_id}"
                if src_node in nodes:
                    edges.add((f"entity:{e.id}", src_node, "mention", "출처"))

        relations = db.knowledge_relations.list(lambda r: r.project_id == project.id and r.status == "approved")
        for r in relations:
            s_id, t_id = f"entity:{r.source_entity_id}", f"entity:{r.target_entity_id}"
            if s_id in nodes and t_id in nodes and s_id != t_id:
                edges.add((s_id, t_id, "relation", r.kind.value))

    # 연결도가 높은 노드 우선으로 상한 적용
    degree: dict[str, int] = {nid: 0 for nid in nodes}
    for s, d, _, _ in edges:
        if s in degree:
            degree[s] += 1
        if d in degree:
            degree[d] += 1

    ordered = sorted(nodes.values(), key=lambda n: (-degree.get(n.id, 0), n.kind, n.label))
    truncated = len(ordered) > max_nodes
    picked = ordered[:max_nodes]
    kept = {n.id for n in picked}
    out_edges = [
        GraphEdge(source=s, target=d, kind=k, label=lbl)
        for s, d, k, lbl in sorted(edges, key=lambda x: (x[0], x[1], x[2], x[3] or ""))
        if s in kept and d in kept
    ]
    return ProjectGraph(nodes=picked, edges=out_edges, truncated=truncated)
