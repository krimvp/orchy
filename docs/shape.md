# The shape of a flow

Status: built. This document reports the study that found six faults in the flow
data, and it records what each one cost. Every change below has landed, under
milestone M8 in [docs/plan.md](./plan.md). The decisions that are hard to
reverse are in [ADR 0012](./adr/0012-a-flow-names-its-harness.md), [ADR
0013](./adr/0013-a-promise-is-a-word-not-a-boolean.md), and [ADR
0014](./adr/0014-a-step-that-a-condition-rules-out.md).

Read this before you add a field, or change one. The study is the reason the
fields have the shapes they have.

[docs/plan.md](./plan.md) holds the design. This document holds the shape of the
data that a user writes.

## How I looked

I wrote flows that a user would plausibly want, and I ran each one through the
real loader, `validate()`, and the runner with a harness that spends no tokens.
I report what the code did, not what the types say.

Two questions drove the probes:

1. Which field can a user write that nothing ever reads?
2. Which flow has no shape at all?

## What a flow holds

The right column is what the study changed.

| Where | Field | Value |
| --- | --- | --- |
| flow | `name` | a string |
| flow | `workspace` | `{ kind: none }` or `{ kind: git, path }` |
| flow | `harness`, `model` | **new.** The default for every step |
| flow | `parallel` | a number, 8 when absent |
| step | `id`, `needs` | a name, and the names it waits for |
| step | `kind` | `agent`, `call`, `gate`, `flow` |
| agent, call, gate | `when` | **new.** A match against the value of a step it needs |
| agent | `prompt`, `tools`, `harness`, `model` | a path, a tool list, two names |
| call | `module` | a path |
| gate | `question` | a string |
| flow step | `flow` | a path |
| agent, call | `changes` | **changed.** `nothing`, or `{ paths }` |
| agent, call | `with` | **new.** A value the step holds |
| agent, call | `fanout` | a list of members |
| agent, call, flow step | `cycle` | `{ to, when, limit, policy }`, and `when` takes `failed` |
| agent, call, gate | `returns` | JSON Schema |
| member | `name`, `with`, and what its kind holds | overrides |

`validate()` refuses every field that this table does not name.

## Finding 1 — a file states a field, and nothing checks it

`validate()` checks the names, the order, and the contract. It never checks the
shape. A file and a graphical editor carry no types, so nothing checks them at
all.

I wrote 17 flows that a user writes by mistake. `validate()` reported a problem
for none of them. It crashed on one.

| What the file says | What `validate()` says | What the run does |
| --- | --- | --- |
| `cycle` on a gate step | nothing | The gate never sends the run back. |
| `harness` and `model` on a call step | nothing | It drops both. |
| `tools` on a call step | nothing | It drops the list. |
| `module` on a member of an agent step | nothing | Both members run one prompt. |
| `model` on a member of a call step | nothing | Both members do one job twice. |
| `changes: true` | nothing | It drops the promise. |
| `prompt` and `tools` on a gate step | nothing | It drops both. |
| `when` on a step | nothing | The step runs anyway. |
| `workspace` on a step | nothing | The step acts in the workspace of the flow. |
| `changes: { only: [docs/**] }` | nothing | The step wrote outside `docs/`, and passed. |
| a `kind` that does not exist | nothing | `TypeError: The "paths[1]" argument must be of type string` |
| a step with no `returns` | nothing | `schema must be object or boolean`, from Ajv |
| `workspace: { kind: git }` with no path | nothing | `TypeError: The "paths[1]" argument must be of type string` |
| `tool`, not `tools` | `TypeError: step.tools is not iterable` | it never starts |

An eleventh field turned up while the fix went in. `parseFlow` built a flow from
three fields and dropped the rest, so `parallel` in a file never reached the
runner at all. Two shipped examples set it. The parser now passes every field
through, and `validate()` is the one gate.

The last four say something. A Node message and an Ajv message name neither the
step nor the fix, and the last one crashes the check itself.

Row 10 is the worst one. A user writes a promise, reads no complaint, and gets
no rule. I proved it: the step wrote a file outside `docs/`, and the run passed.
The same step with `changes: false` failed, and said why.

[AGENTS.md](../AGENTS.md) states the cost. A rule that looks enforced and is not
costs more than a missing rule. A `fanout` on the wrong kind of step did this
once already, and this is the same fault in ten more places.

**This finding blocks every other change here.** Each change below adds a field.
A user who writes a new field on the wrong kind of step must hear about it.

**What landed.** `validate()` checks the shape before it reads any meaning. A
table in `flow.ts` names what each kind of step holds and what it must have, and
the check refuses everything else. It names the kinds that do hold a field, so a
user learns where it belongs. Every row above is now a sentence that names the
step and the fix.

