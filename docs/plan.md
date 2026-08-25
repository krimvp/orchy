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
daemon, and the daemon adds no rule about a flow. It holds one rule of its own,
and that rule is its door: it refuses a foreign `Origin`, a `Host` it does not
answer to, and a flow file outside its root. See [ADR
0020](./adr/0020-the-daemon-refuses-a-foreign-page.md).

A flow is data, not code. See [ADR
0004](./adr/0004-a-flow-is-data-not-code.md). A file and an editor produce
flows that carry no types, so `validate(flow)` is not optional. It refuses the
shape first, and then the meaning: a step reference that resolves to nothing, a
`when` key that the step it reads never returns, a tool or a model name that the
harness cannot take, a value that a step takes and nothing supplies, a promise
that no workspace can check, and a budget that is not a number of dollars.

The runner talks to a harness through an adapter with two methods. `run(request)`
returns the value of the step, a handle for the trajectory, and the cost when
the harness reports one. `toTrajectory(handle)` reads that record. Orchy ships
three adapters, for Pi, for the `claude` command, and for the `droid` command
of Factory. See [ADR 0001](./adr/0001-embed-pi-through-the-sdk.md) and [ADR
0002](./adr/0002-keep-a-harness-adapter.md).

An adapter gives the contract to its harness whole, and Orchy parses no prose.
The Pi adapter builds a `submit_result` tool whose parameters are the contract,
adds that tool to the list, and reads the value out of the one call. The
`claude` command takes the contract with `--json-schema` and answers with the
value. So a contract shapes what the model sees. The `droid` command takes no
schema, so its adapter appends the contract to the system prompt and reads the
one JSON value out of the answer — the nearest the command allows — and the
runner checks that value against the real schema either way.

The Pi adapter loads the resources of Pi itself, with a `DefaultResourceLoader`
and a `SettingsManager`. Without this the extensions and the skills of the user
never load. [docs/running.md](./running.md) says how to choose a model.

A run is local-first, and it also runs on a server and in CI. No part of a run
needs a terminal.

## The API

