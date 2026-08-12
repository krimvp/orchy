---
status: accepted
---

# A step reaches the door of its own run

`orchy` is a tool a step declares, beside `read` and `bash`. A step that
holds it reaches the MCP door of its own root: it authors flows, starts
runs, reads them, and answers gates, through the same ten tools an outside
agent holds (ADR 0024). The claude adapter opens the door with
`--mcp-config`; the pi adapter cannot, and `validate()` refuses the tool
there, from the `SUPPLIES` table.

A run a step starts records who asked. The adapter tells the door the run
and the step, the door passes it down the same path a person's order takes,
and the child writes `startedBy: { runId, step }` into its own state. The
record is the rule: a reader walks the chain from any run, `read_run` lists
the children of a run with what each cost, and the door refuses a chain
that stands three runs deep.

## Why

A step with `bash` could always run `orchy run`, unseen. Invariant 1 says a
tool list is not a sandbox, so the choice was never whether a step can start
a run — it was whether Orchy sees it. A declared tool is governed and
recorded; the same act through `bash` is neither.

The dispatcher is the flow this serves: a step reads a backlog, chooses a
flow at run time, and starts detached runs. The static forms cannot say
that — a `flow` step names its file when the flow is written, and a fanout
multiplies one step, not one flow.

The depth is a constant, not a setting, for the reason a cycle has a limit:
a flow must not run forever, and a run that starts runs escapes its own
budget. Invariant 4 bounds the dollars of one run; the depth bounds how far
the chain of budgets goes. Three is enough for a dispatcher that starts a
flow that asks one question; a flow that wants more holds a `flow` step,
which expands into its parent and spends the parent's budget.

## The limits, stated

- The budget of a run does not count its children. Each child run carries
  its own budget, and `read_run` names the cost of each child, so a reader
  sums a chain that the runner does not.
- A step that starts a run must not wait for it: the daemon holds four run
  slots, and a step that polls holds one while its child wants another.
  Work that runs inside this run is a `flow` step. The refusal at depth
  three says so.
- The chain is read from the states on disk. A state that is gone ends the
  walk, and the walk counts what it reached.
- `--strict-mcp-config` rides on every claude step now, with or without the
  `orchy` tool. Without it, every MCP server of the user's own configuration
  existed for every step, and no tool list declared one of them.
- The step and its door are two processes. The parent's record does not
  name the runs its step started; the children name the parent, and the
  index serves the question both ways.
- The door of a step closes with the step, and the runs it started live
  on: each is its own process, and its state is on disk. The long daemon
  still takes its runs down with it when it closes.
