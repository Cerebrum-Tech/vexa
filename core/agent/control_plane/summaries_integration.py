"""The summaries integration — a service-to-service read of one user's meeting reports.

An integrating system (not a signed-in user) names an account by email and presents the deployment's
fixed summaries key; agent-api answers with that account's completed meeting reports. The key check
lives in the route; this module holds the two upstream lookups and the walk that turns a user's meeting
list into report rows. Both lookups are injectable so the route is driven over fakes in tests.

- ``user_by_email(email) -> dict | None`` — admin-api ``GET /internal/users/by-email/{email}`` over the
  X-Internal-Secret edge: ``{"user_id", "email", "name"}``, or None for an unknown account.
- ``meeting_page(user_id, limit, offset) -> list[dict]`` — meeting-api ``GET /meetings`` with the
  account's ``X-User-Id``: newest first by ``created_at``, owned and shared-with rows alike.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Callable, Optional

PAGE_SIZE = 100
MAX_PAGES = 50  # a 5000-meeting walk bounds one request; `limit` normally ends it far sooner

_SUMMARY_SECTION = re.compile(r"^## Özet[^\S\r\n]*\r?\n(.*?)(?=^## |\Z)", re.M | re.S)
_FIRST_HEADING = re.compile(r"^## ", re.M)


class UpstreamError(RuntimeError):
    """An upstream the integration depends on is unreachable or answered unexpectedly."""


def http_user_by_email(admin_api_url: str, internal_secret: str) -> Callable[[str], Optional[dict]]:
    base = (admin_api_url or "").rstrip("/")

    def _lookup(email: str) -> Optional[dict]:
        if not base or not internal_secret:
            raise UpstreamError("admin-api internal edge is not configured")
        req = urllib.request.Request(
            f"{base}/internal/users/by-email/{urllib.parse.quote(email, safe='')}",
            headers={"X-Internal-Secret": internal_secret})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return json.loads(resp.read().decode() or "null")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise UpstreamError(f"admin-api answered {e.code}") from e
        except Exception as e:  # noqa: BLE001 — transport failure is typed, never read as "no such user"
            raise UpstreamError(f"admin-api unreachable: {type(e).__name__}") from e

    return _lookup


def http_meeting_page(meeting_api_url: str) -> Callable[[str, int, int], list]:
    base = (meeting_api_url or "").rstrip("/")

    def _page(user_id: str, limit: int, offset: int) -> list:
        query = urllib.parse.urlencode({"limit": limit, "offset": offset, "exclude_planned": "true"})
        req = urllib.request.Request(f"{base}/meetings?{query}", headers={"X-User-Id": str(user_id)})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raise UpstreamError(f"meeting-api answered {e.code}") from e
        except Exception as e:  # noqa: BLE001
            raise UpstreamError(f"meeting-api unreachable: {type(e).__name__}") from e
        meetings = body.get("meetings") if isinstance(body, dict) else None
        return meetings if isinstance(meetings, list) else []

    return _page


def parse_instant(value: object) -> Optional[datetime]:
    """An ISO-8601 date or datetime as an aware UTC instant; a naive value is read as UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment.replace(tzinfo=timezone.utc) if moment.tzinfo is None else moment.astimezone(timezone.utc)


def summary_text(body: str) -> str:
    """The report's summary paragraph: the `## Özet` section of a Turkish report, else the prose
    before the first `##` heading (an English report opens with its summary, unheaded)."""
    section = _SUMMARY_SECTION.search(body)
    if section:
        return section.group(1).strip()
    first = _FIRST_HEADING.search(body)
    return (body[:first.start()] if first else body).strip()


def collect_summaries(
    user_id: str,
    *,
    meeting_page: Callable[[str, int, int], list],
    read_report: Callable[[dict], Optional[dict]],
    since: Optional[datetime],
    until: Optional[datetime],
    limit: int,
) -> list[dict]:
    """Walk the user's meetings newest first and keep the ones with a completed report whose meeting
    time (start, else creation) falls in ``[since, until)``, up to ``limit`` rows.

    The list is ordered by ``created_at`` and a meeting starts no earlier than its row is created, so
    once a whole page was created before ``since`` no later page can match and the walk stops."""
    rows: list[dict] = []
    for page_no in range(MAX_PAGES):
        page = meeting_page(user_id, PAGE_SIZE, page_no * PAGE_SIZE)
        for meeting in page:
            when = parse_instant(meeting.get("start_time")) or parse_instant(meeting.get("created_at"))
            if since and (when is None or when < since):
                continue
            if until and (when is None or when >= until):
                continue
            report = read_report(meeting)
            if report is None:
                continue
            rows.append(report)
            if len(rows) >= limit:
                return rows
        if len(page) < PAGE_SIZE:
            break
        if since:
            created = [parse_instant(m.get("created_at")) for m in page]
            if all(c is not None and c < since for c in created):
                break
    return rows
