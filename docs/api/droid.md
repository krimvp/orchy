# `src/droid.ts` — the Droid harness adapter

This module lets Orchy run a step of a flow under Droid, the coding agent of
Factory. It is one of the three harness adapters (the others are Pi, in
`src/pi.ts`, and Claude Code, in `src/claude.ts`) and implements the `Harness`
interface from `src/harness.ts`: run one agent step, and later turn that
step's record into an ATIF `Trajectory` (the format defined in `src/atif.ts`).

The adapter drives the `droid exec` command. A custom model in
`~/.factory/config.json` — Ollama Cloud, a local Ollama server, or any
OpenAI-compatible endpoint — serves a step without a Factory account.

Five details are load-bearing:

- **Only the declared tools exist.** Orchy's harness-neutral tool names are
  mapped to Droid's own (`Read`, `Create`, `Edit`, `Execute`, `Grep`, `Glob`,
  `LS`, `FetchUrl`/`WebSearch`) and go to `--enabled-tools`, which blocks
  every tool it does not name. A name with no mapping throws rather than
  being dropped silently, and so does an empty list: an empty
  `--enabled-tools` would enable the default set of the command, and that is
  invariant 1 broken in silence. The `orchy` tool has no mapping, because
  Droid holds one MCP list for every session, so no per-step list can bound
  the door of the run's own root.
- **The contract rides the system prompt.** The command takes no schema, so
  the adapter appends the `returns` schema to the system prompt and reads the
  one JSON value out of the answer — whole, fenced, or at the end of prose.
  A session continues only under a Factory login, so no reminder can ride the
  same session, the way Pi sends one. The runner still checks the value
  against the real schema, so a value that breaks the contract fails the step
  either way.
- **A model id is plain.** When `request.model` is given it must hold no
  slash, as `"qwen3.5:397b"` or `"custom:glm-5.2-[Ollama-Cloud]-0"`, not the
  `provider/model` pair that Pi wants. The check uses the same grammar that
  `validate()` reads before a run starts.
- **The environment names the autonomy level.** The adapter passes
  `--auto high`, because no one sits at the keyboard of a step: the tool list
  bounds what exists, and the level approves what the list holds. An
  organisation can cap the level of the `droid` command below `high`, and
  every step then fails at the door of the command, so `ORCHY_DROID_AUTO`
  lowers it to `low` or `medium`. The variable belongs to the machine and not
  to the flow, because a flow is data that runs everywhere (ADR 0028). A
  level below `high` takes work away from a step and adds none: droid asks,
  no person answers, and the step fails or comes back short. When droid
  refuses the level itself, the adapter adds one sentence to the error, which
  names the variable.
- **Droid names its own session.** The command tells its session id only at
  the end, so while the step runs the record is found, not asked for: the
  first new session file of the working directory whose title opens with this
  step's prompt. The id from the answer is the trajectory handle the caller
  keeps.

Droid writes its session one JSON line at a time under
`~/.factory/sessions/<directory>`, so the record of a step is also the live
report of it: while the step runs, the adapter tails the session file (via
`src/tail.ts`) and turns each line into notes for the optional `watch`
callback — text, reasoning, tool calls, tool results.

Droid writes no dollars into its record, so `run` reports no cost, and a flow
with a droid step declares no `budget`. The token counts sit in the settings
file beside the session, and `toTrajectory` reads them as one total.

## Exports

### `droid: Harness`

The adapter, with the two methods the interface asks for.

**`run(request, watch?)`** executes one step. It takes an `AgentRequest`
(`step`, `prompt`, `tools`, a `returns` JSON Schema, `cwd`, optional `model`)
and an optional `Watch` callback for live notes. It spawns `droid exec` in
`request.cwd` with the autonomy level that `autonomyOf()` reads — `high`
unless `ORCHY_DROID_AUTO` names another — and resolves to an `AgentResult`:
`value` is the JSON value of the answer and `trajectory` is the session id.
It rejects when a requested tool has no mapping, when the tool list is empty,
when the model id is not plain, when the environment names no autonomy level,
when the command fails or answers something that is not JSON, or when the
answer holds no JSON value.

**`toTrajectory(sessionId, trajectoryId, version)`** reads the session that a
`run` left behind — the handle is the session id `run` returned — and
converts it into an ATIF `Trajectory`: user messages become user steps,
assistant messages become agent steps with tool calls and thinking, and tool
results become system steps. The model name and the token totals come from
the settings file beside the session. The file is another program's data, so
it is read defensively: a session that cannot be found or read returns
`undefined`, and a half-written line is skipped rather than fatal.

Everything else in the file — the tool-name table, the session locator, the
line-to-step conversion — is private to the module.

## Example

Run one step under Droid, watching it work, then fetch its trajectory:

```ts
import { Type } from "@sinclair/typebox";
import { droid } from "./droid.ts";

const result = await droid.run(
  {
    step: "package-name",
    prompt: "Read package.json and report the package name.",
    tools: ["read"],
    returns: Type.Object({ name: Type.String() }),
    cwd: process.cwd(),
    model: "custom:glm-5.2-[Ollama-Cloud]-0",
  },
  (note) => console.log(`[${note.kind}] ${note.text}`),
);

console.log(result.value); // { name: "orchy" } — checked by the runner
console.log(result.cost); // undefined — droid reports no cost

// Later, turn the run's record into an ATIF trajectory:
const trajectory = droid.toTrajectory(result.trajectory!, "run-42/step-2", "0.1.0");
```

In a real run, `src/run.ts` picks this adapter because the flow's step names
`droid` as its harness, `validate()` has already checked the tools and the
model grammar against the tables in `src/harness.ts` before this module loads,
and the runner has already refused a value of `ORCHY_DROID_AUTO` that names no
level.
