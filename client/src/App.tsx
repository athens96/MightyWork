import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { ProjectsProvider } from "./features/projects/ProjectsContext";
import { ProjectListPage } from "./features/projects/ProjectListPage";
import { ProjectLayout } from "./features/projects/ProjectLayout";
import { MembersPage } from "./features/projects/MembersPage";
import { SearchPage } from "./features/projects/SearchPage";
import { TaskBoardPage, TaskDetailRoute } from "./features/tasks/TaskBoardPage";

// 위키(마크다운 렌더러 + 코드 하이라이트)는 용량이 커서 진입 시에만 로드
const WikiPage = lazy(() => import("./features/wiki/WikiPage").then((m) => ({ default: m.WikiPage })));
const wikiElement = (
  <Suspense fallback={<p className="muted">불러오는 중…</p>}>
    <WikiPage />
  </Suspense>
);

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route
          element={
            <ProjectsProvider>
              <Layout />
            </ProjectsProvider>
          }
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectListPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<Navigate to="tasks" replace />} />
            <Route path="tasks" element={<TaskBoardPage />}>
              <Route path=":taskId" element={<TaskDetailRoute />} />
            </Route>
            <Route path="wiki" element={wikiElement} />
            <Route path="members" element={<MembersPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="wiki/:pageId" element={wikiElement} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
