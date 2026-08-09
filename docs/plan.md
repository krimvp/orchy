# Plan

Status: settled. The grilling closed every open decision. The decisions that are
hard to reverse are in [docs/adr](./adr). The words are in
[CONTEXT.md](../CONTEXT.md).

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

Orchy is not only for code. A flow that touches no files is a first-class case.

## Shape

The programmatic API is the product. A file format and, later, a graphical
editor are layers above it. All three produce the same data.

```
TypeScript API ─┐
YAML file ──────┼──▶  Flow (data)  ──▶  validate()  ──▶  Runner
Graphical editor┘                                          │
                                                           ▼
                                             Run state + ATIF trajectory
```

A flow is data, not code. See [ADR
0004](./adr/0004-a-flow-is-data-not-code.md). A file and an editor produce
flows that carry no types, so `validate(flow)` is not optional. It checks that
every step reference resolves, and that every `when` key exists in the schema of
the step that it reads.

The runner talks to a harness through an adapter with one method: `run(request)`
returns the value of the step and the path of the trajectory. Orchy ships one
adapter, for Pi. See [ADR 0001](./adr/0001-embed-pi-through-the-sdk.md) and [ADR
0002](./adr/0002-keep-a-harness-adapter.md).

The adapter gets the value of an agent step from a tool. It builds a
`submit_result` tool whose parameters are the contract of the step, and it adds
that tool to the list. The agent calls it once, and the arguments are the value.
So a contract shapes the tool that the model sees, and Orchy does not parse
prose.

A run is local-first, and it also runs on a server and in CI. No part of a run
needs a terminal.

## The API

```ts
import { flow, agent } from "orchy";
import { Type } from "@sinclair/typebox";

export default flow("code-and-review", {
  workspace: { kind: "git", path: "." },
  steps: [
    agent({
      id: "code",
      prompt: "prompts/code.md",
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      returns: Type.Object({ summary: Type.String() }),
    }),
    agent({
      id: "review",
      needs: ["code"],
      prompt: "prompts/review.md",
      tools: ["read", "grep", "find", "ls"],
      changes: false,
      returns: Type.Object({
        approved: Type.Boolean(),
        findings: Type.Array(Type.String()),
      }),
      cycle: { to: "code", when: { approved: false }, limit: 3, policy: "escalate" },
    }),
  ],
});
```

`agent()` is generic over the schema in `returns`, so TypeScript checks that the
keys in `when` exist in the value that the step returns. Step names in `needs`
and `cycle.to` are plain strings, and `validate()` checks them. A chained
builder would type those names, but it would cost the array, and it would help
only the users who write TypeScript.

## The model

**Step** — one unit of work. A step is deterministic or non-deterministic. A
step that reads a ticket is an API call and spends no tokens. A step that writes
code is an agent session.

**Component** — the code that a step calls. Orchy supplies `agent`. A user adds
a component as a TypeScript file that exports one function. Orchy loads it with
the same loader that Pi uses, so a user writes TypeScript and does not compile
it.

**Gate** — a step that takes its value from a person. A gate is a field on a
step, not a component. The run writes its state to disk and ends. A person runs
`orchy resume <run-id> --value '{"approved":true}'`, and Orchy checks that value
against the same contract as any other step.

**Cycle** — a step result can name an earlier step to return to. Orchy counts
the returns on that edge and stops at the limit. There is no loop construct in
the flow data.

**Value** — what a step returns. A step returns a JSON value, and Orchy puts it
into the run state. A later step reads it. Orchy passes no other state.

**Policy** — what Orchy does when a cycle reaches its limit and the steps still
disagree. `escalate` opens a gate. `accept` continues and records the
disagreement.

**Workspace** — where a step acts, and the source of the record of what changed
there. One field, no default. See [ADR
0006](./adr/0006-one-workspace-field-with-no-default.md).

## The invariants

Orchy enforces these rules. A prompt does not.

1. **Tools** — an agent step calls only the tools that it declares. This is not
   a sandbox. A step that declares `bash` can change any file and can call the
   network. Orchy makes no claim about what a tool does after Orchy permits it.
2. **Contract** — the value of a step must match its TypeBox schema. Orchy
   checks the value after the step ends.
3. **Order** — a step starts only after every step that it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run without
   end.
5. **Provenance** — Orchy takes a workspace snapshot before and after each step,
   and records the difference. A step that declares `changes: false` fails when
   the snapshot moves. This is the rule that catches what `bash` does behind
   rule 1.

Rule 5 needs a workspace. A step with `bash` and no workspace has no record
beyond the text of the command. Only a sandbox closes that gap, and Orchy does
not ship one.

## Measurement

Orchy writes one ATIF trajectory for each run, at schema version 1.7. Each step
becomes a child trajectory. `final_metrics` holds the token counts and the cost.
See [ADR 0003](./adr/0003-write-trajectories-as-atif.md).

Orchy ships no exporter and no dashboard. A user converts ATIF to OpenTelemetry
spans with a tool that already does it.

## Milestones

**M1 — a flow runs. Done.** The API builds a flow as data. `validate()` checks
it. The runner runs each step, through the Pi adapter for an agent step and
through a module for a deterministic step. It enforces rules 1 to 3, and writes
the run state to disk after each step. `orchy run <flow file>` runs a flow.

**M2 — the cycle and the gate.** Rule 4. A step returns to an earlier step to a
limit, and a policy decides what happens at the limit. A gate stops the run, and
`orchy resume` continues it. This milestone lands the first proof flow: code and
review.

**M3 — the workspace.** Rule 5, with the `git` and `none` kinds. This milestone
lands the second proof flow: a grilling session that asks a person questions in
rounds, and reviews its own decisions.

**M4 — ATIF.** Convert the Pi session file into an ATIF trajectory.

**M5 — the file format.** A YAML loader that produces the same flow data as the
API.

## The proof flows

Two flows prove the design, and they stress different parts.

**Code and review** proves the cycle. Code writes, review reads, and review
returns to code until it approves or reaches the limit.

**A grilling session** proves the gate. The agent asks a person a round of
questions, a gate takes the answers, and the flow returns to the agent for the
next round. It ends when the agent has no more questions. It also reviews its
own decisions, so it exercises the cycle a second way.

Both flows use a code repository. So the `none` workspace ships with test cover
only, which [ADR 0006](./adr/0006-one-workspace-field-with-no-default.md)
records as a known risk.

## Deferred

Orchy does not ship these until a real flow needs them.

- Retries and timeouts for a step.
- A model choice for each step. Version 1 uses one model for the whole flow.
- Parallel steps, and the step isolation that they need.
- A remote sandbox workspace.
- A second adapter, a server, a scheduler, and a graphical editor.

## Defaults

These need no decision. Node 22, TypeScript, `node --test`, and components
shipped as ordinary npm packages.
