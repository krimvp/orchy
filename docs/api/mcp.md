# `src/mcp.ts` — the MCP face of the daemon

This module puts a `Daemon` behind the Model Context Protocol, so a coding
agent holds Orchy as a set of tools: it writes a flow, hears every problem
from `validate()`, corrects it, runs it, follows the run, and answers a gate.
See [ADR 0024](../adr/0024-an-agent-authors-a-flow-through-mcp.md). Like the
HTTP face, it defines no behavior of its own: each tool calls a daemon method
or a flow helper, through the same functions `server.ts` uses (`start`,
`missing`, `harnessInFile`, `harnessOfRun`, `under`), so the two doors answer
the same. A tool that refuses answers with its reason as a tool error, so the
agent reads it and writes again.

The door speaks the part of the protocol that tools need — `initialize`,
`tools/list`, `tools/call`, and `ping` — as JSON-RPC 2.0, one message for one
line of the two streams. That is small enough to write here, so the door adds
no dependency. The answer to `initialize` carries a guide: the root, the
shape of a flow, the loop of the tools, the signature of a call module, what
a brace name reads, and the tool names, harness names, and model grammar from
the tables in `harness.ts`, so no copy falls behind the runner. The guide
holds no rule: `validate()` still refuses. A client shows the first 2048
characters of the guide and cuts the rest — a tryout read one that ended
mid-word — so the guide stays under that, and a test holds it there.

The door keeps the one rule of the daemon: every path a tool names resolves
against the root, and one outside it is refused with the root in the message.
A tool list is not a sandbox here either — an agent that writes and runs a
flow runs code, with the authority of the user who started `orchy mcp`.

## Exports

- `mcp(daemon: Daemon, harness = "pi", input = process.stdin, output =
  process.stdout, startedBy?)` — serves the protocol over the two streams,
  against the daemon. `harness` is what a flow that names none runs on, as
  at the command line. `startedBy` names the run and the step this door
  speaks for, when a step opened it. The tools it answers:

  | Tool | What it does |
  | --- | --- |
  | `check_flow` | `{ problems, warnings }` for a flow given as YAML text. Empty lists mean the flow is valid. A warning names a brace name that nothing supplies — in a question, or in a prompt passed through `prompts`, which stands in for its file so a hole is heard before anything is written. It runs nothing and spends nothing. |
  | `write_flow` | Writes the YAML text as given — the leading comment stays the description — and the `prompts` files beside it, then registers the flow. Refuses a flow that does not validate, naming every problem; answers `{ flow, warnings }`, where a warning names a file the flow needs and does not have yet, or a brace name that nothing supplies. `run_flow` refuses a flow with either, so a warning is the next thing to fix. |
  | `read_flow` | `{ path, yaml, files }` — the flow file, and every file its steps name that is there: a prompt, a module, an inner flow. |
  | `list_flows` | Every registered flow: its row, its `description`, and its `lastRun`. |
  | `run_flow` | Loads and validates the flow, then queues a run — registering the file first when no row holds it. Answers the `Ticket`, with its `runId` once the run starts; a queue with every slot taken answers the bare ticket instead of holding the answer. `with` carries the values the flow takes, which the child checks. A run of agent steps spends money. |
  | `read_run` | `{ row, state, children }` — the run's row, its `RunState` from disk with the `question` when it waits at a gate, and the runs its steps started, each with its status and cost. `wait` holds the answer up to that many seconds (at most 55) while the run works, so a poll costs fewer turns; the answer says where the run stands either way. |
  | `read_trajectory` | The run's parsed `trajectory.json`, or an error while it has written none. |
  | `list_runs` | `{ queue, runs }` — every pending ticket, and every run the index holds, newest first. |
  | `resume_run` | Continues a run. `value` answers the gate of a waiting run — as JSON text, as at the command line, so a boolean stays a boolean across every client — and the contract of the gate checks it here, at the door; `from` names a step of an ended run to go back to; `step` names the gate the answer was written for, so a run that moved on refuses it. |
  | `stop_run` | Stops a run where it stands, as `POST /api/runs/:id/stop` does. |

The daemon behind this door asks for no schedule beat (`daemon(root, false)`),
so it and the long daemon stand over one root without firing one schedule
twice. The schedules belong to the long daemon. Runs either door starts are
on disk, so each shows the other's.

A step of a flow reaches this door too, by declaring the `orchy` tool (ADR
0025). The claude adapter opens the door with the run and the step in
`ORCHY_STARTED_BY`, `mcp()` takes them as `startedBy`, and every run such a
step starts records them in its state. The door refuses a chain that stands
three runs deep, and names the `flow` step as the way that still runs.

## Example

Register the door with Claude Code, from the directory the flows live in:

```sh
claude mcp add orchy -- npx orchy mcp
```

The agent then holds the ten tools, and the guide tells it the loop: write
the flow as YAML, hear every problem from `check_flow`, write it with
`write_flow`, start it with `run_flow`, and follow it with `read_run`. A run
that waits at a gate holds a question, and the agent answers it with
`resume_run` — the same contract that checks a person checks the agent.
