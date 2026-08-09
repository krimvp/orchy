---
status: accepted
---

# A step that a condition rules out, and every step that needs it

A step holds `when`, a match against the value of each step that it needs.

```yaml
- id: page
  kind: agent
  needs: [sort]
  when: { sort: { severity: high } }
```

A step that the condition rules out is skipped. Every step that needs a skipped
step is skipped as well.

## Why a condition at all

Every step in a flow ran. The only condition in the format was `cycle.when`,
and it sends the run backwards. So a flow could not say "sort the issue; when it
is severe, wake the on-call agent; otherwise label it and stop".

A user who wrote `when` on a step got no complaint and no condition. The step
ran anyway.

## Why it reads the steps it needs

`cycle.when` is a partial match against the value of the step it sits on. A step
cannot match its own value, because it has not run. So the condition names the
steps it reads.

The values of the steps a step needs already reach that step as one object,
keyed by the id of each step. The condition matches against that same object, so
the shape of a condition and the shape of the inputs are one shape. A key that
the step does not need is a problem, and so is a key that the named step does
not return.

## Why a skipped step takes its dependents with it

Invariant 3 says that a step starts only after every step it needs passes. A
skipped step did not pass, and it never will. So a step that needs it cannot
start, and it cannot wait either.

The rule is one sentence, and it holds the invariant. The cost is real: a step
that joins two branches is skipped when either branch is skipped, so a flow
cannot say "page the on-call when it is severe, then always write the record"
with `record` needing `page`. Write `record` to need only the step it reads.

An optional need would lift that limit, and it is a second concept with a second
question for every user. It waits for a flow that needs it.

## Consequences

A step record takes a third status, `skipped`, and it keeps the reason. The run
emits a `skip` event, so a reader of the events is never left to work out why a
step never started. The page draws a skipped step with a broken outline.

A run that skips its last steps still ends `done`. A skipped step is a decision
the flow made, not a fault.

`when` sits on an agent step, a call step, and a gate step. A flow step holds
none, because expansion replaces it with the steps of the flow it names, and the
condition would have to reach each of them. `validate()` refuses it there.
