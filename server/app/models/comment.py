from pydantic import BaseModel, Field

from app.models.common import Entity

ALLOWED_REACTIONS = ("👍", "👀", "✅", "❤️", "🚀")


class Comment(Entity):
    project_id: str
    task_id: str
    author_id: str
    body: str  # Markdown
    reactions: dict[str, list[str]] = {}
    via_client: str | None = None


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class CommentUpdate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class ReactionToggle(BaseModel):
    emoji: str = Field(min_length=1, max_length=8)


def toggle_reaction_map(reactions: dict[str, list[str]], emoji: str, user_id: str) -> dict[str, list[str]]:
    """이모지 리액션 맵에서 사용자 ID를 토글해 새 딕셔너리를 반환."""
    next_map = {k: list(v) for k, v in reactions.items()}
    users = next_map.get(emoji, [])
    if user_id in users:
        users = [u for u in users if u != user_id]
        if users:
            next_map[emoji] = users
        else:
            next_map.pop(emoji, None)
    else:
        users.append(user_id)
        next_map[emoji] = users
    return next_map
