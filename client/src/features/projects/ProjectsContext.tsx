import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { projectsApi } from "../../api";
import type { Project } from "../../types";

interface ProjectsState {
  projects: Project[];
  loading: boolean;
  reload: () => Promise<void>;
}

const ProjectsContext = createContext<ProjectsState | null>(null);

/** 사이드바와 프로젝트 화면이 공유하는 프로젝트 목록 */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setProjects(await projectsApi.list());
    } catch {
      // 일시적 네트워크/타임아웃 오류 시 기존 목록 유지
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const value = useMemo(() => ({ projects, loading, reload }), [projects, loading, reload]);
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsState {
  const ctx = useContext(ProjectsContext);
  if (!ctx) throw new Error("useProjects must be used within ProjectsProvider");
  return ctx;
}
