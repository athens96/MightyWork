# MightyWork `v0.1.0`

개발 파이프라인 기반 **일감 관리** + 노션/컨플루언스 스타일 **위키** 도구.

> 현재 버전: `0.1.0` ([VERSION](VERSION) · [CHANGELOG.md](CHANGELOG.md)) — 버전 갱신은 `./scripts/bump-version.sh <patch|minor|major|X.Y.Z>` 사용.

**프로젝트** 단위로 운영한다. 프로젝트마다 고유 키(예: `MW`)가 있고, 일감과 위키는 각 프로젝트에 속한다.
일감 번호는 프로젝트별로 `MW-1, MW-2 …` 순서로 발급되며 삭제돼도 재사용하지 않는다.

### 멤버와 권한
- 프로젝트를 만든 사람이 **소유자**이며 항상 관리자다. 프로젝트 삭제·소유권 이전은 소유자만 가능.
- 관리자는 구글 이메일로 멤버를 추가하고 권한을 준다. 아직 로그인한 적 없는 사람도 추가 가능(첫 로그인 시 자동 참여). SMTP 설정 시 초대 메일 자동 발송 및 재발송 지원.
- 권한: `보기`(항상 포함) · `생성`(일감·위키·덧글·첨부 작성) · `편집`(일감·위키 수정, 단계 이동) · `삭제` · `관리자`(멤버·권한·감사 로그 관리, 모든 권한 포함)
- 멤버가 아닌 사용자에게 프로젝트는 존재하지 않는 것처럼 보인다(404). 권한이 없는 작업은 403.
- 작업자는 로그인한 프로젝트 멤버만 지정 가능. 멤버를 제거하면 그 사람의 일감은 '미지정'이 된다.
- **소유권 이전**: 소유자가 로그인한 기존 멤버에게 소유권을 넘길 수 있으며 이전 소유자는 관리자 멤버로 전환.
- **감사 로그**: 프로젝트 생성·수정·소유권 이전, 멤버 추가/변경/제거·초대 발송, 일감·위키·복원·첨부·지식 리뷰 내역을 관리자가 조회.

### 일감 · 알림
- **파이프라인 칸반 보드**: 드래그앤드롭으로 단계 이동(편집 권한), 작업자별 필터, 상태 요약 타일.
- **하위 일감 · 일감 간 링크 · 양방향 위키 링크**: `parent_id` 기반 하위 일감, `blocks`/`relates_to`/`duplicates` 일감 간 연결, 설명의 `[[위키]]` 링크 및 위키 역참조를 함께 표시.
- **첨부 파일**: 프로젝트 권한으로 격리된 이미지·문서 첨부(에디터 붙여넣기/드롭 및 첨부 목록 다운로드/삭제, SVG/HTML 인라인 실행 차단).
- **@멘션 · 알림**: 일감 설명·덧글·위키에서 `@이메일`/`@이름` 멘션(자동완성 지원), 작업자 배정, 덧글, 소유권 이전 알림을 사이드바 알림함(`/notifications`)에서 확인.

