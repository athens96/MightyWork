use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{new_id, utcnow, DiffLine, WikiPage, WikiRevision};

pub fn list_revisions(db: &Database, project_id: &str, page_id: &str) -> ApiResult<Vec<WikiRevision>> {
    let mut revs: Vec<WikiRevision> = db
        .wiki_revisions
        .list_by_project(project_id)?
        .into_iter()
        .filter(|r| r.page_id == page_id)
        .collect();
    revs.sort_by(|a, b| b.version.cmp(&a.version));
    Ok(revs)
}

pub fn record_revision(
    db: &Database,
    page: &WikiPage,
    editor_id: &str,
    note: &str,
    via_client: Option<String>,
) -> ApiResult<WikiRevision> {
    let existing = list_revisions(db, &page.project_id, &page.id)?;
    let next_ver = existing.iter().map(|r| r.version).max().unwrap_or(0) + 1;
    let now = utcnow();
    let rev = WikiRevision {
        id: new_id(),
        created_at: now,
        updated_at: now,
        project_id: page.project_id.clone(),
        page_id: page.id.clone(),
        version: next_ver,
        title: page.title.clone(),
        content: page.content.clone(),
        aliases: page.aliases.clone(),
        page_type: page.page_type,
        status: page.status,
        tags: page.tags.clone(),
        editor_id: editor_id.to_string(),
        note: note.to_string(),
        via_client,
    };
    Ok(db.wiki_revisions.create(&rev)?)
}

/// 단순 LCS 기반 줄 단위 Diff (외부 크레이트 0개)
pub fn line_diff(old_text: &str, new_text: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = old_text.lines().collect();
    let b: Vec<&str> = new_text.lines().collect();
    let (m, n) = (a.len(), b.len());

    // 아주 큰 문서(m*n > 2_000_000)는 공통 접두/접미 축소로 메모리 보호
    let mut prefix = 0;
    while prefix < m && prefix < n && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < (m - prefix) && suffix < (n - prefix) && a[m - 1 - suffix] == b[n - 1 - suffix] {
        suffix += 1;
    }

    let mut out = Vec::with_capacity(m + n);
    for line in &a[..prefix] {
        out.push(DiffLine {
            kind: "equal",
            text: (*line).to_string(),
        });
    }

    let am = &a[prefix..m - suffix];
    let bm = &b[prefix..n - suffix];

    if am.len() * bm.len() > 2_000_000 {
        for line in am {
            out.push(DiffLine {
                kind: "del",
                text: (*line).to_string(),
            });
        }
        for line in bm {
            out.push(DiffLine {
                kind: "add",
                text: (*line).to_string(),
            });
        }
    } else {
        let (rows, cols) = (am.len(), bm.len());
        let mut dp = vec![vec![0u32; cols + 1]; rows + 1];
        for i in (0..rows).rev() {
            for j in (0..cols).rev() {
                dp[i][j] = if am[i] == bm[j] {
                    dp[i + 1][j + 1] + 1
                } else {
                    dp[i + 1][j].max(dp[i][j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < rows && j < cols {
            if am[i] == bm[j] {
                out.push(DiffLine {
                    kind: "equal",
                    text: am[i].to_string(),
                });
                i += 1;
                j += 1;
            } else if dp[i + 1][j] >= dp[i][j + 1] {
                out.push(DiffLine {
                    kind: "del",
                    text: am[i].to_string(),
                });
                i += 1;
            } else {
                out.push(DiffLine {
                    kind: "add",
                    text: bm[j].to_string(),
                });
                j += 1;
            }
        }
        while i < rows {
            out.push(DiffLine {
                kind: "del",
                text: am[i].to_string(),
            });
            i += 1;
        }
        while j < cols {
            out.push(DiffLine {
                kind: "add",
                text: bm[j].to_string(),
            });
            j += 1;
        }
    }

    for line in &a[m - suffix..] {
        out.push(DiffLine {
            kind: "equal",
            text: (*line).to_string(),
        });
    }
    out
}
