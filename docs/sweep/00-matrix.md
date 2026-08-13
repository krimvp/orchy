# The sweep — 100 flows, ten batches

Read `00-brief.md` beside this file first; every rule there holds. This file says
which flows exist and who writes them, so no two agents write the same one.

Ten agents. Each writes **ten flows** of its own batch, in its own directory, and
runs each flow **at least twice** — more where the batch says so — across the
harness and model combinations named below. Deterministic `call` and `gate` steps
cost nothing; run those as often as you like.

## Money

Real agent steps cost real money. Per agent: **stay under $1.50**, and report the
total you actually spent by summing the `cost` of every run you started
(`.orchy/runs/<id>/state.json`, or the state the CLI prints). Prefer
`model: haiku` and one-line prompts. Do not run an agent step to prove something a
`call` step proves for free — spend a model call only where the model *is* the
test.

## Harness and model combinations

Where a batch calls for agent steps, walk this list rather than picking one:

| # | harness | model | expectation |
|---|---------|-------|-------------|
| A | claude | *(none named)* | runs on the harness's own default |
| B | claude | `haiku` | runs |
| C | claude | `sonnet` | runs |
| D | claude | `no-such-model` | fails, and says so before or during the step |
| E | claude | `anthropic/claude-haiku` | wrong grammar for this adapter |
| F | pi | `openai/gpt-5` | the harness is not installed here |
| G | pi | `gpt-5` | wrong grammar for this adapter |

## What to record

Two files, both in `/tmp/claude-0/-home-user-orchy/b311d40f-dc91-564a-af5e-d08b95ea2a20/scratchpad/findings/`:

1. `batch-<n>.md` — your findings, in the shape `00-brief.md` gives, worst first.
2. `batch-<n>.tsv` — one line per run you made, tab separated, no header:

```
flow-name	harness	model	what you did	outcome	as expected?	one-line note
```

`outcome` is one of `done failed waiting stopped refused error`. `as expected?`
is `yes` or `no`. A `no` must have a finding in the `.md`.

## The batches

**Batch 1 — shapes of a flow.** One step. Two in one wave. A chain of three. A
diamond (one splits to two, two join to one). Six in one wave. A chain of twenty.
Two branches that never meet. A wave under `parallel: 1`. Twelve steps under
`parallel: 8`. A step that needs two steps that need one step. All `call` steps —
prove the order, the concurrency, and the timings, and check the wave really is a
wave and not a queue.

**Batch 2 — gates.** A gate as the first step. A gate in the middle. Two gates in
one flow. A gate whose contract holds a string, a number, a boolean, an array, and
an optional field. A gate answered through `POST /api/runs/:id/resume`, and one
answered by `orchy resume` at the command line. A gate answered with a value the
contract refuses. A gate that also carries `when`. A gate on a flow that takes
values. A gate whose question is 500 characters. A gate on a flow with no other
step.

**Batch 3 — fanout.** Over a list written in the flow. Over a list a step
computes. Over an empty list. Over one member. Over twelve members. A fanout whose
member fails. A member that retries itself. A fanout with a condition on it. A
fanout whose members feed a later step. A fanout inside a flow that another flow
calls.

**Batch 4 — conditions.** One flow for each operator in `GET /api/health`
(`is`, `not`, `empty`, `lt`, `gt`). A condition that names a key the value does
not hold. A condition on a nested field. A step ruled out whose dependents still
need it. Two conditions in a chain. A condition that is true only after a cycle.

**Batch 5 — cycles.** A step that retries itself on failure. A cycle back to an
earlier step on a value. `limit: 1`. `limit: 3` with `policy: escalate`. The same
with `policy: accept`. A cycle that leaves an untouched branch alone. Two cycles
in one flow. A cycle whose target is a step that a fanout expanded. A cycle from a
gate, answered twice. A cycle to a step that a condition had ruled out.

**Batch 6 — budget and cost.** `budget: 0`. A budget a run passes on its first
agent step. A budget large enough for the whole flow. A budget with a cycle that
repeats a paid step. A budget with a fanout of paid members. A flow with no budget
at all. A budget refused mid-wave. A budget on a flow whose steps are all free.
A budget of a fraction of a cent. A budget on a flow that calls another flow.
Use combinations **A, B, D** for the paid steps.

**Batch 7 — a flow that calls a flow.** One level. Two levels. An inner flow that
takes values. An inner flow that fails. An inner flow holding a gate. An inner
flow file that is not there. A flow that calls itself. An inner flow on a
different harness from the outer one (combinations **B** and **F**). An inner flow
that returns a value the outer flow uses. An inner flow holding a fanout.

**Batch 8 — the workspace and what a step promises.** `git init` in your own
directory and commit something first. A git workspace. `changes: nothing` kept,
and broken. `changes: { paths: [...] }` kept, and broken. `changes: { except: [...] }`.
A step that writes where it promised not to. A flow with no workspace whose step
writes anyway. `workspace: none`. A dirty tree before the run. A step that deletes
a tracked file. Use one paid step (**B**) where a model must do the writing.

**Batch 9 — contracts.** `takes` satisfied, violated, and missing. `returns`
holding a nested object, an array of objects, and an enum. A model that cannot
meet its contract (**B**, and one on **D**). A schema that is itself malformed. A
schema with no `required`. A value carrying extra keys. A value of the wrong type.
A value of a megabyte. A value full of emoji and right-to-left text.

**Batch 10 — harnesses and models, one flow each.** Ten flows, each a single
agent step with a one-line prompt, one for each of **A**–**G**, plus: a flow whose
two steps name different harnesses; a step that overrides the harness its flow
names; and a flow naming every tool its adapter supplies. Also try `web` on `pi`
and a tool that does not exist, and say when the refusal arrives — before the run
spends, or after.
