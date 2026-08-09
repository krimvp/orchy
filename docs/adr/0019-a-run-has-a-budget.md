---
status: accepted
---

# A run has a budget, and it stops when it reaches it

A flow declares what the run may spend, in dollars.

```yaml
name: research
budget: 10
```

The run counts what each step spent, between waves. A run that reaches the
budget stops before the next step, fails, and says what it spent.

```
the run reached the budget of the flow "research": it spent $10.02 of $10. It
stops before the next step.
```

## Why a budget at all

Invariant 4 says that a cycle stops at its declared limit, so a flow cannot run
without end. The money form of that rule was missing. A cycle limit of 3 over a
panel of three expensive models is bounded in cycles and unbounded in dollars,
and the cost of a step that a cycle throws away is spent all the same.

Orchy recorded the cost of every step already: the record of a step holds one,
the trajectory sums them, and the index of the daemon keeps the total. Nothing
acted on any of it.

## Why the flow holds it, and not the step

A budget is a property of the run, not of one step. A budget for each step is a
question that every user must answer, and the sum of the parts is not the rule
that a person wants. One flow, one budget.

So a sub-flow cannot hold one. Expansion drops the flow and keeps its steps, so
a budget on a sub-flow would vanish, and a rule that looks enforced and is not
costs more than a missing rule. `expandFlows` refuses it:

```
the flow at "./panel.yaml" has a budget, and step "sub" holds it. A budget
belongs to the run, so only the flow that the run starts sets one.
```

## Why it fails, and does not wait for a person

The `escalate` policy stops a run for a person, and this decision reuses the
stop it does not fit.

An escalation asks a person for the value of one named step: the run clears the
record, waits, and `resume` checks the value against the contract of that step.
A budget names no step. No value of any step answers "the money ran out", and
the run has no step for a person to answer for.

A person who resumed such a run would also change nothing. The spend is on
disk, so the next wave would meet the same budget and stop again. A stop that a
person cannot answer is a promise that Orchy does not keep.

So the run fails, and `RunState.error` carries the reason. That field already
holds a fault that belongs to the run and not to one step, which is what a
budget is.

## What counts

Every attempt. The run reads the same records that the trajectory reports,
through one function, so the total in `state.error` and the total in
`trajectory.json` are the same number. A run that a cycle threw away sits in
`state.history`, and it counts.

A step that broke its promise or its contract counts as well. It spent its
tokens before Orchy read its value, and a retry of it spends more. The record
of a failed step now keeps its cost, which is what makes a retry loop stop at
the budget instead of running to its cycle limit.

## The cost that no one knows

A cost that no harness reported is not a cost of zero. A budget that reads it
as zero is a budget that is not enforced.

So a run with a budget stops when an agent step ends with no cost:

```
the flow "panel" has a budget, and step "plan" reported no cost. Orchy does not
enforce a budget that it cannot measure. Use a harness that reports a cost, or
take "budget" off the flow.
```

Only an agent step spends. A call step runs code, a gate takes its value from a
person, and a step that a person answered for an escalation has no run of its
own. None of them reports a cost, and none of them is asked for one.
`validate()` refuses a budget on a flow where no step spends at all.

The two adapters both report:

- The `claude` command answers with `total_cost_usd`, which the adapter already
  put on the result.
- Pi writes the price of each turn into the session file it keeps. The adapter
  reads it there, by ADR 0011, and reports nothing at all when no message of
  the session carried a price. A provider that prices nothing leaves the cost
  unknown, and the run says so rather than counting zero.

## Consequences

The check runs between waves, where the run already settles and saves. So the
budget stops the next step; it does not stop a step that is running, and it
does not undo the step that crossed the line. A wave of eight steps can cross
the budget by a whole wave, because Orchy does not interrupt work it started.

A run that reaches the budget in its last wave still ends `done`. There is no
next step to stop, and the work is finished.

A budget is in dollars and not in tokens. A token count means nothing across
two models, and the trajectory holds both numbers for a reader who wants them.

Nothing raises the budget of a run that stopped. A person starts a new run, or
edits the flow. A run that continues past its budget is the thing this rule
exists to refuse.
