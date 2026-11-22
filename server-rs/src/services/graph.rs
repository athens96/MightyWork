use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};

use serde::Serialize;

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{Project, Task};
use crate::services::links::{link_targets, norm_title, pages_by_title, project_pages, task_numbers};

#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: &'static str,
    pub ref_id: String,
    pub label: String,
    pub depth: i32,
    pub status: Option<String>,
    pub number: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub kind: &'static str,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalGraph {
    pub center: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub truncated: bool,
}

pub fn project_edges(
    db: &Database,
    project: &Project,
) -> ApiResult<(HashMap<String, GraphNode>, Vec<GraphEdge>)> {
    let pages = project_pages(db, &project.id)?;
    let tasks: Vec<Task> = db
        .tasks
        .list_by_project(&project.id)?
        .into_iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    let by_title = pages_by_title(&pages);
    let by_number: HashMap<i64, &Task> = tasks.iter().map(|t| (t.number, t)).collect();

    let mut nodes: HashMap<String, GraphNode> = HashMap::new();
    for p in &pages {
        let id = format!("wiki:{}", p.id);
        nodes.insert(
            id.clone(),
            GraphNode {
                id,
                kind: "wiki",
                ref_id: p.id.clone(),
                label: p.title.clone(),
                depth: -1,
                status: p.status.map(|s| s.as_str().into()),
                number: None,
            },
        );
    }
    for t in &tasks {
        let id = format!("task:{}", t.id);
        nodes.insert(
            id.clone(),
            GraphNode {
                id,
                kind: "task",
                ref_id: t.id.clone(),
                label: t.title.clone(),
                depth: -1,
                status: Some(t.stage.as_str().into()),
                number: Some(t.number),
            },
        );
    }

    let mut edges: BTreeSet<(String, String, &'static str, Option<String>)> = BTreeSet::new();
    let add = |edges: &mut BTreeSet<(String, String, &'static str, Option<String>)>,
               nodes: &HashMap<String, GraphNode>,
               src: String,
               dst: String,
               kind: &'static str,
               label: Option<String>| {
        if src != dst && nodes.contains_key(&src) && nodes.contains_key(&dst) {
            edges.insert((src, dst, kind, label));
        }
    };

    for p in &pages {
        let src = format!("wiki:{}", p.id);
        for title in link_targets(&p.content) {
            if let Some(target) = by_title.get(&norm_title(&title)) {
                add(&mut edges, &nodes, src.clone(), format!("wiki:{}", target.id), "link", None);
            }
        }
        for n in task_numbers(&p.content, &project.key) {
            if let Some(t) = by_number.get(&n) {
                add(&mut edges, &nodes, src.clone(), format!("task:{}", t.id), "mention", None);
            }
        }
        if let Some(pid) = &p.parent_id {
            add(&mut edges, &nodes, src, format!("wiki:{pid}"), "parent", None);
        }
    }
    for t in &tasks {
        let src = format!("task:{}", t.id);
        for title in link_targets(&t.description) {
            if let Some(target) = by_title.get(&norm_title(&title)) {
                add(&mut edges, &nodes, src.clone(), format!("wiki:{}", target.id), "link", None);
            }
        }
        for n in task_numbers(&t.description, &project.key) {
            if let Some(target) = by_number.get(&n) {
                add(&mut edges, &nodes, src.clone(), format!("task:{}", target.id), "mention", None);
            }
        }
        if let Some(pid) = &t.parent_id {
            add(&mut edges, &nodes, src, format!("task:{pid}"), "parent", None);
        }
    }
    for tl in db.task_links.list_by_project(&project.id)? {
        add(
            &mut edges,
            &nodes,
            format!("task:{}", tl.source_id),
            format!("task:{}", tl.target_id),
            "task_link",
            Some(tl.kind.as_str().into()),
        );
    }

    let edge_list = edges
        .into_iter()
        .map(|(source, target, kind, label)| GraphEdge {
            source,
            target,
            kind,
            label,
        })
        .collect();
    Ok((nodes, edge_list))
}

pub fn local_graph(
    db: &Database,
    project: &Project,
    center: &str,
    depth: i32,
    max_nodes: usize,
) -> ApiResult<LocalGraph> {
    let (nodes, edges) = project_edges(db, project)?;
    let mut neighbors: HashMap<String, BTreeSet<String>> = HashMap::new();
    for e in &edges {
        neighbors.entry(e.source.clone()).or_default().insert(e.target.clone());
        neighbors.entry(e.target.clone()).or_default().insert(e.source.clone());
    }

    let mut seen: HashMap<String, i32> = HashMap::new();
    seen.insert(center.to_string(), 0);
    let mut queue = VecDeque::new();
    queue.push_back(center.to_string());
    let mut truncated = false;

    while let Some(cur) = queue.pop_front() {
        let cur_d = seen[&cur];
        if cur_d >= depth {
            continue;
        }
        if let Some(nb) = neighbors.get(&cur) {
            for nxt in nb {
                if seen.contains_key(nxt) {
                    continue;
                }
                if seen.len() >= max_nodes {
                    truncated = true;
                    break;
                }
                seen.insert(nxt.clone(), cur_d + 1);
                queue.push_back(nxt.clone());
            }
        }
    }

    let mut picked: Vec<GraphNode> = seen
        .iter()
        .filter_map(|(nid, &d)| {
            nodes.get(nid).map(|n| {
                let mut cloned = n.clone();
                cloned.depth = d;
                cloned
            })
        })
        .collect();
    picked.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| a.kind.cmp(b.kind)).then_with(|| a.label.cmp(&b.label)));
    let sub_edges: Vec<GraphEdge> = edges
        .into_iter()
        .filter(|e| seen.contains_key(&e.source) && seen.contains_key(&e.target))
        .collect();
    Ok(LocalGraph {
        center: center.to_string(),
        nodes: picked,
        edges: sub_edges,
        truncated,
    })
}

