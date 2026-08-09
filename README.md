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
    returns: &verdict
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

`validate()` refuses a promise that no workspace can check, so a rule never
looks enforced when it is not.

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

## Compose a flow

- **A step** runs an agent, a module of your own, or waits for a person.
- **A harness and a model for each step.** Code with one model, review with
  three others.
- **A fanout** runs one step once for each member, so a panel of reviewers is
  one block of YAML.
- **A flow inside a flow** reuses a whole flow as one step.
- **A wave** runs every step whose needs have passed at the same time.
- **A gate** stops the run and waits for a person. The run persists, the
  process ends, and `orchy resume` continues it. So a flow works in CI.

## Harnesses

Orchy drives a harness, and does not replace one.

| Harness | How | Model |
| --- | --- | --- |
| `pi` | the [Pi](https://pi.dev) SDK | `provider/model`, such as `ollama/glm-5.2` |
| `claude` | the `claude` command | a model name, such as `claude-opus-4-5` |

Adding a third costs one adapter with two methods. The runner, the flow data,
and the five invariants took no edit when the second one arrived.

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
    steps: [agent({ id: "code", prompt: "prompts/code.md", tools: ["edit"], returns: Type.Object({ summary: Type.String() }) })],
  }),
);
```

## Read next

- [docs/running.md](./docs/running.md) — run a flow, choose a harness and a
  model, answer a gate.
- [docs/plan.md](./docs/plan.md) — the design and the milestones.
- [docs/adr](./docs/adr) — every decision that is hard to reverse, and why.
- [CONTEXT.md](./CONTEXT.md) — the words this project uses.
- [AGENTS.md](./AGENTS.md) — how to work in this repository.
- [examples](./examples) — seven flows, from code review to research.

## State

Early. The design is settled and both harnesses run real flows. The API can
still change, and the name on npm belongs to another package.

MIT.
