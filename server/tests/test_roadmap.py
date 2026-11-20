"""전체 로드맵 기능 백엔드 테스트:
- 하위 일감, 일감 간 링크, 일감↔위키 양방향 링크, 첨부 파일 목록
- @멘션·배정·덧글·소유권 알림
- 위키 버전 히스토리 (목록·Diff·복원)
- 전체 프로젝트 그래프
- 프로젝트 용어집 (동의어·상하위·사용처)
- 고정 스키마 엔티티/관계 자동 추출 및 리뷰 큐
- 그래프 기반 Q&A
- 초대 메일 발송/재발송, 소유권 이전, 감사 로그
"""

from app.api.deps import get_invite_sender
from tests.conftest import login


def test_subtasks_task_links_wiki_links_and_attachments(auth_client, project):
    pid = project["id"]
    guide = auth_client.post(f"/api/projects/{pid}/wiki/pages", json={"title": "인증 설계"}).json()
    parent = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "로그인 개편", "description": "[[인증 설계]] 참고"}).json()
    sub1 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "OAuth 연동", "parent_id": parent["id"]}).json()
    sub2 = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "테스트 작성", "parent_id": parent["id"], "stage": "done"}).json()

    # 순환 방지
    assert auth_client.patch(f"/api/projects/{pid}/tasks/{parent['id']}", json={"parent_id": sub1["id"]}).status_code == 400
    assert auth_client.patch(f"/api/projects/{pid}/tasks/{parent['id']}", json={"parent_id": parent["id"]}).status_code == 400

    # 하위 일감 집계 및 목록
    p_info = auth_client.get(f"/api/projects/{pid}/tasks/{parent['id']}").json()
    assert p_info["subtask_count"] == 2 and p_info["subtask_done"] == 1
    subs = auth_client.get(f"/api/projects/{pid}/tasks/{parent['id']}/subtasks").json()
    assert [s["id"] for s in subs] == [sub1["id"], sub2["id"]]

    # 일감 간 링크 (양방향 해석)
    other = auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "배포 준비"}).json()
    assert auth_client.post(f"/api/projects/{pid}/tasks/{parent['id']}/links", json={"target_id": parent["id"], "kind": "blocks"}).status_code == 400
    link = auth_client.post(f"/api/projects/{pid}/tasks/{parent['id']}/links", json={"target_id": other["id"], "kind": "blocks"}).json()
    assert link["kind"] == "blocks" and link["task_id"] == other["id"]
    assert auth_client.post(f"/api/projects/{pid}/tasks/{parent['id']}/links", json={"target_id": other["id"], "kind": "blocks"}).status_code == 409

    rev = auth_client.get(f"/api/projects/{pid}/tasks/{other['id']}/links").json()
    assert len(rev) == 1 and rev[0]["kind"] == "blocked_by" and rev[0]["task_id"] == parent["id"]

    # 일감 → 위키 링크 조회
    wlinks = auth_client.get(f"/api/projects/{pid}/tasks/{parent['id']}/wiki-links").json()
    assert wlinks == [{"title": "인증 설계", "page_id": guide["id"]}]

    # 일감 첨부 파일 업로드 및 필터링 목록
    up = auth_client.post(
        f"/api/projects/{pid}/attachments",
        files={"file": ("spec.pdf", b"%PDF-1.4\n...", "application/pdf")},
        data={"task_id": parent["id"]},
    )
    assert up.status_code == 201
    listed = auth_client.get(f"/api/projects/{pid}/attachments", params={"task_id": parent["id"]}).json()
    assert len(listed) == 1 and listed[0]["filename"] == "spec.pdf"

    # 링크 삭제 및 부모 삭제 시 하위 일감 parent_id 해제
    assert auth_client.delete(f"/api/projects/{pid}/tasks/{parent['id']}/links/{link['id']}").status_code == 204
    assert auth_client.delete(f"/api/projects/{pid}/tasks/{parent['id']}").status_code == 204
    assert auth_client.get(f"/api/projects/{pid}/tasks/{sub1['id']}").json()["parent_id"] is None