pub fn full_project_graph(
    db: &Database,
    project: &Project,
    include_knowledge: bool,
    max_nodes: usize,
) -> ApiResult<ProjectGraph> {
    let (mut nodes, edges_list) = project_edges(db, project)?;
    let mut edges: BTreeSet<(String, String, &'static str, Option<String>)> = edges_list
        .into_iter()
        .map(|e| (e.source, e.target, e.kind, e.label))
        .collect();

    if include_knowledge {
        let terms = db.glossary_terms.list_by_project(&project.id)?;
        for g in &terms {
            let id = format!("glossary:{}", g.id);
            nodes.insert(
                id.clone(),
                GraphNode {
                    id,
                    kind: "glossary",
                    ref_id: g.id.clone(),
                    label: g.term.clone(),
                    depth: 0,
                    status: None,
                    number: None,
                },
            );
        }
        for g in &terms {
            if let Some(bid) = &g.broader_id {
                let dst = format!("glossary:{bid}");
                if nodes.contains_key(&dst) {
                    edges.insert((format!("glossary:{}", g.id), dst, "broader", Some("상위".into())));
                }
            }
            if let Some(wid) = &g.wiki_page_id {
                let dst = format!("wiki:{wid}");
                if nodes.contains_key(&dst) {
                    edges.insert((format!("glossary:{}", g.id), dst, "link", Some("정의".into())));
                }
            }
        }

        let entities: Vec<_> = db
            .knowledge_entities
            .list_by_project(&project.id)?
            .into_iter()
            .filter(|e| e.status == "approved")
            .collect();
        for e in &entities {
            let id = format!("entity:{}", e.id);
            nodes.insert(
                id.clone(),
                GraphNode {
                    id: id.clone(),
                    kind: "entity",
                    ref_id: e.id.clone(),
                    label: e.name.clone(),
                    depth: 0,
                    status: Some(e.kind.as_str().into()),
                    number: None,
                },
            );
            for s in &e.sources {
                let src_node = format!("{}:{}", s.source_type, s.source_id);
                if nodes.contains_key(&src_node) {
                    edges.insert((id.clone(), src_node, "mention", Some("출처".into())));
                }
            }
        }

        for r in db
            .knowledge_relations
            .list_by_project(&project.id)?
            .into_iter()
            .filter(|r| r.status == "approved")
        {
            let s_id = format!("entity:{}", r.source_entity_id);
            let t_id = format!("entity:{}", r.target_entity_id);
            if s_id != t_id && nodes.contains_key(&s_id) && nodes.contains_key(&t_id) {
                edges.insert((s_id, t_id, "relation", Some(r.kind.as_str().into())));
            }
        }
    }

    let mut degree: HashMap<String, usize> = nodes.keys().map(|k| (k.clone(), 0)).collect();
    for (s, d, _, _) in &edges {
        if let Some(v) = degree.get_mut(s) {
            *v += 1;
        }
        if let Some(v) = degree.get_mut(d) {
            *v += 1;
        }
    }

    let mut ordered: Vec<GraphNode> = nodes.into_values().collect();
    ordered.sort_by(|a, b| {
        let da = degree.get(&a.id).copied().unwrap_or(0);
        let db_val = degree.get(&b.id).copied().unwrap_or(0);
        db_val
            .cmp(&da)
            .then_with(|| a.kind.cmp(b.kind))
            .then_with(|| a.label.cmp(&b.label))
    });
    let truncated = ordered.len() > max_nodes;
    ordered.truncate(max_nodes);
    let kept: HashSet<String> = ordered.iter().map(|n| n.id.clone()).collect();
    let out_edges: Vec<GraphEdge> = edges
        .into_iter()
        .filter(|(s, d, _, _)| kept.contains(s) && kept.contains(d))
        .map(|(source, target, kind, label)| GraphEdge {
            source,
            target,
            kind,
            label,
        })
        .collect();

    Ok(ProjectGraph {
        nodes: ordered,
        edges: out_edges,
        truncated,
    })
}
