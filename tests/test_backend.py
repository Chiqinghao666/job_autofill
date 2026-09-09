"""纯离线后端的安全与本地映射行为测试；所有资料均为虚构数据。"""
import sys
import sqlite3
import stat
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend import app as service


FAKE_PROFILE = {
    "basic": {"name_cn": "测试同学", "email": "test@example.invalid", "phone": "13800000000"},
    "education": [], "internships": [], "student_activities": [], "awards": [],
    "family": {"members": [], "emergency_contact": {}},
}
EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """每个用例使用独立 SQLite 与认证文件，绝不读取真实 data。"""
    monkeypatch.setattr(service, "DATA_DIR", tmp_path)
    monkeypatch.setattr(service, "DB_PATH", tmp_path / "autofill.db")
    monkeypatch.setattr(service, "AUTH_PATH", tmp_path / "auth.json")
    monkeypatch.setattr(service, "SEED_PATH", tmp_path / "missing_seed.json")
    service.init_db()
    with TestClient(service.app) as test_client:
        yield test_client


def pair(client):
    requested = client.post("/api/pairing/request", json={"extension_origin": EXTENSION_ORIGIN})
    assert requested.status_code == 200
    code = requested.json()["pairing_code"]
    confirmed = client.post("/api/pairing/confirm", json={"pairing_code": code})
    assert confirmed.status_code == 200
    claimed = client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN})
    assert claimed.status_code == 200
    return {"Authorization": f"Bearer {claimed.json()['access_token']}", "Origin": EXTENSION_ORIGIN}


def test_unpaired_clients_cannot_read_profile_or_sensitive_status(client):
    status = client.get("/api/status")
    assert status.status_code == 401
    assert "profile_name" not in status.text
    assert "autofill.db" not in status.text
    assert client.get("/api/profile").status_code == 401
    assert client.post("/api/match", json={"fields": []}).status_code == 401


def test_pairing_requires_confirmation_then_persists_bearer_token(client):
    requested = client.post("/api/pairing/request", json={"extension_origin": EXTENSION_ORIGIN})
    code = requested.json()["pairing_code"]
    assert client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 409
    assert client.post("/api/pairing/confirm", json={"pairing_code": code}).status_code == 200
    token = client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}", "Origin": EXTENSION_ORIGIN}
    assert client.put("/api/profile", headers=headers, json={"profile": FAKE_PROFILE}).status_code == 200
    assert client.get("/api/profile", headers=headers).json()["profile"]["basic"]["name_cn"] == "测试同学"
    service.init_db()
    assert client.get("/api/profile", headers=headers).status_code == 200


