/** 일감 키와 제목으로부터 Git 브랜치명을 생성한다 (예: feat/mw-12-github-sync) */
export function makeBranchName(projectKey: string, taskNumber: number, title: string, tags: string[] = []): string {
  const isFix = tags.some((t) => /^(bug|fix|hotfix|버그)$/i.test(t)) || /버그|오류|수정|fix/i.test(title);
  const prefix = isFix ? "fix" : "feat";
  const key = `${projectKey.toLowerCase()}-${taskNumber}`;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 36)
    .replace(/-+$/, "");
  return slug ? `${prefix}/${key}-${slug}` : `${prefix}/${key}`;
}
