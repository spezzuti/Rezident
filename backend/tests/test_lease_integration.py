"""Integration test for the dispatcher lease across TWO real server processes.

Spawns two uvicorn servers sharing one temp data dir (shared SQLite DB) and the
zero-cost NoopRunner (AGENTOS_TEST_NOOP_RUNNER=1 — no Claude, no money), then
proves the single-dispatcher invariant end to end:

  (i)   a POSTed task runs on exactly the lease holder
  (ii)  killing the holder → the survivor takes over within ~TTL and runs the
        next task
  (iii) killing the holder MID-RUN (run > TTL) → the task ends 'failed' by the
        orphan sweep, is never double-run by the survivor, and a later task still
        completes on the survivor

Gated behind RUN_LEASE_INTEGRATION=1 (spawns processes, binds ports). Run with:

    RUN_LEASE_INTEGRATION=1 backend/.venv/Scripts/python.exe backend/tests/test_lease_integration.py

Never touches the live :8734 server or its data dir — its own temp dir + ports.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
PYEXE = sys.executable  # the venv python this script runs under
TOKEN = "lease-integration-test-token"
TTL = 4
PORT_A, PORT_B = 8791, 8792


# ---- tiny HTTP client --------------------------------------------------------

def _req(method: str, url: str, body: dict | None = None, token: str | None = None, timeout: float = 5.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return None, None


def health(port: int) -> bool:
    s, _ = _req("GET", f"http://127.0.0.1:{port}/api/health", timeout=2)
    return s == 200


def readiness(port: int) -> dict | None:
    s, d = _req("GET", f"http://127.0.0.1:{port}/api/readiness", timeout=3)
    return d if s == 200 else None


def dispatcher(port: int) -> dict | None:
    r = readiness(port)
    return r.get("dispatcher") if r else None


def post_task(port: int, title: str) -> str:
    s, d = _req("POST", f"http://127.0.0.1:{port}/api/tasks",
                {"title": title, "prompt": "noop"}, token=TOKEN, timeout=5)
    assert s == 201 and d, f"create task failed: status={s}"
    return d["id"]


def get_task(port: int, tid: str) -> dict:
    s, d = _req("GET", f"http://127.0.0.1:{port}/api/tasks/{tid}", token=TOKEN, timeout=5)
    assert s == 200 and d, f"get task failed: status={s}"
    return d


# ---- process management ------------------------------------------------------

def _spawn(port: int, data_dir: str, run_seconds: float, logf) -> subprocess.Popen:
    env = dict(os.environ)
    env.update(
        AGENTOS_DATA_DIR=data_dir,
        AGENTOS_TOKEN=TOKEN,
        AGENTOS_DISPATCH_LEASE_TTL_SECONDS=str(TTL),
        AGENTOS_MAX_CONCURRENT="1",
        AGENTOS_TEST_NOOP_RUNNER="1",
        AGENTOS_TEST_RUN_SECONDS=str(run_seconds),
    )
    return subprocess.Popen(
        [PYEXE, "-m", "uvicorn", "agentos.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(BACKEND), env=env, stdout=logf, stderr=subprocess.STDOUT,
    )


def _wait_health(port: int, timeout: float = 25.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if health(port):
            return
        time.sleep(0.3)
    raise AssertionError(f"server on {port} never became healthy")


def _wait(cond, timeout: float, what: str):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = cond()
        if last:
            return last
        time.sleep(0.3)
    raise AssertionError(f"timed out waiting for {what} (last={last})")


def _kill(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass


def _find_holder(procs: dict[int, subprocess.Popen]):
    """Return (holder_port, holder_pid) — the instance whose dispatcher.held is True."""
    def probe():
        for port in procs:
            d = dispatcher(port)
            if d and d["held"]:
                return port, d["holder_pid"]
        return None
    port, pid = _wait(probe, TTL + 6, "a lease holder to emerge")
    return port, pid


def _result_pid(summary: str | None) -> int | None:
    if not summary or "pid=" not in summary:
        return None
    return int(summary.split("pid=")[1].split()[0])


# ---- the scenarios -----------------------------------------------------------

def scenario_holder_runs_and_takeover() -> None:
    """(i) task runs on the holder; (ii) kill holder → survivor takes over + runs."""
    data_dir = tempfile.mkdtemp(prefix="lease-it-")
    logs = open(os.path.join(data_dir, "servers.log"), "w")
    procs: dict[int, subprocess.Popen] = {}
    try:
        procs[PORT_A] = _spawn(PORT_A, data_dir, 0.3, logs)
        _wait_health(PORT_A)  # A migrates the DB + grabs the lease first
        procs[PORT_B] = _spawn(PORT_B, data_dir, 0.3, logs)
        _wait_health(PORT_B)

        holder_port, holder_pid = _find_holder(procs)
        # exactly one holder
        held = [p for p in procs if (dispatcher(p) or {}).get("held")]
        assert held == [holder_port], f"exactly one holder expected, got {held}"

        # (i) POST to the holder → it runs, stamped with the holder's pid
        tid = post_task(holder_port, "it-i")
        done = _wait(lambda: (get_task(holder_port, tid)["status"] in ("done", "failed") and get_task(holder_port, tid)) or None,
                     15, "task i to finish")
        assert done["status"] == "done", f"task i status={done['status']}"
        assert _result_pid(done["result_summary"]) == holder_pid, \
            f"task ran on {_result_pid(done['result_summary'])}, holder is {holder_pid}"

        # (ii) kill the holder → survivor seizes the lease within ~TTL and runs next
        survivor_port = PORT_B if holder_port == PORT_A else PORT_A
        _kill(procs[holder_port])
        d = _wait(lambda: (dispatcher(survivor_port) or {}).get("held") and dispatcher(survivor_port),
                  TTL + 6, "survivor to take over")
        survivor_pid = d["holder_pid"]
        tid2 = post_task(survivor_port, "it-ii")
        done2 = _wait(lambda: (get_task(survivor_port, tid2)["status"] in ("done", "failed") and get_task(survivor_port, tid2)) or None,
                      15, "task ii to finish")
        assert done2["status"] == "done", f"task ii status={done2['status']}"
        assert _result_pid(done2["result_summary"]) == survivor_pid, \
            f"task ii ran on {_result_pid(done2['result_summary'])}, survivor is {survivor_pid}"
        print(f"  holder_pid={holder_pid} survivor_pid={survivor_pid}")
        print(f"  live readiness dispatcher payload: {json.dumps(dispatcher(survivor_port))}")
    finally:
        for p in procs.values():
            _kill(p)
        logs.close()
        shutil.rmtree(data_dir, ignore_errors=True)


def scenario_orphan_sweep_no_double_run() -> None:
    """(iii) kill holder mid-run (run > TTL) → task fails via orphan sweep, is never
    stamped by the survivor, and a later task still completes on the survivor."""
    data_dir = tempfile.mkdtemp(prefix="lease-it-")
    logs = open(os.path.join(data_dir, "servers.log"), "w")
    procs: dict[int, subprocess.Popen] = {}
    try:
        procs[PORT_A] = _spawn(PORT_A, data_dir, 8.0, logs)  # 8s run > 4s TTL
        _wait_health(PORT_A)
        procs[PORT_B] = _spawn(PORT_B, data_dir, 8.0, logs)
        _wait_health(PORT_B)

        holder_port, holder_pid = _find_holder(procs)
        survivor_port = PORT_B if holder_port == PORT_A else PORT_A

        tid = post_task(holder_port, "it-iii")
        # wait until the holder actually starts running it, then kill mid-run
        _wait(lambda: get_task(holder_port, tid)["status"] == "running", 10, "task iii to start running")
        _kill(procs[holder_port])

        # survivor takes over and the orphan sweep fails the abandoned task
        final = _wait(lambda: (get_task(survivor_port, tid)["status"] in ("failed", "done") and get_task(survivor_port, tid)) or None,
                      TTL + 12, "orphaned task iii to be swept")
        assert final["status"] == "failed", f"orphaned task must fail, got {final['status']}"
        assert _result_pid(final["result_summary"]) is None, \
            f"orphaned task must NOT be stamped by the survivor: {final['result_summary']!r}"

        # a subsequent task still completes on the survivor
        d = _wait(lambda: (dispatcher(survivor_port) or {}).get("held") and dispatcher(survivor_port),
                  TTL + 6, "survivor to hold the lease")
        survivor_pid = d["holder_pid"]
        tid2 = post_task(survivor_port, "it-iii-next")
        done2 = _wait(lambda: (get_task(survivor_port, tid2)["status"] in ("done", "failed") and get_task(survivor_port, tid2)) or None,
                      20, "post-sweep task to finish")
        assert done2["status"] == "done", f"post-sweep task status={done2['status']}"
        assert _result_pid(done2["result_summary"]) == survivor_pid, "post-sweep task must run on the survivor"
        print(f"  orphaned task error: {final.get('error')!r}")
        print(f"  survivor_pid={survivor_pid} completed post-sweep task")
    finally:
        for p in procs.values():
            _kill(p)
        logs.close()
        shutil.rmtree(data_dir, ignore_errors=True)


def scenario_standby_cancel_aborts_holder() -> None:
    """(iv) durable worker self-check: a task runs on the holder; a cancel POSTed to
    the STANDBY moves the row to cancelled; the holder's worker notices it left the
    active statuses and self-aborts well under the run time — never stamping its pid.
    Proves #3 (another process cancelled) end to end across two real servers."""
    data_dir = tempfile.mkdtemp(prefix="lease-it-")
    logs = open(os.path.join(data_dir, "servers.log"), "w")
    procs: dict[int, subprocess.Popen] = {}
    try:
        procs[PORT_A] = _spawn(PORT_A, data_dir, 8.0, logs)  # 8s run > any plausible abort latency
        _wait_health(PORT_A)
        procs[PORT_B] = _spawn(PORT_B, data_dir, 8.0, logs)
        _wait_health(PORT_B)

        holder_port, holder_pid = _find_holder(procs)
        standby_port = PORT_B if holder_port == PORT_A else PORT_A

        tid = post_task(holder_port, "it-iv")
        _wait(lambda: get_task(holder_port, tid)["status"] == "running", 10, "task iv to start on the holder")

        # cancel via the STANDBY (which doesn't own the live worker) — it writes the
        # durable cancel; the holder's worker must self-abort in response.
        t0 = time.time()
        s, _ = _req("POST", f"http://127.0.0.1:{standby_port}/api/tasks/{tid}/cancel", token=TOKEN, timeout=5)
        assert s == 200, f"standby cancel POST failed: status={s}"

        final = _wait(lambda: (get_task(standby_port, tid)["status"] in ("cancelled", "done", "failed")
                               and get_task(standby_port, tid)) or None,
                      7, "task iv to reach a terminal state")
        elapsed = time.time() - t0
        assert final["status"] == "cancelled", f"standby-cancelled task must end cancelled, got {final['status']}"
        assert elapsed < 7.0, f"the holder must abort well under the 8s run, took {elapsed:.1f}s"
        assert _result_pid(final["result_summary"]) is None, \
            f"a self-aborted worker must NOT stamp its pid: {final['result_summary']!r}"
        print(f"  holder_pid={holder_pid} aborted its run {elapsed:.1f}s after a standby cancel")
    finally:
        for p in procs.values():
            _kill(p)
        logs.close()
        shutil.rmtree(data_dir, ignore_errors=True)


SCENARIOS = [
    scenario_holder_runs_and_takeover,
    scenario_orphan_sweep_no_double_run,
    scenario_standby_cancel_aborts_holder,
]


def main() -> int:
    if os.environ.get("RUN_LEASE_INTEGRATION") != "1":
        print("SKIP  set RUN_LEASE_INTEGRATION=1 to run the two-server lease integration test")
        return 0
    failed = 0
    for s in SCENARIOS:
        try:
            s()
            print(f"PASS  {s.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            import traceback
            print(f"FAIL  {s.__name__}: {type(exc).__name__}: {exc}")
            traceback.print_exc()
    print(f"\n{len(SCENARIOS) - failed}/{len(SCENARIOS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
