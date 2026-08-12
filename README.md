# Orchy

Orchy runs agent flows. You declare the steps and the rules. Orchy runs the
steps, enforces the rules, and records what each step did.

A coding agent is good at one step and poor at a long one. So Orchy holds the
control flow, and gives each step one job, one tool list, and one contract.

```yaml
name: code-and-review
workspace: { kind: git, path: . }
harness: claude
model: claude-opus-4-5
budget: 5
takes:
  type: object
  required: [issue]
  properties: { issue: { type: number } }
returns:
  type: object
  properties: { approved: { type: boolean } }

steps:
  - id: code
    kind: agent
    prompt: prompts/code.md        # this file holds "{{ issue }}"
    tools: [read, write, edit, grep, find, ls]
    returns:
      type: object
      required: [summary]
      properties: { summary: { type: string } }

  - id: review
    kind: agent
    needs: [code]
    harness: pi
    model: ollama/glm-5.2
    prompt: prompts/review.md
    tools: [read, grep]
    changes: nothing
    returns:
      type: object
      required: [approved, findings]
      properties:
        approved: { type: boolean }
        findings: { type: array, items: { type: string } }
    cycle: { to: code, when: { approved: false }, limit: 3, policy: escalate }
```

```bash
orchy run flow.yaml --with '{"issue":412}'
```

The flow takes the issue, and the prompt of the first step reads it as
`{{ issue }}`. So one flow serves every issue, and a name that nothing supplies
fails the step instead of sending a model to do the wrong work. The flow returns
the value of the step it ends with, and the run stops before the next step when
it has spent $5.

One model writes the code. A different model on a different harness reviews it,
reaches no tool that can change a file, and sends the work back until it
approves or a person takes over.

## What Orchy guarantees

A prompt asks. Orchy enforces.

1. **Tools** — a step calls only the tools it declares. This is not a sandbox.
   A step that declares `bash` can still change any file.
2. **Contract** — the value of a step must match its JSON Schema. A step that
   answers something else fails. The rule works both ways: a step declares
   `takes`, and the values that reach it must match that schema as well.
3. **Order** — a step starts only after every step it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run forever.
   A flow declares a `budget` in dollars, and the run stops before the next step
   when it reaches it. Every attempt counts, including the ones a cycle threw
   away.
5. **Provenance** — Orchy records what each step changed in the workspace. A
   step that declares `changes: nothing`, `changes: { paths: [docs] }`, or
   `changes: { except: [src] }` fails when anything else moved. The record says
   what the step did to each path: added, changed, deleted, renamed, restored,
   or moved. This catches what `bash` does behind rule 1. A promise bounds what
   a step may change: it does not require the step to change anything, and the
   record covers the workspace, so a step that writes outside it moved nothing
   that Orchy can see.

`validate()` refuses a promise that no workspace can check, a tool that the
harness of the flow does not supply, a model name that the harness cannot read,
a value that a step takes and nothing supplies, and a field that the kind of a
step cannot act on. A rule never looks enforced when it is not, and a field that
no step reads never passes in silence.

## Compose a flow

- **A step** runs an agent, a component of your own — a TypeScript module,
  or a command in any language — or waits for a person.
- **The values of a run** reach every step. A flow declares what it takes, a
  prompt reads `{{ issue }}`, and a component takes the same value as an
  argument.
- **A harness and a model** for the flow, and for any step that wants another.
  Code with one model, review with three others.
- **A fanout** runs one step once for each member, so a panel of reviewers is
  one block of YAML. A member holds a value, so one prompt serves a list. A
  fanout over a list that an earlier step computes waits for that value.
- **A condition** on a step, so a step runs only when an earlier value says so.
  A match holds a value, or one of five operators: `is`, `not`, `empty`, `lt`,
  `gt`.
- **A retry** is a cycle to the step itself, on the word `failed`. A fanout
  takes one too, and each member retries its own work.
- **A flow inside a flow** reuses a whole flow as one step, and carries a cycle
  of its own.
- **A wave** runs every step whose needs have passed at the same time, eight at
  once unless the flow says otherwise. A wave that can change the workspace runs
  one step at a time, because a snapshot of the workspace reads what every step
  wrote. A wave where every step promises `nothing` has no writer, so it runs
  whole.
- **A gate** stops the run and waits for a person. The run persists, the
  process ends, and `orchy resume` continues it. So a flow works in CI. A gate
  carries a cycle, so a person rejects the work and sends the run back.

