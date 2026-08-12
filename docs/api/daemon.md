# `src/daemon.ts` — the run scheduler

This module is the long-lived heart of Orchy: it accepts orders to run flows,
holds them in a queue, and drives each one in a child process. At most four
runs work at once — that bound is a constant, not a setting; a user who wants
more starts a second daemon. Each run is `cli.ts` spawned with `--events`, so
the child writes one JSON event per line on stdout and the daemon turns that
stream into notices for whoever watches (in practice, `server.ts`, which puts
a daemon behind HTTP). Every thirty seconds the daemon also fires every
schedule that is due, through the same `start` door a person uses; a flow
whose last scheduled run still works is skipped, so runs never stack behind a
slow one.

The daemon keeps two records with different lifetimes. Lifecycle events
(`run_start`, step starts and ends) go into the SQLite index that `store.ts`
opens under `<root>/.orchy/index.db`, where they survive the process. Step
output does not: the output of a step is a view, and the trajectory is the
record, so the daemon holds only the last 500 output notes per run, for the
20 most recent runs, in memory. An older run answers from its
`trajectory.json` on disk instead. Every event carries a sequence number, so
two events in one millisecond still line up.

A queued run is identified by a **ticket** — a number the daemon hands out
before the child exists. Once the child reports `run_start`, the ticket gains
a `runId` and the run lives in the index from then on. A child that dies
before it starts a run keeps its ticket and an `error` explaining why, so a
failure is never silent. A child that dies mid-run leaves its state on disk,
and the daemon marks the row `stopped`.

## Exports

- `daemon(root: string, beats = true)` — builds and returns a daemon rooted
  at `root`. It creates `<root>/.orchy/runs`, opens the index, and re-indexes
  what is already there. `beats` says whether this daemon fires the schedules
  every thirty seconds; the long daemon does, and a second one over the same
  root — the MCP door — must not, because two beats would fire one schedule
  twice. The returned object has:

  - `start(order)` — queues a run and returns its `Ticket`. The `Order`
    names the flow file (`path`), the flow (`flowName`), the harness, and
    optionally `with`, the values the flow takes; the child validates them.
  - `resume(runId, value, harness, from?)` — continues a run, returning a
    fresh `Ticket`. A `value` answers the gate of a run whose status is
    `waiting`. No value continues a run that ended, from the step `from`
    names or from where the run stood; a run that is `done` needs `from`.
    Throws when the index holds no such run, the run is still running or
    already queued, or the combination of value and status makes no sense.
    The child checks the details again; this refuses only what a row
    already refutes.
  - `stop(runId)` — sends `SIGTERM` to the child of a running run. Returns
    `false` when no child holds that run id. The state on disk keeps what
    the run reached.
  - `abandon(runId)` — ends a run that no child drives: one that waits at a
    gate, or one a dead daemon left behind. Marks the state on disk
    `stopped`, updates the row, and tells the listeners; returns `false`
    when the run is neither waiting nor running.
  - `notes(runId)` — the recent output of a run's steps, as far back as
    memory holds (`StoredEvent[]`, possibly empty).
  - `pending()` — every ticket the daemon still holds, queued or running.
  - `forget(ticket)` — drops a ticket, typically one that ended in error.
  - `state(runId)` — the run's `RunState` read from disk, or `undefined`.
  - `trajectory(runId)` — the parsed `trajectory.json` of a run, or
    `undefined` when none exists.
  - `watch(listener)` — subscribes to notices and returns the unsubscribe
    function.
  - `fire()` — checks the schedules now, so a test does not wait for the
    thirty-second clock.
  - `close()` — stops the schedule clock, kills every child, drops the
    listeners, and closes the store. Nothing is delivered after this.
  - `store` and `root` — the open `Store` and the root path, exposed for
    callers like the server that answer queries directly.

- `Daemon` — the type of what `daemon()` returns.
- `Ticket` — `{ ticket, flowName, path, queuedAt, runId?, error? }`; the
  receipt for an accepted run.
- `Order` — what `start` takes, described above.
- `Notice` — what a `watch` listener receives: either
  `{ kind: "event", runId, event }` for one stored event of one run, or
  `{ kind: "queue", pending }` whenever the set of tickets changes.

## Example

Start a daemon, watch a flow run to its end, then shut down:

```ts
import { daemon } from "./daemon.ts";

const orchy = daemon(process.cwd());

const stop = orchy.watch((notice) => {
  if (notice.kind === "queue") console.log(`${notice.pending.length} pending`);
  else console.log(`${notice.runId}: ${notice.event.type}`);
});

const ticket = orchy.start({
  path: "flows/health.yaml",
  flowName: "health",
  harness: "claude",
  with: { target: "package.json" },
});
console.log(`queued as ticket ${ticket.ticket}`);

// ... later, once a notice reported run_end for the run:
stop();
orchy.close();
```

In a real deployment, `cli.ts` builds one daemon for the `daemon` command and
`server.ts` exposes these same methods over HTTP; nothing else constructs
one. `daemon` and the types `Daemon`, `Notice`, `Order`, and `Ticket` are
re-exported from `src/index.ts` as part of the package's public surface.
