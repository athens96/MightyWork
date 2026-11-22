use std::collections::{HashMap, HashSet};

use crate::db::Database;
use crate::error::ApiResult;
use crate::models::{normalize_permissions, Permission, Project, ProjectMember, User};

#[derive(Debug, Clone)]
pub struct Access {
    pub project: Project,
    pub user: User,
    pub permissions: Vec<Permission>,
    pub is_owner: bool,
}

impl Access {
    pub fn can(&self, perm: Permission) -> bool {
        self.permissions.contains(&perm)
    }
}

pub fn find_member(db: &Database, project_id: &str, email: &str) -> ApiResult<Option<ProjectMember>> {
    let email_lc = email.to_lowercase();
    let members = db.project_members.list_by_project(project_id)?;
    Ok(members.into_iter().find(|m| m.email.to_lowercase() == email_lc))
}

pub fn resolve_access(db: &Database, project: &Project, user: &User) -> ApiResult<Access> {
    if project.created_by == user.id {
        return Ok(Access {
            project: project.clone(),
            user: user.clone(),
            permissions: Permission::ALL.to_vec(),
            is_owner: true,
        });
    }
    let perms = match find_member(db, &project.id, &user.email)? {
        Some(m) => normalize_permissions(&m.permissions),
        None => vec![],
    };
    Ok(Access {
        project: project.clone(),
        user: user.clone(),
        permissions: perms,
        is_owner: false,
    })
}

pub fn accessible_projects(db: &Database, user: &User) -> ApiResult<Vec<Access>> {
    let projects = db.projects.list()?;
    let mut out = Vec::new();
    for p in projects {
        let a = resolve_access(db, &p, user)?;
        if a.can(Permission::View) {
            out.push(a);
        }
    }
    Ok(out)
}

pub fn is_member_user(db: &Database, project: &Project, user_id: &str) -> ApiResult<bool> {
    if project.created_by == user_id {
        return Ok(true);
    }
    if let Some(u) = db.users.get(user_id)? {
        return Ok(find_member(db, &project.id, &u.email)?.is_some());
    }
    Ok(false)
}

pub fn project_related_users(db: &Database, project: &Project) -> ApiResult<Vec<User>> {
    let member_emails: HashSet<String> = db
        .project_members
        .list_by_project(&project.id)?
        .into_iter()
        .map(|m| m.email.to_lowercase())
        .collect();
    let mut ids: HashSet<String> = HashSet::new();
    ids.insert(project.created_by.clone());

    for t in db.tasks.list_by_project(&project.id)? {
        ids.insert(t.created_by);
        if let Some(a) = t.assignee_id {
            ids.insert(a);
        }
    }
    for c in db.comments.list_by_project(&project.id)? {
        ids.insert(c.author_id);
    }
    for a in db.task_activities.list_by_project(&project.id)? {
        ids.insert(a.actor_id);
    }
    for p in db.wiki_pages.list_by_project(&project.id)? {
        ids.insert(p.created_by);
        ids.insert(p.updated_by);
        if let Some(o) = p.owner_id {
            ids.insert(o);
        }
    }

    let mut users: Vec<User> = db
        .users
        .list()?
        .into_iter()
        .filter(|u| ids.contains(&u.id) || member_emails.contains(&u.email.to_lowercase()))
        .collect();
    users.sort_by(|a, b| {
        let ka = if a.name.is_empty() { &a.email } else { &a.name };
        let kb = if b.name.is_empty() { &b.email } else { &b.name };
        ka.cmp(kb)
    });
    Ok(users)
}

pub fn visible_users_for(db: &Database, user: &User) -> ApiResult<Vec<User>> {
    let mut by_id: HashMap<String, User> = HashMap::new();
    by_id.insert(user.id.clone(), user.clone());
    for access in accessible_projects(db, user)? {
        for rel in project_related_users(db, &access.project)? {
            by_id.insert(rel.id.clone(), rel);
        }
    }
    let mut users: Vec<User> = by_id.into_values().collect();
    users.sort_by(|a, b| {
        let ka = if a.name.is_empty() { &a.email } else { &a.name };
        let kb = if b.name.is_empty() { &b.email } else { &b.name };
        ka.cmp(kb)
    });
    Ok(users)
}
