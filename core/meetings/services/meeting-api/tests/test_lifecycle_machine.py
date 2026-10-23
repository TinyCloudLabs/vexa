"""O-MTG-1 eval (machine) — feed the lifecycle.v1 goldens through the FSM directly.

Asserts: goldens in legal order → correct transitions + terminal attribution; an illegal
transition (e.g. active→joining) is REJECTED; terminal records carry failure_stage +
completion_reason; a terminal record cannot be re-opened.
"""
from __future__ import annotations

import pytest

from meeting_api.lifecycle import (
    BotStatus,
    CompletionReason,
    FailureStage,
    IllegalTransition,
    LifecycleSink,
    MeetingStore,
    can_transition,
)


# --- the machine itself ----------------------------------------------------------------

def test_legal_edges():
    assert can_transition(None, BotStatus.JOINING)
    assert can_transition(BotStatus.JOINING, BotStatus.AWAITING_ADMISSION)
    assert can_transition(BotStatus.JOINING, BotStatus.ACTIVE)  # no waiting room
    assert can_transition(BotStatus.AWAITING_ADMISSION, BotStatus.ACTIVE)
    assert can_transition(BotStatus.AWAITING_ADMISSION, BotStatus.NEEDS_HELP)
    assert can_transition(BotStatus.NEEDS_HELP, BotStatus.ACTIVE)
    assert can_transition(BotStatus.ACTIVE, BotStatus.COMPLETED)
    assert can_transition(BotStatus.ACTIVE, BotStatus.FAILED)


def test_illegal_edges():
    assert not can_transition(BotStatus.ACTIVE, BotStatus.JOINING)  # the canonical illegal one
    assert not can_transition(BotStatus.COMPLETED, BotStatus.ACTIVE)  # terminal is terminal
    assert not can_transition(BotStatus.FAILED, BotStatus.ACTIVE)
    assert not can_transition(None, BotStatus.ACTIVE)  # first event must be `joining`
    assert not can_transition(BotStatus.JOINING, BotStatus.COMPLETED)  # must pass through active


# --- driving the goldens in legal order ------------------------------------------------

def test_goldens_legal_order(goldens):
    """joining → active → completed(stopped), feeding the actual sealed goldens."""
    sink = LifecycleSink(store=MeetingStore())

    rec = sink.apply(goldens["joining"])
    assert rec.status is BotStatus.JOINING
    assert rec.container_id == "mtg-abc123-bot"  # carried from the golden

    rec = sink.apply(goldens["active"])
    assert rec.status is BotStatus.ACTIVE

    rec = sink.apply(goldens["completed-stopped"])
    assert rec.status is BotStatus.COMPLETED
    assert rec.completion_reason is CompletionReason.STOPPED
    assert rec.is_terminal
    assert rec.history == [BotStatus.JOINING, BotStatus.ACTIVE, BotStatus.COMPLETED]


def test_failed_join_records_stage_and_reason(goldens):
    """joining → failed(awaiting_admission_rejected): the failed-join golden.

    The golden was reached from `joining`; failure_stage is derived SERVER-SIDE from the
    state we were in (JOINING) — NOT trusted from the payload's failure_stage field
    (which says 'awaiting_admission'). Mirrors the parent's FM-003 discipline.
    """
    sink = LifecycleSink(store=MeetingStore())
    sink.apply(goldens["joining"])
    rec = sink.apply(goldens["failed-join"])

    assert rec.status is BotStatus.FAILED
    assert rec.is_terminal
    # Derived from current state (was JOINING), not the payload's "awaiting_admission".
    assert rec.failure_stage is FailureStage.JOINING
    assert rec.completion_reason is CompletionReason.AWAITING_ADMISSION_REJECTED


def test_failed_from_awaiting_admission_stage(goldens):
    """joining → awaiting_admission → failed: failure_stage is AWAITING_ADMISSION."""
    sink = LifecycleSink(store=MeetingStore())
    sink.apply(goldens["joining"])
    sink.apply({"connection_id": "sess-uid", "status": "awaiting_admission"})
    rec = sink.apply(goldens["failed-join"])
    assert rec.failure_stage is FailureStage.AWAITING_ADMISSION


# --- rejecting illegal transitions -----------------------------------------------------

def test_illegal_transition_rejected(goldens):
    """active → joining is rejected (the canonical illegal transition)."""
    sink = LifecycleSink(store=MeetingStore())
    sink.apply(goldens["joining"])
    sink.apply(goldens["active"])

    with pytest.raises(IllegalTransition) as exc:
        sink.apply(goldens["joining"])  # active → joining
    assert exc.value.frm is BotStatus.ACTIVE
    assert exc.value.to is BotStatus.JOINING


def test_terminal_cannot_reopen(goldens):
    """A completed record rejects any further event."""
    sink = LifecycleSink(store=MeetingStore())
    sink.apply(goldens["joining"])
    sink.apply(goldens["active"])
    sink.apply(goldens["completed-stopped"])

    with pytest.raises(IllegalTransition):
        sink.apply(goldens["active"])  # completed → active


def test_first_event_must_be_joining(goldens):
    """A record's first event can only be `joining` — active-first is rejected."""
    sink = LifecycleSink(store=MeetingStore())
    with pytest.raises(IllegalTransition) as exc:
        sink.apply(goldens["active"])  # None → active
    assert exc.value.frm is None
    assert exc.value.to is BotStatus.ACTIVE


# --- joining -> needs_help and the escalation reason -------------------------------------