```ts
import { flow, agent } from "@krimvp/orchy";
import { Type } from "@sinclair/typebox";

export default flow("code-and-review", {
  workspace: { kind: "git", path: "." },
  harness: "claude",
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
      changes: "nothing",
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
a component as a TypeScript file that exports one function, and Orchy imports
it: Node strips the types, so a user writes TypeScript and does not compile it.
A component is also a command in any language, which Orchy runs as a process.
See [ADR 0026](./adr/0026-a-component-is-a-process.md).

**Gate** — a step that takes its value from a person. A gate is a kind of step,
not a component, so it names no prompt and no module. The run writes its state
to disk and ends. A person runs `orchy resume <run id> '{"approved":true}'`, and
Orchy checks that value against the same contract as any other step. A gate
holds a cycle, so a person rejects the work and sends the run back. Without it
the least trusted actor holds the control flow: an agent could send the run
back, and a person could not.

The same stop serves the `escalate` policy. When a cycle reaches its limit,
Orchy clears the value of the step and waits for a person to supply it. So one
mechanism covers a declared gate and an escalation. A gate refuses that policy,
because a person answers a gate already.

**Wave** — every step whose needs have passed runs at the same time, eight at
once unless the flow sets `parallel`. Orchy runs
a wave, settles it, and then works out the next one. So a panel of reviewers
runs together, and invariant 3 still holds because a step with an unfinished
need is not in the wave.

A wave that holds a promise and a step that may write runs one step at a time,
and `parallel` does not raise it. Invariant 5 reads a snapshot of the whole
workspace, so a step that runs beside a writer sees what that one wrote, and the
rule reports a change that the step did not make. A promise costs the speed of a
wave, and a rule that reports what it does not observe costs more.

A wave where every step promises `nothing` holds no writer, so it keeps the
width of the flow. A change there breaks the promise of every step in the wave,
which names too many steps and never too few, and in the ordinary case where
nothing moved it names none.

A wave settles one cycle. Two would fight for the same steps, so the run goes
back to the earliest target of the steps that voted, and the record of a vote
that the run does not act on keeps that vote.

**Cycle** — a step result can name an earlier step to return to. Orchy counts
the returns on that edge and stops at the limit. There is no loop construct in
the flow data. A cycle that names the step itself is a retry, and a cycle whose
condition is the word `failed` fires on a step that failed rather than on a
value. So one construct carries both, and a retry adds no second one.

A cycle clears the target and the steps that need it, and it keeps the rest. A
branch that needs nothing the cycle touches keeps its value and spends no tokens
twice. Every attempt that a cycle drops goes to the history of the run, because
a dropped attempt is still a cost.

Every failure in one wave takes its own cycle. A failure with a retry under its
limit goes back and hears its own error. A failure with no way back fails the
run. One failure alone still asks a person, because a stop takes one step.

Orchy carries the value that sent the run back to the step that it goes back to.
Without this the step runs again with no knowledge of the fault, and the cycle
repeats the same work. The value arrives as an input named after the step that
sent it.

**Condition** — a step holds `when`, a match against the value of each step that
it needs. A step that the condition rules out is skipped, and so is every step
that needs it, because the value it waits for never arrives. See [ADR
0014](./adr/0014-a-step-that-a-condition-rules-out.md).

**Operator** — the match against one value is the value itself, or one of five
operators: `is`, `not`, `empty`, `lt`, and `gt`. The set is closed, so a
dropdown draws it whole and no expression language grows. A condition on a step
and a condition on a cycle read the same match. See [ADR
0016](./adr/0016-a-match-holds-one-operator.md).

**Value** — what a step returns. A step returns a JSON value, and Orchy puts it
into the run state. A later step reads it. Orchy passes no other state.

**Policy** — what Orchy does when a cycle reaches its limit and the steps still
disagree. `escalate` opens a gate. `accept` continues and records the
disagreement.

**Takes and returns** — a flow holds `takes`, the schema of the values a run
supplies, and `returns`, the schema of the value it produces, which is the value
of the step it ends with. `orchy run --with`, the daemon, and a flow step all
supply the values, and every step of the run reads them. A name in a prompt
takes one, and a name that nothing supplies fails the step. A step holds `takes`
as well, for the values that must reach it. So invariant 2 guards what goes into
a step and what comes out of it. See [ADR
0015](./adr/0015-a-flow-takes-values-and-returns-one.md).

**Budget** — what the run may spend, in dollars. The flow declares one, and only
the flow that the run starts holds one. See the invariants below and [ADR
0019](./adr/0019-a-run-has-a-budget.md).

**Fanout** — a step that runs once for each member of a list. A member holds
`with`, the value that is its own. An agent step reads that value in its prompt,
and a component takes it as a third argument. So one prompt serves a list, and a
fanout over data needs no file for each member. **A flow step** —
a whole flow used as one step. Orchy turns both into plain steps before the run,
so the runner knows neither. This is why they cost the runner nothing.

One fanout is the exception. A fanout also holds `{ step, key }`, the place
where an earlier step puts the list. That list arrives with a value, so the run
expands that one when the step it reads is done. It is the one expansion that the runner performs, and it calls
the same expander that a file uses. See [ADR
0017](./adr/0017-a-fanout-over-a-value-the-run-computes.md).

A run holds the expanded flow, so the UI draws one step for each member of a
fanout. The editor draws the flow that the file holds, because that is what it
writes back, and it marks a fanout step as a stack with the number of members.
See [ADR 0010](./adr/0010-the-editor-writes-the-same-yaml-file.md).

**Workspace** — where a step acts, and the source of the record of what changed
there. One field, no default. See [ADR
0006](./adr/0006-one-workspace-field-with-no-default.md).

**Harness** — the flow names one, and a step names another when it wants one.
The narrower one wins, and `--harness` sets the default for a flow that names
none. Without the field on the flow, a flow could not say what it needs, and
`validate()` could not refuse `web` under Pi. See [ADR
0012](./adr/0012-a-flow-names-its-harness.md).

## The invariants

Orchy enforces these rules. A prompt does not.

1. **Tools** — an agent step calls only the tools that it declares. This is not
   a sandbox. A step that declares `bash` can change any file and can call the
   network. Orchy makes no claim about what a tool does after Orchy permits it.
2. **Contract** — the value of a step must match its schema. A user writes the
   schema with TypeBox, and Orchy checks the value as plain JSON Schema. See
   [ADR 0007](./adr/0007-check-a-contract-as-json-schema.md). The rule works
   both ways: the values that reach a step must match what the step `takes`,
   and the value of the run must match what the flow `returns`. A model accepts
   a value that is not there. It asks a person for it, or it guesses one.
3. **Order** — a step starts only after every step that it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run without
   end. A flow also declares a `budget`, in dollars, and the run stops before
   the next step when it reaches that budget. The run counts every attempt,
   including the ones a cycle threw away. A cycle limit bounds the rounds, and
   a budget bounds the money. See [ADR 0019](./adr/0019-a-run-has-a-budget.md).
5. **Provenance** — Orchy takes a workspace snapshot before and after each step,
   and records what moved. A step that declares `changes: nothing` fails when
   anything moved. A step that declares `changes: { paths: [docs] }` fails when
   anything outside those paths moved, and one that declares
   `changes: { except: [src] }` fails when anything inside `src` moved. The
   record names what each change did to a path: added, changed, deleted,
   renamed, restored, or moved. This is the rule that catches what `bash` does
   behind rule 1.

Rule 5 needs a workspace. A step with `bash` and no workspace has no record
beyond the text of the command. Only a sandbox closes that gap, and Orchy does
not ship one. `validate()` refuses a promise that no workspace can check, so the
rule never looks enforced when it is not. A bounded tool does not close it
either: Orchy intercepts no tool call, so only a harness can hold a bound, and
no harness that Orchy drives holds one. See [ADR
0018](./adr/0018-a-tool-list-is-not-a-sandbox.md).

A promise is a word and not a boolean. A boolean holds two values, and only one
of them ever meant anything. See [ADR
0013](./adr/0013-a-promise-is-a-word-not-a-boolean.md). A flow holds one promise
for every step that declares none, so a flow of read-only steps says it once.
Expansion carries the promise of a sub-flow onto each step of it, because a
promise that expansion drops is a rule that looks enforced and is not.

**The shape comes before the meaning.** A file and a graphical editor carry no
types. So `validate()` first refuses a field that the kind of a step cannot act
on, an unknown kind, an unknown workspace, and a missing contract. Ten fields
passed in silence before this landed, and one of them made a promise look
enforced when it was not.

The `git` workspace ignores everything under `.orchy/`, because the run state of
Orchy is not the work of the step.

## Events

A run calls `onEvent` when it starts, when a step starts, when a step ends, when
a condition rules a step out, when a step goes back, when the run waits for a
person, and when the run ends. The command line prints these, so a long flow is
not silent.

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
trajectory that its own adapter read from the record of its own harness.
`final_metrics` holds the token counts and the cost. See [ADR
0003](./adr/0003-write-trajectories-as-atif.md).

A step record reaches the disk as the step settles, and not when the wave ends.
So a wave that dies keeps every step that finished, with the trajectory and the
cost of each one.

A cycle runs a step more than once. A dropped run is still a cost, so the run
state keeps every dropped record and the trajectory holds them all, in the order
they happened. The record of a step that broke its promise or its contract keeps
its cost as well, because a retry of it spends again.

Each step record holds `startedAt` and `endedAt`, so a reader gets the duration
as well as the tokens. It holds `changed`, the path of each change and what the
step did to that path, and `cost`, when the harness of the step reports one.

The budget reads those same records, through one function, so the total that
stops a run and the total in `trajectory.json` are one number. A cost that no
harness reported is not a cost of zero, so a run with a budget stops when an
agent step reports none, and says that Orchy does not enforce a budget it cannot
measure.

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

**M8 — the shape of a flow. Done.** A study of the flow data found ten fields
that a user could write and nothing ever read, and four workflows that had no
shape at all. See [docs/shape.md](./shape.md). This milestone lands six changes:

1. `validate()` checks the shape before it reads any meaning.
2. A flow names its harness and its model, and a step overrides them.
3. A member holds `with`, so one prompt serves a list.
4. A promise is a word, and it takes a list of paths.
5. A step holds a condition, and a step it rules out is skipped.
6. A retry is a cycle to the step itself, on the word `failed`.

[examples/dependency-audit](../examples/dependency-audit) exercises five of the
six in one flow.

**M9 — the build, and the licence. Done.** Nothing ran the tests. A workflow now
installs the packages, runs the tests, runs the compiler, and builds the page,
on every push to main and on every pull request. So a broken example fails a
build that exists. The project holds the MIT text, which it named in two places
and did not hold. A trajectory names the version of the code that wrote it,
which `package.json` holds.

**M10 — the daemon holds its own door. Done.** The daemon listens on
`127.0.0.1`, and that is not a boundary against a browser. It now refuses a
foreign `Origin`, so a page a person visits starts nothing, and it refuses a
`Host` that it does not answer to, which closes DNS rebinding. It refuses a
flow file outside its root, which read a file anywhere on the machine before.
One number bounds the runs that the index holds, and the events of a run that
falls behind go when a run ends. See [ADR
0020](./adr/0020-the-daemon-refuses-a-foreign-page.md).

**M11 — the runner keeps its promise, and every attempt. Done.** Five faults in
the wave loop, and the first one broke invariant 5. A wave that holds a promise
now runs one step at a time, because a snapshot reads the whole workspace. A
step record reaches the disk as it settles. Every failure in a wave takes its
own cycle. A wave keeps the cycle votes it does not act on. A cycle clears the
target and the steps that need it, and keeps the rest, so a branch beside it
spends no tokens twice. Every dropped attempt reaches the history, which is
what makes the cost of a run whole.

**M12 — a flow takes values, and a run has a budget. Done.** The goal of this
plan reads "read the ticket, plan, code, review, open the merge request", and no
one could write that flow, because a flow took no values. This milestone lands
six changes:

1. A flow holds `takes` and `returns`, `orchy run --with` supplies the values,
   and a prompt holds `{{ name }}`. See [ADR
   0015](./adr/0015-a-flow-takes-values-and-returns-one.md).
2. A gate holds a cycle, so a person sends the run back, and a match holds one
   of five operators. See [ADR
   0016](./adr/0016-a-match-holds-one-operator.md).
3. A fanout runs over a list that a step computes. See [ADR
   0017](./adr/0017-a-fanout-over-a-value-the-run-computes.md).
4. A flow holds one promise for every step, a promise holds `{ except }`, and
   the record names what each change did to a path.
5. A flow holds `budget`, and `validate()` reads the grammar of a model name
   before the run. See [ADR 0019](./adr/0019-a-run-has-a-budget.md).
6. A step holds `takes`, so invariant 2 guards what goes into a step.

A probe of a bounded tool, such as a `bash` that names the commands it may run,
found that no harness Orchy drives can hold one. See [ADR
0018](./adr/0018-a-tool-list-is-not-a-sandbox.md).

**M13 — an agent authors a flow through MCP. Done.** `orchy mcp` serves the
Model Context Protocol on stdin and stdout: twelve tools, so a coding agent
writes a flow, hears every problem from `validate()`, runs it, follows it,
and answers a gate through the same contract check a person meets. The door
is a sibling of the HTTP one — it translates a call to the daemon and adds no
rule — and its engine fires no schedule, so it stands beside the long daemon
over one root. See [ADR
0024](./adr/0024-an-agent-authors-a-flow-through-mcp.md). A step of a flow
does not reach this door yet: that is a later decision with an ADR of its
own, because it touches the budget and the record.

**M14 — a step reaches the door of its own run. Done.** `orchy` is a tool a
step declares, and the claude adapter opens the MCP door of the run's root
for it. A run a step starts records `startedBy` in its state and its row,
`read_run` lists the children of a run with their costs and holds its answer
up to 55 seconds while a run works, `check_flow` reads a prompt before it is
written, and the door refuses a chain of runs that stands three deep. Every
claude step now rides `--strict-mcp-config`, so no server of the user's own
configuration exists for a step that declared none. See [ADR
0025](./adr/0025-a-step-reaches-the-door-of-its-own-run.md).

**M15 — a component is a process, and a step declares what it may start.
Done.** A call step holds a `command` in any language — JSON on stdin and
stdout, notes on stderr, a code that is not 0 fails the step — beside
`module`, and exactly one of the two. Orchy ships its first component,
`orchy:check`, which passes only when its command ends with 0, so a
deterministic check composes with the cycle a flow already holds. An agent
step that holds the `orchy` tool declares `starts` — the flows it may start,
and how many runs — and the door enforces the bound from the state on disk.
See [ADR 0026](./adr/0026-a-component-is-a-process.md) and [ADR
0027](./adr/0027-a-step-declares-what-it-may-start.md).

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

- A timeout for a step. A run stops at a budget of dollars, and not at a length
  of time.
- A workspace for one step, and a workspace for each run. Two runs in one
  working directory disturb each other, and `src/run.ts` names that limit in a
  `ponytail`. See [docs/shape.md](./shape.md).
- A remote sandbox workspace. A bounded tool is refused and not deferred. See
  [ADR 0018](./adr/0018-a-tool-list-is-not-a-sandbox.md).
- A user, a password, and a daemon that listens beyond this machine. The daemon
  refuses a foreign `Origin` and a foreign `Host`, which bounds a browser and
  not a program. See [ADR
  0020](./adr/0020-the-daemon-refuses-a-foreign-page.md).
- An optional need, so a step joins two branches when a condition rules one out.

## Defaults

These need no decision. Node 22, TypeScript, `node --test`, and components
shipped as ordinary npm packages.
