"""Speaker evidence uses the same authenticated, scoped recording proxy as audio."""
import pytest
from fastapi.testclient import TestClient
from gateway import create_app
from conftest import VALID_KEY, FakeAuthorizer, FakeDownstream, FakeRedis


@pytest.mark.parametrize("status", [200, 404, 422])
def test_timeline_proxy_preserves_body_status_and_authoritative_identity(status):
    body = {"version": 1, "recording_id": 12, "intervals": []} if status == 200 else {"detail": "unavailable"}
    downstream = FakeDownstream(status_code=status, body=body)
    client = TestClient(create_app(FakeAuthorizer(), downstream, FakeRedis()))
    response = client.get("/recordings/12/speaker-timeline", headers={"x-api-key": VALID_KEY, "x-user-id": "999"})
    assert response.status_code == status
    assert response.json() == body
    assert downstream.last["url"].endswith("/recordings/12/speaker-timeline")
    assert {k.lower(): v for k, v in downstream.last["headers"].items()}["x-user-id"] == "7"


def test_timeline_proxy_rejects_missing_key_and_insufficient_scope():
    downstream = FakeDownstream()
    client = TestClient(create_app(FakeAuthorizer(user={"user_id": 7, "scopes": ["browser"]}), downstream, FakeRedis()))
    assert client.get("/recordings/12/speaker-timeline").status_code == 401
    assert client.get("/recordings/12/speaker-timeline", headers={"x-api-key": VALID_KEY}).status_code == 403
    assert downstream.last is None
