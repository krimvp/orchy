---
status: accepted
---

# A member of a fanout retries itself

A step that fans out may cycle to itself. Every other cycle on a fanout is
still refused.

```yaml
- id: judge
  kind: agent
  needs: [clauses]
  prompt: prompts/judge.md
  tools: [read]
  fanout: { step: clauses, key: clauses }
  cycle: { to: judge, when: failed, limit: 1, policy: escalate }
```

Expansion gives each member the cycle, pointed at the member itself, so
`judge/deposit` retries `judge/deposit` and nothing else. Each member keeps its
own count in `state.cycles`, under the key `judge/deposit->judge/deposit`.

## What this reverses

[ADR 0017](./0017-a-fanout-over-a-value-the-run-computes.md) records the
refusal: `validate()` refuses a step that fans out and cycles, because which
member cycles is unclear. That reason is true of a cycle that leaves the step,
and it is not true of a cycle to the step itself. A fanout has no one value to
send back to an earlier step; it has one failure for each member, and each
member is the answer to "which one".

So the refusal now names the target, and says what is allowed:

> step "judge" fans out and cycles to "clauses", so which member cycles is
> unclear. A cycle to "judge" itself is a retry, and each member takes its own.

## Why the retry, and not something else

A fanout is where a run is least reliable, and it had the one shape that could
not ask for a retry.

A step fails most often because the model wrote its answer and never called the
tool that records it. Across thirty runs of fifteen flows in
[trials](../../trials), that was seven of the eight step failures. On a single
step it costs one step. On a fanout it costs the whole run: eleven clauses were
judged, ten came back, and the eleventh took the other ten with it.

The three ways out were a retry, dropping the member, and finishing without it.
The last two hide a failure, which this project refuses. A retry is the one
that keeps every value and keeps the run honest, and `escalate` on it asks a
person for the member that a second attempt could not answer.

The reprompt in the Pi adapter, added at the same time, makes this rarer. It
does not make it impossible, so both exist.

## Consequences

The count belongs to the member, so a fanout of eleven with `limit: 1` may
spend eleven retries. The limit bounds each member, not the step. This is what
a reader of `limit` expects when the members are eleven copies of one prompt,
and a budget bounds the money either way.

A wave that loses two members past their limit still fails the run. `escalate`
asks a person only when one step in the wave failed, because the run stops at
one question, and a second failed record would run again past its limit.

A cycle to another step stays refused, and `expandFanout` still rewrites a
cycle that points *at* a fanout to the last member it made. Nothing here
changes that.
