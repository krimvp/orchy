---
status: accepted
---

# A step declares what it may start

An agent step that holds the `orchy` tool may declare `starts`: the flow
files it may start, and how many runs.

```yaml
- id: dispatch
  kind: agent
  prompt: prompts/dispatch.md
  tools: [read, orchy]
  starts: { flows: [flows/bugfix/flow.yaml], most: 5 }
```

The door of the run enforces the bound. It reads the flow from the state of
the run that asked — the state on disk, which `validate()` and
`resolvePaths` already shaped — so the model the step drives cannot talk its
way past it. A flow outside the list is refused with the list. A start past
`most` is refused with the count, and every run counts, including one that
failed, the way a budget counts a dropped attempt.

## Why

ADR 0025 opened the door to a step and bounded the chain with a depth. The
depth bounds how far runs stack; it does not bound what one dispatcher does
at one level. A step that reads a backlog and starts runs is given real
authority, and the flow is where a person says how much: the flow declares,
Orchy enforces — the same sentence the README opens with.

The bound follows the shape of the `changes` promise, the guardrail this
project already trusts: declared as data on the step, enforced where Orchy
can really check it, and refused by `validate()` when nothing can read it —
a `starts` on a step with no `orchy` tool is refused, because a bound that
nothing reads is a rule that looks enforced and is not.

## The limits, stated

- The door holds the bound, and the door is the governed way in. A step
  that holds `bash` can still run `orchy run` beside it, unrecorded — ADR
  0018 said a tool list is not a sandbox, and this bound does not claim
  otherwise. A step given `orchy` and not `bash` is bounded in full.
- `flows` names files, relative to the flow file like every path a flow
  holds. A path is the identity of a flow (ADR 0024), so the bound compares
  paths, not names.
- `most` counts the children of one step of one run, from the index. A
  resume of the same run keeps the count, because the children keep their
  rows.
- The bound reaches `run_flow` only. Reading runs, writing flows, and
  answering gates stay open to the step; each is its own authority, and a
  bound for one waits for a real flow that needs it.