def test_mentions_and_notifications(app, auth_client, project):
    pid = project["id"]
    auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com"})
    bob = login(app, "u2:bob@example.com")

    # 배정 + 설명 멘션 + 코드 블록 안 멘션 무시
    t = auth_client.post(
        f"/api/projects/{pid}/tasks",
        json={"title": "알림 기능", "assignee_id": "u2", "description": "확인 부탁 `@bob` (코드 무시) @bob@example.com"},
    ).json()
    # 덧글 멘션
    auth_client.post(f"/api/projects/{pid}/tasks/{t['id']}/comments", json={"body": "@bob 리뷰해주세요"})

    notifs = bob.get("/api/notifications").json()
    assert notifs["unread_count"] >= 3
    kinds = {n["kind"] for n in notifs["items"]}
    assert {"assigned", "mention"} <= kinds

    first_id = notifs["items"][0]["id"]
    assert bob.post(f"/api/notifications/{first_id}/read").json()["read"] is True
    assert bob.post("/api/notifications/read-all").json()["updated"] >= 2
    assert bob.get("/api/notifications").json()["unread_count"] == 0


def test_wiki_revisions_diff_and_restore(auth_client, project):
    pid = project["id"]
    p = auth_client.post(f"/api/projects/{pid}/wiki/pages", json={"title": "배포 가이드", "content": "첫 줄\n둘째 줄"}).json()
    auth_client.patch(f"/api/projects/{pid}/wiki/pages/{p['id']}", json={"content": "첫 줄\n수정된 줄\n셋째 줄"})

    revs = auth_client.get(f"/api/projects/{pid}/wiki/pages/{p['id']}/revisions").json()
    assert [r["version"] for r in revs] == [2, 1]

    v1_detail = auth_client.get(f"/api/projects/{pid}/wiki/pages/{p['id']}/revisions/{revs[1]['id']}").json()
    assert any(d["kind"] == "del" and d["text"] == "둘째 줄" for d in v1_detail["diff_to_current"])
    assert any(d["kind"] == "add" and d["text"] == "수정된 줄" for d in v1_detail["diff_to_current"])

    restored = auth_client.post(f"/api/projects/{pid}/wiki/pages/{p['id']}/revisions/{revs[1]['id']}/restore").json()
    assert restored["content"] == "첫 줄\n둘째 줄"
    revs_after = auth_client.get(f"/api/projects/{pid}/wiki/pages/{p['id']}/revisions").json()
    assert [r["version"] for r in revs_after] == [3, 2, 1]
    assert "v1 복원" in revs_after[0]["note"]


def test_glossary_extraction_review_queue_full_graph_and_qa(auth_client, project):
    pid = project["id"]

    # 1) 용어집 (동의어 · 상하위 · 사용처)
    auth_term = auth_client.post(f"/api/projects/{pid}/glossary", json={"term": "인증", "definition": "사용자 신원을 확인하는 절차"}).json()
    sso = auth_client.post(
        f"/api/projects/{pid}/glossary",
        json={"term": "싱글사인온", "definition": "한 번의 로그인으로 여러 서비스를 이용하는 방식", "synonyms": ["SSO", "통합 로그인"], "broader_id": auth_term["id"]},
    ).json()
    assert auth_client.patch(f"/api/projects/{pid}/glossary/{auth_term['id']}", json={"broader_id": sso["id"]}).status_code == 400

    # 위키·일감 작성
    w_sso = auth_client.post(
        f"/api/projects/{pid}/wiki/pages",
        json={"title": "SSO 서버", "page_type": "spec", "content": "싱글사인온은 [[OAuth 게이트웨이]] 에 의존한다.\nPOST /oauth/token 엔드포인트를 제공한다."},
    ).json()
    w_gw = auth_client.post(
        f"/api/projects/{pid}/wiki/pages",
        json={"title": "OAuth 게이트웨이", "page_type": "spec", "content": "토큰 검증을 담당한다."},
    ).json()
    auth_client.post(f"/api/projects/{pid}/tasks", json={"title": "SSO 적용", "description": "SSO 서버와 OAuth 게이트웨이 연동"})

    usages = auth_client.get(f"/api/projects/{pid}/glossary/{sso['id']}/usages").json()
    assert len(usages) >= 2

    # 2) 고정 스키마 엔티티/관계 추출 → 리뷰 큐
    extracted = auth_client.post(f"/api/projects/{pid}/knowledge/extract").json()
    assert extracted["entities_added"] >= 4
    assert extracted["relations_added"] >= 2

    pending_ents = auth_client.get(f"/api/projects/{pid}/knowledge/entities", params={"status": "pending"}).json()
    names = {e["name"]: e for e in pending_ents}
    assert "SSO 서버" in names and "POST /oauth/token" in names and names["POST /oauth/token"]["kind"] == "api"

    # 일부 승인, 일부 거절 → 재추출 시 거절된 항목은 다시 생성되지 않음
    for e in pending_ents:
        status_val = "rejected" if e["name"] == "인증" else "approved"
        res = auth_client.patch(f"/api/projects/{pid}/knowledge/entities/{e['id']}", json={"status": status_val})
        assert res.status_code == 200 and res.json()["reviewed_by"] == "u1"

    pending_rels = auth_client.get(f"/api/projects/{pid}/knowledge/relations", params={"status": "pending"}).json()
    assert len(pending_rels) >= 2
    for r in pending_rels:
        auth_client.patch(f"/api/projects/{pid}/knowledge/relations/{r['id']}", json={"status": "approved"})

    re_extract = auth_client.post(f"/api/projects/{pid}/knowledge/extract").json()
    assert re_extract["entities_added"] == 0  # 중복/거절 재추출 없음

    # 3) 전체 그래프 뷰 API
    graph = auth_client.get(f"/api/projects/{pid}/graph").json()
    node_kinds = {n["kind"] for n in graph["nodes"]}
    assert {"wiki", "task", "glossary", "entity"} <= node_kinds
    assert any(e["kind"] == "relation" for e in graph["edges"])
    assert any(e["kind"] == "broader" for e in graph["edges"])

    # 4) 그래프 기반 Q&A (동의어 '통합 로그인'으로 질문해도 '싱글사인온'·'SSO 서버'·'OAuth 게이트웨이' 관계까지 답변)
    qa = auth_client.post(f"/api/projects/{pid}/knowledge/qa", json={"question": "통합 로그인은 무엇에 의존하나요?"}).json()
    assert "싱글사인온" in qa["expanded_terms"]
    assert "한 번의 로그인" in qa["answer"]
    assert any("OAuth 게이트웨이" in fact for fact in qa["related_facts"])
    assert len(qa["citations"]) >= 2
    assert len(qa["graph_nodes"]) >= 2
    assert w_sso["id"] and w_gw["id"]


