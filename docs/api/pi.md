# `src/pi.ts` — the Pi harness adapter

This module lets Orchy run a step of a flow under Pi, via its SDK
(`@earendil-works/pi-coding-agent`), building an agent session in-process
rather than spawning a command. It is one of the three harness adapters (the
others are Claude Code, in `src/claude.ts`, and Droid, in `src/droid.ts`)
and implements the `Harness`
interface from `src/harness.ts`: run one agent step, and later turn that
step's record into an ATIF `Trajectory` (the format defined in
`src/atif.ts`).

Structured output works through a custom tool. The adapter defines a
`submit_result` tool whose parameters are the step's `returns` JSON Schema,
and the value the model passes to that tool becomes the value of the step. A
model that answers in prose instead gets one reminder to call the tool; if it
still does not, the run fails with an error that quotes the model's last
answer — a second reminder has never helped.

Three details are load-bearing:

- **Only the declared tools exist.** The requested tools are checked against
  `SUPPLIES.pi` (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), and
  a request naming a tool outside that list throws rather than dropping it
  silently. The session is created with exactly the declared tools plus
  `submit_result`, so a step reaches what it declared and nothing else.
- **Resources load explicitly.** The adapter loads Pi's settings and
  resources itself before creating the session; without that, the user's
  extensions and skills never load, a custom provider is unknown, and Pi
  falls back to another model without a word.
- **A model name is a pair.** When `request.model` is given it must be the
  full `provider/model` form (as `"openai/gpt-5"`), because two providers can
  serve one model. A plain name is rejected, using the same grammar that
  `validate()` checks before a run starts.

Pi writes its session file one JSON line at a time, so the record of a step
is also the live report of it: while the step runs, the adapter tails that
file (via `src/tail.ts`) and turns each line into notes for the optional
`watch` callback.

## Exports

### `pi: Harness`

The adapter, with the two methods the interface asks for.

**`run(request, watch?)`** executes one step. It takes an `AgentRequest`
(`step`, `prompt`, `tools`, a `returns` JSON Schema, `cwd`, optional `model`)
and an optional `Watch` callback for live notes. It resolves to an
`AgentResult`: `value` is what the model passed to `submit_result`,
`trajectory` is the path of Pi's session file, and `cost` is what `costOf`
reads from that file. It rejects when a requested tool is outside
`SUPPLIES.pi`, when the model name is not `provider/model` or is unknown to
Pi, or when the step ends without a call to `submit_result` even after the
reminder.

**`toTrajectory(path, trajectoryId, version)`** reads the session file that a
`run` left behind — the handle is the path `run` returned — and converts it
into an ATIF `Trajectory`: user messages become user steps, assistant
messages become agent steps with tool calls, thinking, and per-step token
metrics, and tool results become system steps. The file is another program's
data, so it is read defensively: a missing file returns `undefined`, and a
half-written line is skipped rather than fatal.

### `costOf(path): number | undefined`

The total spend recorded in a session file, in dollars, or `undefined` when
there is nothing to report. The distinction matters for budgets: a provider
with no price table reports a cost of zero on every message, and a budget
that read that zero as a real price would never trigger. So a session that
reports zero throughout reports *no* cost, and `undefined` says so (see
ADR 0019).

Everything else in the file — the message parsing, the line-to-step
conversion, the wording of the failure message — is private to the module.

## Example

Run one step under Pi, watching it work, then fetch its trajectory:

```ts
import { Type } from "@sinclair/typebox";
import { pi } from "./pi.ts";

const result = await pi.run(
  {
    step: "health",
    prompt: "Read package.json and report the package name.",
    tools: ["read"],
    returns: Type.Object({ name: Type.String() }),
    cwd: process.cwd(),
    model: "openai/gpt-5",
  },
  (note) => console.log(`[${note.kind}] ${note.text}`),
);

console.log(result.value); // { name: "orchy" } — shaped by `returns`
console.log(result.cost); // spend in USD, or undefined if no price was reported

// Later, turn the run's record into an ATIF trajectory:
const trajectory = pi.toTrajectory(result.trajectory!, "run-42/step-3", "0.1.0");
```

In a real run, `src/run.ts` picks this adapter because the flow's step names
`pi` as its harness, and `validate()` has already checked the tools and the
model grammar against the tables in `src/harness.ts` before this module
loads.