def test_cors_only_echoes_paired_extension_origins(client):
    headers = pair(client)
    response = client.options("/api/profile", headers={"Origin": EXTENSION_ORIGIN, "Access-Control-Request-Method": "GET"})
    assert response.headers["access-control-allow-origin"] == EXTENSION_ORIGIN
    denied = client.options("/api/profile", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in denied.headers
    assert client.get("/api/profile", headers={"Authorization": headers["Authorization"], "Origin": "https://evil.example"}).status_code == 403


def test_exact_mapping_reused_compatible_mapping_and_ignore_are_persistent(client):
    headers = pair(client)
    client.put("/api/profile", headers=headers, json={"profile": FAKE_PROFILE})
    payload = {"page_url": "https://jobs.example/apply", "form_signature": "form-a", "fields": [
        {"id": "email", "label": "陌生字段", "fingerprint": "field-email"},
        {"id": "skip", "label": "无需填写", "fingerprint": "field-skip"},
    ]}
    saved = client.post("/api/mappings/confirm", headers=headers, json={"page_url": payload["page_url"], "form_signature": "form-a", "mappings": [
        {"field_fingerprint": "field-email", "profile_key": "basic.email"},
        {"field_fingerprint": "field-skip", "ignored": True},
    ]})
    assert saved.status_code == 200
    exact = client.post("/api/match", headers=headers, json=payload).json()["matches"]
    assert exact[0]["profile_key"] == "basic.email" and exact[0]["source"] == "history_exact"
    assert exact[1]["source"] == "ignored"
    compatible = client.post("/api/match", headers=headers, json={**payload, "form_signature": "form-b", "fields": [payload["fields"][0]]}).json()["matches"][0]
    assert compatible["profile_key"] == "basic.email" and compatible["source"] == "history_domain"


def test_mapping_signature_change_only_requires_the_changed_field_and_can_be_deleted(client):
    headers = pair(client)
    client.put("/api/profile", headers=headers, json={"profile": FAKE_PROFILE})
    created = client.post("/api/mappings/confirm", headers=headers, json={"page_url": "https://jobs.example/x", "form_signature": "original", "mappings": [
        {"field_fingerprint": "same-field", "profile_key": "basic.email"}
    ]}).json()["mappings"][0]
    changed = client.post("/api/match", headers=headers, json={"page_url": "https://jobs.example/x", "form_signature": "changed", "fields": [
        {"id": "same", "label": "完全陌生", "fingerprint": "same-field"},
        {"id": "new", "label": "仍然陌生", "fingerprint": "new-field"},
    ]}).json()["matches"]
    assert changed[0]["profile_key"] == "basic.email"
    assert changed[1]["profile_key"] is None
    assert client.delete(f"/api/mappings/{created['id']}", headers=headers).status_code == 200
    assert client.get("/api/mappings", headers=headers, params={"page_url": "https://jobs.example/x"}).json()["mappings"] == []


def test_legacy_feedback_still_creates_a_mapping(client):
    headers = pair(client)
    response = client.post("/api/feedback", headers=headers, json={
        "page_url": "https://jobs.example/x", "fingerprint": "legacy-email", "profile_key": "basic.email"
    })
    assert response.status_code == 200
    mappings = client.get("/api/mappings", headers=headers, params={"page_url": "https://jobs.example/x"}).json()["mappings"]
    assert mappings[0]["field_fingerprint"] == "legacy-email"


def test_pairing_code_expires_and_cannot_be_claimed_twice(client, monkeypatch):
    monkeypatch.setattr(service, "pairing_is_expired", lambda pair: True)
    expired = client.post("/api/pairing/request", json={"extension_origin": EXTENSION_ORIGIN}).json()["pairing_code"]
    assert client.post("/api/pairing/confirm", json={"pairing_code": expired}).status_code == 410
    monkeypatch.setattr(service, "pairing_is_expired", lambda pair: False)
    code = client.post("/api/pairing/request", json={"extension_origin": EXTENSION_ORIGIN}).json()["pairing_code"]
    client.post("/api/pairing/confirm", json={"pairing_code": code})
    assert client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 200
    assert client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 404


def test_delete_mapping_query_clears_only_the_selected_domain(client):
    headers = pair(client)
    for url in ("https://one.example/a", "https://two.example/b"):
        client.post("/api/mappings/confirm", headers=headers, json={"page_url": url, "mappings": [
            {"field_fingerprint": "email", "profile_key": "basic.email"}
        ]})
    assert client.delete("/api/mappings", headers=headers, params={"page_url": "https://one.example/a"}).json()["deleted"] == 1
    assert client.get("/api/mappings", headers=headers, params={"page_url": "https://one.example/a"}).json()["mappings"] == []
    assert len(client.get("/api/mappings", headers=headers, params={"page_url": "https://two.example/b"}).json()["mappings"]) == 1


def test_match_marks_only_history_as_safe_for_automatic_fill(client):
    headers = pair(client)
    client.put("/api/profile", headers=headers, json={"profile": FAKE_PROFILE})
    rule = client.post("/api/match", headers=headers, json={"page_url": "https://jobs.example/x", "fields": [
        {"id": "email", "label": "电子邮箱", "fingerprint": "rule-email"}
    ]}).json()["matches"][0]
    assert rule["source"] == "rule" and rule["needs_confirmation"] is True
    client.post("/api/mappings/confirm", headers=headers, json={"page_url": "https://jobs.example/x", "form_signature": "f", "mappings": [
        {"field_fingerprint": "rule-email", "profile_key": "basic.email"}
    ]})
    learned = client.post("/api/match", headers=headers, json={"page_url": "https://jobs.example/x", "form_signature": "f", "fields": [
        {"id": "email", "label": "电子邮箱", "fingerprint": "rule-email"}
    ]}).json()["matches"][0]
    assert learned["needs_confirmation"] is False


def test_auth_store_is_owner_read_write_only(client):
    assert stat.S_IMODE(service.AUTH_PATH.stat().st_mode) == 0o600


def test_init_db_migrates_the_real_legacy_mapping_shape(tmp_path, monkeypatch):
    database = tmp_path / "legacy.db"
    with sqlite3.connect(database) as conn:
        conn.execute("CREATE TABLE mappings (hostname TEXT NOT NULL, fingerprint TEXT NOT NULL, profile_key TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, PRIMARY KEY(hostname, fingerprint))")
        conn.execute("INSERT INTO mappings VALUES ('legacy.example', 'old-field', 'basic.email', 0.9)")
    monkeypatch.setattr(service, "DATA_DIR", tmp_path)
    monkeypatch.setattr(service, "DB_PATH", database)
    monkeypatch.setattr(service, "AUTH_PATH", tmp_path / "auth.json")
    monkeypatch.setattr(service, "SEED_PATH", tmp_path / "missing_seed.json")
    service.init_db()
    with sqlite3.connect(database) as conn:
        migrated = conn.execute("SELECT form_signature, field_fingerprint, profile_key FROM mappings").fetchone()
    assert migrated == ("", "old-field", "basic.email")


def test_untrusted_extension_cannot_confirm_or_claim_another_extensions_pairing_code(client):
    evil = "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
    pending = client.post("/api/pairing/request", headers={"Origin": EXTENSION_ORIGIN}, json={"extension_origin": EXTENSION_ORIGIN})
    code = pending.json()["pairing_code"]
    assert client.post("/api/pairing/confirm", headers={"Origin": evil}, json={"pairing_code": code}).status_code == 403
    assert client.post("/api/pairing/claim", headers={"Origin": evil}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 403
    # 只有本机确认页的无 Origin 请求能确认；随后也只能由原扩展来源领取。
    assert client.post("/api/pairing/confirm", json={"pairing_code": code}).status_code == 200
    assert client.post("/api/pairing/claim", headers={"Origin": evil}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 403
    assert client.post("/api/pairing/claim", headers={"Origin": EXTENSION_ORIGIN}, json={"pairing_code": code, "extension_origin": EXTENSION_ORIGIN}).status_code == 200


def test_unpaired_token_cannot_mutate_feedback_mappings_or_repeatables(client):
    assert client.post("/api/feedback", json={"page_url": "https://x.example", "fingerprint": "x", "profile_key": "basic.email"}).status_code == 401
    assert client.post("/api/mappings/confirm", json={"page_url": "https://x.example", "mappings": []}).status_code == 401
    assert client.get("/api/mappings").status_code == 401
    assert client.delete("/api/mappings", params={"page_url": "https://x.example"}).status_code == 401
    assert client.delete("/api/mappings/1").status_code == 401
    assert client.post("/api/repeatable/plan", json={"kind": "internships", "controls": []}).status_code == 401
    assert client.post("/api/repeatable/choose-option", json={"kind": "internships", "record_key": "company"}).status_code == 401


def test_auth_store_generates_secret_and_invalidates_legacy_token_digests(tmp_path, monkeypatch):
    auth_path = tmp_path / "auth.json"
    auth_path.write_text(json.dumps({"pairs": [{"extension_origin": EXTENSION_ORIGIN, "token_digest": "legacy"}]}), encoding="utf-8")
    monkeypatch.setattr(service, "AUTH_PATH", auth_path)
    service.init_auth_store()
    store = json.loads(auth_path.read_text(encoding="utf-8"))
    assert len(store["service_secret"]) >= 43
    assert store["pairs"] == []
    first_digest = service.token_digest("token-a")
    store["service_secret"] = "replacement-secret"
    auth_path.write_text(json.dumps(store), encoding="utf-8")
    assert first_digest != service.token_digest("token-a")


def test_schema_version_is_recorded_without_overwriting_existing_profile(client):
    headers = pair(client)
    client.put("/api/profile", headers=headers, json={"profile": FAKE_PROFILE})
    service.init_db()
    with sqlite3.connect(service.DB_PATH) as conn:
        version = conn.execute("SELECT value FROM kv WHERE key='schema_version'").fetchone()[0]
    assert int(version) >= 1
    assert client.get("/api/profile", headers=headers).json()["profile"]["basic"]["name_cn"] == "测试同学"