## Finding 2 — `changes` is a boolean, and one value is legal

`changes?: false` is the only boolean in the flow data. It holds one legal
value, so it is not a boolean. It is a promise with one setting.

Three things follow:

- `changes: true` reads as "this step must change something". It means nothing,
  and nothing says so.
- The field cannot grow. A step that may write documents and nothing else has no
  way to say it. `changes: { only: [docs/**] }` passes and enforces nothing.
- The editor already draws the field as a checkbox, and the label says
  `Promises to change nothing in the workspace`. The page names the concept. The
  data names a boolean.

[ADR 0006](./adr/0006-one-workspace-field-with-no-default.md) met the same
question for the workspace, and it answered with a tagged value, so a new kind
costs no change to the format. The same answer fits here:

```yaml
changes: nothing                     # what `changes: false` said
changes: { paths: [docs, CONTEXT.md] }
```

**What landed.** Both lines above run. A path names a file, or a directory and
everything under it. A pattern language would invite `**/*.md`, and partial
support for one is a hidden failure. `validate()` refuses `changes: false` and
says what to write instead.

The record had to get more precise for this to mean anything: `git status`
collapses a wholly untracked directory into one entry such as `docs/`, so the
snapshot now runs `-uall` and names every file. See [ADR
0013](./adr/0013-a-promise-is-a-word-not-a-boolean.md).

## Finding 3 — a fanout carries configuration, and a flow wants data

A member overrides `harness`, `model`, `prompt`, `tools`, or `module`. Every one
of these is configuration. A member carries no data.

So a fanout serves three jobs, and it does one of them badly.

1. **A panel of roles.** [examples/decision](../examples/decision) gives each
   member its own prompt. This works.
2. **A panel of models.** [examples/research](../examples/research) gives three
   members the same model and the same prompt. That is not a fanout over
   anything. It is a repeat count, and the names `first`, `second`, and `third`
   carry no meaning.
3. **One job over a list.** "Audit each of these six packages." This has no
   shape. Each member needs its own prompt file, and the six files differ in one
   word.

A call step shows the hole plainly. I fanned one out over two members and
recorded what the module received:

```
the module was given: [{},"a function"]
the module was given: [{},"a function"]
```

The module cannot tell which member it is. So a fanout over a call step is two
identical calls, unless each member names a different file.

The fix is one field, not a new concept. `CONTEXT.md` already says that a member
"names itself and overrides only what differs from the step". Let the difference
be a value:

```yaml
fanout:
  - { name: core, with: { package: core } }
  - { name: cli, with: { package: cli } }
```

**What landed.** A member holds `with`, and expansion copies it onto the step.
An agent step reads it in the prompt under `The values this step holds`. A
component takes it as a third argument, so a component that ignores it still
answers the same way. [examples/dependency-audit](../examples/dependency-audit)
audits three packages from one prompt, and
[examples/research](../examples/research) now gives each reader its angle.

## Finding 4 — the flow does not name its harness

A step names a harness. A flow does not. So the default lives in three places,
and none of them is the flow:

- `--harness` on the command line, which is `pi` when absent.
- The `harness` column of the flow table in the index.
- The `harness` field of each step.

[ADR 0009](./adr/0009-the-database-indexes-the-runs-on-disk.md) says the index
is not the run. A setting that changes the result of a run should not live
there. The editor says the same thing out loud: the empty option of its harness
list reads `the default of the run`, because the flow cannot answer.

This costs two things.

**A flow repeats itself.** `examples/research/flow.yaml` writes
`harness: claude` four times, on four steps of four. It does this because the
flow needs Claude, and the flow has no other way to say so.

**`validate()` cannot check a tool.** The README says that `validate()` refuses
a tool that no harness has. It checks the union of the tool names, not the
harness. I ran it:

```
validate() on the research flow: nothing
validate() with no harness named: nothing
pi, at run time: pi has no tool for "web"
```

A user who drops the four `harness` lines gets a valid flow that fails in the
middle of a run, after the first step already spent its tokens.

**What landed.** A flow holds `harness` and `model`, and a step overrides them.
The narrower one wins, and `--harness` sets the default for a flow that names
none. `SUPPLIES` in `harness.ts` names the tools
of each adapter, beside the adapter names and not inside an adapter, so
`validate()` reads it without loading an SDK. A flow that asks for `web` under
`pi` now fails the check:

```
step "a" asks for the tool "web", and the harness "pi" has none
```

`examples/research/flow.yaml` names its harness once, and not four times. See
[ADR 0012](./adr/0012-a-flow-names-its-harness.md).

## Finding 5 — nothing says "do not run this step"

