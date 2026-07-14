"""Dialogue-mode roundtables — a standing group channel alongside the decision
table. The contract under test:
  * config: mode defaults to 'decision' (old blobs unchanged); 'dialogue' parses;
    garbage falls back to 'decision'
  * prompts: a dialogue turn's framing must NEVER mention the consensus protocol
    (the token or the convergence instruction) — a decision turn must carry it
  * loop: a participant echoing [CONSENSUS] must NOT end a dialogue batch (it
    still ends a decision batch), so a dialogue channel can never self-adjourn
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("AGENTOS_DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("AGENTOS_TOKEN", "test")

import agentos.roundtable as RT  # noqa: E402
from agentos.schemas import RoundtableConfig  # noqa: E402


def _participants():
    return [
        {"agent_key": "profile:a", "name": "EchoBot", "color": "#ff0000", "persona": ""},
        {"agent_key": "profile:b", "name": "ReplyBot", "color": "#00ff00", "persona": ""},
    ]


def test_parse_config_mode():
    assert RT._parse_config({"participants": [], "rounds": 2})["mode"] == "decision", "absent mode must stay decision (old blobs)"
    assert RT._parse_config({"mode": "dialogue"})["mode"] == "dialogue"
    assert RT._parse_config({"mode": "DIALOGUE"})["mode"] == "dialogue", "case-tolerant like the rest of the parser"
    assert RT._parse_config({"mode": "banana"})["mode"] == "decision", "unknown mode falls back to decision"
    assert RT._parse_config('{"mode": "dialogue", "rounds": 1}')["mode"] == "dialogue", "persisted JSON-string column"


def test_schema_accepts_mode():
    assert RoundtableConfig().mode == "decision"
    assert RoundtableConfig(mode="dialogue").mode == "dialogue"
    try:
        RoundtableConfig(mode="forever")
        raise AssertionError("unknown mode must be rejected by the schema")
    except ValueError:
        pass


def test_dialogue_prompt_omits_consensus_protocol():
    parts = _participants()
    dialogue = RT._system_for(parts[0], parts, "dialogue")
    decision = RT._system_for(parts[0], parts, "decision")
    assert RT.CONSENSUS_TOKEN not in dialogue, "a dialogue turn must never learn the consensus token"
    assert "consensus" not in dialogue.lower(), "no convergence instruction in dialogue framing"
    assert RT.CONSENSUS_TOKEN in decision, "decision framing keeps the protocol"
    assert "ReplyBot" in dialogue, "the others are still introduced by name"
    # persona still leads the framing in both modes
    parts[0]["persona"] = "You are a grizzled prospector."
    assert RT._system_for(parts[0], parts, "dialogue").startswith("You are a grizzled prospector.")


def test_dialogue_batch_ignores_consensus_token():
    """One participant echoes [CONSENSUS] every turn: a decision batch ends at once,
    a dialogue batch runs every round of every seat and reports no consensus."""
    parts = _participants()
    turns: list[str] = []

    async def fake_turn(p, participants, transcript, mode="decision"):
        turns.append(p["name"])
        return f"I think we agree. {RT.CONSENSUS_TOKEN}\nShip it.", True

    class _Bus:
        async def emit_task_event(self, *a, **k):
            return None

    class _Runner:
        task_id = "t-dialogue"

        async def _should_stop(self):
            return False

    real_turn, real_bus = RT._one_turn, RT.bus
    RT._one_turn, RT.bus = fake_turn, _Bus()
    try:
        ended = asyncio.run(RT._run_batch(_Runner(), parts, [], 2, "decision"))
        assert ended is True, "decision mode must still adjourn on the token"
        assert len(turns) == 1, "decision batch ends on the first consensus turn"

        turns.clear()
        ended = asyncio.run(RT._run_batch(_Runner(), parts, [], 2, "dialogue"))
        assert ended is False, "a dialogue batch must never report consensus"
        assert len(turns) == 4, f"all 2 rounds x 2 seats must run (got {len(turns)})"
    finally:
        RT._one_turn, RT.bus = real_turn, real_bus


TESTS = [
    test_parse_config_mode,
    test_schema_accepts_mode,
    test_dialogue_prompt_omits_consensus_protocol,
    test_dialogue_batch_ignores_consensus_token,
]


def main():
    fails = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS ", fn.__name__)
        except AssertionError as e:
            fails += 1
            print("FAIL ", fn.__name__, "->", e)
    print("all pass" if not fails else f"{fails} FAILED")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
