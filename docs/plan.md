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
                                                           │
                                     orchy daemon ──────────┤
                                       queue, API, UI       ▼
                                                     index.db (a list)
```

The daemon is a layer above the runner, not a part of it. It starts
`orchy run --events` as a child process for each run, reads the events of that
child, and indexes the run state that the child writes. So a run needs no
daemon, and the daemon adds no rule of its own.

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

The adapter loads the resources of Pi itself, with a `DefaultResourceLoader` and
a `SettingsManager`. Without this the extensions and the skills of the user
never load. [docs/running.md](./running.md) says how to choose a model.

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

Every field in this example runs today.

## The model

**Step** — one unit of work. A step is deterministic or non-deterministic. A
step that reads a ticket is an API call and spends no tokens. A step that writes
code is an agent session.

**Component** — the code that a step calls. Orchy supplies `agent`. A user adds
a component as a TypeScript file that exports one function. Orchy loads it with
the same loader that Pi uses, so a user writes TypeScript and does not compile
it.

**Gate** — a step that takes its value from a person. A gate is a kind of step,
not a component, so it names no prompt and no module. The run writes its state
to disk and ends. A person runs `orchy resume <run id> '{"approved":true}'`, and
Orchy checks that value against the same contract as any other step.

The same stop serves the `escalate` policy. When a cycle reaches its limit,
Orchy clears the value of the step and waits for a person to supply it. So one
mechanism covers a declared gate and an escalation.

**Wave** — every step whose needs have passed runs at the same time, eight at
once unless the flow sets `parallel`. Orchy runs
a wave, settles it, and then works out the next one. So a panel of reviewers
runs together, and invariant 3 still holds because a step with an unfinished
need is not in the wave.

**Cycle** — a step result can name an earlier step to return to. Orchy counts
the returns on that edge and stops at the limit. There is no loop construct in
the flow data.

Orchy carries the value that sent the run back to the step that it goes back to.
Without this the step runs again with no knowledge of the fault, and the cycle
repeats the same work. The value arrives as an input named after the step that
sent it.

**Value** — what a step returns. A step returns a JSON value, and Orchy puts it
into the run state. A later step reads it. Orchy passes no other state.

**Policy** — what Orchy does when a cycle reaches its limit and the steps still
disagree. `escalate` opens a gate. `accept` continues and records the
disagreement.

**Fanout** — a step that runs once for each member of a list. **A flow step** —
a whole flow used as one step. Orchy turns both into plain steps before the run,
so the runner knows neither. This is why they cost the runner nothing.

A run holds the expanded flow, so the UI draws one step for each member of a
fanout. The editor draws the flow that the file holds, because that is what it
writes back, and it marks a fanout step as a stack with the number of members.
See [ADR 0010](./adr/0010-the-editor-writes-the-same-yaml-file.md).

**Workspace** — where a step acts, and the source of the record of what changed
there. One field, no default. See [ADR
0006](./adr/0006-one-workspace-field-with-no-default.md).

## The invariants

Orchy enforces these rules. A prompt does not.

1. **Tools** — an agent step calls only the tools that it declares. This is not
   a sandbox. A step that declares `bash` can change any file and can call the
   network. Orchy makes no claim about what a tool does after Orchy permits it.
2. **Contract** — the value of a step must match its schema. A user writes the
   schema with TypeBox, and Orchy checks the value as plain JSON Schema. See
   [ADR 0007](./adr/0007-check-a-contract-as-json-schema.md).
3. **Order** — a step starts only after every step that it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run without
   end.
5. **Provenance** — Orchy takes a workspace snapshot before and after each step,
   and records what moved. A step that declares `changes: false` fails when
   anything moved. This is the rule that catches what `bash` does behind rule 1.

Rule 5 needs a workspace. A step with `bash` and no workspace has no record
beyond the text of the command. Only a sandbox closes that gap, and Orchy does
not ship one. `validate()` refuses a `changes: false` promise that no workspace
can check, so the rule never looks enforced when it is not.

The `git` workspace ignores everything under `.orchy/`, because the run state of
Orchy is not the work of the step.

## Events

A run calls `onEvent` when a step starts, when a step ends, when a step goes
back, when the run waits for a person, and when the run ends. The command line
prints these, so a long flow is not silent.

The daemon reads the same events. `orchy run --events` writes one JSON event for
each line, a child process of the daemon writes to that stream, and the daemon
keeps every event and sends it to the UI. A run names itself with `run_start`
first, so the daemon knows the run that a child drives.

A step says what it does while it does it, through an `output` event. The
adapter takes the second argument that this plan reserved for it, and it reports
by reading the record that the harness already writes. A deterministic step
reports the same way, because a component takes that argument as well. See [ADR
0011](./adr/0011-a-step-reports-by-reading-its-own-record.md).

## Measurement

Orchy writes `trajectory.json` beside the run state, at every point where the
run stops. The file is one ATIF trajectory at `schema_version: "ATIF-v1.7"`. Each
run of each step is one root step, and each agent step carries a child
trajectory read from the Pi session file. `final_metrics` holds the token counts
and the cost. See [ADR 0003](./adr/0003-write-trajectories-as-atif.md).

A cycle runs a step more than once. A dropped run is still a cost, so the run
state keeps every dropped record and the trajectory holds them all, in the order
they happened.

Each step record holds `startedAt` and `endedAt`, so a reader gets the duration
as well as the tokens.

The UI of the daemon draws the trajectory. Each run of each step opens on the
turns that the harness took: the reasoning, the tool calls with their arguments,
the results, and the tokens of each turn. A run that a cycle threw away is
marked as one, because it is still a cost. Orchy ships no exporter. A user
converts ATIF to OpenTelemetry spans with a tool that already does it.

## Milestones

**M1 — a flow runs. Done.** The API builds a flow as data. `validate()` checks
it. The runner runs each step, through the Pi adapter for an agent step and
through a module for a deterministic step. It enforces rules 1 to 3, and writes
the run state to disk after each step. `orchy run <flow file>` runs a flow.

**M2 — the cycle and the gate. Done.** Rule 4. A step returns to an earlier step
to a limit, and a policy decides what happens at the limit. A gate stops the
run, and `orchy resume <run id> <json value>` continues it. A run reports what it
does through events. This milestone lands the first proof flow, in
[examples/code-review](../examples/code-review).

**M3 — the workspace. Done.** Rule 5, with the `git` and `none` kinds. This
milestone lands the second proof flow, in [examples/grilling](../examples/grilling):
a grilling session that asks a person questions in rounds, and reviews its own
decisions.

**M4 — ATIF. Done.** Convert the Pi session file into an ATIF trajectory, and
write one for every run.

**M5 — the file format. Done.** A YAML loader that produces the same flow data
as the API. [examples/code-review](../examples/code-review) holds the same flow
twice, as `flow.ts` and as `flow.yaml`, and a test keeps the two equal.

A file names the `kind` of each step, exactly as the data does. The file format
is a serialization, not a friendlier language, so a graphical editor writes the
same file with no translation.

**M6 — the daemon, the backend, and the UI. Done.** `orchy daemon` holds a
queue, starts each run as a child process, and serves an API and a page. A
person registers a flow, starts a run, watches the steps as they run, answers a
gate, reads the value and the cost of each step, and edits a flow as a drawing.

Three decisions carry this milestone. The daemon runs each run in a child
process, so a run that dies takes nothing with it. See [ADR
0008](./adr/0008-the-daemon-runs-each-run-in-a-child-process.md). A SQLite
database indexes the runs on disk, and the state on disk stays the run. See [ADR
0009](./adr/0009-the-database-indexes-the-runs-on-disk.md). The editor writes
the same YAML file that a person reads, so a flow lives in one place. See [ADR
0010](./adr/0010-the-editor-writes-the-same-yaml-file.md).

**M7 — what a step says, and the record it leaves. Done.** A step reports while
it works, and the page shows each note as it arrives. The page also draws the
trajectory: every run of every step, opening on the turns that the harness took,
with the reasoning, the tool calls, the results, and the tokens of each turn. A
run that a cycle threw away is marked as one. An adapter reports by reading the
record that it already writes, so no harness is started a different way. See
[ADR 0011](./adr/0011-a-step-reports-by-reading-its-own-record.md).

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
- A remote sandbox workspace.
- A scheduler. Nothing starts a run except a person and the command line.
- A user, a password, and a daemon that listens beyond this machine.

## Defaults

These need no decision. Node 22, TypeScript, `node --test`, and components
shipped as ordinary npm packages.
