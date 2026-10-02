"""TC-583 — meeting-api guarantees ``attributed_audio_ranges`` at startup.

Meeting-api and admin-api deploy independently (ptx-dev runs the fork's meeting-api image with
the upstream ``v012`` admin-api image, whose ``ensure_schema`` predates TC-583), and meeting-api
historically ran no DDL at boot — so the attributed write path would 500 on a missing table in
exactly that topology. The lifespan now runs ``ensure_attributed_audio_schema(engine)`` BEFORE
the background loops start and before the app serves: a failed DDL propagates and fails startup
loudly; ``engine=None`` (Lite / fake wiring) skips it.

These tests drive the REAL ``_attach_background_loops`` lifespan (over fakes) — the same shape as
``test_main_ensure_fts_index_wiring.py`` — so a regression that drops the call or swallows its
failure goes red without any Postgres.
"""
from __future__ import annotations

import asyncio
import types

import pytest

import meeting_api.__main__ as main_mod
import meeting_api.recordings.adapters as recordings_adapters


class _FakeRedis:
    async def publish(self, channel, message):
        return None


def _fake_app():
    app = types.SimpleNamespace()
    app.state = types.SimpleNamespace()
    app.router = types.SimpleNamespace()
    return app


def _attach(app, *, engine):
    main_mod._attach_background_loops(
        app,
        transcript_store=types.SimpleNamespace(),
        segment_bus=types.SimpleNamespace(),
        redis_client=_FakeRedis(),
        meeting_repo=None,
        runtime=None,
        service_authority=None,
        system_webhook_sink=None,
        session_factory=None,
        storage=None,
        engine=engine,
    )


async def test_lifespan_runs_attributed_schema_convergence(monkeypatch):
    """The real lifespan invokes the DDL with the engine it was given, before any loop starts."""
    calls = []
    fake_engine = object()

    async def _spy(engine):
        calls.append(engine)

    monkeypatch.setattr(recordings_adapters, "ensure_attributed_audio_schema", _spy)
    app = _fake_app()
    _attach(app, engine=fake_engine)

    async with app.router.lifespan_context(app):
        await asyncio.sleep(0.02)

    assert calls == [fake_engine], "ensure_attributed_audio_schema was never called — the lifespan is not wired"


async def test_lifespan_fails_loudly_when_schema_convergence_fails(monkeypatch):
    """A failed DDL must abort startup: serving would 500 every attributed write on a missing table."""
    async def _boom(engine):
        raise RuntimeError("attributed_audio_ranges DDL failed")

    monkeypatch.setattr(recordings_adapters, "ensure_attributed_audio_schema", _boom)
    app = _fake_app()
    _attach(app, engine=object())

    with pytest.raises(RuntimeError, match="attributed_audio_ranges DDL failed"):
        async with app.router.lifespan_context(app):
            pass


async def test_lifespan_skips_schema_convergence_without_an_engine(monkeypatch):
    """engine=None is the Lite/fake path — no DDL, no crash."""
    calls = []

    async def _spy(engine):
        calls.append(engine)

    monkeypatch.setattr(recordings_adapters, "ensure_attributed_audio_schema", _spy)
    app = _fake_app()
    _attach(app, engine=None)

    async with app.router.lifespan_context(app):
        await asyncio.sleep(0.02)

    assert calls == []
