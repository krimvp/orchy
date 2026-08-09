# Orchy

Orchy runs agent flows. You declare the steps and the rules. Orchy runs the
steps, enforces the rules, and records what each step did.

A coding agent is good at one step and poor at a long one. So Orchy holds the
control flow, and gives each step one job, one tool list, and one contract.

```yaml
name: code-and-review
workspace: { kind: git, path: . }

steps:
  - id: code
    kind: agent
    harness: claude
    model: claude-opus-4-5
    prompt: prompts/code.md
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
    changes: false
    returns:
      type: object
      required: [approved, findings]
      properties:
        approved: { type: boolean }
        findings: { type: array, items: { type: string } }
    cycle: { to: code, when: { approved: false }, limit: 3, policy: escalate }
```

```bash
orchy run flow.yaml
```

One model writes the code. A different model on a different harness reviews it,
reaches no tool that can change a file, and sends the work back until it
approves or a person takes over.

## What Orchy guarantees

A prompt asks. Orchy enforces.

1. **Tools** — a step calls only the tools it declares. This is not a sandbox.
   A step that declares `bash` can still change any file.
2. **Contract** — the value of a step must match its JSON Schema. A step that
   answers something else fails.
3. **Order** — a step starts only after every step it needs passes.
4. **Limit** — a cycle stops at its declared limit. A flow cannot run forever.
5. **Provenance** — Orchy records what each step changed in the workspace. A
   step that declares `changes: false` fails when anything moved. This catches
   what `bash` does behind rule 1.

`validate()` refuses a promise that no workspace can check, and refuses a tool
that no harness has. A rule never looks enforced when it is not.

## Compose a flow

- **A step** runs an agent, a module of your own, or waits for a person.
- **A harness and a model for each step.** Code with one model, review with
  three others.
- **A fanout** runs one step once for each member, so a panel of reviewers is
  one block of YAML.
- **A flow inside a flow** reuses a whole flow as one step, and carries a cycle
  of its own.
- **A wave** runs every step whose needs have passed at the same time, eight at
  once unless the flow says otherwise.
- **A gate** stops the run and waits for a person. The run persists, the
  process ends, and `orchy resume` continues it. So a flow works in CI.

## Examples

Seven flows in [examples](./examples). A test checks every one of them, so a
broken example fails the build.

| Flow | What it shows |
| --- | --- |
| [code-review](./examples/code-review) | a cycle, written twice: as `flow.ts` and as `flow.yaml` |
| [research](./examples/research) | the web, three readers at once, and a check that reads the sources again |
| [triage](./examples/triage) | a gate that overrides the agent, and no workspace at all |
| [docs-audit](./examples/docs-audit) | `changes: false` on every step, proved by the workspace |
| [release-notes](./examples/release-notes) | a deterministic step reads git, so no model spends tokens on it |
| [decision](./examples/decision) | three fixed stances argue, then a person chooses |
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
orchy run flow.yaml --harness claude       # pi is the default
orchy resume <run id> '{"approved":true}'  # answer a gate
```

The command prints the events to the error stream and the run state to the
output stream. It ends with 0 when the run finishes or waits, and 1 when the
run fails.

A `prompt` path is relative to the flow file. The working directory is where
the steps act, so run the command from the directory you want them to work in.

## What you get from a run

```
.orchy/runs/<run id>/
├── state.json        the flow, the value of every step, the cycle counts
└── trajectory.json   one ATIF v1.7 trajectory, with a child for each agent step
```

The trajectory holds the tool calls, the reasoning, the tokens, and the cost of
every step, including the runs a cycle threw away. ATIF is a standard format,
so a tool that already reads it turns the file into OpenTelemetry spans. Orchy
ships no dashboard.

```bash
jq .final_metrics .orchy/runs/<run id>/trajectory.json
```

## How it works

```
TypeScript API ─┐
YAML file ──────┼──▶ Flow (data) ──▶ expand ──▶ validate ──▶ waves ──▶ record
Graphical editor┘
```

A flow is data, not code. So the API, a file, and one day a graphical editor
all produce the same flow.

A fanout and a flow step are expansions. They become plain steps before the
run, so the runner knows neither and an editor draws one flat graph.

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

**Covered by tests only:** the `none` workspace, and the `docs-audit`,
`release-notes`, and `decision` examples.

**Not built:** a graphical editor, live agent output for one, an OpenTelemetry
exporter, a third harness, and a sandbox. Invariant 1 names that last gap
rather than hiding it.

The API can still change, and the name on npm belongs to another package.

## Read next

- [docs/running.md](./docs/running.md) — choose a harness and a model, answer a
  gate, pace the work.
- [docs/plan.md](./docs/plan.md) — the design and the milestones.
- [docs/adr](./docs/adr) — every decision that is hard to reverse, and why.
- [CONTEXT.md](./CONTEXT.md) — the words this project uses.
- [AGENTS.md](./AGENTS.md) — how to work in this repository.

MIT.