### 문서 구조 · 지식화 (1~3단계)
- 위키·일감 설명·덧글에서 `[[페이지 제목]]` / `[[제목|표시 텍스트]]` 는 위키 링크, `KEY-12` 는 일감 링크로 렌더링된다. 코드 블록 안은 제외. 에디터에서 `[[` 및 `@` 입력 시 자동완성 제공.
- 없는 페이지 링크는 빨간 점선으로 표시되고, 생성 권한이 있으면 클릭해서 그 제목으로 만든다.
- 위키 하단 '연결': 이 문서를 링크한 문서(백링크) · 이 문서가 링크한 문서 · 언급한 일감. 일감 패널에는 '연결된 위키'(양방향).
- 페이지 제목을 바꾸면 다른 위키와 일감 설명의 `[[옛 제목]]` 이 자동으로 새 제목으로 바뀐다(코드 블록 제외).
- **버전 히스토리**: 위키 생성·수정마다 버전 스냅샷이 쌓이며, 현재 문서 대비 줄 단위 Diff 확인 및 원클릭 복원 지원.
- 프로젝트 검색(헤더 검색창, ⌘K): SQLite FTS5(trigram) 기반 일감·위키 검색. `MW-12` 처럼 키로 찾으면 해당 일감이 맨 위.
- **별칭 · 링크 안 된 언급 · Properties**: 별칭 링크·검색, 미연결 언급 원클릭 링크화, 타입·상태·담당자·태그 필터(Bases).
- **로컬 그래프 · 전체 그래프 뷰**: 문서 중심 1~2단계 로컬 그래프 + 지식 베이스의 프로젝트 전체 그래프(위키·일감·용어집·승인된 엔티티/관계, 줌·필터·검색 강조).
- **프로젝트 용어집**: 도메인 용어 정의, 동의어, 상하위 개념(계층), 위키 연결 및 프로젝트 내 사용처 조회.
- **고정 스키마 엔티티/관계 추출 · 리뷰 큐**: 위키·일감·용어집에서 `system/service/api/data/role/decision/concept` 엔티티와 관계를 자동 추출해 리뷰 큐(`pending`)에 적재 → 승인(`approved`)/거절(`rejected`).
- **그래프 기반 Q&A**: 질문 키워드를 용어집 동의어·상하위로 확장하고 지식·문서 그래프를 순회해 근거 출처·서브그래프와 함께 답변.

