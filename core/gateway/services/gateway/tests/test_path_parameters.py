"""Path parameters stay in their declared upstream route through real httpx URL handling."""
from contextlib import asynccontextmanager
from time import perf_counter

import httpx
import pytest

from gateway import create_app
from gateway.adapters import HttpxDownstreamClient
from conftest import VALID_KEY, FakeAuthorizer, FakeRedis


@asynccontextmanager
async def gateway_client(scopes=("bot", "tx")):
    seen = []

    async def upstream(request):
        seen.append((request.method, str(request.url), request.headers.get("x-user-id")))
        return httpx.Response(404, json={"detail": "not found"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as downstream:
        app = create_app(
            FakeAuthorizer(user={"user_id": 7, "scopes": list(scopes), "max_concurrent": 2}),
            HttpxDownstreamClient(downstream), FakeRedis(), agent_api_url="http://agent-api",
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://gateway", headers={"x-api-key": VALID_KEY},
        ) as client:
            yield client, seen


# Exercise every native-key verb/suffix, including the transcripts-to-meetings alias.
NATIVE_ROUTES = [
    ("DELETE", "bots", "", "bots"),
    ("PUT", "bots", "/config", "bots"),
    ("POST", "bots", "/speak", "bots"),
    ("GET", "bots", "/chat", "bots"),
    ("GET", "transcripts", "", "transcripts"),
    ("POST", "transcripts", "/share", "meetings"),
    ("POST", "meetings", "/annotate", "meetings"),
    ("POST", "meetings", "/share", "meetings"),
    ("POST", "meetings", "/workspace", "meetings"),
    ("GET", "meetings", "/participants", "meetings"),
    ("PUT", "meetings", "/intent", "meetings"),
    ("PATCH", "meetings", "", "meetings"),
    ("DELETE", "meetings", "", "meetings"),
]


@pytest.mark.parametrize("method,prefix,suffix,target", NATIVE_ROUTES)
@pytest.mark.parametrize("platform,native", [
    ("google_meet", "daily"),
    ("google_meet", "abc-defg-hij"),
    ("google_meet", "TeamNick_1-x"),
    ("google%3Flabel%3D1", "daily%23note"),
    ("google_meet", "room%2520name"),
])
async def test_native_route_preserves_exact_upstream_address(method, prefix, suffix, target, platform, native):
    async with gateway_client() as (client, seen):
        response = await client.request(method, f"/{prefix}/{platform}/{native}{suffix}")
        assert response.status_code == 404
        assert seen == [(method, f"http://meeting-api/{target}/{platform}/{native}{suffix}", "7")]


@pytest.mark.parametrize("method,path,target", [
    ("PATCH", "/user/calendars/work%3Flabel%3D1", "http://admin-api/user/calendars/work%3Flabel%3D1"),
    ("DELETE", "/user/calendars/work%23note", "http://admin-api/user/calendars/work%23note"),
    ("GET", "/user/calendars/work%23note/sync", "http://meeting-api/user/calendars/work%23note/sync"),
    ("POST", "/user/calendars/work%3Flabel%3D1/sync", "http://meeting-api/user/calendars/work%3Flabel%3D1/sync"),
    ("GET", "/agent/sessions/a%3Flabel%3D1/messages", "http://agent-api/api/sessions/a%3Flabel%3D1/messages"),
    ("POST", "/agent/sessions/a%23note/messages", "http://agent-api/api/sessions/a%23note/messages"),
    ("GET", "/mcp/session/a%3Flabel%3D1", "http://mcp:8010/mcp/session/a%3Flabel%3D1"),
    ("POST", "/mcp/session/a%23note", "http://mcp:8010/mcp/session/a%23note"),
    ("GET", "/recordings/12/media/3/download", "http://meeting-api/recordings/12/media/3/raw"),
    ("GET", "/meetings/12/attributed-audio/ranges/3", "http://meeting-api/meetings/12/attributed-audio/ranges/3"),
])
async def test_other_parameter_routes_preserve_exact_upstream_address(method, path, target):
    async with gateway_client() as (client, seen):
        response = await client.request(method, path)
        assert response.status_code == 404
        assert seen == [(method, target, "7")]


@pytest.mark.parametrize("value", [
    "%2E", "%2E%2E", "%252E%252E", "%25252E%25252E",
    "%5C", "%255C", "%252F", "%2525252F", "%00", "%0A",
])
@pytest.mark.parametrize("method,template", [
    ("GET", "/transcripts/{value}/daily"),
    ("DELETE", "/bots/google_meet/{value}"),
    ("PATCH", "/user/calendars/{value}"),
    ("GET", "/agent/sessions/{value}/messages"),
    ("POST", "/agent/sessions/{value}/messages"),
    ("GET", "/mcp/session/{value}"),
    ("POST", "/mcp/session/{value}"),
])
async def test_invalid_segments_never_open_an_upstream_request(method, template, value):
    async with gateway_client() as (client, seen):
        response = await client.request(method, template.format(value=value))
        # Starlette does not match a newline inside an agent catch-all tail.
        expected = 404 if value == "%0A" and template.startswith("/agent/") else 400
        assert response.status_code == expected, response.text
        assert seen == []


@pytest.mark.parametrize("prefix", ["agent/sessions", "mcp/session"])
@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("segment", ["a%2Fb", "a%252Fb", "a%5Cb"])
async def test_multi_segment_routes_refuse_encoded_separators(prefix, method, segment):
    async with gateway_client() as (client, seen):
        response = await client.request(method, f"/{prefix}/{segment}")
        assert response.status_code == 400
        assert seen == []


@pytest.mark.parametrize("path", [
    "/bots/google_meet/lookup/daily", "/bots/google_meet/lookup%2Fdaily",
    "/bots/google_meet/%2E%2E/%2E%2E/meetings/12",
    "/transcripts/google_meet/%2E%2E/%2E%2E/bots/status",
])
async def test_single_segment_native_routes_remain_404_for_extra_segments(path):
    async with gateway_client() as (client, seen):
        response = await client.request("DELETE" if path.startswith("/bots") else "GET", path)
        assert response.status_code == 404
        assert seen == []


@pytest.mark.parametrize("scopes,method,path", [
    (("bot",), "DELETE", "/meetings/12"),
    (("tx",), "GET", "/bots/status"),
    (("tx",), "DELETE", "/bots/google_meet/daily"),
])
async def test_scope_refusals_do_not_forward(scopes, method, path):
    async with gateway_client(scopes) as (client, seen):
        response = await client.request(method, path)
        assert response.status_code == 403
        assert seen == []


@pytest.mark.parametrize("path", ["/agent/session%0A", "/agent/sessions/name%0A"])
async def test_agent_trailing_newline_is_refused_before_forwarding(path):
    async with gateway_client() as (client, seen):
        response = await client.get(path)
        assert response.status_code == 400
        assert seen == []


@pytest.mark.parametrize("prefix", ["/bots/google_meet/", "/agent/", "/mcp/"])
async def test_deep_encoding_is_bounded_before_authentication(prefix):
    async with gateway_client() as (client, seen):
        client.headers.clear()
        deeply_encoded = "%" + "25" * 15000
        started = perf_counter()
        response = await client.request("DELETE", prefix + deeply_encoded)
        elapsed = perf_counter() - started
        assert response.status_code == 400
        assert seen == []
        # Generous relative to ordinary local request latency; catches unbounded decoding.
        assert elapsed < 1.0, f"parameter refusal took {elapsed:.3f}s"
