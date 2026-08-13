# `src/harness.ts` — the contract between Orchy and its harness adapters

This module defines what a harness adapter is, without being one. The two
adapters (`src/pi.ts` and `src/claude.ts`) each drive a coding agent; this
file holds the interface they implement, the request and result shapes they
exchange, and three small tables of facts about them — which adapters exist,
which tools each supplies, and what each accepts as a model name. The tables
live here rather than inside the adapters so that `validate()` can refuse a
bad flow — an unknown harness, a tool the harness lacks, a model name in the
wrong grammar — without loading the SDK of any harness.

It also owns the one piece of shared behavior: turning an ATIF `Step` into
short `Note`s for live output, which both adapters use to report what a step
is doing while it runs.

## Exports

Tables and their types:

- `ADAPTERS` — `["pi", "claude"]`, the name of every adapter.
  `AdapterName` is the union of those names.
- `TOOLS` — the nine harness-neutral tool names a flow may declare
  (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `web`, `orchy`);
  each adapter maps them to its own. `orchy` is the door of the run's own
  root, served over MCP (ADR 0025). `ToolName` is their union.
- `SUPPLIES: Record<AdapterName, readonly ToolName[]>` — which of those
  tools each adapter supplies. Pi supplies everything but `web` and
  `orchy`; Claude supplies all nine. `validate()` reads it to refuse a tool
  the harness lacks, and each adapter checks requests against its own row.
- `MODELS: Record<AdapterName, { reads: RegExp; write: string }>` — the
  grammar of a model name per adapter (`reads`) and the message to show
  when a name fails it (`write`). Pi reads a `provider/model` pair like
  `"openai/gpt-5"`; Claude reads a plain name like `"opus"`. Only the
  grammar is checked here — which models exist is the harness's business
  (ADR 0019).

Shapes:

- `AgentRequest` — what a harness is asked to run: `step` (name), `prompt`,
  `tools`, `returns` (the JSON Schema for the structured output), `cwd`,
  an optional `model` string that only that harness reads, and an optional
  `run` — the run this step belongs to, so a run the step starts through the
  `orchy` tool records who asked (ADR 0025).
- `AgentResult` — what comes back: the structured `value`, an optional
  `trajectory` handle that only the same harness understands (a file path,
  a session id), and an optional `cost` for adapters whose trajectory does
  not carry the spend.
- `Note` — one thing a step did, while it did it: a `kind` (`"prompt"` —
  what the step asked, after Orchy read its file and filled every name in it
  — `"text"`, `"reasoning"`, `"tool"`, or `"result"`) and a `text` of at most
  400 characters. A note is a view, not a record; the trajectory holds the
  whole of it.
- `Watch` — `(note: Note) => void`, the callback for live notes.
- `Harness` — the interface each adapter implements (ADR 0002):
  `run(request, watch?)` resolves to an `AgentResult`, and
  `toTrajectory(handle, trajectoryId, version)` turns the handle a `run`
  returned into an ATIF `Trajectory`, or `undefined` when no record exists.

One function:

- `notesOf(step: Step): Note[]` — converts one ATIF `Step` into notes: its
  reasoning, its message (for agent steps), each tool call with its
  arguments, and each non-empty tool result, every one trimmed to 400
  characters. Both adapters already read their own record as ATIF steps
  while it grows, so both report through this one function.

## Example

Turn an ATIF step into notes and print them, the way an adapter feeds its
`Watch` callback:

```ts
import { notesOf } from "./harness.ts";
import type { Step } from "./atif.ts";

const step: Step = {
  step_id: 3,
  timestamp: "2026-08-10T12:00:00Z",
  source: "agent",
  message: "Reading the manifest.",
  tool_calls: [{ tool_call_id: "1", function_name: "read", arguments: { path: "package.json" } }],
};

for (const note of notesOf(step)) {
  console.log(`[${note.kind}] ${note.text}`);
}
// [text] Reading the manifest.
// [tool] read {"path":"package.json"}
```

In a real run, `validate()` reads `ADAPTERS`, `SUPPLIES`, and `MODELS` from
this module to check a flow before any harness loads, and `run.ts` then calls
the chosen adapter through the `Harness` interface.
