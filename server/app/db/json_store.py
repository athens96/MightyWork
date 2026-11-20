import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Callable

from app.db.base import Repository, T


class JsonFileRepository(Repository[T]):
    """컬렉션 하나를 JSON 파일 하나에 저장하는 파일 DB.

    - 메모리에 캐시하고, 변경 시 임시 파일에 쓴 뒤 원자적으로 교체(os.replace)한다.
    - 단일 프로세스 전제(uvicorn worker 1개). 멀티 워커가 필요해지면 실제 DB로 교체할 것.
    """

    def __init__(self, path: Path, model: type[T]):
        self._path = path
        self._model = model
        self._lock = threading.RLock()
        self._items: dict[str, T] = self._load()

    def _load(self) -> dict[str, T]:
        if not self._path.exists():
            return {}
        raw = json.loads(self._path.read_text(encoding="utf-8") or "{}")
        return {key: self._model.model_validate(value) for key, value in raw.items()}

    def _flush(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        data = {key: item.model_dump(mode="json") for key, item in self._items.items()}
        fd, tmp_path = tempfile.mkstemp(dir=self._path.parent, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, self._path)
        except BaseException:
            Path(tmp_path).unlink(missing_ok=True)
            raise

    def list(self, where: Callable[[T], bool] | None = None) -> list[T]:
        with self._lock:
            items = [i.model_copy(deep=True) for i in self._items.values()]
        return [i for i in items if where is None or where(i)]

    def get(self, entity_id: str) -> T | None:
        with self._lock:
            item = self._items.get(entity_id)
            return item.model_copy(deep=True) if item else None

    def create(self, entity: T) -> T:
        with self._lock:
            if entity.id in self._items:
                raise ValueError(f"duplicate id: {entity.id}")
            self._items[entity.id] = entity.model_copy(deep=True)
            self._flush()
        return entity

    def update(self, entity: T) -> T | None:
        with self._lock:
            if entity.id not in self._items:
                return None
            self._items[entity.id] = entity.model_copy(deep=True)
            self._flush()
        return entity

    def delete(self, entity_id: str) -> bool:
        with self._lock:
            if self._items.pop(entity_id, None) is None:
                return False
            self._flush()
        return True