Every step in a flow runs. The only condition in the whole format is
`cycle.when`, and it sends the run backwards.

So this flow has no shape: "sort the issue; when it is severe, wake the
on-call agent; otherwise label it and stop." I wrote `when` on the step. The
step ran anyway, and nothing said a word.

The word is already here. `cycle.when` is a partial match against the value of a
step, and the comment in `flow.ts` says why it is a match and not an expression.
A condition on a step reads the same way.

This is the largest missing concept, and it is not one field. A step that does
not run has no value, so:

- Every step that needs it has one input missing.
- Its contract never holds, so `StepRecord` needs a third status.
- The wave loop ends when no step is ready. A skipped step never becomes ready,
  so the run reports `done` with steps missing, and says nothing.

**What landed.** The condition, and the answer to each of those three questions.
A step holds `when`, a match against the values of the steps it needs, keyed by
step id — the same shape as the inputs those steps already give it. A step that
the condition rules out is skipped, and so is every step that needs it, which
keeps invariant 3 whole. A record takes a third status, the run emits a `skip`
event with the reason, and the page draws a skipped step with a broken outline.

The cost is a join: a step that needs both branches is skipped when either is.
An optional need would lift that, and it is a second concept with a second
question for every user. It waits for a flow that needs it. See [ADR
0014](./adr/0014-a-step-that-a-condition-rules-out.md).

## Finding 6 — a retry has no home, and the cycle is the home it wants

`docs/plan.md` defers retries. The shape question is where one goes when it
arrives, and the answer is that the cycle already counts attempts on an edge.

Two rules block it:

- A cycle refuses `to` on the step itself. `validate()` says: `step "flaky"
  cycles to "flaky", which does not run before it`.
- A step that throws fails the whole run in the same wave. The cycle never gets
  a turn. I ran this, and the run ended `failed` on the first throw.

**What landed.** Both rules gave way, and no second construct arrived. A cycle
may name the step itself, and `when` takes the word `failed`, which reads the
record rather than a value. A step that throws and a step that breaks its
contract are both retried, because both are failures. The step hears the error
of its last attempt, so it does not repeat the mistake.

At the limit, `escalate` asks a person for the value. `accept` fails the run: a
failure carries no value, so there is nothing to accept.

## Smaller notes

**A cycle throws away a branch it does not touch.** `goBackTo` clears every step
from the target onward in the sorted order, not the steps that depend on it. I
ran a flow with a cycle and one branch that needs nothing the cycle touches:

```
the steps ran in this order: code, far, review, code, far, review
```

`far` paid for its tokens twice. The code marks this a `ponytail`, and `needs`
already holds what the runner needs to fix it.

**A flow is a kind, and a fanout is a field.** Both are expansions. A flow step
replaces one step, and a fanout multiplies one step, so the two shapes are
right. The documents never say this, and a reader asks.

**`limit` and `policy` are one idea.** `policy` only acts at the limit. Nesting
them would say so:

```yaml
cycle: { to: code, when: { approved: false }, limit: { count: 3, then: escalate } }
```

This did not land, and it should not. Four flat fields read well, the editor
draws them, and the nesting buys one fewer question in the head of a reader.

**`returns` had no check.** Ajv answered `schema must be object or boolean`, and
named no step. Finding 1 covers it, and the message now names the step.

## What changed

| # | Change | What it fixed |
| --- | --- | --- |
| 1 | `validate()` checks the shape before the meaning. | Eleven fields that a user could write and nothing ever read. |
| 2 | A flow names `harness` and `model`. | A flow could not state what it needs, and the check could not read a tool. |
| 3 | A member holds `with`. | A fanout over a list had no shape, and a call fanout could not tell its members apart. |
| 4 | `changes` takes a word, and a list of paths. | A boolean with one legal value, and a promise that looked enforced. |
| 5 | A step holds a condition. | A flow could not say "only when". |
| 6 | A retry is a cycle to the step itself. | A retry had no home, and would have grown a second construct. |

Rows 1 to 3 and 6 add no question that a user must answer. Row 4 replaces one.
Row 5 adds one, and only for a flow that wants it.

## What is still open

- **A cycle throws away a branch it does not touch.** The smaller note above
  still holds. `needs` carries what the runner needs to fix it.
- **A join over a skipped branch.** A step that needs two branches is skipped
  when either one is. An optional need would lift it.
- **A fanout whose members a step decides at run time.** Expansion happens
  before the run, so the list is what the file says. This is what makes a fanout
  cost the runner nothing, and what a graphical editor draws.
- **A workspace for one step.** The flow holds one. A flow that reads one
  repository and patches another has no shape.
- **A prompt that lives in the file.** A prompt is a path, so the editor draws a
  flow whose words it cannot write.
