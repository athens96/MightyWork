"""마일스톤(릴리즈/에픽) 모델 및 진척률 집계 스키마."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.common import Entity

MilestoneStatus = Literal["planned", "active", "completed"]


class MilestoneBase(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    start_date: date | None = None
    target_date: date | None = None
    status: MilestoneStatus = "planned"

    @model_validator(mode="after")
    def _check_dates(self):
        if self.start_date and self.target_date and self.start_date > self.target_date:
            raise ValueError("start_date must be on or before target_date")
        return self


class Milestone(Entity, MilestoneBase):
    project_id: str
    created_by: str


class MilestoneCreate(MilestoneBase):
    pass


class MilestoneUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    start_date: date | None = None
    target_date: date | None = None
    status: MilestoneStatus | None = None


class MilestoneRead(Milestone):
    total_tasks: int = 0
    done_tasks: int = 0
    in_progress_tasks: int = 0
    total_points: int = 0
    done_points: int = 0
    progress_pct: int = 0
