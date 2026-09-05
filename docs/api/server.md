# `src/server.ts` — the HTTP face of the daemon

This module puts a `Daemon` (from `daemon.ts`) behind HTTP. It answers a JSON
API under `/api/`, streams run events as server-sent events, and serves the
built UI from `ui/dist` for every other path — the UI is one page, so a path
that names no file gets `index.html`. It defines no behavior of its own: each
route calls a daemon method or a flow helper (`readFlow`, `loadFlow`,
`validate`, `formatFlow`) and returns what that call returns. A handler that
throws answers `400` with `{ "error": "<message>" }`; an unknown `/api/` path
answers `404`; a request for the UI before `npm run ui:build` answers `503`.

Three doors start a run — the run button, a schedule, and a webhook — and all
three go through one checked `start`: the flow must validate, every file it
names (a prompt, a module, an inner flow) must exist, and no question or
prompt may read a brace name that nothing supplies (`unfilled`), before a
child spends money on it. Every route that touches a file resolves the path
against the daemon's root. It also resolves symbolic links. An existing file
must have a canonical path inside the root. A new file must have its nearest
existing parent there.

The server trusts no one but its own pages. It has no user and no password,
and it starts an agent that can hold `bash`, so every request is checked
against the set of origins the daemon answers to: a `Host` that is not its own
name is refused (that is how DNS rebinding starts), and an `Origin` from
another page is refused (that is a cross-site request). Both answer `403`. A
malformed route or body answers a controlled `400`. The next request still
reaches the daemon.
When the server listens on a loopback address, `127.0.0.1`, `[::1]`, and
`localhost` all count as its own name, since a person types either one. The
one exception a person makes on purpose is a webhook token: `POST
/api/hooks/:token` is the URL that holds the token, and holding it starts the
run.

## Exports

- `serve(daemon: Daemon, port: number, host = "127.0.0.1")` — starts the
  server and resolves to the Node `http.Server` once it listens. Pass port
  `0` to take a free port and read the real one from `server.address()`.
  The routes it answers:

  | Route | What it does |
  | --- | --- |
  | `GET /api/health` | The daemon's `root`, the `adapters` and `tools` of the harness, the `operators` with what each reads, `models` — what a model name looks like for each harness — and `components`, the `orchy:` names Orchy ships, so the editor never holds a copy that falls behind the runner. |
  | `GET /api/flows` | Every registered flow, each row carrying what a person needs to choose one: the `description` its file starts with (the leading comment), its `lastRun`, its `schedule` (`{ everyMinutes, lastAt }` or `null`), and its webhook `hook` token or `null`. |
  | `POST /api/flows` | Registers the flow file at `body.path`, under `body.harness` (default `"pi"`). The path must name an existing file under the daemon's root. |
  | `POST /api/flows/new` | Creates a new flow from `body.name` (or an explicit `body.path` ending in `.yaml`): writes a one-step starter flow and its prompt under the root, then registers it. Refuses a path where a file already exists — register that instead. |
  | `GET /api/flows/:id` | The flow's row, its parsed `flow`, its validation `problems`, its `warnings` (files the flow names that are not there), and `editable` — true when the file is YAML. |
  | `PUT /api/flows/:id` | Saves `body.flow` back to the file as YAML. Answers `{ problems, saved: false }` instead of writing when validation finds problems, and refuses a flow whose file is TypeScript. |
  | `DELETE /api/flows/:id` | Removes the flow from the index. The file stays. |
  | `PUT /api/flows/:id/hook` | Turns on the flow's webhook and answers `{ token }` — the same token again if one exists. |
  | `DELETE /api/flows/:id/hook` | Removes the webhook. |
  | `POST /api/hooks/:token` | Starts the flow the token belongs to. The JSON body is the values the flow takes; a body a flow does not take fails the start, and the queue keeps the reason. |
  | `PUT /api/flows/:id/schedule` | Runs the flow by itself every `body.everyMinutes` minutes — at least 15; a tighter loop is a runaway spend, not a schedule. `body.with` carries the values, and a schedule missing a required value is refused here, not at 3 a.m. |
  | `DELETE /api/flows/:id/schedule` | Removes the schedule. |
  | `GET /api/file?path=...` | The content of a file under the root, for the editor: `{ path, exists, content }`. A file over one megabyte is refused — it is not a prompt. |
  | `PUT /api/file` | Writes `body.content` to `body.path` under the root, creating directories on the way. |
  | `POST /api/flows/:id/runs` | Loads and validates the flow, then queues a run and returns its `Ticket`. `body.harness` overrides the flow's harness; `body.with` carries the values the flow takes, which the child checks. |
  | `POST /api/validate` | `{ problems, warnings }` for the flow in `body.flow`, without touching the flow file. `warnings` names missing files and unfilled brace names; the files are only checked when `body.path` says where the flow lives. A warning blocks no save, since the editor mends one in a click — but `start` refuses both kinds, so none reaches a run. |
  | `GET /api/runs` | Every run the index holds. |
  | `GET /api/runs/:id` | The run's row and its `RunState` from disk. |
  | `GET /api/runs/:id/children` | The runs the steps of this run started, every one — not a page. The page draws a run's family from here. |
  | `GET /api/runs/:id/trajectory` | The run's parsed `trajectory.json`, or an error while it has written none. |
  | `POST /api/runs/:id/resume` | Continues a run and returns a fresh `Ticket`. `body.value` answers the gate of a waiting run; `body.from` names the step to go back to. Without `body.harness` it uses the harness of the flow the run came from, falling back to `"pi"`. |
  | `POST /api/runs/:id/stop` | `{ stopped: true }` when a live child heard the signal, `{ stopped: true, abandoned: true }` when no child drove the run — one waiting at a gate, or one a dead daemon left — and it was marked stopped where it stands. A run that is already over answers with the reason instead. |
  | `GET /api/queue` | Every ticket still pending, queued or running. |
  | `DELETE /api/queue/:ticket` | Drops a ticket, typically one that ended in error. |
  | `GET /api/events` | A server-sent event stream of every daemon notice. |
  | `GET /api/runs/:id/events` | The same stream held to one run. It first replays the run's stored events and recent output notes in the order they happened, then follows live. |

  Both streams open with a `{ kind: "queue", pending }` notice, send one JSON
  object per `data:` line in the format `EventSource` reads, and write a
  comment beat every twenty seconds so a client that went away is noticed.

## Example

Start a daemon, put it on a free port, and register a flow over HTTP:

```ts
import type { AddressInfo } from "node:net";
import { daemon } from "./daemon.ts";
import { serve } from "./server.ts";

const orchy = daemon(process.cwd());
const server = await serve(orchy, 0);
const { port } = server.address() as AddressInfo;

const answer = await fetch(`http://127.0.0.1:${port}/api/flows`, {
  method: "POST",
  body: JSON.stringify({ path: "flows/health.yaml", harness: "claude" }),
});
console.log(await answer.json()); // the flow's row in the index

server.close();
orchy.close();
```

In a real deployment, `cli.ts` builds the daemon and calls `serve` for the
`orchy daemon` command; the UI and anything else on the same machine speak to
the daemon through these routes.
