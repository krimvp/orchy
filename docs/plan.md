# Plan

Status: draft. The open questions at the end are not settled.

## Goal

A user declares a flow, such as `read the ticket, plan, code, review, open the
merge request`. Orchy runs the flow. Orchy also enforces the rules that the
user declares, and records what each step did.

Three properties make Orchy different from a shell script:

1. **Composable** — a user wires supplied components together, and adds their
   own components.
2. **Enforced** — Orchy guarantees the declared invariants. It does not ask the
   model to respect them.
3. **Observable** — every run produces a measurable record and a trajectory for
   each step.

## Shape

Orchy is a command-line program and a library. It embeds Pi through the Pi SDK.
One step is one Pi agent session. Orchy owns the control flow.

```
orchy run flow.yaml
   │
   ├── step "plan"   → createAgentSession(...) → session JSONL + files
   ├── step "code"   → createAgentSession(...) → session JSONL + files
   └── step "review" → createAgentSession(...) → session JSONL + files
```

Reasons to embed Pi rather than to extend Pi:

- The value of Orchy is deterministic control flow. Control flow belongs in a
  process that Orchy owns, not inside one agent session.
- A Pi extension lives inside a single session. A flow needs many sessions with
  different prompts, tools, and models.
- The SDK gives the parts that Orchy needs directly: `createAgentSession`,
  `SessionManager`, and a typed event stream.

See [ADR 0001](./adr/0001-embed-pi-through-the-sdk.md).

## What Pi supplies

These facts come from the Pi documentation. They set the limits of the design.

| Need | Pi feature | Source |
| --- | --- | --- |
| Run one step | `createAgentSession({ model, tools, sessionManager })` | [SDK](https://pi.dev/docs/latest/sdk) |
| Limit the tools of a step | `tools`, `noTools`, `excludeTools`. Built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | [SDK](https://pi.dev/docs/latest/sdk) |
| Watch a step | `session.subscribe()` gives `tool_execution_start`, `turn_end`, `agent_end` | [SDK](https://pi.dev/docs/latest/sdk) |
| Record a trajectory | Sessions are JSONL files. Entries form a tree through `id` and `parentId` | [Session format](https://pi.dev/docs/latest/session-format) |
| Store Orchy data in a trajectory | `CustomEntry` holds a `customType` and a `data` field | [Session format](https://pi.dev/docs/latest/session-format) |
| Block a tool call | The `tool_call` event can block execution and can change the arguments | [Extensions](https://pi.dev/docs/latest/extensions) |
| Reuse prompts as components | Skills are `SKILL.md` files under `.pi/skills/` or `.agents/skills/` | [Skills](https://pi.dev/docs/latest/skills) |
| Ship components to users | A Pi package declares `pi.extensions` and `pi.skills` in `package.json` | [Packages](https://pi.dev/docs/latest/packages) |
| Choose a model | `getModel(provider, modelId)` from `@earendil-works/pi-ai` | [SDK](https://pi.dev/docs/latest/sdk) |

Pi supports 15 or more providers, and four run modes: interactive, print, RPC,
and JSON. Orchy needs only the SDK.

## The model

**Flow** — a YAML file. It holds a name and a list of steps.

**Step** — an entry in that list.

```yaml
name: ticket-to-mr
steps:
  - id: plan
    uses: agent
    prompt: prompts/plan.md
    tools: [read, grep, find, ls]
    produces: [plan.md]

  - id: code
    uses: agent
    needs: [plan]
    prompt: prompts/code.md
    tools: [read, write, edit, bash, grep, find, ls]
    produces: [.orchy/changed.txt]

  - id: review
    uses: agent
    needs: [code]
    prompt: prompts/review.md
    tools: [read, grep, find, ls]
    produces: [review.md]
```

**Component** — the value of `uses`. Orchy supplies `agent`. A user adds a
component with a TypeScript file that exports one function:

```ts
export default async function (step, ctx) {
  // ctx.workspace, ctx.log, ctx.run
  return { ok: true };
}
```

Orchy loads a user component with the same loader that Pi uses for extensions.
So a user writes TypeScript and does not compile it.

**Workspace** — one directory per run. The files in the workspace are the only
state between steps. A step declares what it produces. The next step reads the
file. Orchy passes no other data.

## The invariants

Orchy guarantees three rules in version 1. Each rule is cheap and each rule is
enforced by Orchy, not by a prompt.

1. **Tools** — a step receives only the tools that it declares. Orchy passes
   the list to `createAgentSession`. A step that declares read-only tools cannot
   write a file.
2. **Contract** — a step must produce every file in `produces`. Orchy checks the
   files after the session ends. A missing file fails the step.
3. **Order** — a step starts only after every step in `needs` passes.

These three rules make a trajectory match the declared flow. A step cannot
reach outside its declared tools, and a step cannot pass work forward that it
did not finish.

## Measurement

Orchy writes one record per run:

```
.orchy/runs/<run-id>/
├── run.jsonl          # one line per step event
├── plan.session.jsonl  # the trajectory of the step "plan"
├── code.session.jsonl
└── review.session.jsonl
```

For each step, `run.jsonl` records the start time, the end time, the token
count, the cost, the number of tool calls, the invariant results, and the
result.

Orchy also emits one OpenTelemetry span for each step, with the same fields as
attributes. OpenTelemetry is the boring choice. A user sends the spans to a
system that they already operate. Orchy ships no dashboard.

## Milestones

**M1 — a flow runs.** Read the YAML. Run each step as a Pi session. Enforce the
three invariants. Write `run.jsonl` and keep the session files. The target is a
two-step flow: `plan` then `code`.

**M2 — a user adds a component.** Load a TypeScript file that a step names in
`uses`.

**M3 — the spans.** Emit one OpenTelemetry span for each step.

**M4 — the proof.** Make the full flow work: read a ticket, plan, code, review,
open a merge request.

## Deferred

Orchy does not ship these until a real flow needs them. Each one is a knob, and
each knob costs the user a decision.

- Retries and timeouts for a step.
- A model choice for each step. Version 1 uses one model for the whole flow.
- Parallel steps. Version 1 runs the steps in order.
- Conditions and loops. A review step writes its findings to a file. A later
  step reads the file and repairs the code. This is a linear flow and it needs
  no loop. Add a loop when a real flow shows that the linear form fails.
- A second harness. Orchy calls the Pi SDK directly. It has no adapter layer.
  Add the layer when a second harness arrives.
- A user interface, a server, and a scheduler.

## Open questions

The `grill-with-docs` session covers these. See the questions in the reply that
accompanies this plan.
