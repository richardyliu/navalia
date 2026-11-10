# TEST-ISOLATION: a Runtime test leaks writes into `<HOME>/.persome`

Target: `personal-model` integration branch `og/upstream-fixes` (worktree `personal-model-og`).
Found by the R6 agent: with the real `HOME` and `PERSOME_ROOT` unset, the offline suite sometimes
creates or opens `<HOME>/.persome/index.db` after the tests finish. They saw it in about 10 of 16 runs.
Investigated and fixed by the R3 agent on 2026-11-05. Status: committed on the integration branch, not pushed.

## How it was reproduced safely

The real `HOME` was never used. Each run set `env -i HOME=/tmp/persome-test/leak-home-N` and left
`PERSOME_ROOT` unset, which recreates the R6 condition against a throwaway home. A diagnostic pytest plugin
installed `sys.addaudithook`. It logged every `open`, `os.mkdir`, and `sqlite3.connect` under
`$HOME/.persome`, together with the thread name, `PYTEST_CURRENT_TEST`, and the stack. The plugin lived in
the session scratchpad, not in the repo.

First run: `$HOME/.persome/.wal-checkpoint.lock` was created. All four logged touches came from the same place:

```
thread=reduce-sess_<id>  test=tests/test_session_tick.py::test_prune_telemetry_calls_parser_store (setup)
session_reducer._run -> on_done -> session/tick._after_reduce -> writer/agent.finalize_session
  -> pattern_detector.detect_after_classify -> fts.cursor() -> database_activity
  -> paths.open_private_lock_file(paths.wal_checkpoint_lock()) -> mkdir <HOME>/.persome
```

## Root cause

`tests/test_session_tick.py::test_build_manager_wires_reducer_end_to_end` calls `manager.force_end()`.
That starts the daemon thread `reduce-<session>` (`writer/session_reducer.reduce_session_async`). The test
polls until the session row reads `reduced` and then returns. The thread is still running at that point: its
`on_done` callback (`finalize_session`, which runs the pattern detector) starts after the row is marked
reduced.

During teardown, monkeypatch restores `PERSOME_ROOT` to its original value. With `PERSOME_ROOT` unset in the
outer environment, that means no value. `paths.root()` reads the variable on every call, so the thread's next
`fts.cursor()` resolves to `Path.home()/.persome`. The thread then creates the directory and the WAL lock,
and can go on to open or create `index.db`.

The outcome depends on timing (the thread races the next test's setup), which explains why it happens in
some runs and not others. When `PERSOME_ROOT` is set in the outer shell, the same leak lands in that
directory and goes unnoticed. That is why the usual `env -i PERSOME_ROOT=/tmp/...` runs never showed it.

## Fix (tests only; Runtime code unchanged)

1. `test_build_manager_wires_reducer_end_to_end` now joins the `reduce-<sid>` thread (30 s timeout) before
   it returns, and fails if the thread is still alive.
2. `tests/conftest.py` gets a session-level guard:
   - It captures the real `~/.persome` at import, recording whether it exists and the `index.db` mtime. It
     uses `stat()` only and never opens the database.
   - Before any `persome` import, it sets `HOME` and `PERSOME_ROOT` to a per-session temp directory. Any
     future leaker then lands in that sandbox, not the real root.
   - `pytest_sessionfinish` sets the session exit status to failed and prints
     `REAL DATA ROOT TOUCHED ...` if the real root was created or its `index.db` mtime changed.
   - It prints a yellow warning if anything wrote under the session `HOME/.persome`. Such a write means some
     code resolved `paths.root()` without a per-test root.
   - A Persome daemon running on the same machine also writes the real `index.db`. In that case set
     `PERSOME_TEST_IGNORE_REAL_ROOT_MTIME=1`, and the guard checks only whether the root was created.

I checked that the guard fires. A throwaway test that created `<fake HOME>/.persome/index.db` made pytest exit
with status 1 and print the `REAL DATA ROOT TOUCHED` line. That test file was deleted afterwards.

## Verification

After the fix I ran the full offline suite 3 times under the leak condition (fake `HOME`, `PERSOME_ROOT` unset,
audit-hook plugin on). Each run: 2570 passed, nothing created under the fake `HOME/.persome`, 0 audit-hook
touches, and no sandbox warning. The sandbox warning matters here, because it covers writes that the new
session `HOME` redirect would otherwise hide. Before the fix, the first comparable run created
`.wal-checkpoint.lock`. Three clean runs is a small sample for a timing race, so the conftest guard stays in as
the backstop.

## Other candidates checked

- `tests/test_session_tick.py::test_terminal_callback_finalizes_no_write_and_heuristic_results` replaces
  `reduce_session_async` with a synchronous fake, so it starts no thread.
- `tests/test_runtime_model_e2e.py` drives `force_end` through its own wired manager.
- `tests/test_daemon.py` and `tests/test_session_manager.py` use mocks or a manager without a reducer.

None of them showed up in the audit-hook logs.