def test_joining_may_escalate_to_needs_help_but_not_back():
    assert can_transition(BotStatus.JOINING, BotStatus.NEEDS_HELP)
    assert not can_transition(BotStatus.NEEDS_HELP, BotStatus.JOINING)


def test_needs_help_from_joining_is_applied_with_its_reason():
    sink = LifecycleSink(store=MeetingStore())
    sink.apply({"connection_id": "c-esc-1", "status": "joining"})
    rec = sink.apply({
        "connection_id": "c-esc-1",
        "status": "needs_help",
        "escalation_reason": "consent_text",
    })
    assert rec.status is BotStatus.NEEDS_HELP
    assert rec.escalation_reason == "consent_text"
    assert rec.data["escalation_reason"] == "consent_text"


def test_unrecognised_escalation_reason_is_stored_as_unknown():
    sink = LifecycleSink(store=MeetingStore())
    sink.apply({"connection_id": "c-esc-2", "status": "joining"})
    rec = sink.apply({
        "connection_id": "c-esc-2",
        "status": "needs_help",
        "escalation_reason": "free text describing the page",
    })
    assert rec.escalation_reason == "unknown"
    assert rec.data["escalation_reason"] == "unknown"


def test_needs_help_from_joining_fails_as_join_not_admission():
    """joining -> needs_help -> failed, through the real receiver: the join stage is kept.

    A pre-lobby escalation that later fails must not be filed under awaiting_admission, or the
    evidence reads as a host who never admitted the bot (awaiting_admission_timeout -> host_action).
    """
    sink = LifecycleSink(store=MeetingStore())
    sink.apply({"connection_id": "c-attr-1", "status": "joining"})
    sink.apply({"connection_id": "c-attr-1", "status": "needs_help", "escalation_reason": "consent_text"})
    rec = sink.apply({"connection_id": "c-attr-1", "status": "failed", "reason": "escalation_expired"})

    assert rec.status is BotStatus.FAILED
    assert rec.failure_stage is FailureStage.JOINING
    evidence = rec.join_evidence
    assert evidence is not None
    assert evidence["stage"] == "joining"
    assert evidence["reason"] != "awaiting_admission_timeout"
    assert evidence["attribution"] != "host_action"


def test_needs_help_from_awaiting_admission_keeps_admission_stage():
    """joining -> awaiting_admission -> needs_help -> failed keeps AWAITING_ADMISSION."""
    sink = LifecycleSink(store=MeetingStore())
    sink.apply({"connection_id": "c-attr-2", "status": "joining"})
    sink.apply({"connection_id": "c-attr-2", "status": "awaiting_admission"})
    sink.apply({"connection_id": "c-attr-2", "status": "needs_help", "escalation_reason": "modal_dialog"})
    rec = sink.apply({"connection_id": "c-attr-2", "status": "failed", "reason": "escalation_expired"})

    assert rec.failure_stage is FailureStage.AWAITING_ADMISSION
    assert rec.join_evidence is not None
    assert rec.join_evidence["stage"] == "awaiting_admission"
    assert rec.join_evidence["reason"] == "awaiting_admission_timeout"


def _escalate_then_fail_after_restart(conn_id: str, entry: list[str]):
    """Escalate on the live path, persist the record's data, then fail it on a FRESH store.

    The fresh store stands in for a restarted API process: the record is rebuilt only from the
    persisted DB status and `data`, exactly as `rehydrate` is called on the callback path.
    """
    live = LifecycleSink(store=MeetingStore())
    for status in entry:
        live.apply({"connection_id": conn_id, "status": status})
    escalated = live.apply({"connection_id": conn_id, "status": "needs_help", "escalation_reason": "consent_text"})
    persisted = dict(escalated.data)
    expected = live.apply({"connection_id": conn_id, "status": "failed", "reason": "escalation_expired"})

    restarted = MeetingStore()
    restarted.rehydrate(conn_id, "needs_help", persisted)
    rehydrated = LifecycleSink(store=restarted).apply(
        {"connection_id": conn_id, "status": "failed", "reason": "escalation_expired"},
    )
    return expected, rehydrated


def test_rehydrated_needs_help_from_joining_keeps_join_attribution():
    expected, rehydrated = _escalate_then_fail_after_restart("c-rehy-1", ["joining"])

    assert rehydrated.failure_stage is FailureStage.JOINING
    assert rehydrated.failure_stage is expected.failure_stage
    assert rehydrated.join_evidence == expected.join_evidence


def test_rehydrated_needs_help_from_awaiting_admission_keeps_admission_attribution():
    expected, rehydrated = _escalate_then_fail_after_restart("c-rehy-2", ["joining", "awaiting_admission"])

    assert rehydrated.failure_stage is FailureStage.AWAITING_ADMISSION
    assert rehydrated.failure_stage is expected.failure_stage
    assert rehydrated.join_evidence is not None
    assert rehydrated.join_evidence["stage"] == "awaiting_admission"
    assert rehydrated.join_evidence == expected.join_evidence


def test_rehydrated_needs_help_with_empty_trail_falls_back_to_base_admission_stage():
    restarted = MeetingStore()
    restarted.rehydrate("c-rehy-3", "needs_help", {"status_transition": []})
    rehydrated = LifecycleSink(store=restarted).apply(
        {"connection_id": "c-rehy-3", "status": "failed", "reason": "escalation_expired"},
    )

    assert rehydrated.failure_stage is FailureStage.AWAITING_ADMISSION
