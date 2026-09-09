"""validate_ics_url — what a person pastes vs what the poller can fetch.

Outlook and Apple publish the feed as webcal://; it is the same https resource, so it is
accepted and stored fetchable. Anything else that is not http(s) is refused with a message that
names where the right link lives — the message is what the terminal shows verbatim.
"""
import pytest
from fastapi import HTTPException

from admin_api.app.calendars import validate_ics_url

OUTLOOK = "outlook.office365.com/owa/calendar/abc/def/calendar.ics"


def test_webcal_is_stored_as_https():
    assert validate_ics_url(f"webcal://{OUTLOOK}") == f"https://{OUTLOOK}"
    assert validate_ics_url(f"WEBCAL://{OUTLOOK}") == f"https://{OUTLOOK}"
    assert validate_ics_url(f"webcals://{OUTLOOK}") == f"https://{OUTLOOK}"


def test_https_passes_through_untouched():
    assert validate_ics_url(f"  https://{OUTLOOK} ") == f"https://{OUTLOOK}"


@pytest.mark.parametrize("bad", ["mecelik@innova.com.tr", "calendar.ics", "ftp://x/y.ics", "webcal://"])
def test_not_a_feed_url_is_refused_with_directions(bad):
    with pytest.raises(HTTPException) as e:
        validate_ics_url(bad)
    assert e.value.status_code == 422
    assert "Outlook" in e.value.detail and "webcal" in e.value.detail
