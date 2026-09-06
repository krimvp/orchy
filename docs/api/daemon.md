# `src/daemon.ts` — the run scheduler

This module is the long-lived heart of Orchy: it accepts orders to run flows,
holds them in a queue, and drives each one in a child process. At most four
runs work at once — that bound is a constant, not a setting; a user who wants
more starts a second daemon. Each run is `cli.ts` with a private file
descriptor for events. The child writes one checked JSON event per line there.
The daemon turns that stream into notices for whoever watches. Component
stdout is a separate stream, so ordinary output cannot control the daemon.
Every thirty seconds the daemon also fires every
schedule that is due, through the same `start` door a person uses; a flow
whose last scheduled run still works is skipped, so runs never stack behind a
slow one.

The daemon keeps records with different lifetimes. Accepted starts and resumes
go into the SQLite `accepted_work` ledger before their caller receives a
ticket. Lifecycle events
(`run_start`, step starts and ends) go into the SQLite index that `store.ts`
opens under `<root>/.orchy/index.db`, where they survive the process. Step
output does not: the output of a step is a view, and the trajectory is the
record, so the daemon holds only the last 500 output notes per run, for the
20 most recent runs, in memory. An older run answers from its
`trajectory.json` on disk instead. Every event carries a sequence number, so
two events in one millisecond still line up.

A queued run is identified by a **ticket** — a global SQLite number the daemon
hands out before the child exists. Its `status` is `queued`, `dispatching`,
`delivered`, `failed`, or `uncertain`. Once the child reports `run_start`, the
ticket gains a `runId` and the run lives in the index from then on. A child that dies
before it starts a run keeps its ticket and an `error` explaining why, so a
failure is never silent. A child that dies mid-run leaves its state on disk,
and the daemon marks the row `stopped`.

A restart claims a durable `queued` ticket, then checks the flow or run again
before it starts a child.
It never retries a ticket that a dead daemon had claimed, because a detached
child may already have started. Such a ticket is `uncertain`; its `recovery`
text names the run and the exact HTTP or UI actions to inspect and acknowledge
it. Dismissal does not prove delivery. See ADR 0030.

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
    `startedBy` rides along when a step placed the order through the MCP
    door, and the child writes it into its state (ADR 0025).
  - `resume(runId, value, harness, from?, step?)` — continues a run,
    returning a fresh `Ticket`. A `value` answers the gate of a run whose
    status is `waiting`, checked against that gate's contract here at the
    door; `step` names the gate the answer was written for, so a run that has
    moved on refuses an answer meant for the question it has left. No value continues a run that ended, from the step `from`
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
  - `pending()` — durable tickets from every daemon over this root.
  - `forget(ticket)` — drops a failed ticket, or acknowledges one whose dead
    owner makes delivery uncertain. It refuses queued, dispatching, and live
    delivered work.
  - `state(runId)` — the run's `RunState` read from disk, or `undefined`.
  - `trajectory(runId)` — the parsed `trajectory.json` of a run, or
    `undefined` when none exists.
  - `watch(listener)` — subscribes to notices and returns the unsubscribe
    function.
  - `fire()` — checks the schedules now, so a test does not wait for the
    thirty-second clock.
  - `close(kill = true)` — stops the schedule clock, kills every child
    (`kill: false` leaves them to finish — the MCP door closes this way, so
    a dispatcher's runs outlive the step's door), drops the
    listeners, and closes the store. Nothing is delivered after this.
  - `store` and `root` — the open `Store` and the root path, exposed for
    callers like the server that answer queries directly.

- `Daemon` — the type of what `daemon()` returns.
- `Ticket` — `{ ticket, flowName, path, queuedAt, status, runId?, error?,
  recovery? }`; the durable receipt for accepted work.
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
