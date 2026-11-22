import type { PageStatus, PageType, WikiPageSummary } from "../types";

export interface WikiTemplate {
  id: string;
  label: string;
  desc: string;
  page_type: PageType;
  status: PageStatus;
  tags: string[];
  makeTitle: (todayYmd: string) => string;
  makeContent: (todayYmd: string) => string;
}

export const WIKI_TEMPLATES: readonly WikiTemplate[] = [
  {
    id: "meeting",
    label: "회의록",
    desc: "참석자 · 안건 · 결정 · 액션 아이템",
    page_type: "meeting",
    status: "draft",
    tags: ["meeting"],
    makeTitle: (today) => `회의록 ${today}`,
    makeContent: (today) =>
      `## 개요
- **일시**: ${today}
- **참석자**: @

## 안건
1. 

## 결정 사항
- 

## 액션 아이템
- [ ] 담당자 · 할 일 내용
`,
  },
  {
    id: "adr",
    label: "의사결정 기록 (ADR)",
    desc: "배경 · 선택지 비교 · 최종 결정",
    page_type: "decision",
    status: "review",
    tags: ["adr"],
    makeTitle: () => "ADR: 제목을 입력하세요",
    makeContent: () =>
      `> [!IMPORTANT]
> **상태**: 검토 중 · **결정일**: YYYY-MM-DD

## 배경 및 문제
- 

## 검토한 선택지
| 선택지 | 장점 | 단점 |
| --- | --- | --- |
| 안 A |  |  |
| 안 B |  |  |

## 최종 결정 및 근거
- 

## 후속 작업
- [ ] 관련 일감 연결
`,
  },
  {
    id: "spec",
    label: "기능 명세서 (Spec)",
    desc: "목표 · 요구사항 · 설계 · 완료 조건",
    page_type: "spec",
    status: "draft",
    tags: ["spec"],
    makeTitle: () => "기능 명세: 제목을 입력하세요",
    makeContent: () =>
      `## 목표
- 

## 범위 (포함 / 제외)
- **포함**: 
- **제외**: 

## 상세 설계
### 데이터 · API
- 

### 화면 · UX
- 

## 검증 기준
- [ ] 단위 테스트 통과
- [ ] 주요 시나리오 수동 확인
`,
  },
  {
    id: "postmortem",
    label: "장애 회고 (Postmortem)",
    desc: "영향 요약 · 타임라인 · 원인 · 재발 방지",
    page_type: "reference",
    status: "draft",
    tags: ["postmortem"],
    makeTitle: (today) => `장애 회고 ${today}`,
    makeContent: (today) =>
      `> [!WARNING]
> **발생일**: ${today} · **영향 범위**: 요약 입력

## 타임라인
| 시각 | 이벤트 |
| --- | --- |
| 00:00 | 감지 |
| 00:00 | 복구 완료 |

## 근본 원인 (Root Cause)
- 

## 재발 방지 대책
- [ ] 단기 조치
- [ ] 근본 개선
`,
  },
  {
    id: "guide",
    label: "가이드 · 런북",
    desc: "사전 준비 · 단계별 절차 · 트러블슈팅",
    page_type: "guide",
    status: "draft",
    tags: ["guide"],
    makeTitle: () => "가이드: 제목을 입력하세요",
    makeContent: () =>
      `## 개요
- 

## 사전 준비
- 

## 진행 절차
1. 
2. 

## 트러블슈팅
> [!TIP]
> 자주 발생하는 문제와 해결 방법을 기록하세요.
`,
  },
];

/** 자기 자신 및 모든 하위(자손) 페이지 ID 집합 반환 (상위 페이지 이동 시 순환 방지용) */
export function collectDescendantIds(pages: Pick<WikiPageSummary, "id" | "parent_id">[], rootId: string): Set<string> {
  const blocked = new Set<string>([rootId]);
  const childrenByParent = new Map<string, string[]>();
  for (const p of pages) {
    if (!p.parent_id) continue;
    const list = childrenByParent.get(p.parent_id) ?? [];
    list.push(p.id);
    childrenByParent.set(p.parent_id, list);
  }
  const queue = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const childId of childrenByParent.get(cur) ?? []) {
      if (!blocked.has(childId)) {
        blocked.add(childId);
        queue.push(childId);
      }
    }
  }
  return blocked;
}
