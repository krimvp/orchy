# `src/claude.ts` — the Claude Code harness adapter

This module lets Orchy run a step of a flow under Claude Code. It is one of
the three harness adapters (the others are Pi, in `src/pi.ts`, and Droid, in
`src/droid.ts`) and implements the
`Harness` interface from `src/harness.ts`: run one agent step, and later turn
that step's record into an ATIF `Trajectory` (the format defined in
`src/atif.ts`).

The adapter drives the `claude` command directly, not the Claude Agent SDK:
the SDK would spawn that same command anyway at the cost of two packages, and
the command accepts the step's return contract as JSON Schema through
`--json-schema`, so no schema conversion happens at all.

Three details are load-bearing:

- **Only the declared tools exist.** Orchy's harness-neutral tool names
  (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web`) are mapped
  to Claude Code's own (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`,
  `WebSearch`/`WebFetch`). Both `find` and `ls` map to `Glob`, because Claude
  has no separate list tool. A name with no mapping throws rather than being
  dropped silently, so a step never runs with fewer tools than it asked for.
  The mapped names go to both `--tools` (what exists) and `--allowedTools`
  (what runs without a permission prompt).
- **A model name is plain.** When `request.model` is given it must be a bare
  name (as `"opus"`), not the `provider/model` pair that Pi wants. The check
  uses the same grammar that `validate()` reads before a run starts, so a
  flow that names this harness hears about a bad name early.
- **Each step gets a fresh session id.** The adapter generates a UUID per
  run, which keeps the step out of the transcript of whatever session
  started it. That id is also the trajectory handle the caller keeps.

Claude writes its transcript one JSON line at a time under its own config
directory (`$CLAUDE_CONFIG_DIR/projects`, or `~/.claude/projects`), so the
record of a step is also the live report of it: while the step runs, the
adapter tails the `<sessionId>.jsonl` file (via `src/tail.ts`) and turns each
line into notes for the optional `watch` callback — text, reasoning, tool
calls, tool results.

## Exports

### `claude: Harness`

The adapter, with the two methods the interface asks for.

**`run(request, watch?)`** executes one step. It takes an `AgentRequest`
(`step`, `prompt`, `tools`, a `returns` JSON Schema, `cwd`, optional `model`)
and an optional `Watch` callback for live notes. It spawns
`claude --print` in `request.cwd` and resolves to an `AgentResult`: `value`
is the structured output shaped by `returns`, `trajectory` is the session id,
and `cost` is the spend in USD taken from the command's answer — Claude
writes no cost into its transcript, so the answer is the only place to read
it. It rejects when a requested tool has no mapping, when the model name is
not plain, when the command's answer is not JSON or reports an error, or
when the answer carries no structured output.

**`toTrajectory(sessionId, trajectoryId, version)`** reads the transcript
that a `run` left behind — the handle is the session id `run` returned — and
converts it into an ATIF `Trajectory`: user messages become user steps,
assistant messages become agent steps with tool calls, thinking, and
per-step token metrics, and tool results become system steps. The file is
another program's data, so it is read defensively: a transcript that cannot
be found or read returns `undefined`, and a half-written line is skipped
rather than fatal.

Everything else in the file — the tool-name table, the transcript locator,
the line-to-step conversion — is private to the module.

## Example

Run one step under Claude Code, watching it work, then fetch its trajectory:

```ts
import { Type } from "@sinclair/typebox";
import { claude } from "./claude.ts";

const result = await claude.run(
  {
    step: "package-name",
    prompt: "Read package.json and report the package name.",
    tools: ["read"],
    returns: Type.Object({ name: Type.String() }),
    cwd: process.cwd(),
    model: "opus",
  },
  (note) => console.log(`[${note.kind}] ${note.text}`),
);

console.log(result.value); // { name: "orchy" } — shaped by `returns`
console.log(result.cost); // spend in USD, from the command's answer

// Later, turn the run's record into an ATIF trajectory:
const trajectory = claude.toTrajectory(result.trajectory!, "run-42/step-2", "0.1.0");
```

In a real run, `src/run.ts` picks this adapter because the flow's step names
`claude` as its harness, and `validate()` has already checked the tools and
the model grammar against the tables in `src/harness.ts` before this module
loads.