## Examples

Eight flows in [examples](./examples). A test checks every one of them, and CI
runs the tests on every push, so a broken example fails the build.

| Flow | What it shows |
| --- | --- |
| [code-review](./examples/code-review) | a cycle, written twice: as `flow.ts` and as `flow.yaml` |
| [research](./examples/research) | the web, three readers at once, a budget in dollars, and a check that reads the sources again |
| [triage](./examples/triage) | a gate that overrides the agent, and no workspace at all |
| [docs-audit](./examples/docs-audit) | one promise on the flow, which the workspace checks on every step |
| [release-notes](./examples/release-notes) | a deterministic step reads git, so no model spends tokens on it |
| [decision](./examples/decision) | three fixed stances argue, then a person chooses |
| [dependency-audit](./examples/dependency-audit) | one prompt over a list, a value every member supplies, a retry, and a step a condition rules out |
| [grilling](./examples/grilling) | a gate that asks a person a round of questions, over and over |

## Harnesses

Orchy drives a harness, and does not replace one.

| Harness | How | Model |
| --- | --- | --- |
| `pi` | the [Pi](https://pi.dev) SDK | `provider/model`, such as `ollama/glm-5.2` |
| `claude` | the `claude` command | a model name, such as `claude-opus-4-5` |

A tool has one name in Orchy and another in each harness.

| Orchy | Pi | Claude |
| --- | --- | --- |
| `read` `write` `edit` `bash` `grep` | the same names | `Read` `Write` `Edit` `Bash` `Grep` |
| `find` `ls` | `find` `ls` | `Glob` |
| `web` | none, and Pi says so | `WebSearch` `WebFetch` |

A harness refuses a tool it cannot supply. It never drops one in silence.

Adding a third harness costs one adapter with two methods. The runner, the flow
data, and the five invariants took no edit when the second one arrived.

## Commands

```bash
orchy run flow.yaml                        # or flow.ts
orchy run flow.yaml --with '{"issue":412}' # the values the flow takes
orchy run flow.yaml --harness claude       # for a flow that names none
orchy resume <run id> '{"approved":true}'  # answer a gate
orchy resume <run id>                      # continue a run that ended
orchy resume <run id> --from <step>        # go back to a step, and run again
orchy daemon                               # a queue, an API, and a page
orchy mcp                                  # the same engine, for an agent
```

A resume with no value continues a run that ended: a failed run goes back to
the step that failed, and a stopped run continues where it stood. `--from`
names the step to go back to, and every step after it runs again. The steps
that passed keep their work, and the record of a step that runs again goes to
history first, so its cost still counts.

`--with` takes one JSON object. Orchy checks it against what the flow takes
before the first step spends a token. It refuses a value that breaks the schema,
and a name the flow does not take: a value that reaches no step and no prompt is
a mistake that would otherwise run to the end in silence.

The command prints the events to the error stream and the run state to the
output stream. It ends with 0 when the run finishes, 1 when the run fails, 2
when the command or the flow it was given is wrong, and 3 when the run waits for
a person. `--events` writes one JSON event for each line instead, which is how
the daemon reads a run.

`orchy check <flow file>` reads a flow, and every flow it holds, and says what
is wrong with it. It runs nothing and spends nothing.

`orchy mcp` serves the Model Context Protocol on stdin and stdout, so a coding
agent writes flows, hears every problem from `validate()`, runs them, and
answers a gate. Register it with `claude mcp add orchy -- npx orchy mcp`. See
[docs/running.md](./docs/running.md#drive-orchy-from-an-agent).

A `prompt` path and a `module` path are relative to the flow file. The working
directory is where the steps act, so run the command from the directory you want
them to work in.

## The daemon and the page

```bash
npm run ui:build     # once, and after a change to the UI
orchy daemon         # http://127.0.0.1:4000
```

The daemon holds a queue, starts each run as a child process, and serves a
page. On the page you make a flow or register a flow file, start a run, watch
each step as it runs, read what a step says while it works, answer a gate in a
form built from its contract, read the value, the cost, and the changed files
of every step, open the trajectory of every run of every step, and edit a flow
as a drawing.

One flow runs many times. Every run of a flow reads together on its own page,
newest first, and a run starts from there without leaving it — so a person
starts one run on issue 41 and the next on issue 42, and watches both. Four
runs work at once and the rest wait in the queue. Each run keeps the values it
took, so every list tells one run of a flow from another.

A flow also runs by itself. A schedule fires it on a pace, at most every 15
minutes, and a hook starts it from a POST whose body is the values the flow
takes. Both start a run through the same checked door as the button, so each
refuses the same broken flow the same way. The tab title says whose move it is,
and an opt-in notification says when a run waits for you or ends.

- **A run in a child process.** A run that hangs or dies takes nothing with it.
  Four runs start at the same time. See [ADR
  0008](./docs/adr/0008-the-daemon-runs-each-run-in-a-child-process.md).
- **The disk stays the run.** A SQLite index answers a list and holds the
  events. Losing it costs the events and no run. See [ADR
  0009](./docs/adr/0009-the-database-indexes-the-runs-on-disk.md).
- **The editor writes your file.** It reads a flow, draws it, and writes the
  same YAML back. It refuses to write a flow that `validate()` rejects, and it
  reads a flow in TypeScript without writing one. See [ADR
  0010](./docs/adr/0010-the-editor-writes-the-same-yaml-file.md).
- **A step reports by reading its own record.** An adapter reads the file that
  its harness already writes, so the live report and the trajectory come from
  one parser, and no harness is started a different way. See [ADR
  0011](./docs/adr/0011-a-step-reports-by-reading-its-own-record.md).

The daemon listens on `127.0.0.1` only, and it refuses a page that is not its
own. A request with a foreign `Origin` reaches nothing, so a page a person
visits starts no flow here. A request with a `Host` that this daemon does not
answer to reaches nothing, which closes DNS rebinding. The daemon answers to
`127.0.0.1`, to `[::1]`, and to `localhost`, on its own port, and the answer
names the address to use. See [ADR
0020](./docs/adr/0020-the-daemon-refuses-a-foreign-page.md).

This is not a user and a password. The daemon has neither. It starts an agent
that can hold `bash`, so anyone who reaches the port from a program still runs
code on the machine. The rule above bounds a browser, because a browser writes
those two headers itself. The daemon is not ready for a shared host.

The steps of every run act in the directory where the daemon starts, so start it
where you want the work to happen. A flow file outside that directory is
refused, and the message names the directory.

## What you get from a run

```
.orchy/
├── index.db          the daemon builds this from the runs, and rebuilds it
└── runs/<run id>/
    ├── state.json        the flow, the prompt and the value of every step,
    │                     the value the flow returns, and the cycle counts
    └── trajectory.json   one ATIF v1.7 trajectory, a child for each agent step
```

`orchy runs` lists them, newest first.

`state.json` holds `value`, which is what the flow produced: the value of the
step it ends with. It holds the `prompt` of every agent step as well, filled in
with the values of the run, so a reader knows what the step was really asked.

The trajectory holds the tool calls, the reasoning, the tokens, and the cost of
every step, including the runs a cycle threw away. ATIF is a standard format,
so a tool that already reads it turns the file into OpenTelemetry spans. Orchy
ships no exporter.

```bash
jq .final_metrics .orchy/runs/<run id>/trajectory.json
```

## How it works

```
TypeScript API ─┐
YAML file ──────┼──▶ Flow (data) ──▶ expand ──▶ validate ──▶ waves ──▶ record
Graphical editor┘                                                        │
                                                                         ▼
                                          orchy daemon ──▶ a queue, an API, a page
```

A flow is data, not code. So the API, a file, and the graphical editor all
produce the same flow.

The daemon sits above the runner and adds no rule about a flow. It starts
`orchy run` as a child process for each run, and indexes what that child writes.
Its own rule is its door, and nothing else.

A fanout and a flow step are expansions. They become plain steps before the
run, so the runner knows neither and an editor draws one flat graph. A fanout
over a list that a step computes is the one exception: that list arrives with a
value, so the run expands it and writes the steps it made to disk.

A run is a state machine on disk. It writes its state after every step, so a
gate and a crash recover the same way.

## Install

Orchy needs Node 22.18 or later. Node strips the types, so there is no build
step.

Orchy is not on npm yet, and another package already holds the name. Install it
from this repository.

```bash
git clone https://github.com/krimvp/orchy && cd orchy && npm install
node src/cli.ts run flow.yaml
```

A run needs `ajv`, `yaml`, and the Pi SDK. Add `@sinclair/typebox` only to
write a flow in TypeScript. A flow in YAML holds plain JSON Schema and needs
nothing.

### A model comes from the harness

Orchy holds no credential and no model catalogue. Each harness reads its own,
so a flow runs only where its harness can reach the model it names.

**Pi** reads `~/.pi/agent/auth.json` for a key, and `~/.pi/agent/models.json`
for a provider it does not ship. A local model, an Ollama server, or any
OpenAI-compatible endpoint goes in that file:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "https://ollama.com/v1",
      "api": "openai-completions",
      "apiKey": "$OLLAMA_API_KEY",
      "models": [{ "id": "glm-5.2" }]
    }
  }
}
```

That name is the one a flow writes: `model: ollama/glm-5.2`. Run
`npx pi --list-models` to see what Pi reaches, and `npx pi auth check --provider
<name>` to see whether it can reach it.

**Claude Code** reads the account that `claude` is logged in to. A flow writes a
plain name: `model: opus`.

A flow that names no model takes the default of its harness, and the default of
Pi is a model that most machines cannot reach. So name one.

The page needs a build, and its packages live under `ui/` and reach no run.

```bash
npm run ui:build
node src/cli.ts daemon
```

The daemon keeps its index with `node:sqlite`, which the standard library holds.
Node calls it experimental and prints a warning when it starts.

```bash
npm test        # every test, with node --test
npm run check   # the compiler
```

CI runs both, and the page build, on every push to main and on every merge
request. See [.github/workflows/ci.yml](./.github/workflows/ci.yml).

A flow in TypeScript builds the same data as a file:

```ts
import { agent, flow, run } from "./src/index.ts";
import { Type } from "@sinclair/typebox";

