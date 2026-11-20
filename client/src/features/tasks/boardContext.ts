import { useOutletContext } from "react-router-dom";
import type { Permission, PipelineStageInfo, Project, Task, User } from "../../types";

/** 보드 → 상세 패널(중첩 라우트)로 넘기는 공유 상태 */
export interface BoardContext {
  project: Project;
  tasks: Task[];
  stages: PipelineStageInfo[];
  users: User[]; // 표시용 (덧글 작성자 등)
  members: User[]; // 작업자로 지정 가능한 사람 (로그인한 멤버)
  can: (perm: Permission) => boolean;
  onChanged: (task: Task) => void;
  onDeleted: (taskId: string) => void;
}

export function useBoard(): BoardContext {
  return useOutletContext<BoardContext>();
}
