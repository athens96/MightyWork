import type { Permission, Project } from "../types";

export const PERMISSIONS: Permission[] = ["view", "create", "edit", "delete", "admin"];

export const PERMISSION_LABEL: Record<Permission, string> = {
  view: "보기",
  create: "생성",
  edit: "편집",
  delete: "삭제",
  admin: "관리자",
};

export const PERMISSION_HINT: Record<Permission, string> = {
  view: "일감·위키 보기 (항상 포함)",
  create: "일감·위키 페이지·덧글 작성",
  edit: "일감·위키 수정, 단계 이동",
  delete: "일감·위키 삭제",
  admin: "멤버·권한 관리 (모든 권한 포함)",
};

/** 역할 프리셋 (추가 폼) */
export const PRESETS: { label: string; permissions: Permission[] }[] = [
  { label: "보기 전용", permissions: ["view"] },
  { label: "기여자 (보기·생성·편집)", permissions: ["view", "create", "edit"] },
  { label: "편집자 (+삭제)", permissions: ["view", "create", "edit", "delete"] },
  { label: "관리자", permissions: ["view", "create", "edit", "delete", "admin"] },
];

/** 서버와 같은 규칙: 관리자는 전부, 보기는 항상 포함 */
export function normalize(perms: Permission[]): Permission[] {
  const s = new Set(perms.includes("admin") ? PERMISSIONS : perms);
  s.add("view");
  return PERMISSIONS.filter((p) => s.has(p));
}

export const can = (project: Project, perm: Permission) => project.my_permissions.includes(perm);

export function roleLabel(project: Project): string {
  if (project.is_owner) return "소유자";
  const p = project.my_permissions;
  if (p.includes("admin")) return "관리자";
  if (p.length === 1) return "보기 전용";
  return "멤버";
}