const state = await run(
  flow("code-and-review", {
    steps: [
      agent({
        id: "code",
        prompt: "prompts/code.md",
        tools: ["edit"],
        returns: Type.Object({ summary: Type.String() }),
      }),
    ],
  }),
);
```

`agent()` is generic over its contract, so TypeScript catches a `cycle.when`
key that the step never returns.

## State

Early, and honest about it.

**Run against a real model:** both harnesses, a cycle that carries its reason
back, a gate and `orchy resume`, an escalation to a person, a panel of three
models at once, a flow inside a flow, and a workspace that proves what changed.

**Covered by a run of the whole flow, with a stand-in model:** the values a run
takes and the value a flow returns, a name in a prompt, a step that declares
what reaches it, a member that holds a value, a fanout over a list that a step
computes, each of the five operators, a gate that sends the run back, a step
that retries itself, a step that a condition rules out, a wave that holds a
promise, two failures in one wave, and a budget that stops a run. See
[dependency-audit](./examples/dependency-audit).

**Driven in a browser:** the daemon, the queue, the live events, the notes a
step reports while it works, the gate form, the step view, the trajectory view,
and the editor. A test drives each one through the API, and a flow of
deterministic steps stands in for a model. A test also proves that the daemon
passes the values of a run to the child, that a schedule fires a run by itself
and holds its pace, that a hook starts a run and a wrong token starts nothing,
that a failed run resumes from the step that failed and keeps the work that
passed, and that it refuses a foreign `Origin`, a foreign `Host`, and a flow
file outside its root.

**Checked, and never run:** the `none` workspace, and the `docs-audit`,
`release-notes`, `decision`, and `dependency-audit` examples. A test reads every
example and holds it to `validate()`. It starts no run of one.

**Not built:** an OpenTelemetry exporter, a third harness, a sandbox, a
timeout for a step, a workspace for one step, a workspace for each run, and
any user or password on the daemon. Invariant 1 names the sandbox gap
rather than hiding it, and [ADR
0018](./docs/adr/0018-a-tool-list-is-not-a-sandbox.md) records the probes that
closed the question. A note arrives when the harness writes a line, so a step
reports by the turn and not by the word. Two runs in one working directory
disturb each other, and the code names that limit.

The API can still change, and the name on npm belongs to another package.

## Read next

- [docs/running.md](./docs/running.md) — choose a harness and a model, answer a
  gate, pace the work.
- [docs/plan.md](./docs/plan.md) — the design and the milestones.
- [docs/shape.md](./docs/shape.md) — what the flow data holds, and where it is
  weak.
- [docs/usability.md](./docs/usability.md) — one usability run over the whole
  product, and what it found.
- [docs/adr](./docs/adr) — every decision that is hard to reverse, and why.
- [CONTEXT.md](./CONTEXT.md) — the words this project uses.
- [AGENTS.md](./AGENTS.md) — how to work in this repository.

MIT. The text is in [LICENSE](./LICENSE).
