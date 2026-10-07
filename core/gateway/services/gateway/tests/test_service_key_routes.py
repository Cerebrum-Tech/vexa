"""Service-key routes — an integrating system calls with a deployment key, not a user's API key.

GET /integrations/summaries forwards to agent-api's /api/integrations/summaries without resolving
any user: only its X-Summary-Api-Key, the query and the trace id travel downstream, so a caller can
never smuggle an identity header through it. agent-api owns the key check.
"""
from fastapi.testclient import TestClient

from gateway import SERVICE_KEY_ROUTES, create_app, undeclared_routes
from conftest import FakeAuthorizer, FakeDownstream, FakeRedis


def _client(downstream=None, authorizer=None):
    downstream = downstream or FakeDownstream(status_code=200, body={"count": 0, "summaries": []})
    authorizer = authorizer or FakeAuthorizer()
    app = create_app(authorizer, downstream, FakeRedis(), agent_api_url="http://agent-api")
    return TestClient(app), downstream


def test_forwards_the_key_and_query_to_agent_api():
    client, downstream = _client()
    r = client.get("/integrations/summaries?email=ayse@innova.com.tr&limit=5",
                   headers={"X-Summary-Api-Key": "k"})
    assert r.status_code == 200 and r.json() == {"count": 0, "summaries": []}
    assert downstream.last["method"] == "GET"
    assert downstream.last["url"] == "http://agent-api/api/integrations/summaries"
    assert downstream.last["params"] == {"email": "ayse@innova.com.tr", "limit": "5"}
    assert downstream.last["headers"]["x-summary-api-key"] == "k"


def test_no_identity_header_reaches_the_downstream():
    """A caller-sent X-User-Id / X-Api-Key must not ride along: agent-api would trust the first."""
    client, downstream = _client()
    client.get("/integrations/summaries?email=a@b.c", headers={
        "X-Summary-Api-Key": "k", "X-User-Id": "1", "X-User-Email": "admin@x", "X-Api-Key": "user-key",
        "X-Internal-Secret": "s"})
    sent = {k.lower() for k in downstream.last["headers"]}
    assert sent.isdisjoint({"x-user-id", "x-user-email", "x-api-key", "x-internal-secret"})


def test_no_user_key_is_resolved():
    """The route never asks the authorizer anything — it does not depend on a user key existing."""
    class Refusing(FakeAuthorizer):
        async def resolve(self, api_key):  # pragma: no cover - must not be called
            raise AssertionError("service-key route resolved a user key")

    client, downstream = _client(authorizer=Refusing())
    r = client.get("/integrations/summaries?email=a@b.c", headers={"X-Summary-Api-Key": "k"})
    assert r.status_code == 200 and downstream.last is not None


def test_downstream_status_is_carried_verbatim():
    client, _ = _client(FakeDownstream(status_code=401, body={"detail": "invalid or missing X-Summary-Api-Key"}))
    r = client.get("/integrations/summaries?email=a@b.c")
    assert r.status_code == 401


def test_the_route_is_declared():
    assert ("GET", "/integrations/summaries") in SERVICE_KEY_ROUTES
    app = create_app(FakeAuthorizer(), FakeDownstream(), FakeRedis())
    assert undeclared_routes(app) == []
