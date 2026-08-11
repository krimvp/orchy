# `src/atif.ts` — the run as an ATIF trajectory

Orchy records every run in the Agent Trajectory Interchange Format (ATIF),
version 1.7, pinned by [ADR 0003](../adr/0003-write-trajectories-as-atif.md).
This module holds that format: the TypeScript types for a trajectory, and the
conversion from a run's state to one. The run becomes one root trajectory, each
agent step becomes a child trajectory, and the root's `final_metrics` sum what
the whole run spent — including the attempts a cycle threw away, because a
dropped attempt is still a cost.

The module does not read any harness's own files. Each harness adapter (Pi,
Claude) reads its own session format and produces a `Trajectory`; this module
takes that conversion as a function and assembles the tree. `run.ts` calls it
at the close of a run to write `trajectory.json`.

## Exports

### Values and functions

- `SCHEMA_VERSION` — the string `"ATIF-v1.7"`. ATIF still moves, so Orchy pins
  the version and records it in every trajectory rather than following it
  silently.

- `toAtif(state, version, toTrajectory): Trajectory` — the main conversion.
  Takes a `RunState` (from `run.ts`), the Orchy version string for the `agent`
  field, and a `ToTrajectory` callback that turns one step's trajectory handle
  into a child `Trajectory` (or `undefined` when the step has none). Each
  attempt becomes one root step: its message says how the step ended, its
  `extra.orchy` carries the run-level facts (status, changes, disagreement,
  whether a person answered, whether a cycle dropped it), and its metrics come
  from the child trajectory — or from the step record's own `cost` when the
  harness reports spend on the result instead of in the trajectory.

- `attempts(state)` — every run of every step, in the order they started, as
  `{ step, record, dropped? }`. A cycle runs a step more than once; the
  attempts a cycle dropped come from `state.history` and carry
  `dropped: true`. This is what `toAtif` iterates, exported so other readers
  of a run can count cost the same way.

- `totalMetrics(parts)` — sums an array of `Metrics` into one, treating absent
  `cached_tokens` and `cost_usd` as zero.

### Types

- `Trajectory` — one agent's record: `schema_version`, `trajectory_id`,
  `session_id`, an `agent` (name, version, model name), the `steps`, optional
  `subagent_trajectories`, and `final_metrics` (a `Metrics` plus
  `total_steps`).
- `Step` — one turn: `step_id`, `timestamp`, a `source` of `"user"`,
  `"agent"`, or `"system"`, a `message`, and optional `reasoning_content`,
  `tool_calls`, `observation`, `metrics`, `subagent_trajectory_ref`, and
  `extra`.
- `ToolCall` — one tool invocation: `tool_call_id`, `function_name`, and
  `arguments`.
- `Metrics` — `prompt_tokens`, `completion_tokens`, and optional
  `cached_tokens` and `cost_usd`.
- `ToTrajectory` — the callback `toAtif` takes:
  `(step, handle, trajectoryId, version) => Trajectory | undefined`. The
  handle is whatever the step's record stored in `trajectory` — a file path
  for Pi, a session id for Claude — and each harness adapter provides the
  implementation.

## Example

Convert a run whose steps all ran under the Pi harness, and write the
trajectory file that `orchy run` would write:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { toAtif } from "./atif.ts";
import { pi } from "./pi.ts";
import type { RunState } from "./run.ts";

const state: RunState = JSON.parse(readFileSync("state.json", "utf8"));

const trajectory = toAtif(state, "0.1.0", (_step, handle, trajectoryId, version) =>
  pi.toTrajectory(handle, trajectoryId, version),
);

writeFileSync("trajectory.json", JSON.stringify(trajectory, null, 2));
```

In the real run this callback looks the step up in the flow first, because each
step may name its own harness (`run.ts`, in `execute`). The example collapses
that to one harness.
