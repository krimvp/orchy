# Run a flow

## Schemas

A contract is JSON Schema. That is the one form that Orchy keeps, because a
flow is data and a file or a graphical editor must produce the same contract.

Orchy uses one library at run time: **Ajv** checks every value against the
contract. That is the guarantee.

Each adapter gives the contract to its harness whole. Pi builds a
`submit_result` tool from it. The `claude` command takes it with
`--json-schema`. Neither converts it.

**TypeBox** is optional. You need it only to write a flow in TypeScript, where
it gives one source for the contract and the static type that makes
`cycle.when` safe. A flow in YAML holds plain JSON Schema and needs nothing.

```bash
npm i orchy @sinclair/typebox   # to write a flow in TypeScript
npm i orchy                     # to run a flow from YAML
```

## Choose a harness

Orchy ships two adapters. Pi is the default.

```bash
orchy run flow.yaml --harness pi        # the default
orchy run flow.yaml --harness claude    # Claude Code
```

The Claude Code adapter runs the `claude` command, so it needs that command on
the path and a logged-in account. It takes no model setting from Orchy: Claude
chooses its own.

A tool name changes across the two harnesses, and Orchy maps it. `find` and `ls`
both become `Glob`, because Claude has no separate list tool. So a step that
declares `ls` gets `Glob`. The list still holds: a step reaches no tool that it
did not declare.

## A harness and a model for each step

A step names the harness and the model it wants. A step that names neither uses
the harness of the run and lets that harness choose its model.

```yaml
  - id: code
    kind: agent
    harness: claude
    model: claude-opus-4-5
```

The `model` string means whatever the harness says it means. Claude takes a
model name. Pi takes `provider/model`, because two providers can serve one
model, for example `ollama/glm-5.2`.

A run refuses a harness it does not have before it runs any step.

### More than one reviewer, in one step

A `fanout` runs one step once for each member. A member names itself and
overrides only what differs. Orchy turns the step into one step for each member
before the run, so the ids read `reviewer/opus`, and a graphical editor draws
the expanded graph.

```yaml
  - id: reviewer
    kind: agent
    prompt: prompts/review.md
    tools: [read]
    changes: false
    returns: *verdict
    fanout:
      - { name: opus,   harness: claude, model: claude-opus-4-5 }
      - { name: sonnet, harness: claude, model: claude-sonnet-5, prompt: prompts/review-strict.md }
      - { name: glm,    harness: pi,     model: ollama/glm-5.2 }

  - id: verdict
    kind: call
    needs: [reviewer]          # this becomes every member
    module: verdict.ts
    returns: *verdict
```

A step that needs `reviewer` needs every member, and the module reads them with
`Object.values(inputs)`. The members run at the same time, because every step
whose needs have passed runs together.

A `call` step fans out as well. A member of a `call` step overrides its
`module`, and a member of an agent step overrides its `harness`, `model`,
`prompt`, and `tools`. A member never picks up a field the other kind holds.

A step cannot both fan out and cycle, because which member cycles is unclear.
Put the cycle on the step that reads the members.

### A flow inside a flow

A `kind: flow` step puts the steps of another file in its place. The id of the
step becomes their prefix, so the same panel serves two flows without a clash.

```yaml
  - id: review
    kind: flow
    needs: [code]
    flow: ./review-panel.yaml
```

The steps become `review/reviewer/opus`, `review/verdict`, and so on. A step
that starts the inner flow waits for whatever the outer step waited for, and
whoever needed `review` now needs the step the inner flow ends with.

An inner flow must end in exactly one step, so that reference is never unclear.
A cycle inside an inner flow stays inside it.

A `kind: flow` step carries a cycle of its own, and expansion hangs it on the
step the inner flow ends with. So a panel sends the work back without the outer
flow knowing how the panel reaches its answer.

```yaml
  - id: review
    kind: flow
    needs: [code]
    flow: ./review-panel.yaml
    cycle: { to: code, when: { approved: false }, limit: 3, policy: escalate }
```

An inner file is a fragment: it holds no workspace and the run checks the whole
flow after it joins the parts.

### More than one reviewer, written out

A panel is a step for each reviewer and one step that counts the votes. Each
reviewer names its own harness, model, and prompt. The rule for a disagreement
is yours, so it lives in a `call` step, not in Orchy.

```yaml
  - { id: review-opus,   kind: agent, needs: [code], harness: claude, model: claude-opus-4-5,  prompt: prompts/review.md,        tools: [read], changes: false, returns: *verdict }
  - { id: review-sonnet, kind: agent, needs: [code], harness: claude, model: claude-sonnet-5,  prompt: prompts/review-strict.md, tools: [read], changes: false, returns: *verdict }
  - { id: review-glm,    kind: agent, needs: [code], harness: pi,     model: ollama/glm-5.2,   prompt: prompts/review.md,        tools: [read], changes: false, returns: *verdict }

  - id: verdict
    kind: call
    needs: [review-opus, review-sonnet, review-glm]
    module: verdict.ts
    returns: *verdict
    cycle: { to: code, when: { approved: false }, limit: 2, policy: escalate }
```

A YAML anchor such as `&verdict` and `*verdict` keeps one copy of a contract.

## How many steps at once

Every step whose needs have passed runs together, up to eight at a time. A flow
sets its own number.

```yaml
name: panel-review
parallel: 3
```

The number only paces the work. It changes no result, so raise it when the
harness and the provider allow more.

## Choose a model

This section is for Pi.

Orchy does not choose a model. Pi does. Version 1 uses one model for the whole
flow, so you set it once.

Declare a provider in `~/.pi/agent/models.json`. Declare it here, and not in a
Pi extension. Pi resolves the model before an extension runs, so a provider that
an extension registers comes too late and Pi falls back to another model.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "https://ollama.com/v1",
      "api": "openai-completions",
      "apiKey": "$OLLAMA_API_KEY",
      "models": [
        {
          "id": "qwen3.5:397b",
          "name": "Qwen 3.5 397B",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 256000,
          "maxTokens": 32768,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

`apiKey` reads an environment variable when it starts with `$`.

Then name the default in `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3.5:397b"
}
```

A model must call tools well. Orchy takes the value of a step from a
`submit_result` tool, so a model that answers in prose fails the step.

The `cost` numbers come from you. A provider with a subscription price reports
no cost for one call, so `cost_usd` in the trajectory stays at zero.

Claude Code writes no cost into its transcript, so the adapter takes the cost
from the answer of the command and Orchy keeps it in the step record.

## Run

```bash
orchy run flow.yaml        # or flow.ts
```

A `prompt` path and a `module` path are relative to the flow file, so a flow in
its own directory finds its own prompts. The working directory is where a step
acts, which is a different thing. So you run a flow from the directory you want
it to work in, wherever the flow file sits.

The command prints the events to the error stream and the run state to the
output stream. It ends with 0 when the run finishes or waits, and 1 when the run
fails.

## Answer a gate

A run that reaches a gate writes its state and ends. The command prints the run
id.

```bash
orchy resume <run id> '{"approved":true}'
```

Orchy checks the value against the contract of the gate, so a wrong value is
refused before the run continues.

## Read the record

Each run writes two files to `.orchy/runs/<run id>/`:

- `state.json` — the flow, the value of every step, and the cycle counts.
- `trajectory.json` — one ATIF trajectory, with a child for each agent step.
