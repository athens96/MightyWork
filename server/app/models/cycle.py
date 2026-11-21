"""경량 사이클(스프린트) 모델 — 기간·목표 pt·상태·번다운 집계."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.common import Entity

CycleStatus = Literal["upcoming", "active", "completed"]


class CycleBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    goal: str = Field(default="", max_length=500)
    start_date: date
    end_date: date
    target_points: int | None = Field(default=None, ge=0, le=10000)
    status: CycleStatus = "upcoming"

    @model_validator(mode="after")
    def _check_dates(self):
        if self.start_date > self.end_date:
            raise ValueError("start_date must be on or before end_date")
        return self


class Cycle(Entity, CycleBase):
    project_id: str
    created_by: str


class CycleCreate(CycleBase):
    pass


class CycleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    goal: str | None = Field(default=None, max_length=500)
    start_date: date | None = None
    end_date: date | None = None
    target_points: int | None = Field(default=None, ge=0, le=10000)
    status: CycleStatus | None = None


class CycleBurndownPoint(BaseModel):
    day: str  # YYYY-MM-DD
    ideal: float
    remaining: float | None = None


class CycleRead(Cycle):
    total_tasks: int = 0
    done_tasks: int = 0
    total_points: int = 0
    done_points: int = 0
    completion_pct: int = 0
    burndown: list[CycleBurndownPoint] = []


class CycleCompleteRequest(BaseModel):
    rollover: bool = True
    next_cycle_id: str | None = None


class CycleCompleteResult(BaseModel):
    completed: CycleRead
    next_cycle: CycleRead | None = None
    rolled_over_count: int = 0