def test_invite_email_ownership_transfer_and_audit_logs(app, auth_client, project):
    pid = project["id"]
    sent_mails: list[tuple[str, str]] = []

    def fake_sender(settings, to_email, proj, inviter, perms):
        sent_mails.append((to_email, proj.key))
        return "sent"

    app.dependency_overrides[get_invite_sender] = lambda: fake_sender

    # 1) 초대 메일 발송 & 재발송
    m = auth_client.post(f"/api/projects/{pid}/members", json={"email": "bob@example.com"}).json()
    assert m["invite_status"] == "sent" and sent_mails == [("bob@example.com", "MW")]
    resent = auth_client.post(f"/api/projects/{pid}/members/{m['id']}/resend-invite").json()
    assert resent["invite_status"] == "sent" and len(sent_mails) == 2

    # 2) 소유권 이전 (로그인 전이면 실패, 로그인 후 성공)
    bob = login(app, "u2:bob@example.com")
    # 비관리자는 감사 로그 403
    assert bob.get(f"/api/projects/{pid}/audit-logs").status_code == 403
    # 비소유자는 소유권 이전 403
    assert bob.post(f"/api/projects/{pid}/transfer-ownership", json={"new_owner_user_id": "u1"}).status_code == 403

    transferred = auth_client.post(f"/api/projects/{pid}/transfer-ownership", json={"new_owner_user_id": "u2"})
    assert transferred.status_code == 200
    assert transferred.json()["is_owner"] is False and "admin" in transferred.json()["my_permissions"]
    assert bob.get(f"/api/projects/{pid}").json()["is_owner"] is True
    assert any(n["kind"] == "ownership" for n in bob.get("/api/notifications").json()["items"])

    # 3) 감사 로그에 초대·재발송·소유권 이전 등이 기록됨
    logs = bob.get(f"/api/projects/{pid}/audit-logs").json()
    actions = {l["action"] for l in logs}
    assert {"project.created", "member.added", "member.invite_resent", "project.ownership_transferred"} <= actions
    # 이전 소유자도 admin 멤버로 유지되어 삭제 권한(소유자 전용)만 없고 감사 로그는 볼 수 있음
    assert auth_client.get(f"/api/projects/{pid}/audit-logs").status_code == 200
    assert auth_client.delete(f"/api/projects/{pid}").status_code == 403
    assert bob.delete(f"/api/projects/{pid}").status_code == 204
