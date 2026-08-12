---
status: proposed
---

# An agent authors a flow through MCP

`orchy mcp` speaks the Model Context Protocol over stdio. A coding agent adds
it as a server and holds nine tools: `check_flow`, `write_flow`, `read_flow`,
`list_flows`, `run_flow`, `read_run`, `list_runs`, `resume_run`, and
`stop_run`. The agent writes a flow, hears every problem from `validate()`,
corrects the flow, runs it, follows the run, and answers a gate.

The command opens the daemon over the root, the same way `orchy daemon` does.
The MCP server is a door beside the HTTP API: it translates a call to the
daemon, and it adds no rule about a flow. A tool names a flow by its path
under the root, the same name the command line takes.

## Why

A flow is data, not code (ADR 0004), so an agent can produce one and Orchy can
refuse a bad one before anything runs. The value of the door is the loop: the
agent writes YAML, `validate()` names the step, the fault, and the fix, and
the agent writes again. That loop already serves a person at `orchy check`.
The door gives it to an agent.

A gate takes its value from a person. Through this door an agent answers one
as well, and the daemon checks the answer against the contract at the door,
as ADR 0023 set down. So one flow serves both: a person answers in the UI,
and an agent answers over MCP, and the same schema refuses both when they are
wrong.

The door adds no dependency. The subset it needs is `initialize`,
`tools/list`, and `tools/call`: JSON-RPC 2.0 over lines of stdio. That is a
few hundred lines, and the HTTP door already writes HTTP and SSE with
`node:http` alone. When the door needs a remote transport or notifications,
the official SDK is the upgrade, and this ADR takes an amendment that says
what changed.

## The limits, stated

- The door keeps the one rule of the daemon: a flow path stays under the
  root. `write_flow` refuses a path outside it.
- `write_flow` refuses a flow that `validate()` refuses, and its answer holds
  every problem. A person saves a broken draft through the editor. An agent
  corrects the draft and writes again, so a broken flow never reaches the
  store through this door.
- `run_flow` answers with the run id and returns. A run takes minutes, so the
  agent reads the run for its state. The door holds no tool that waits.
- Schedules belong to the long daemon. The MCP daemon does not fire them, so
  the daemon and `orchy mcp` over one root do not fire one schedule twice.
- The tool names, the harness names, and the model grammar go into the server
  instructions, the same way `GET /api/health` serves the editor. The
  instructions hold no rule: `validate()` still refuses.
- A tool list is not a sandbox (ADR 0018). An agent that writes and runs a
  flow runs code, with the authority of the user who started `orchy mcp`.
  The door adds no authority that the command line does not already give.
