# `src/store.ts` — the SQLite index of flows and runs

This module wraps a SQLite database (via `node:sqlite`) holding five tables:
the flows a user has registered, one row per run, the events of each run, the
schedules of flows that run by themselves, and the webhook tokens that start
a flow from a POST. Its design premise is ADR 0008: the state on disk is the
run, and this database is only an index of it plus what a directory cannot
hold — the event stream, the flow registry, and what a person has attached to
a flow. `index()` rebuilds every run row from the `state.json` files on disk,
so losing the database file loses no run, only its events.

The index is deliberately bounded. `KEPT` (200) is how many runs the list
holds; `trim()` drops the events of any run that falls behind that window,
because a run no page shows needs no event stream. The state and trajectory
of every run stay on disk regardless (ADR 0009).

## Exports

- `open(file)` — opens (creating if needed) the database at `file`, applies
  the schema, sets WAL journaling, and returns the store object. Its methods:
  - `close()` — closes the database.
  - `flows()`, `flow(id)`, `flowAt(path)` — list registered flows ordered by
    name, or fetch one by id or by file path.
  - `addFlow(path, name, harness)` — registers a flow, updating the name and
    harness if the path is already known, and returns its `FlowRow`.
  - `removeFlow(id)` — deletes a flow row, and its schedule and hook with it;
    either without its flow would fire nothing.
  - `hook(flowId)`, `hooked(token)` — the token that starts a flow from a
    POST, or the flow a token starts; each is `undefined` when no hook holds
    the pair.
  - `setHook(flowId, token)`, `clearHook(flowId)` — attach a token to a flow
    (replacing any it had), or remove it.
  - `schedules()`, `schedule(flowId)` — every schedule, or one flow's.
  - `setSchedule(flowId, everyMinutes, values?)` — makes a flow run by
    itself, every so many minutes, with the given values. Updating a
    schedule keeps its `lastAt`: a change of pace is not a reason to fire
    right now.
  - `clearSchedule(flowId)` — removes a schedule.
  - `markScheduled(flowId, at)` — records when a schedule last fired.
  - `runs(limit?)`, `run(runId)` — list runs newest first (default limit
    `KEPT`), or fetch one.
  - `saveRun(row)` — inserts a `RunRow`, or updates its mutable fields
    (status, end time, waiting state, question, cost, tokens) if the run
    exists.
  - `addEvent(runId, event, seq?)` — stamps a `RunEvent` with the current
    time and the given sequence number, stores it, and returns the
    `StoredEvent`.
  - `events(runId)` — the run's events in insertion order.
  - `trim()` — deletes the events of every run outside the newest `KEPT`.
  - `index(runs)` — walks the run directories under `runs`, rebuilds a row
    from each readable `state.json` (taking cost and tokens from
    `trajectory.json`), and returns how many runs it found. A run still
    marked "running" becomes "stopped" — the daemon calls this at startup,
    when nothing can be running — and that status is written back to the
    `state.json` too, so a page that reads the state hears the same thing.

- `due(schedule, now)` — whether a schedule should fire. A schedule that has
  never fired is due now — that is what scheduling it asked for; after that,
  it is due when its interval has passed since `lastAt`.

- `rowOf(state, path, spend?)` — builds a `RunRow` from a `RunState`: the
  start time is the earliest step start, the end time is the latest step end
  (counting attempts a cycle or resume dropped to `history`) but only once
  the status is `done` or `failed`, and cost and tokens come from `spend`.

- `metricsAt(file)` — reads a `trajectory.json` and returns
  `{ cost, tokens }` from its `final_metrics`, or `undefined` if the file is
  missing or holds none. The cost of a run lives in its trajectory, not in
  its state.

- `KEPT` — the number of runs the index holds (200).

- Types: `Store` (the return type of `open`), `FlowRow`, `RunRow`,
  `ScheduleRow` (how often a flow fires, with which values, and when it last
  did), and `StoredEvent` (a `RunEvent` plus its `at` timestamp and an
  optional `seq` — the order of receipt, since two events can land in the
  same millisecond and a clock alone cannot put them back in line).

## Example

Open the index, record a run, and read its events back:

```ts
import { open, rowOf, metricsAt } from "./store.ts";

const store = open("index.db");

store.saveRun(rowOf(state, "flows/review.yaml", metricsAt(trajectoryFile)));
store.addEvent(state.runId, { type: "step", stepId: "plan" });

for (const event of store.events(state.runId)) {
  console.log(event.at, event.type);
}

store.close();
```

In practice `src/daemon.ts` is the only caller: it opens `index.db` in its
own directory, runs `index()` once at startup, checks `due()` on a timer to
start scheduled flows, saves a row and an event as each run progresses, and
trims after a run closes. `open`, `rowOf`, `metricsAt`, and the types
`FlowRow`, `RunRow`, `Store`, and `StoredEvent` are re-exported from
`src/index.ts` as part of the package's public surface; `due`, `KEPT`, and
`ScheduleRow` are not.
