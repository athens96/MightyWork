# MightyWork

개발 파이프라인 기반 **일감 관리** + 노션/컨플루언스 스타일 **위키** 도구.

**프로젝트** 단위로 운영한다. 프로젝트마다 고유 키(예: `MW`)가 있고, 일감과 위키는 각 프로젝트에 속한다.
일감 번호는 프로젝트별로 `MW-1, MW-2 …` 순서로 발급되며 삭제돼도 재사용하지 않는다.

### 멤버와 권한
- 프로젝트를 만든 사람이 **소유자**이며 항상 관리자다. 프로젝트 삭제는 소유자만 가능.
- 관리자는 구글 이메일로 멤버를 추가하고 권한을 준다. 아직 로그인한 적 없는 사람도 추가 가능(첫 로그인 시 자동 참여).
- 권한: `보기`(항상 포함) · `생성`(일감·위키·덧글 작성) · `편집`(일감·위키 수정, 단계 이동) · `삭제` · `관리자`(멤버·권한 관리, 모든 권한 포함)
- 멤버가 아닌 사용자에게 프로젝트는 존재하지 않는 것처럼 보인다(404). 권한이 없는 작업은 403.
- 작업자는 로그인한 프로젝트 멤버만 지정 가능. 멤버를 제거하면 그 사람의 일감은 '미지정'이 된다.

### 문서 구조 (지식화 1단계)
- 위키·일감 설명·덧글에서 `[[페이지 제목]]` / `[[제목|표시 텍스트]]` 는 위키 링크, `KEY-12` 는 일감 링크로 렌더링된다. 코드 블록 안은 제외.
- 없는 페이지 링크는 빨간 점선으로 표시되고, 생성 권한이 있으면 클릭해서 그 제목으로 만든다.
- 위키 하단 '연결': 이 문서를 링크한 문서(백링크) · 이 문서가 링크한 문서 · 언급한 일감. 일감 패널에는 '이 일감을 언급한 위키'.
- 페이지 제목을 바꾸면 다른 위키와 일감 설명의 `[[옛 제목]]` 이 자동으로 새 제목으로 바뀐다.
- 프로젝트 검색(헤더 검색창, ⌘K): 일감(제목·레이블·설명·할 일·덧글)과 위키(제목·본문). `MW-12` 처럼 키로 찾으면 해당 일감이 맨 위.
- 링크는 같은 프로젝트 안에서만 연결된다(권한 격리). 판정 규칙은 `server/app/services/links.py` 와 `client/src/lib/wikilinks.ts` 가 같다.
- **별칭**: 페이지마다 다른 이름(예: SSO)을 붙이면 `[[SSO]]` 링크·백링크·검색에 함께 쓰인다.
- **링크 안 된 언급**: 다른 위키·일감 설명에서 제목/별칭이 링크 없이 적힌 곳을 찾아 보여주고, 편집 권한이 있으면 한 번에 `[[링크]]` 로 바꾼다 (옵시디언 Unlinked mentions).
- **Properties**: 위키 페이지에 타입(가이드·명세·결정·회의록·참고·메모)·상태(초안·검토 중·확정·폐기)·담당자·태그. 위키 첫 화면의 문서 목록에서 이 값들로 거른다 (옵시디언 Bases).
- **로컬 그래프**: 문서를 중심으로 1~2단계 이웃(위키·일감)과 링크·일감 언급·상하위 관계를 그린다. 노드를 누르면 이동.

### 내보내기 · 가져오기
- 위키 페이지 '내보내기' 메뉴: **PDF**(인쇄 창에서 PDF로 저장) · **Word(.docx)** · **한글(.hwpx / .hwp)** · HTML · Markdown. '하위 페이지 포함'으로 트리를 한 문서로.
  - Markdown 은 `[[링크]]`·front matter(별칭·태그·타입·상태) 그대로 → 옵시디언에서 열림
  - Word: pandoc(`pypandoc-binary`), `--sandbox` 로 서버 파일 접근 차단, 한국어 글꼴·표 테두리 서식
  - 한글: [kordoc](https://github.com/chrisryugj/kordoc)(MIT) 공문서 프리셋(보고서·회의록·계획서·개조식·기안문 …), .hwp 는 [rhwp](https://github.com/edwardkim/rhwp)(MIT) 엔진
- 위키 목록의 '전체 ZIP': 페이지 트리를 폴더로 한 .md 묶음(옵시디언 볼트) + wiki.html
- 위키 '가져오기': HWP·HWPX·DOCX·PDF·PPTX·XLSX·Markdown → 새 페이지 (생성 권한, 최대 20MB, 그림은 아직 제외). MightyWork 가 내보낸 .md 는 속성까지 복원

일감 필드 (JIRA/Linear 스타일): 제목, 설명(Markdown), 상태(파이프라인 단계), 우선순위, 작업자, 보고자,
시작일·종료일(시작일 ≤ 종료일), 추정치(pt), 레이블, 할 일 체크리스트, 덧글(Markdown), 변경 이력.

| 구성 | 기술 |
| --- | --- |
| client | React 19 + TypeScript + Vite, React Router, `@react-oauth/google` |
| server | Python 3.12 + FastAPI, Pydantic v2, PyJWT, google-auth |
| 인증 | Google 계정 로그인 → 서버가 ID 토큰 검증 후 자체 JWT 발급 |
| DB | 파일 DB(JSON) — `Repository` 인터페이스 뒤에 숨겨져 있어 추후 교체 가능 |

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

## DB 교체 방법
1. `server/app/db/base.py` 의 `Repository` 를 구현하는 클래스 작성(예: `SqlRepository`)
2. `server/app/db/__init__.py` 의 `Database` 에 팩토리 추가(예: `from_sql(url)`)
3. `server/app/main.py` 의 `create_app` 에서 사용할 팩토리 선택

라우터는 `Repository` 인터페이스에만 의존하므로 수정할 필요가 없다.

> 파일 DB는 단일 프로세스 전제다. uvicorn worker 를 여러 개 띄우면 데이터가 꼬일 수 있다.

## 다음 단계 후보
- 일감: 드래그앤드롭, 하위 일감/일감 간 링크, 일감↔위키 링크, 첨부 파일, @멘션·알림
- 위키: `[[` 입력 시 자동완성, 버전 히스토리, 전체 그래프 뷰
- 지식화: 프로젝트 용어집(동의어·상하위) → 고정 스키마 엔티티/관계 추출(리뷰 큐) → 그래프 기반 Q&A
- 권한: 초대 메일 발송, 소유권 이전, 감사 로그
