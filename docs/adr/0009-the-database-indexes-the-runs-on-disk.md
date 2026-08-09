---
status: accepted
---

# The database indexes the runs on disk

The daemon keeps a SQLite database at `.orchy/index.db`. The database is not
the run. [ADR 0005](./0005-a-run-is-a-persisted-state-machine.md) says that the
state on disk is the run, and that stays true.

The database holds three things that a directory of runs cannot answer:

1. A list of every run, in order, with the status, the length, and the cost. A
   scan of every `state.json` answers this, and it gets slower with every run.
2. The events of a run. A run reports what it does while it runs, and nothing
   writes those events to disk today.
3. The flows that a user registers, and the harness for each one. This is the
   configuration of the daemon.

`index()` reads every run from disk when the daemon starts, and writes a row
for each one. So a lost database costs the events, and no run.

## Consequences

The database uses `node:sqlite`, which the standard library holds. It costs no
dependency. Node calls it experimental and prints a warning when it loads.

A row can disagree with the file that it describes, and the file wins. A reader
that wants the truth of one run reads `state.json` through `GET /api/runs/:id`.
The list view reads rows, because a list of a thousand runs must not read a
thousand files.

`orchy run` writes no row, because it runs without a daemon. The next start of
the daemon indexes that run.
