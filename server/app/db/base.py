from abc import ABC, abstractmethod
from typing import Callable, Generic, TypeVar

from app.models.common import Entity

T = TypeVar("T", bound=Entity)


class Repository(ABC, Generic[T]):
    """저장소 인터페이스.

    라우터/서비스는 이 인터페이스에만 의존한다. 이후 DB(PostgreSQL, MongoDB 등)가
    정해지면 이 클래스를 구현한 새 저장소로 교체하면 된다.
    """

    @abstractmethod
    def list(self, where: Callable[[T], bool] | None = None) -> list[T]: ...

    @abstractmethod
    def get(self, entity_id: str) -> T | None: ...

    @abstractmethod
    def create(self, entity: T) -> T: ...

    @abstractmethod
    def update(self, entity: T) -> T | None:
        """같은 id 의 객체를 교체한다. 없으면 None."""

    @abstractmethod
    def delete(self, entity_id: str) -> bool: ...
