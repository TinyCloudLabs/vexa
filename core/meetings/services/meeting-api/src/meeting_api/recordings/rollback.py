"""Offline rollback for MIGRATION-0008: fold ``attributed_audio_ranges`` back inline.

The pre-table meeting-api image reads ``meetings.data['attributed_audio_manifest']['ranges']``
straight out of the JSONB — a meeting whose ranges were migrated to (or appended in) the table
would serve a 200 with zero ranges to it, and a base-image completed-artifact deletion cannot
see table rows at all. Pure SQL cannot express the fold faithfully — the union contract
(inline positions kept, same-identity pairs merged to the more-advanced payload, crossed
key/sequence collisions dropped) lives in ``ledger.union_ranges``, so this module runs the
same code the readers and the lazy migration run.

Run it while meeting-api is STOPPED:

    DATABASE_URL=postgresql+asyncpg://… uv run python -m meeting_api.recordings.rollback

Per meeting the fold and the deletion of that meeting's table rows commit in ONE transaction —
a crash mid-run leaves folded meetings visibly complete on the base image, and re-running skips
them entirely (a meeting with no table rows is never touched, so an untouched-legacy manifest
is byte-identical before and after). Meetings the table knows but that carry no manifest header
(a mid-delete crash wrote rows without one) have their rows deleted without touching ``data``;
when every meeting is folded the table itself is dropped, restoring the exact pre-migration
schema. Storage objects are untouched — rolling forward later re-links identical deterministic
keys.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from typing import Optional

log = logging.getLogger("meeting_api.recordings.rollback")


async def rollback_attributed_ranges(session_factory) -> dict:
    """Fold every meeting's table ranges back into ``meetings.data`` and drop the table.

    Idempotent and resumable: a meeting already folded (no table rows) rewrites the same
    union; a fully rolled-back database has no table and returns ``table_present: False``.
    """
    from sqlalchemy import delete, select, text
    from sqlalchemy.orm.attributes import flag_modified

    from ..sessions.models import AttributedAudioRange, Meeting
    from .ledger import report_dropped_union_rows, union_ranges

    stats = {"meetings_folded": 0, "rows_folded": 0, "dropped": 0,
             "orphan_rows_deleted": 0, "table_present": True}

    # Candidate meetings: the header still carries pre-table inline ranges, OR the meeting owns
    # table rows. A meeting with neither is already in base shape — never touched.
    async with session_factory() as db:
        if (await db.execute(text(
                "SELECT to_regclass('attributed_audio_ranges')"))).scalar() is None:
            stats["table_present"] = False
            return stats
        meeting_ids = [
            row[0] for row in (await db.execute(text(
                "SELECT id FROM meetings"
                " WHERE data -> 'attributed_audio_manifest' ? 'ranges'"
                "    OR EXISTS (SELECT 1 FROM attributed_audio_ranges r"
                "               WHERE r.meeting_id = meetings.id)"
            ))).all()
        ]

    for meeting_id in meeting_ids:
        async with session_factory() as db:
            m = (await db.execute(
                select(Meeting)
                .where(Meeting.id == meeting_id)
                .with_for_update()
            )).scalars().first()
            payloads = (
                await db.execute(
                    select(AttributedAudioRange.payload)
                    .where(AttributedAudioRange.meeting_id == meeting_id)
                    .order_by(AttributedAudioRange.id)
                )
            ).scalars().all()
            payloads = [
                json.loads(p) if isinstance(p, str) else p for p in payloads
            ]
            folded = False
            if m is not None:
                data = dict(m.data) if isinstance(m.data, dict) else {}
                header = data.get("attributed_audio_manifest")
                # A meeting with NO table rows is already in base shape — inline ranges or not,
                # it is left byte-identical (the old SQL rollback clobbered these with []).
                if isinstance(header, dict) and payloads:
                    dropped: list = []
                    merged = union_ranges(
                        header.get("ranges") or [], payloads,
                        meeting_id=meeting_id, dropped_out=dropped,
                    )
                    report_dropped_union_rows(
                        dropped, merged, meeting_id=meeting_id,
                        context="attributed-audio rollback",
                    )
                    header = dict(header)
                    header["ranges"] = merged
                    data["attributed_audio_manifest"] = header
                    m.data = data
                    flag_modified(m, "data")
                    stats["meetings_folded"] += 1
                    stats["rows_folded"] += len(payloads)
                    stats["dropped"] += len(dropped)
                    folded = True
            await db.execute(
                delete(AttributedAudioRange).where(
                    AttributedAudioRange.meeting_id == meeting_id
                )
            )
            if not folded:
                stats["orphan_rows_deleted"] += len(payloads)
            await db.commit()

    # Every meeting is folded and row-free — drop the table, restoring the exact pre-migration
    # schema (the pre-table image creates neither table nor rows).
    async with session_factory() as db:
        await db.execute(text("DROP TABLE attributed_audio_ranges"))
        await db.commit()
    return stats


async def _run(database_url: Optional[str] = None) -> dict:
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from ..db import build_engine
    from ..__main__ import _database_url

    engine = build_engine(database_url or _database_url())
    try:
        return await rollback_attributed_ranges(
            async_sessionmaker(engine, expire_on_commit=False)
        )
    finally:
        await engine.dispose()


def main() -> None:
    """CLI entry: ``python -m meeting_api.recordings.rollback`` (DATABASE_URL from env)."""
    logging.basicConfig(level=logging.INFO)
    url = sys.argv[1] if len(sys.argv) > 1 else os.getenv("DATABASE_URL")
    print(json.dumps(asyncio.run(_run(url)), sort_keys=True))


if __name__ == "__main__":
    main()
