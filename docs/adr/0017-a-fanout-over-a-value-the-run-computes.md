---
status: accepted
---

# A fanout over a value the run computes

A `fanout` is a list of members, or a value that names where the list comes
from: the step that holds it, and the key in the value of that step.

```yaml
- id: audit
  kind: call
  needs: [find]
  module: audit.ts
  fanout: { step: find, key: packages }
```

`find` returns `{ packages: [{ name: core }, { name: cli }] }`, so the run holds
`audit/core` and `audit/cli`. Each item is one member: the item is the value of
the member, and the `name` field of the item names it.

## Why a flow needs one

"Audit every package that this step found" had no shape. A person wrote the list
into the file, and a list that changes made the flow wrong in silence. This is
the most common real workflow that Orchy could not express, and
[docs/shape.md](../shape.md) names it as open.

## Why a tagged value, and not a second field

[ADR 0006](./0006-one-workspace-field-with-no-default.md) met this question for
the workspace, and [ADR 0013](./0013-a-promise-is-a-word-not-a-boolean.md) met it
for a promise. Both answered with a tagged value, so a new kind costs no change
to the format. A fanout gets the same answer: a list of members, or `{ step,
key }`. A second field would let a step hold both, and then a reader asks which
one wins.

`FANOUT_HOLDS` in `flow.ts` names the two fields, so a third one fails the check.

## Why the runner expands this one

[docs/plan.md](../plan.md) and [AGENTS.md](../../AGENTS.md) both say that a
fanout becomes plain steps before the run. That is why a fanout costs the runner
nothing, and why a graphical editor draws it.

A computed fanout cannot obey that rule, because the list does not exist until a
step produces it. So the run expands it, at the moment the step is ready and its
source holds a value. **This is the first and the only expansion the runner
performs.**

The rule was worth breaking, because the alternatives are worse:

- **A loop construct in the flow data.** A second construct for one job, and the
  runner would learn it as well.
- **A component that starts a run for each item.** The steps of that run sit
  outside the flow, so no invariant, no trajectory, and no gate reaches them.
- **A person writes the list.** This is what a user does today, and it is the
  fault the change fixes.

The expansion calls `expandFanout`, the same function that a file already uses.
Two expansions that drift apart is the fault this project keeps finding, so the
run turns the items into members and hands them to the one expander.

## What it costs

**The state on disk grows a second author.** [ADR
0005](./0005-a-run-is-a-persisted-state-machine.md) says the state on disk is
the run. The expanded steps go into `state.flow`, so a crash recovers the same
steps and a resume reads them. The step that fanned out is gone from
`state.flow`, so nothing expands it twice.

**The flow of a run is no longer the flow of the file.** It never was, for a
fanout, but now it changes while the run is on the way. A reader of the run
state sees the members after the expansion, and the step before it.

**A graphical editor cannot draw the count.** It draws a fanout as a stack with
the number of members. A computed fanout has no number until the run has one, so
the stack draws without a count.

**`validate()` checks less than it does for a list of members.** It checks what a
file can say: the step it reads is one the step needs, that step does not fan out
itself, and the key is one that the step declares in `returns` as a list. When
the source declares the shape of an item, it checks that the item holds a `name`.
The rest waits for the value: an item that carries no name, and two items with
one name, fail the run and name the step.

## What is refused, and why

**A cycle.** `validate()` already refuses a step that fans out and cycles,
because which member cycles is unclear. A computed fanout keeps that refusal.

**An item that cannot name itself.** A number for each item would read
`audit/0`, and a list that comes back in another order would move the work under
that name. A name that means nothing hides the change. So Orchy refuses the
fanout and says which item has no name.

**The end of a flow that returns a value.** A flow returns the value of the step
it ends with, and a fanout at the end makes one end for each item. `validate()`
already refuses a flow that returns a value and ends in more than one step. It
now refuses a computed fanout at that end as well, because the run makes those
ends after the check.

**An empty list is not refused.** It skips the step, with the reason, and every
step that needs it is skipped by the rule of [ADR
0014](./0014-a-step-that-a-condition-rules-out.md). A step that found nothing to
audit is an answer, not a fault, and the run says so out loud.
