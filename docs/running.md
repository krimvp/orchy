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

Orchy ships two adapters. A flow names the one it needs. `--harness` sets the
default for a flow and a step that name none, and Pi is that default.

```bash
orchy run flow.yaml                     # the harness the flow names, or pi
orchy run flow.yaml --harness claude    # Claude Code, for a flow that names none
```

A flow that names its harness runs on that harness. Edit the flow to change it,
because a flag that overruled the flow would start a run that `validate()`
already refused.

The Claude Code adapter runs the `claude` command, so it needs that command on
the path and a logged-in account. It passes a `model` on to `--model`, and it
lets Claude choose when the flow names none.

A tool name changes across the two harnesses, and Orchy maps it. `find` and `ls`
both become `Glob`, because Claude has no separate list tool. So a step that
declares `ls` gets `Glob`. The list still holds: a step reaches no tool that it
did not declare.

## A harness and a model for each flow, and for each step

A flow names the harness and the model it wants, and a step names another when
it wants another. The narrower one wins: the step, then the flow, then the
default of the run.

```yaml
name: code-and-review
harness: claude
model: claude-sonnet-5

steps:
  - id: code
    kind: agent
    model: claude-opus-4-5   # this step alone
```

The `model` string means whatever the harness says it means. Claude takes a
model name. Pi takes `provider/model`, because two providers can serve one
model, for example `ollama/glm-5.2`.

Name the harness on the flow when the flow needs one. `validate()` then refuses
a tool that the harness does not supply, before the run spends a token. A flow
that asks for `web` under `pi` fails the check and never starts.

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
    changes: nothing
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
`prompt`, and `tools`. Both kinds hold `with`. `validate()` refuses a member
that holds a field of the other kind, so nothing is dropped in silence.

### One prompt over a list

A member holds `with`, the value that is its own. So a step that audits six
packages is one prompt and six members, and not six prompt files.

```yaml
  - id: audit
    kind: agent
    prompt: prompts/audit.md
    tools: [read, grep]
    changes: nothing
    returns: *finding
    fanout:
      - { name: ajv,  with: { package: ajv } }
      - { name: yaml, with: { package: yaml } }
```

An agent step reads the value in its prompt, under `The values this step holds`.
A component takes it as a third argument:

```ts
export default (inputs, say, held) => ({ package: held.package });
```

### A step that runs only sometimes

A step holds `when`, a match against the value of each step that it needs.

```yaml
  - id: page
    kind: agent
    needs: [sort]
    when: { sort: { severity: high } }
```

A step that the condition rules out is skipped, and so is every step that needs
it. So a step that must run whatever happens needs only the steps it reads. See
[ADR 0014](./adr/0014-a-step-that-a-condition-rules-out.md).

### A step that retries itself

A cycle to the step itself repeats one step. The word `failed` fires it on a
step that failed, rather than on a value.

```yaml
    cycle: { to: advise, when: failed, limit: 2, policy: escalate }
```

The step hears the error of its last attempt, so it does not repeat the mistake.
A step that breaks its contract is retried in the same way, because that is a
failure too. At the limit, `escalate` asks a person for the value, and `accept`
fails the run: a failure carries no value, so there is nothing to accept.

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
  - { id: review-opus,   kind: agent, needs: [code], harness: claude, model: claude-opus-4-5,  prompt: prompts/review.md,        tools: [read], changes: nothing, returns: *verdict }
  - { id: review-sonnet, kind: agent, needs: [code], harness: claude, model: claude-sonnet-5,  prompt: prompts/review-strict.md, tools: [read], changes: nothing, returns: *verdict }
  - { id: review-glm,    kind: agent, needs: [code], harness: pi,     model: ollama/glm-5.2,   prompt: prompts/review.md,        tools: [read], changes: nothing, returns: *verdict }

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

## Say what a step does

A component takes the values of the steps before it, and a way to say what it
does. A component that says nothing ignores the second argument.

```ts
export default (inputs, say) => {
  say("reading the tickets");
  const tickets = read();
  say(`${tickets.length} tickets`);
  return { tickets };
};
```

An agent step needs nothing: the adapter reads the record that the harness
writes and reports each turn as it lands. See [ADR
0011](./adr/0011-a-step-reports-by-reading-its-own-record.md).

## Read the record

Each run writes two files to `.orchy/runs/<run id>/`:

- `state.json` — the flow, the value of every step, and the cycle counts.
- `trajectory.json` — one ATIF trajectory, with a child for each agent step.

## Run from a page

The daemon does the same work from a browser. Build the page once, then start
the daemon in the directory where you want the steps to act.

```bash
npm run ui:build
orchy daemon                  # http://127.0.0.1:4000
orchy daemon --port 8080
```

On the page:

1. Open **Flows** and give the path of a flow file. The path is relative to the
   directory of the daemon.
2. Press **Run**. The run goes in the queue, and it starts when a slot is free.
   Four runs run at the same time.
3. Open the run. Each step turns green when it passes and red when it fails, and
   the events arrive while the run is on the way.
4. A run that reaches a gate shows a form built from the contract of that gate.
   Answer it, and the run continues. This is `orchy resume` under a form.
5. Choose a step to read its value, its error, its length, and the files it
   changed.
6. **What the steps say** shows each note as it arrives, while the run works. A
   note is a view: the daemon keeps the last of them in memory and writes none
   of them to the index.
7. **Trajectory** draws the record: every run of every step, opening on the
   turns that the harness took, with the reasoning, the tool calls and their
   arguments, the results, and the tokens of each turn. A run that a cycle threw
   away is marked as one, because it is still a cost.
8. Press **Edit** on a flow to draw it. The editor writes the same YAML file.
   It refuses to write a flow that `validate()` rejects, and it will not write a
   flow in TypeScript.

The daemon listens on `127.0.0.1` only. A step can hold `bash`, so anyone who
reaches the port runs code on the machine. The daemon has no user and no
password. Do not put it on a shared host.

The command line and the daemon run a flow the same way. The daemon starts
`orchy run <flow file> --events` as a child process, which writes one JSON event
for each line, and reads the state that the child writes to disk. So a run needs
no daemon, and `orchy run` on its own stays the same command.

The daemon indexes every run it finds under `.orchy/runs` when it starts, so a
run from the command line shows up on the page. It keeps that index in
`.orchy/index.db`. Deleting the index costs the events of past runs, and no run.
