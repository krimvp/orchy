# `src/run.ts` — executing a flow, one wave at a time

This module is the runner: it takes a `Flow` (the interface in `src/flow.ts`)
and drives it to a terminal state. It validates the flow before spending
anything, then repeats one loop — find every step whose needs have settled,
run them together as a wave, record what each one did — until no step remains,
a gate asks a person for a value, a failure has no way back, or the run
reaches the flow's budget.

The state on disk is the run (ADR 0005). After every wave the runner writes
`.orchy/runs/<runId>/state.json` under the working directory, alongside a
`trajectory.json` in ATIF form, so a crash, a gate, and a resume all recover
from the same file — no process needs to stay alive while a run waits.

Along the way the runner enforces the flow's contracts. A step's value is
checked against its `returns` schema, and the values that reach a component
against its `takes`. A component is a TypeScript module — its default export
called as `(inputs, say, values, cwd)` — or a command in any language, run
where the steps act with `{ values, steps }` as JSON on stdin, its value as
JSON on stdout, and each stderr line as a live note (ADR 0026). A `module`
of the form `orchy:check` names a component Orchy ships. A condition (`when`) rules a step out and skips it, and
every step that needs a skipped step is skipped too. A computed fanout is
expanded mid-run, once the step it reads has produced its list. A step that
votes to cycle sends the run back to an earlier step (carrying its value as
feedback), a failed step with a `when: "failed"` cycle retries the same way,
and a cycle past its limit either accepts the disagreement or escalates to a
person, per its policy. A workspace promise (`changes`) is checked against
what the step really touched, and a wave that holds both a promise and a
possible writer runs one step at a time so the promises stay observable.

## Exports

Functions:

- `run(input: Flow, options?: RunOptions): Promise<RunState>` — starts a new
  run. It refuses an invalid flow, checks `options.with` against what the
  flow takes, expands static fanouts, and refuses a flow that still holds a
  `kind: "flow"` step (only loading a file expands one — use `loadFlow` from
  `src/load.ts`). It assigns a fresh `runId`, creates the run directory, and
  executes until the run is `"done"`, `"failed"`, or `"waiting"`. A run and a
  resume both refuse a value of `ORCHY_DROID_AUTO` that names no autonomy
  level, before any step starts (ADR 0028).

- `resume(runId: string, value: unknown, options?: RunOptions & { from?: string }): Promise<RunState>`
  — continues a run, in two distinct ways. With a value, it answers the gate
  or escalation of a run that waits: the value is checked against the waiting
  step's `returns` contract, recorded as `answeredByPerson` (so the step's own
  retry cycle does not fire on it), and execution picks up from there. With no
  value, it continues a run that ended: `options.from` names a step, and that
  step and every step after it run again while the rest keep their work
  (ADR 0023); without `from`, a `"failed"` run retries its failed steps and a
  `"stopped"` run simply continues, while a `"done"` or `"waiting"` run
  refuses and says what to supply instead. Every record that runs again goes
  to `history` first, because every attempt is a cost.

- `read(cwd: string, runId: string): RunState` — reads a run's `state.json`
  from disk, without executing anything.

Shapes:

- `RunOptions` — everything a run can be given: `cwd` (default: the current
  working directory), `with` (the values the flow takes), `harness` (the
  adapter for a step that names none; default: `pi`), `harnesses` (the
  adapters a step can name), `startedBy` (the run and the step that started
  this one, when a step did through the MCP door — ADR 0025), and `onEvent`,
  a callback for `RunEvent`s.

- `RunState` — the whole run: `runId`, the `flow` itself (held in full, so a
  resume needs no file), the run's `with` values, its `startedBy` when a
  step started it, a `status` of `"running"`,
  `"waiting"`, `"done"`, `"failed"`, or `"stopped"` (what a person or a dead
  daemon leaves — a run never writes it itself), an `error` when the fault
  belongs to the run and not to one step, a `StepRecord` per settled step,
  cycle counts, pending `feedback`, and a `history` of every record a cycle
  or a resume dropped (a dropped attempt still counts toward the budget).
  While waiting, `waitingFor` names the step and `question` says what to
  supply.

- `StepRecord` — what one step did: `status` (`"done"`, `"failed"`, or
  `"skipped"`), timestamps, the `value`, an `error`, a `trajectory` handle,
  the `cost` its harness reported, each path it `changed`, and flags such as
  `answeredByPerson`, `votedToCycle`, `disagreement`, and why it was
  `skipped`.

- `RunEvent` — what `onEvent` hears, in order: `run_start`, then per step
  `step_start`, `output` (live notes while it works), and `step_end` — or
  `skip` when a condition ruled it out — plus `cycle` when the run goes back,
  `waiting` when it stops for a person, and `run_end` with the final status.

## Example

Run a flow, watch its progress, and answer a gate if it stops at one:

```ts
import { loadFlow } from "./load.ts";
import { resume, run } from "./run.ts";

const flow = await loadFlow("flows/review.yaml");

const state = await run(flow, {
  with: { branch: "main" },
  onEvent: (event) => {
    if (event.type === "step_end") console.log(`${event.step}: ${event.status}`);
  },
});

if (state.status === "waiting") {
  console.log(state.question);
  // A person decides, and the run continues from its file on disk.
  await resume(state.runId, { approved: true });
}
```

In practice, `src/cli.ts` calls `run` and `resume` for `orchy run` and
`orchy resume`, `src/daemon.ts` uses `read` to serve run state to the UI, and
`src/atif.ts` reads `RunState` to build the trajectory. All three functions
and the four types are re-exported from `src/index.ts` as part of the
package's public surface.
