# Changelog

이 프로젝트의 주요 변경 사항은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/) 형식을 따르며 [Semantic Versioning](https://semver.org/lang/ko/)을 준수합니다.

## [0.1.0] - 2026-11-22

MightyWork 첫 번째 공식 마이너 릴리즈.

### Added
- **일감 파이프라인 · 다중 뷰**: 칸반 보드 · 리스트(표) · 타임라인(간트) 전환, 다중 필터·정렬·URL 동기화, 저장된 뷰, 전 프로젝트 통합 '내 일감(`/my-tasks`)'
- **키보드 퍼스트 UX**: 전역 커맨드 팔레트(`⌘K`/`Ctrl+K`), 빠른 일감 생성 모달(`C`) 및 일감 템플릿 자동 채우기, 다중 선택 일괄 편집 바, 단축키 안내(`?`), 상세 패널 단축키(`1~4`, `A`, `S`, `Esc`)
- **계획 · 워크플로우**:
  - 경량 사이클(스프린트) CRUD, 미완료 일감 자동 이월, SVG 번다운 & 속도(Velocity) 차트
  - 마일스톤(릴리즈/에픽) 그룹핑, 진척률 집계 및 목표일 기반 로드맵 타임라인
  - 트리아지 / 인테이크 대기열(수락·중복 병합·보류·거절) 및 외부 버그 제보 접수 웹훅(`/api/intake/{token}`)
  - 프로젝트별 파이프라인 단계 커스터마이징(이름·색상·순서·숨김·리매핑) 및 컬럼 WIP 상한 경고
- **위키 · 지식 베이스**:
  - 양방향 `[[위키]]`·`KEY-n` 링크, 버전 히스토리 Diff·복원, HWP/HWPX/DOCX/PDF/Markdown 내보내기·가져오기
  - 위키 체크리스트·선택 텍스트 원클릭 일감 생성 및 `KEY-n` 링크 자동 삽입
  - 용어집, 엔티티/관계 자동 추출·리뷰 큐, 로컬·전체 지식 그래프, 그래프 기반 Q&A
- **실시간 동기화 · 외부 연동**:
  - SQLite 멀티 워커 안전 SSE 실시간 스트림(`/api/projects/{pid}/events`, `/api/events`)
  - GitHub 연동(브랜치명 복사, HMAC-SHA256 Webhook 서명 검증, PR/커밋 자동 연결 및 단계 전환)
  - Slack · Discord · Custom Webhook 외부 알림 연동(SSRF 방어, HMAC 서명, 자동 재시도, 전송 로그, AI 에이전트 조건부 자동화 훅)
- **MCP 2026-07-28 + OAuth 2.1**:
  - Streamable HTTP MCP 서버(`/mcp`), CIMD/DCR OAuth 2.1 인가 서버
  - AI 에이전트 1급 협업자 출처 배지(`via <client_name>` 메타데이터 저장 및 UI 표시)
- **버저닝 · 운영 인프라**:
  - 루트 `VERSION` 단일 소스, `/api/version`·`/api/health` 버전 응답, 클라이언트 `v0.1.0` 표기, `scripts/bump-version.sh` 및 `scripts/deploy.sh`
