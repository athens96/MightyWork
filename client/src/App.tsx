import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { VersionUpdatePrompt } from "./components/VersionUpdatePrompt";
import { LoginPage } from "./pages/LoginPage";
import { ConsentPage } from "./features/oauth/ConsentPage";
import { ConnectedAppsPage } from "./features/oauth/ConnectedAppsPage";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { ProjectsProvider } from "./features/projects/ProjectsContext";
import { ProjectListPage } from "./features/projects/ProjectListPage";
import { ProjectLayout } from "./features/projects/ProjectLayout";
import { MembersPage } from "./features/projects/MembersPage";
import { SearchPage } from "./features/projects/SearchPage";
import { TrashPage } from "./features/projects/TrashPage";
import { TaskBoardPage, TaskDetailRoute } from "./features/tasks/TaskBoardPage";
import { TriagePage } from "./features/tasks/TriagePage";
import { MyTasksPage } from "./features/tasks/MyTasksPage";
import { CyclesPage } from "./features/planning/CyclesPage";

// 위키·지식 베이스(마크다운 렌더러 + 그래프)는 진입 시에만 로드
const WikiPage = lazy(() => import("./features/wiki/WikiPage").then((m) => ({ default: m.WikiPage })));
const KnowledgePage = lazy(() => import("./features/knowledge/KnowledgePage").then((m) => ({ default: m.KnowledgePage })));
const wikiElement = (
  <Suspense fallback={<p className="muted">불러오는 중…</p>}>
    <WikiPage />
  </Suspense>
);
const knowledgeElement = (
  <Suspense fallback={<p className="muted">불러오는 중…</p>}>
    <KnowledgePage />
  </Suspense>
);

export default function App() {
  return (
    <>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        {/* OAuth 동의 화면 — 사이드바 없이 단독 (로그인 필요) */}
        <Route path="/oauth/consent" element={<ConsentPage />} />
        <Route
          element={
            <ProjectsProvider>
              <Layout />
            </ProjectsProvider>
          }
        >
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectListPage />} />
          <Route path="/my-tasks" element={<MyTasksPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/settings/apps" element={<ConnectedAppsPage />} />
          <Route path="/projects/:projectId" element={<ProjectLayout />}>
            <Route index element={<Navigate to="tasks" replace />} />
            <Route path="tasks" element={<TaskBoardPage />}>
              <Route path=":taskId" element={<TaskDetailRoute />} />
            </Route>
            <Route path="triage" element={<TriagePage />} />
            <Route path="cycles" element={<CyclesPage />} />
            <Route path="wiki" element={wikiElement} />
            <Route path="knowledge" element={knowledgeElement} />
            <Route path="members" element={<MembersPage />} />
            <Route path="trash" element={<TrashPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="wiki/:pageId" element={wikiElement} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <VersionUpdatePrompt />
    </>
  );
}