### 내보내기 · 가져오기
- 위키 페이지 '내보내기' 메뉴: **PDF**(인쇄 창에서 PDF로 저장) · **Word(.docx)** · **한글(.hwpx / .hwp)** · HTML · Markdown. '하위 페이지 포함'으로 트리를 한 문서로.
  - Markdown 은 `[[링크]]`·front matter(별칭·태그·타입·상태) 그대로 → 옵시디언에서 열림
  - Word: pandoc(`pypandoc-binary`), `--sandbox` 로 서버 파일 접근 차단, 한국어 글꼴·표 테두리 서식
  - 한글: [kordoc](https://github.com/chrisryugj/kordoc)(MIT) 공문서 프리셋(보고서·회의록·계획서·개조식·기안문 …), .hwp 는 [rhwp](https://github.com/edwardkim/rhwp)(MIT) 엔진
- 위키 목록의 '전체 ZIP': 페이지 트리를 폴더로 한 .md 묶음(옵시디언 볼트) + wiki.html
- 위키 '가져오기': HWP·HWPX·DOCX·PDF·PPTX·XLSX·Markdown → 새 페이지 (생성 권한, 최대 20MB, 그림은 아직 제외). MightyWork 가 내보낸 .md 는 속성까지 복원

### MCP 서버 (AI 앱 연결)
- 주소: `<PUBLIC_URL>/mcp` (Streamable HTTP, **MCP 2026-07-28** — `server/discover`·무상태, 이전 버전 클라이언트도 SDK 가 처리)
- 도구: `list_projects` · `search` · `list_tasks` · `get_task` · `create_task`(하위 일감 `parent` 지원) · `update_task` · `link_tasks` · `add_comment` · `list_wiki_pages` · `get_wiki_page` · `create_wiki_page` · `update_wiki_page` · `list_glossary` · `ask_knowledge_graph`
- 권한: 토큰 scope(`mightywork:read` / `mightywork:write`) **와** 사용자의 실제 프로젝트 권한(보기·생성·편집)을 함께 확인
- 인증: **OAuth 2.1** — 이 서버가 인가 서버를 겸함, 로그인은 기존 구글 로그인 + 동의 화면
  - Protected Resource Metadata(RFC 9728), 401 `WWW-Authenticate: resource_metadata`
  - 인가 서버 메타데이터(RFC 8414), PKCE S256 필수, resource 바인딩(RFC 8707, 토큰 aud = MCP 주소), 인가 응답 `iss`(RFC 9207)
  - 클라이언트 등록: **Client ID Metadata Document(CIMD) 우선**, 동적 등록(RFC 7591)은 호환용 — CIMD 가져오기는 SSRF 방어(https·공개 주소·크기·시간 제한)
  - refresh 토큰 회전 + 재사용 탐지, 폐기(RFC 7009), 액세스 토큰은 웹 앱 로그인 토큰과 다른 키·aud
- 웹 앱 사이드바 하단 🔌 **연결된 앱**: MCP 주소·연결 방법(Claude Code / mcp.json), 허용한 앱 목록·해제(즉시 무효)

```bash
claude mcp add --transport http mightywork http://localhost:8000/mcp   # 브라우저에서 로그인·동의
```

일감 필드 (JIRA/Linear 스타일): 제목, 설명(Markdown), 상태(파이프라인 단계), 우선순위, 작업자, 보고자,
시작일·종료일(시작일 ≤ 종료일), 추정치(pt), 레이블, 할 일 체크리스트, 덧글(Markdown), 변경 이력.

| 구성 | 기술 |
| --- | --- |
| client | React 19 + TypeScript + Vite 8, React Router 7, `@react-oauth/google`, Vitest |
| server | Python 3.12 + FastAPI, Pydantic v2, PyJWT, google-auth, MCP Python SDK |
| 인증 | Google 계정 로그인 → 자체 JWT + `HttpOnly` 리프레시 쿠키 자동 갱신 |
| DB | SQLite(WAL + FTS5 trigram 기본, 기존 JSON 자동 이전) / 파일 JSON 선택 가능 — `Repository` 인터페이스 뒤에 숨겨져 교체 용이 |
| 배포 | `Dockerfile` (server/client), `docker-compose.yml`, GitHub Actions CI |

## 디렉터리 구조

```
server/
  app/
    main.py              # create_app(): CORS, 라우터 등록
    core/config.py       # 환경설정(.env)
    core/security.py     # JWT 발급/검증
    db/base.py           # Repository 추상 인터페이스
    db/json_store.py     # JSON 파일 저장소 구현(원자적 쓰기)
    db/__init__.py       # Database: 저장소 묶음 — DB 교체 지점
    models/              # user / project / task / comment / activity / wiki 모델 & 요청 스키마
    services/google_auth.py  # 구글 ID 토큰 검증
    services/projects.py # 일감 번호 발급, 프로젝트 삭제(하위 데이터 포함)
    services/tasks.py    # 변경 이력 기록, 일감 삭제(덧글·이력 포함)
    services/access.py   # 프로젝트 권한 계산(소유자/멤버)
    services/links.py    # [[링크]]·일감 키 파싱, 백링크, 제목 변경 전파
    services/search.py   # 프로젝트 검색 (SQLite 전환 시 FTS5 로 교체)
    services/graph.py    # 로컬 그래프 (위키·일감 간선, BFS)
    services/export/     # 내보내기: prepare(묶기·링크) · markdown · html · docx(pandoc) · hangul(kordoc) · archive(zip)
    services/importer.py # 문서 가져오기 (kordoc → Markdown)
    services/oauth/      # OAuth 2.1 인가 서버 (server: 토큰·코드·회전, cimd: 클라이언트 메타데이터 문서)
    mcp_server.py        # MCP 서버(MCPServer): 도구·토큰 검증
  tools/kordoc/          # kordoc·rhwp 버전 고정 (package.json / lock)
    api/deps.py          # 의존성: 현재 사용자, 현재 프로젝트, DB, PATCH 헬퍼
    api/routes/          # auth, users, projects, members, tasks, comments, wiki, knowledge
  tests/                 # pytest (구글 검증기는 가짜로 대체)
client/
  src/
    api/                 # fetch 래퍼(http.ts) + 도메인별 API
    auth/                # AuthContext, RequireAuth
    components/Layout.tsx
    pages/LoginPage.tsx
    features/projects/   # 프로젝트 목록/생성, 레이아웃(탭), 멤버·권한 관리
    features/tasks/      # 파이프라인 칸반 보드 + 일감 상세 패널(속성·할 일·덧글/이력)
    features/wiki/       # 페이지 트리 + 뷰어/에디터
    types.ts             # 서버 모델과 1:1 대응 타입
```

## API 요약 (`/api`)

| Method | Path | 설명 |
| --- | --- | --- |
| GET | `/health` | 헬스체크 |
| POST | `/auth/google` | `{credential}` → `{access_token, user}` |
| GET | `/auth/me` | 현재 사용자 |
| GET | `/users` | 사용자 목록(담당자 지정용) |
| GET | `/pipeline` | 파이프라인 단계(보드 컬럼, 전 프로젝트 공통) |
| GET/POST | `/projects` | 내가 멤버인 프로젝트 목록(내 권한 포함) / 생성(만든 사람 = 소유자) |
| GET/PATCH/DELETE | `/projects/{pid}` | 조회 / 수정(관리자) / 삭제(소유자, 하위 데이터 모두 삭제) |
| GET/POST | `/projects/{pid}/members` | 멤버 목록(소유자 포함) / 이메일로 추가(관리자) |
| PATCH/DELETE | `/projects/{pid}/members/{mid}` | 권한 변경 / 제거 (관리자, 소유자는 변경 불가) |
| GET/POST | `/projects/{pid}/tasks` | 일감 목록(`?stage=&assignee_id=`) / 등록 |
| GET/PATCH/DELETE | `/projects/{pid}/tasks/{id}` | 조회 / 수정(보낸 필드만) / 삭제(덧글·이력 포함) |
| GET/POST | `/projects/{pid}/tasks/{id}/comments` | 덧글 목록 / 작성 |
| PATCH/DELETE | `/projects/{pid}/tasks/{id}/comments/{cid}` | 덧글 수정 / 삭제 (작성자만, 아니면 403) |
| GET | `/projects/{pid}/tasks/{id}/activity` | 변경 이력(생성, 상태·작업자·날짜 등) |
| GET | `/projects/{pid}/tasks/{id}/wiki-refs` | 이 일감 키를 언급한 위키 |
| GET | `/projects/{pid}/wiki/pages/{id}/links` | 링크한 문서 · 백링크 · 언급한 일감 |
| GET | `/projects/{pid}/wiki/pages/{id}/unlinked-mentions` | 링크 안 된 언급 목록 |
| POST | `/projects/{pid}/wiki/pages/{id}/unlinked-mentions/link` | 선택한 문서의 언급을 `[[링크]]` 로 변환 (편집) |
| GET | `/projects/{pid}/wiki/pages/{id}/graph?depth=1\|2` | 로컬 그래프 (노드·간선) |
| GET | `/projects/{pid}/wiki/pages/{id}/export?format=md\|html\|docx\|hwpx\|hwp` | 내보내기 (`children`, `print`, `preset`) |
| GET | `/projects/{pid}/wiki/export.zip` | 위키 전체 ZIP |
| POST | `/projects/{pid}/wiki/import` | 문서 가져오기 (multipart `file`, `parent_id`) |
| GET/DELETE | `/oauth/grants`, `/oauth/grants/{id}` | 연결된 앱 목록 / 해제 |

OAuth·MCP 엔드포인트 (루트): `POST /mcp` · `GET /.well-known/oauth-protected-resource[/mcp]` · `GET /.well-known/oauth-authorization-server` · `GET /oauth/authorize` · `POST /oauth/token` · `POST /oauth/register` · `POST /oauth/revoke`
| GET | `/projects/{pid}/search?q=` | 일감 + 위키 검색 (점수순) |
| GET/POST | `/projects/{pid}/wiki/pages` | 페이지 목록(본문 제외, `?page_type=&status=&tag=&owner_id=` 필터) / 생성 |
| GET/PATCH/DELETE | `/projects/{pid}/wiki/pages/{id}` | 조회 / 수정·이동 / 삭제(하위 페이지 있으면 409) |

서버 실행 후 `http://localhost:8000/docs` 에서 Swagger UI 확인 가능.

파이프라인 단계: `backlog → todo → in_progress → review → qa → done` (`server/app/models/task.py` 에서 변경)

## 시작하기

### 1. Google OAuth 클라이언트 ID 발급
Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → **OAuth 클라이언트 ID(웹 애플리케이션)**
- 승인된 JavaScript 원본: `http://localhost:5174`

### 2. 서버
```bash
cd server
cp .env.example .env        # GOOGLE_CLIENT_ID, JWT_SECRET 설정
uv sync
(cd tools/kordoc && npm ci)  # 한글 내보내기·문서 가져오기용 (Node.js 20+). 없으면 해당 기능만 503
uv run uvicorn app.main:app --reload --port 8000
uv run pytest               # 테스트
```

### 3. 클라이언트
```bash
cd client
cp .env.example .env        # VITE_GOOGLE_CLIENT_ID 설정(서버와 동일 값)
npm install
npm run dev                 # http://localhost:5174 (/api 는 8000 으로 프록시)
```

### 4. Docker Compose 실행
```bash
GOOGLE_CLIENT_ID=... JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") docker compose up --build
```

## 배포 (Oracle Cloud, MightyTrade 와 같은 VM)

한 VM 의 nginx 가 도메인(`server_name`)으로 나눈다: `mightytrade.duckdns.org` → MightyTrade(127.0.0.1:5001), `mightywork.duckdns.org` → MightyWork(정적 빌드 + 127.0.0.1:8000). 웹 앱과 API·OAuth·MCP 가 같은 origin 이다. 두 저장소는 같은 배포 구조를 쓴다:

| 파일 | 내용 |
|---|---|
| `scripts/deploy.sh` | 공통 스크립트 (MightyTrade 와 동일 파일) |
| `deploy/app.conf` | 앱별 값(경로·도메인·서비스·헬스 체크)과 설치 단계(`remote_prereqs`·`remote_install`·`remote_env`) |
| `deploy/nginx.conf` | nginx 사이트 템플릿 (처음 설치 때만 복사, 이후 certbot 이 고친 파일 유지) |
| `deploy/mighty-work-api.service` | systemd 유닛 (바뀌면 업데이트 때 자동 반영) |
| `deploy/.env.deploy` | 로컬 수동 배포 접속 정보 `DEPLOY_HOST`, `DEPLOY_KEY` (git 제외) |
| `.github/workflows/deploy.yml` | `main` 푸시 · 수동 트리거 시 GitHub Actions 자동 배포 (`DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `VITE_GOOGLE_CLIENT_ID` Secrets 사용) |

```bash
./scripts/deploy.sh            # 업데이트: main 에 푸시한 뒤. 서버 git pull·의존성·재시작 + 클라이언트 로컬 빌드 업로드
./scripts/deploy.sh setup      # 처음 설치 (반복 실행 안전): Node 22·uv·clone·server/.env·systemd·nginx·HTTPS
./scripts/deploy.sh status     # 서비스 상태·헬스 체크
./scripts/deploy.sh logs 200   # 서비스 로그
```

- `setup` 은 `server/.env` 가 없을 때만 만든다: 로컬 `server/.env` 의 `GOOGLE_CLIENT_ID`, 새 `JWT_SECRET`, `PUBLIC_URL`·`APP_URL`·`CORS_ORIGINS` = `https://<도메인>`.
- 클라이언트는 로컬에서 빌드한다 (`client/.env` 의 `VITE_GOOGLE_CLIENT_ID`).
- 외부 설정: Google OAuth 클라이언트의 승인된 JavaScript 원본에 `https://mightywork.duckdns.org`.
- `server/.env` 와 `server/data/`(SQLite DB·첨부)는 서버에만 있다. MCP 주소는 `https://mightywork.duckdns.org/mcp`.

## DB 교체 방법
1. `server/app/db/base.py` 의 `Repository` 를 구현하는 클래스 작성(예: `PostgresRepository`)
2. `server/app/db/__init__.py` 의 `Database` 에 팩토리 추가
3. `server/app/main.py` 의 `create_app` 에서 `settings.db_backend` 분기 추가

기본 백엔드는 `sqlite`(WAL 모드 + FTS5 + 영속 OAuth 스토어로 멀티 워커 안전)이며, 기존 `data/*.json` 이 있으면 최초 기동 시 자동으로 이전합니다. `DB_BACKEND=json` 으로 기존 JSON 파일 DB도 선택할 수 있습니다.
