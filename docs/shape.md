# The shape of a flow

Status: a study, not a decision. It names where the flow data is weak, and what
to change. Nothing here is built. A change that this document proposes needs an
ADR when it lands.

[docs/plan.md](./plan.md) holds the design. This document holds the shape of the
data that a user writes.

## How I looked

I wrote flows that a user would plausibly want, and I ran each one through the
real loader, `validate()`, and the runner with a harness that spends no tokens.
I report what the code did, not what the types say.

Two questions drove the probes:

1. Which field can a user write that nothing ever reads?
2. Which flow has no shape at all?

## What a flow holds today

| Where | Field | Value |
| --- | --- | --- |
| flow | `name` | a string |
| flow | `workspace` | `{ kind: none }` or `{ kind: git, path }` |
| flow | `parallel` | a number, 8 when absent |
| step | `id`, `needs` | a name, and the names it waits for |
| step | `kind` | `agent`, `call`, `gate`, `flow` |
| agent | `prompt`, `tools`, `harness`, `model` | a path, a tool list, two names |
| call | `module` | a path |
| gate | `question` | a string |
| flow step | `flow` | a path |
| agent, call | `changes` | `false`, and nothing else |
| agent, call | `fanout` | a list of members |
| agent, call, flow step | `cycle` | `{ to, when, limit, policy }` |
| agent, call, gate | `returns` | JSON Schema |
| member | `name`, `harness`, `model`, `prompt`, `tools`, `module` | overrides |

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
changes: nothing            # what `changes: false` says today
changes: { paths: [docs/**] }   # what the grilling flow and the code flow want
```

Two flows in this repository would use the second line. The `record` step of
[examples/grilling](../examples/grilling) writes `CONTEXT.md` and `docs/adr/`
and nothing else. The `code` step of
[examples/code-review](../examples/code-review) writes source and no document.

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

The value reaches an agent step as a named block in the prompt, beside the
values of the steps before it. It reaches a component as a third argument, so a
component that ignores it still answers the same way.

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

A flow-level `harness` and `model`, which a step overrides, fixes both. It reads
the same as `workspace` and `parallel`, which are already flow-level with no
step override. The command line then overrides the flow, and the index holds a
default for a flow that names none.

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

**Do not build this until a real flow needs it.** Refuse `when` on a step today,
under finding 1. Then no flow written now changes its meaning on the day the
field arrives.

## Finding 6 — a retry has no home, and the cycle is the home it wants

`docs/plan.md` defers retries. The shape question is where one goes when it
arrives, and the answer is that the cycle already counts attempts on an edge.

Two rules block it:

- A cycle refuses `to` on the step itself. `validate()` says: `step "flaky"
  cycles to "flaky", which does not run before it`.
- A step that throws fails the whole run in the same wave. The cycle never gets
  a turn. I ran this, and the run ended `failed` on the first throw.

So a retry needs a self edge and a condition that reads a failure, not a value.
It needs no second construct. Keep it deferred, and do not invent one.

## Smaller notes

**A cycle throws away a branch it does not touch.** `goBackTo` clears every step
from the target onward in the sorted order, not the steps that depend on it. I
ran a flow with a cycle and one branch that needs nothing the cycle touches:

```
the steps ran in this order: code, far, review, code, far, review
```

`far` paid for its tokens twice. The code marks this a `ponytail`, and `needs`
already holds what the runner needs to fix it.

**A prompt is a path, so the editor draws a flow it cannot write.** `Editor.tsx`
edits the path of a prompt, and never the words. A tagged value, as the
workspace has, would let a short prompt live in the file:

```yaml
prompt: { file: prompts/review.md }
prompt: { text: Read the diff. Answer with the findings. }
```

**A flow is a kind, and a fanout is a field.** Both are expansions. A flow step
replaces one step, and a fanout multiplies one step, so the two shapes are
right. The documents never say this, and a reader asks.

**`limit` and `policy` are one idea.** `policy` only acts at the limit. Nesting
them says so:

```yaml
cycle: { to: code, when: { approved: false }, limit: { count: 3, then: escalate } }
```

I do not recommend it. Four flat fields read well, the editor draws them, and
the nesting buys one fewer question in the head of a reader.

**`returns` has no check.** Ajv answers `schema must be object or boolean`, and
names no step. Finding 1 covers it.

## What to change

In this order. Each row states the reason and the cost.

| # | Change | Why | Cost |
| --- | --- | --- | --- |
| 1 | `validate()` refuses a field that the kind of a step cannot hold, an unknown `kind`, an unknown workspace kind, and a missing `returns`. | Ten silent fields today. One of them makes a promise look enforced. | One table and one loop in `flow.ts`, and tests. No format change. |
| 2 | A flow names `harness` and `model`. A step overrides them. | A flow states what it needs. `validate()` can then refuse `web` on `pi` before the run. | `flow.ts`, `run.ts`, `cli.ts`, the editor, and `examples/research`. |
| 3 | A member holds `with`, and the value reaches the prompt and the component. | A fanout over a list has no shape today, and a call fanout cannot tell its members apart. | One field, one block in `buildPrompt`, one argument in `callModule`. |
| 4 | `changes` takes a word, not a boolean. `nothing` first, `{ paths }` when a flow needs it. | One legal value is not a boolean, and the field cannot grow. | Every example, the README, the editor checkbox, and `run.ts`. |
| 5 | A condition on a step. | The largest missing concept. | A third status, and a new answer for a step that needs a skipped step. |
| 6 | A retry, as a self edge on a cycle. | Deferred. Name the home now, so no second construct arrives. | Two rules in `validate()`, and a failure condition. |

Rows 1 to 3 add no question that a user must answer. Row 4 replaces one. Row 5
is a new concept, and it waits for a flow that needs it.
