# MightyWork Workspace — MightyWork 프로젝트 연동 규칙

이 워크스페이스(`/Users/young/MightyWork`)는 **MightyWork MCP 서버(`mightywork`)**의 **"마이티 워크"** 프로젝트와 연동됩니다.

## 연동 대상 프로젝트
- **MCP 서버**: `mightywork`
- **프로젝트 이름**: 마이티 워크
- **프로젝트 키 (`project`)**: `MW`
- **프로젝트 ID**: `5b2c8c0b0ca14185a7a8d6ea85d08c47`

> 별도 지시가 없는 한 모든 `mightywork` MCP 도구 호출의 `project` 인자는 `"MW"`를 사용합니다(다른 프로젝트 `MC`, `MT`와 혼동 금지).

## 협업 · 작업 흐름 규칙

### 1. 일감 관리 (`MW-n`)
- 파이프라인 단계: `backlog` → `todo` → `in_progress` → `review` → `qa` → `done`
- 일감 조회·생성·수정은 `list_tasks`, `get_task`, `create_task`, `update_task`, `link_tasks`, `add_comment` 도구를 사용합니다.
- 기능 개발·버그 수정 등 요청을 수행할 때 관련 일감이 있으면 `in_progress`로 이동하고, 완료 시 변경 요약·검증 결과를 덧글(`add_comment`)로 남긴 뒤 적절한 단계(`review` 또는 `done`)로 갱신합니다.
- 큰 작업은 `create_task(parent="MW-n")`으로 하위 일감을 분할하고, 선후/의존 관계는 `link_tasks`로 연결합니다.

### 2. 위키 · 지식화 연동
- 설계 변경, 의사결정(ADR), 배포·운영 가이드, 트러블슈팅 기록은 `create_wiki_page` / `update_wiki_page`로 `MW` 위키에 남깁니다.
- 위키 본문과 일감 설명에서는 `[[페이지 제목]]`으로 관련 위키를, `MW-12` 형식으로 관련 일감을 연결합니다.
- 작업 전 기존 맥락·용어·설계를 확인할 때는 `search`, `list_wiki_pages`, `list_glossary`, `ask_knowledge_graph`를 우선 활용합니다.
