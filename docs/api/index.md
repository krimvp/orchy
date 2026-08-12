# `src/index.ts` — the public entry point

This module is the package's front door. `package.json` maps the bare import
`"orchy"` to this file, so everything a program uses from the library passes
through here. It holds no code of its own — every line is a re-export from
one of the other modules under `src/` — but the selection is the point: what
this file names is public API, and what it omits stays internal even when its
home module exports it (the CLI in `src/cli.ts`, for example, or `flow.ts`
helpers like `OPERATORS` and `schemaProblem` that only the daemon and the
validator's own callers need).

A reader who wants to know what a re-export *does* should follow it to its
home module's page in this directory; this page maps the surface.

## Exports

Grouped by the module each name comes from:

- **`flow.ts` — building and checking flows.** The builders `flow`, `agent`,
  `call`, and `gate`; `validate`; the expansions `expandFanout` and
  `expandFlows` with `resolvePaths`; the readers `harnessOf`, `modelOf`,
  `changesOf`, `cycleOf`, `fanoutOf`, `membersOf`, `computedOf`, and `order`;
  the constant `WAVE`. Types: `Flow`, `Step`, `AgentStep`, `CallStep`,
  `GateStep`, `FlowStep`, `Cycle`, `Fanout`, `Member`, `Computed`, `Changes`,
  `When`, `Match`.
- **`run.ts` — running one.** `run`, `resume`, and `read`. Types:
  `RunOptions`, `RunState`, `RunEvent`, `StepRecord`.
- **`load.ts` and `yaml.ts` — flows as files.** `loadFlow` and `readFlow`
  bring a YAML flow in from disk; `parseFlow` and `formatFlow` convert
  between text and the `Flow` data without touching disk.
- **`harness.ts` — what an agent step runs under.** The tables `ADAPTERS`,
  `MODELS`, `SUPPLIES`, and `TOOLS`, plus `notesOf`. Types: `Harness`,
  `AdapterName`, `ToolName`, `AgentRequest`, `AgentResult`, `Note`, `Watch`.
- **`pi.ts` and `claude.ts` — the two shipped harnesses.** `pi` and `claude`,
  each a ready `Harness` value to pass to `run`.
- **`workspace.ts` — what a step may change.** `take` and `changed`. Types:
  `Workspace`, `Snapshot`, `Change`.
- **`daemon.ts`, `server.ts`, and `mcp.ts` — the long-running side.**
  `daemon`, `serve`, and `mcp`. Types: `Daemon`, `Order`, `Ticket`, `Notice`.
- **`store.ts` — the run record.** `open`, `rowOf`, and `metricsAt`. Types:
  `Store`, `FlowRow`, `RunRow`, `StoredEvent`.
- **`atif.ts` — trajectories.** `toAtif` and `SCHEMA_VERSION`. Type:
  `Trajectory`.
- **`tail.ts`** — `tail`, which follows a run's events as they land.

## Example

Load a flow from a YAML file, run it under the pi harness, and print each
step as it finishes — using only names this module exports:

```ts
import { loadFlow, pi, run } from "orchy";

const flow = await loadFlow("flows/review.yaml");
const state = await run(flow, {
  harness: pi,
  onEvent: (event) => {
    if (event.type === "step_end") console.log(event.step, event.status);
  },
});

console.log(state.status); // "done", "failed", or "waiting" on a gate
```

Inside this repository the same import reads `from "./src/index.ts"`; the
names and behavior are identical either way.
