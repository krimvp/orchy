# `src/cli.ts` — the `orchy` command

This module is the executable that `package.json` names as the `orchy` bin. It
is the one place where the library meets a terminal: it parses the arguments,
picks a harness adapter, wires the engine's events to a reader, and turns the
end of a run into an exit code. Everything it does, it does by calling the
other modules — `loadFlow` from `src/load.ts`, `run` and `resume` from
`src/run.ts`, `daemon` and `serve` from `src/daemon.ts` and `src/server.ts`.

Seven commands exist:

- `orchy run <flow file>` — load a flow (TypeScript or YAML) and run it.
  `--with <json>` supplies the values the flow takes, as one JSON object —
  anything else (an array, a bare string, invalid JSON) is refused with a
  message that shows what was given.
- `orchy resume <run id> [json value] [--from <step>]` — carry a run that
  ended forward. The JSON value, when given, answers the question a waiting
  run asked. `--from` names the step to continue from. With no value and no
  step, a failed run goes back to the step that failed, and a stopped run
  continues where it stood.
- `orchy check <flow file>` — load a flow, and every flow it holds, and print
  what `validate()` says about it. It runs nothing and spends nothing, and it
  exits `2` with the list of problems when the flow is not valid.
- `orchy runs` — list the runs under this directory, newest first, as a table;
  with `--events`, one JSON row per line.
- `orchy memory keys | list <scope> | add <scope> <text> | forget <scope> [id]`
  — read and write what runs recorded, under `.orchy/memory`. A scope is the
  key a flow declares, and it is read the way the runner reads one, so
  `ticket/PROJ-14` reaches the store a run wrote. `list` prints one entry a
  line, or one JSON entry a line with `--events`. `forget` drops the entry an
  id names, and the whole scope without one. This is the door for a person
  correcting what a run wrote, and for a harness that holds no `orchy` tool
  (ADR 0029).
  exits `2` with the list of problems when the flow is not valid. A valid flow
  that takes values gets them named, each with its type, so the `--with` that
  comes next is written once.
- `orchy runs` — list the runs under this directory, newest first, as a table
  with a header; with `--events`, one JSON row per line. The row of a failed
  run says why, and the row of a waiting run names the step it waits for.
- `orchy daemon [--port 4000]` — start the long-running engine over the
  current directory and serve its HTTP API. The daemon runs an agent on this
  machine, so it listens on `127.0.0.1` only, and it closes cleanly on
  `SIGINT` or `SIGTERM`.
- `orchy mcp` — serve the Model Context Protocol on stdin and stdout, so an
  agent writes flows and runs them here. See `src/mcp.ts`. The engine behind
  it fires no schedule — the long daemon does — so the two stand over one
  root together. The door closes when the client closes stdin. When a step
  opened the door, `ORCHY_STARTED_BY` names the run and the step, and every
  run it starts records them (ADR 0025).

`orchy run` also takes `--started-by <json>`, one object with `runId` and
`step`: the record of who started this run. The MCP door of a run passes it
through the daemon; a person has no use for it.

`run` and `resume` share two more flags. `--harness pi|claude|droid` picks the
adapter (default `pi`); the table of adapters is typed by `AdapterName`, so an
adapter that goes missing fails the compiler, and an unknown name at the
command line exits with the list of real ones. `--events` switches the output
contract: instead of the human report, every `RunEvent` goes to stdout as one
JSON line, and nothing else may reach stdout, because a parent process is
reading it.

A flag a command does not take (`orchy run … --from`), a flag given twice, and
a flag with no value after it are refused with `2`, because each of them once
passed in silence and ran the wrong thing.

Without `--events`, the run reports to stderr with one glyph per event kind
(`◆` run start, `▶` step start, `✎` the prompt a step asks, `✓`/`✗` step end,
`⊘` a step a condition ruled out, `↻` cycle, with the pass and the limit as
`(1 of 3)`, `≠` a cycle that stopped at its limit with the disagreement
accepted, `⏸` waiting for a person, `—` run end), and the final `RunState`
prints to stdout as pretty JSON. A run that ends `waiting` also prints the
exact `orchy resume` command that would answer it, and the contract the answer
must match.

Exit codes: `0` when the run ends `done` or `stopped`, `1` on a failed run or a
thrown error, `2` for a usage mistake or a refusal at the door — no command, an
unknown harness or flag, values the flow refuses, a resume nothing takes — where
nothing ran and nothing changed, and `3` when the run ends `waiting`. A waiting
run has its own code because pausing is not failing, and a script that reads the
`3` knows a person owes it an answer.

## Exports

Nothing. The file is a script, not a library — its first line is a shebang,
and importing it would run it. Programs that want what the CLI does should
import the modules it calls: `run`/`resume` from `src/run.ts`, or spawn this
command with `--events` and read the JSON lines.

## Example

The call is a shell invocation, not an import. Run a flow, giving it its
values, under the Claude Code harness:

```sh
orchy run flows/triage.yaml --with '{"issue": 123}' --harness claude
```

The report streams to stderr while the run works; the final state lands on
stdout. If the run stops at a gate, the answer is another invocation —
`orchy resume <run id> '{"approved": true}'` — and a run that failed midway
comes back with `orchy resume <run id> --from <step>`, or with no arguments at
all to retry the step that failed. A parent process would add `--events` and
read one JSON `RunEvent` per line instead — the same events the daemon serves
over HTTP.
