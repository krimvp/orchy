# Plan

Status: draft. Round 1 of the grilling is settled. Round 2 is open. The
mechanisms in "Open questions" are not decided.

## Goal

A user declares a flow, such as `read the ticket, plan, code, review, open the
merge request`. Orchy runs the flow, enforces the rules that the user declares,
and records what each step did.

Three properties make Orchy different from a shell script:

1. **Composable** — a user wires supplied components together, and adds their
   own components.
2. **Enforced** — Orchy guarantees the declared invariants. It does not ask the
   model to respect them.
3. **Observable** — every run produces a measurable record and a trajectory for
   each step, in a standard format.

## Shape

The programmatic API is the product. A file format and, later, a graphical
editor are layers above it. All three produce the same data.

```
TypeScript API ─┐
YAML file ──────┼──▶  Flow (data)  ──▶  Runner  ──▶  Run record + trajectories
Graphical editor┘
```

This makes one rule: **a flow is data, not code.** The wiring of the steps is
serializable. Code lives inside a component, never in the wiring. A graphical
editor cannot draw arbitrary TypeScript, so the API must not permit it.

The runner talks to a harness through an adapter. Orchy ships one adapter, for
Pi. See [ADR 0001](./adr/0001-embed-pi-through-the-sdk.md) and [ADR
0002](./adr/0002-keep-a-harness-adapter.md).

A run is local-first, but it must also run on a server and in CI. So no part of
a run needs a terminal.

## What Pi supplies

These facts come from the Pi documentation. They set the limits of the design.

| Need | Pi feature | Source |
| --- | --- | --- |
| Run one agent step | `createAgentSession({ model, tools, sessionManager })` | [SDK](https://pi.dev/docs/latest/sdk) |
| Limit the tools of a step | `tools`, `noTools`, `excludeTools`. Built-in tools are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | [SDK](https://pi.dev/docs/latest/sdk) |
| Watch a step | `session.subscribe()` gives `tool_execution_start`, `turn_end`, `agent_end` | [SDK](https://pi.dev/docs/latest/sdk) |
| Record a trajectory | Sessions are JSONL files. Entries form a tree through `id` and `parentId` | [Session format](https://pi.dev/docs/latest/session-format) |
| Block a tool call | The `tool_call` event can block execution and can change the arguments | [Extensions](https://pi.dev/docs/latest/extensions) |
| Reuse prompts | Skills are `SKILL.md` files under `.pi/skills/` or `.agents/skills/` | [Skills](https://pi.dev/docs/latest/skills) |
| Choose a model | `getModel(provider, modelId)` from `@earendil-works/pi-ai` | [SDK](https://pi.dev/docs/latest/sdk) |

## The model

**Step** — one unit of work. A step is deterministic or non-deterministic. A
step that reads a ticket is an API call and spends no tokens. A step that writes
code is an agent session.

**Component** — the code that a step calls. Orchy supplies `agent` and `gate`. A
user adds a component as a TypeScript file that exports one function. Orchy
loads it with the same loader that Pi uses, so a user writes TypeScript and does
not compile it.

**Gate** — a step that stops the run and waits for a person. Because a run must
work on a server, a gate does not block a process. The run writes its state to
disk and ends. A person answers, and the run continues.

**Cycle** — a group of steps that repeat, such as code and then review. A flow
sets a limit on the number of cycles, and a policy for the case where the limit
is reached and the steps still disagree.

## The invariants

Orchy guarantees these rules. Orchy enforces each one, not a prompt.

1. **Tools** — an agent step receives only the tools that it declares. A step
   that declares read-only tools cannot write a file.
2. **Contract** — a step must produce the result that it declares. Orchy checks
   the result after the step ends.
3. **Order** — a step starts only after every step that it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run without
   end.

## Measurement

Orchy writes one ATIF trajectory for each run. Each step becomes a child
trajectory. `final_metrics` holds the token counts and the cost. See [ADR
0003](./adr/0003-write-trajectories-as-atif.md).

Orchy ships no exporter and no dashboard. A user converts ATIF to OpenTelemetry
spans with a tool that already does it.

## Milestones

**M1 — a flow runs.** The TypeScript API builds a flow as data. The runner runs
each step, through the Pi adapter for an agent step and directly for a
deterministic step. It enforces the tool, contract, and order invariants, and
writes the run state to disk after each step.

**M2 — the cycle and the gate.** Code and review repeat to a limit. A gate stops
the run and `orchy resume` continues it. Both features use the run state from
M1.

**M3 — ATIF.** Convert the Pi session file into an ATIF trajectory.

**M4 — the file format.** A YAML loader that produces the same flow data as the
API.

## Deferred

Orchy does not ship these until a real flow needs them.

- Retries and timeouts for a step.
- A model choice for each step. Version 1 uses one model for the whole flow.
- Parallel steps.
- A second adapter, a server, a scheduler, and a graphical editor.

## Open questions

Round 2 of the grilling covers the mechanisms: how a run suspends and resumes,
how the API stays serializable, how a step passes a value to the next step, the
shape of the cycle, the disagreement policy, the members of the adapter, and the
version of ATIF to pin.
