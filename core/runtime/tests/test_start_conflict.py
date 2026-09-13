"""DockerBackend.start name-conflict path (409) — fake socket, no daemon.

Under kernel-level idempotent create (ADR 0027) a RUNNING workload is touched before the backend is
ever reached, so a 409 here means a STALE (exited / crashed-runtime) container squatting on the
deterministic name. The contract of this branch: force-remove the stale container, re-create, start.
This was the force-delete that killed live copilots when dispatch reached it for a running workload —
pinned here so the branch keeps its (now safe) replace semantics and finally has fake-backed coverage.
"""
from __future__ import annotations

import json
import pytest
from urllib.parse import unquote, urlparse

from runtime_kernel.docker_backend import DockerBackend
from runtime_kernel.profiles import Runnable


class _Resp:
    def __init__(self, status_code: int, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class _ConflictThenCreateSession:
    """First create → 409 (name taken by a stale container); expects a force DELETE, then a clean
    create + start. Records the call sequence for the assertion."""

    def __init__(self, inspect=None, inspect_status=200) -> None:
        self.inspect = inspect if inspect is not None else {
            "Id": "stale-id", "State": {"Running": False, "Status": "exited"},
            "Config": {"Labels": {"runtime.managed": "true", "runtime.workload_id": "w9"}},
            "HostConfig": {"NetworkMode": "test-network"},
        }
        self.inspect_status = inspect_status
        self.calls: list[str] = []
        self._conflicted = False

    def request(self, method: str, url: str, **kw):
        parsed = urlparse(url)
        path = unquote(parsed.path)
        path = path[path.index("/containers"):] if "/containers" in path else path
        q = f"?{parsed.query}" if parsed.query else ""
        self.calls.append(f"{method} {path}{q}")
        if method == "POST" and path == "/containers/create":
            if not self._conflicted:
                self._conflicted = True
                return _Resp(409, {"message": "Conflict. The container name is already in use"})
            return _Resp(201, {"Id": "cid-123"})
        if method == "GET" and path.endswith("/json"):
            return _Resp(self.inspect_status, self.inspect)
        if method == "DELETE" and path.startswith("/containers/"):
            return _Resp(204)
        if method == "POST" and path.endswith("/start"):
            return _Resp(204)
        return _Resp(500, {"message": f"unhandled {method} {path}"})


def test_start_replaces_stale_named_container_on_409(monkeypatch):
    monkeypatch.setenv("DOCKER_NETWORK", "test-network")
    be = DockerBackend()
    fake = _ConflictThenCreateSession()
    be._session = fake  # inject the fake socket

    h = be.start("w9", Runnable(image="alpine", command=["true"]), env={})

    assert h.id == "w9" and h._impl == "vexa-w9"
    assert fake.calls == [
        "POST /containers/create?name=vexa-w9",       # taken by a stale container → 409
        "GET /containers/vexa-w9/json",
        "DELETE /containers/stale-id?force=true",     # reclaim only the inspected stale container
        "POST /containers/create?name=vexa-w9",       # clean re-create
        "POST /containers/cid-123/start",
    ]


@pytest.mark.parametrize("kind", ["foreign-network", "foreign-owner", "live", "inspect-failed"])
def test_start_never_deletes_foreign_or_live_name_conflicts(monkeypatch, kind):
    monkeypatch.setenv("DOCKER_NETWORK", "test-network")
    fake = _ConflictThenCreateSession()
    if kind == "foreign-network":
        fake.inspect["HostConfig"]["NetworkMode"] = "vexa-v012_vexa"
    elif kind == "foreign-owner":
        fake.inspect["Config"]["Labels"]["runtime.workload_id"] = "another-workload"
    elif kind == "live":
        fake.inspect["State"] = {"Running": True, "Status": "running"}
    else:
        fake.inspect_status = 404
    backend = DockerBackend()
    backend._session = fake
    with pytest.raises(RuntimeError, match="refusing to replace"):
        backend.start("w9", Runnable(image="alpine", command=["true"]), env={})
    assert not any(call.startswith("DELETE ") for call in fake.calls)
    assert len([call for call in fake.calls if call.startswith("POST /containers/create")]) == 1
