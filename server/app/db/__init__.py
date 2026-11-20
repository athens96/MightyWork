from pathlib import Path

from app.db.base import Repository
from app.db.json_store import JsonFileRepository
from app.models.activity import TaskActivity
from app.models.comment import Comment
from app.models.member import ProjectMember
from app.models.oauth import OAuthClient, OAuthGrant, RefreshToken
from app.models.project import Project
from app.models.task import Task
from app.models.user import User
from app.models.wiki import WikiPage


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
    ):
        self.users = users
        self.projects = projects
        self.project_members = project_members
        self.tasks = tasks
        self.comments = comments
        self.task_activities = task_activities
        self.wiki_pages = wiki_pages
        self.oauth_clients = oauth_clients
        self.oauth_grants = oauth_grants
        self.refresh_tokens = refresh_tokens

    @classmethod
    def from_json_files(cls, data_dir: Path) -> "Database":
        return cls(
            users=JsonFileRepository(data_dir / "users.json", User),
            projects=JsonFileRepository(data_dir / "projects.json", Project),
            project_members=JsonFileRepository(data_dir / "project_members.json", ProjectMember),
            tasks=JsonFileRepository(data_dir / "tasks.json", Task),
            comments=JsonFileRepository(data_dir / "comments.json", Comment),
            task_activities=JsonFileRepository(data_dir / "task_activities.json", TaskActivity),
            wiki_pages=JsonFileRepository(data_dir / "wiki_pages.json", WikiPage),
            oauth_clients=JsonFileRepository(data_dir / "oauth_clients.json", OAuthClient),
            oauth_grants=JsonFileRepository(data_dir / "oauth_grants.json", OAuthGrant),
            refresh_tokens=JsonFileRepository(data_dir / "refresh_tokens.json", RefreshToken),
        )
