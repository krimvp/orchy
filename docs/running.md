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

Orchy is on npm as `@krimvp/orchy`, because the bare name belongs to another
package, and a clone runs from source. Either way, see the
[Install](../README.md#install) part of the README. Add `@sinclair/typebox` only
to write a flow in TypeScript. A flow in YAML holds plain JSON Schema and needs
nothing.

## The values a run takes

A flow declares `takes`, the schema of the values that a run supplies. So one
flow serves every issue, and you edit no file for a run.

```yaml
name: fix-the-issue
takes:
  type: object
  required: [issue]
  properties: { issue: { type: number } }
```

```bash
orchy run flow.yaml --with '{"issue":412}'
```

`--with` takes one JSON object. Orchy checks it against `takes` before the first
step spends a token. A run that supplies a value the flow does not take is
refused, and so is a flow that takes values and gets none.

Every step of the run reads the values. A prompt holds the name in braces:

```
Read issue {{ issue }} and write the patch it asks for.
```

A name that nothing supplies fails the step, and the message names the step and
the name. A prompt that keeps the braces sends a model to do the wrong work, and
says nothing about it.

A component reads the same values as its third argument:

```ts
export default (inputs, say, values) => ({ url: open(values.issue) });
```

A name that the run and the step both supply takes the value of the step,
because the step is the narrower of the two.

A step declares `takes` as well, for the values that must reach it. Orchy checks
them before it loads the module and before it builds the prompt.

```yaml
  - id: audit
    kind: agent
    takes: { type: object, required: [package], properties: { package: { type: string } } }
```

A flow declares `returns`, the value it produces, which is the value of the step
it ends with. Orchy checks that value at the end of the run. A flow that returns
a value ends in one step, and `validate()` refuses one that ends in more.

The daemon takes the same values in `POST /api/flows/:id/runs`, and a `kind:
flow` step supplies them with `with`. See [ADR
0015](./adr/0015-a-flow-takes-values-and-returns-one.md).

## Choose a harness

Orchy ships three adapters. A flow names the one it needs. `--harness` sets the
default for a flow and a step that name none, and Pi is that default.

```bash
orchy run flow.yaml                     # the harness the flow names, or pi
orchy run flow.yaml --harness claude    # Claude Code, for a flow that names none
orchy run flow.yaml --harness droid     # Droid, the same way
```

A flow that names its harness runs on that harness. Edit the flow to change it,
because a flag that overruled the flow would start a run that `validate()`
already refused.

The Claude Code adapter runs the `claude` command, so it needs that command on
the path and a logged-in account. It passes a `model` on to `--model`, and it
lets Claude choose when the flow names none.

The Droid adapter runs the `droid` command of Factory the same way, and a
custom model in `~/.factory/config.json` needs no Factory account. See the
Install part of [README.md](../README.md#a-model-comes-from-the-harness). Droid
writes no dollars into its record, so a droid step reports no cost, and a flow
that holds one declares no `budget`.

A tool name changes across the harnesses, and Orchy maps it. `find` and `ls`
both become `Glob`, because Claude has no separate list tool. So a step that
declares `ls` gets `Glob`. On droid, `write` becomes `Create` and `bash`
becomes `Execute`. The list still holds: a step reaches no tool that it did
not declare.

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
model, for example `ollama/glm-5.2`. Droid takes the id it lists, and a custom
model reads best by its long name, as `custom:glm-5.2-[Ollama-Cloud]-0`.

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

### A fanout over a list that a step computes

A fanout also names where the list comes from: the step that holds it, and the
key in the value of that step. So "audit every package that this step found" is
one step, and a list that changes needs no edit.

```yaml
  - id: audit
    kind: call
    needs: [find]
    module: audit.ts
    fanout: { step: find, key: packages }
```

`find` returns `{ packages: [{ name: core }, { name: cli }] }`, so the run holds
`audit/core` and `audit/cli`. Each item is one member: the item is the value of
the member, and the `name` field of the item names it. An item with no name, and
two items with one name, fail the run and name the step.

The run expands this one, at the moment the step it reads holds a value. Every
other expansion happens before the run. A list that comes back empty skips the
step, and says so. See [ADR
0017](./adr/0017-a-fanout-over-a-value-the-run-computes.md).

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

The match against one value is the value itself, which tests that the two are
equal, or one operator.

| Operator | What it tests | Reads |
| --- | --- | --- |
| `is` | the value is equal to this | any value |
| `not` | the value is not equal to this | any value |
| `empty` | a list, a string, or an object holds nothing | a boolean |
| `lt` | the value is below this | a number |
| `gt` | the value is above this | a number |

```yaml
    when: { review: { findings: { empty: false } } }
    cycle: { to: code, when: { approved: { not: true } }, limit: 3, policy: accept }
```

An object is always an operator, so write `{ is: { ok: true } }` to test a value
that is an object. The set is closed, and `validate()` names every operator in
its message. A step answers the question that no operator asks. See [ADR
0016](./adr/0016-a-match-holds-one-operator.md).

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

A step that fans out cycles to itself, and no further: each member retries its
own work, and keeps its own count. A cycle that leaves the step is refused,
because a fanout has no one value to send back and which member cycles is
unclear — put that cycle on the step that reads the members. See [ADR
0021](./adr/0021-a-member-of-a-fanout-retries-itself.md).

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

The number paces the work of a wave that promises nothing. Raise it when the
harness and the provider allow more.

A wave that holds a promise ignores the number and runs one step at a time.
Invariant 5 reads a snapshot of the whole workspace, so a step that runs beside
another one sees what that one wrote, and the promise of the first step fails
for a file that the second step made. A rule that reports what it did not
observe is worse than no rule, so the promise wins and the wave gets slower.

The promise of the flow counts as well, because every step that declares none
takes it. So a flow with `changes: nothing` on the flow runs one step at a time
from end to end. Put the promise on the steps that act, and not on the flow,
when a wave must run wide.

Two runs in one working directory still disturb each other, whatever this number
says. A promise holds inside one run. Give each run a working directory of its
own.

## Choose a model

This section is for Pi.

Orchy does not choose a model. Pi does. A flow names the model once, and a step
that wants another names it, as above.

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
no cost for one call, so `cost_usd` in the trajectory stays at zero. A session
whose cost is zero throughout is a session that reported nothing, and a budget
over it stops the run. So a flow on such a provider declares no budget.

Claude Code writes no cost into its transcript, so the adapter takes the cost
from the answer of the command and Orchy keeps it in the step record.

A model must also carry a name that the harness reads. Pi reads
`provider/model`, and the `claude` command reads a plain name. `validate()`
refuses the wrong grammar before the run, and says what to write.

## What a run may spend

A flow declares a budget, in dollars.

```yaml
name: research
budget: 10
```

The run counts what every step spent, between waves. A run that reaches the
budget stops before the next step and fails:

```
the run reached the budget of the flow "research": it spent $10.02 of $10. It
stops before the next step.
```

Every attempt counts, including the ones a cycle threw away, because a dropped
attempt is still a cost. The check runs between waves, so a wave that starts
inside the budget runs to its end. A run that reaches the budget in its last
wave still ends `done`.

A budget does not wait for a person. No value of any step answers "the money ran
out", and a resumed run meets the same spend again.

Orchy enforces no budget that it cannot measure. A run with a budget stops when
an agent step reports no cost, and says so. A provider with no price table, and
a provider whose prices are all zero, both report a total of zero on every
message — and a step that answered spent something, so Orchy reads that total as
no measurement and not as a cost of zero. So a flow that holds one such step
declares no budget: the wave after that step stops the run, whatever the other
steps report. Only the flow that the run starts holds a budget: a sub-flow with
one is refused when the file loads. See [ADR
0019](./adr/0019-a-run-has-a-budget.md).

## What a run remembers

A flow that says nothing remembers nothing, which is the default. One that
wants to says where:

```yaml
name: bugfix
takes:
  type: object
  required: [issue]
  properties:
    issue: { type: string }
memory:
  scope: "ticket/{{ issue }}"
  most: 20
```

`scope` is the key of one store. Three words are not keys: `none` remembers
nothing, `flow` is one store for every run of this flow, and `user` is the one
global store — available, but you write it by name. Everything else is a key of
your own, and it reads the values of the run the way a prompt does. So each
ticket gets a store, and a follow-up flow that writes the same scope reads what
the first run left:

```yaml
name: corrections
memory:
  scope: "ticket/{{ issue }}"
```

`orchy check` refuses a scope that reads a value the flow does not take, before
a run starts. A memory belongs to the run, as a budget does, so a flow held by a
`flow` step declares none: expansion would drop it, and a scope that stood alone
would resolve against another flow's values. A run resolves the key once, before its first step, and keeps it,
so a resume reads the store the run really used.

What the scope holds goes into the prompt of every step, under **What earlier
runs recorded**, beside the values of the run. `most` bounds how many entries —
twenty when the flow is silent, and `0` seeds none. A step that must judge the
work and nothing else declines the lot:

```yaml
- id: review
  kind: agent
  needs: [code]
  memory: none
  prompt: prompts/review.md
  tools: [read]
```

Four things write an entry. A step that holds the `orchy` tool calls `remember`
at the door of its own run, mid-work. A flow that would rather not leave it to
the model ends with a step:

```yaml
- id: record
  kind: call
  needs: [summarize]
  module: orchy:remember
  with: { tags: [handoff] }
  returns:
    type: object
    required: [recorded]
    properties:
      recorded: { type: array, items: { type: string } }
```

With no `text` of its own it records the value of each step it needs, so an
agent step that summarizes before it is the whole of what a flow has to write.
The third way is the command line — `orchy memory add <scope> <text>` — which is
also how a `command` step and a harness with no `orchy` tool reach the store; a
command step reads the key as `$ORCHY_MEMORY_KEY`. The fourth is a hand, in the
file: it is a line of JSON for each entry, under `.orchy/memory`.

A step reads past the seed with `recall_memory`, which takes a query and no
key. The scope comes from the state of the run, so a step cannot reach the
store of another ticket, another flow, or another user — there is nothing to
ask for.

Every entry names the run and the step that wrote it, so a wrong one is found
and dropped:

```bash
orchy memory keys
orchy memory list ticket-proj-14
orchy memory forget ticket-proj-14 a41f9c02   # or the whole scope, with no id
```

Nothing expires, and nothing ranks: `recall_memory` matches a substring, in the
text and in the tags. Durable project knowledge still belongs in reviewed,
human-readable records in the repository — a store is where one run tells the
next what it found. See [ADR
0028](./adr/0028-memory-is-a-declared-scope.md).

## Run

```bash
orchy run flow.yaml                          # or flow.ts
orchy run flow.yaml --with '{"issue":412}'   # the values the flow takes
```

A `prompt` path and a `module` path are relative to the flow file, so a flow in
its own directory finds its own prompts. The working directory is where a step
acts, which is a different thing. So you run a flow from the directory you want
it to work in, wherever the flow file sits.

The command prints the events to the error stream and the run state to the
output stream. It ends with 0 when the run finishes, 1 when the run fails, 2
when the command or the flow it was given is wrong, and 3 when the run waits for
a person. A script that treats a waiting run as a failure reads the 3 and knows
better.

`--events` changes both streams: one JSON event goes to the output stream for
each line, no run state joins it there, and the glyphs on the error stream stop.
A parent process reads the events alone, which is what the daemon does.

## Answer a gate

A run that reaches a gate writes its state and ends. The command prints the run
id. The question carries the values of the steps the gate needs, the way an
agent step reads them in its prompt, so the person answers with the work in
front of them.

```bash
orchy resume <run id> '{"approved":true}'
```

Orchy checks the value against the contract of the gate, so a wrong value is
refused before the run continues.

## Continue a run that ended

A resume with no value continues a run that ended. A failed run goes back to
the step that failed, and a stopped run continues where it stood. `--from`
names the step to go back to, and every step after it runs again.

```bash
orchy resume <run id>                # a failed or a stopped run
orchy resume <run id> --from draft   # go back to one step, and run again
```

The steps that passed keep their work. The record of a step that runs again
goes to history first, so its cost still counts against the budget. A step
reads its prompt from disk when it runs, so a person edits the prompt, goes
back to the step, and pays for one step instead of one run. See [ADR
0023](./adr/0023-a-resume-goes-back-to-a-step.md).

A gate holds a cycle, so the answer of the person sends the run back.

```yaml
  - id: confirm
    kind: gate
    needs: [code]
    question: Do you accept this work?
    returns:
      type: object
      required: [approved]
      properties: { approved: { type: boolean } }
    cycle: { to: code, when: { approved: false }, limit: 3, policy: accept }
```

The value of the person takes its own turn before the steps after the gate run.
A gate refuses the policy `escalate`, because an escalation asks a person for a
value that a person just gave. A gate cannot fail, so it cannot cycle on the
word `failed`.

## Say what a step does

A component takes three arguments: the values of the steps before it, a way to
say what it does, and the values it works on. A component that says nothing
ignores the second argument, and one that needs no value ignores the third.

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
9. Press **New flow** to make one: one file, one step, and its prompt, open in
   the editor.
10. Press **Schedule** to run the flow by itself, on a pace of at most every 15
    minutes, or make a hook there: a POST to its URL starts the run, with the
    body as the values the flow takes. See [ADR
    0022](./adr/0022-a-flow-runs-by-itself.md).
11. A run that ended offers the way back: a failed run resumes from the step
    that failed, and each step of an ended run runs again from there. The steps
    that passed keep their work.

The daemon listens on `127.0.0.1` only, and it refuses a page that is not its
own. A request with a foreign `Origin` reaches nothing, and so does a request
with a `Host` that the daemon does not answer to. So open the page at
`http://127.0.0.1:4000`, at `http://localhost:4000`, or at `http://[::1]:4000`,
and the answer names the address when you use another one.

This is not a user and a password. The daemon has neither. A step can hold
`bash`, so anyone who reaches the port from a program runs code on the machine.
Do not put the daemon on a shared host. See [ADR
0020](./adr/0020-the-daemon-refuses-a-foreign-page.md).

A flow file outside the directory of the daemon is refused, because every step
acts in that directory. The index holds the newest 200 runs. The events of a run
that falls behind that list go when a run ends, and the run itself stays on
disk.

The command line and the daemon run a flow the same way. The daemon starts
`orchy run <flow file> --events` as a child process, which writes one JSON event
for each line, and reads the state that the child writes to disk. So a run needs
no daemon, and `orchy run` on its own stays the same command.

The daemon indexes every run it finds under `.orchy/runs` when it starts, so a
run from the command line shows up on the page. It keeps that index in
`.orchy/index.db`. Deleting the index costs the events of past runs, and no run.

## Drive Orchy from an agent

`orchy mcp` serves the Model Context Protocol on stdin and stdout, so a coding
agent holds Orchy as a set of tools. Register it from the directory the flows
live in — that directory is the root, as it is for the daemon:

```bash
claude mcp add orchy -- npx @krimvp/orchy mcp
```

The agent gets twelve tools and a guide. The loop: it writes a flow as YAML,
hears every problem from `check_flow`, corrects it, writes it with
`write_flow`, starts it with `run_flow`, and follows it with `read_run`. A
flow that does not validate is refused at the write, with every problem named,
so a broken flow never runs. A run that waits at a gate holds a question, and
the agent answers it with `resume_run` — the contract of the gate checks the
answer at the door, the same way it checks a person.

The engine behind `orchy mcp` fires no schedule; the long daemon does. So the
two stand over one root together, and each shows the runs the other started,
because every run is on disk.

An agent that writes and runs a flow runs code on this machine, with your
authority. That is the same trust the command line gives, and no more — but
give the door only to an agent you would give a shell to. See [ADR
0024](./adr/0024-an-agent-authors-a-flow-through-mcp.md).

A step of a flow reaches the same door by declaring the `orchy` tool:

```yaml
- id: dispatch
  kind: agent
  prompt: prompts/dispatch.md
  tools: [read, orchy]
  returns: { type: object, properties: { started: { type: array } } }
```

The step authors flows, starts runs, and answers gates, in the root of its
own run. Every run it starts records the run and the step that asked, a
run's children ride on `read_run` with their costs, and a chain of runs
stops at three. The budget of a run does not count its children, and a step
that starts a run must not wait for it — work that runs inside this run is a
`flow` step. Only the claude harness supplies the tool. See [ADR
0025](./adr/0025-a-step-reaches-the-door-of-its-own-run.md).

`starts` bounds such a step: the flow files it may start, and how many runs.
The door enforces the bound from the state on disk, so the model cannot talk
its way past it, and `validate()` refuses a bound on a step with no `orchy`
tool. See [ADR 0027](./adr/0027-a-step-declares-what-it-may-start.md).

```yaml
- id: dispatch
  kind: agent
  prompt: prompts/dispatch.md
  tools: [read, orchy]
  starts: { flows: [flows/bugfix/flow.yaml], most: 5 }
```

## Write a component in any language

A call step runs a `module` — a TypeScript default export — or a `command`:
a program in any language, run where the steps act. The program takes
`{ values, steps }` as JSON on stdin, answers with its value as JSON on
stdout, and the contract checks it like any step. Notes go to stderr, one
line at a time, and a code that is not 0 fails the step with what stderr
said. See [ADR 0026](./adr/0026-a-component-is-a-process.md).

```yaml
- id: classify
  kind: call
  command: ./classify.py
  returns: { type: object, required: [severity], properties: { severity: { type: string } } }
```

## Check a step deterministically

Orchy ships `orchy:check`: a component that runs a command and passes only
when it ends with 0 — the tests, a linter, a build, in any language. Its
output rides as live notes, and a failure carries the last of what the
command said, so a cycle sends the reason back to the step it checks.

```yaml
- id: verify
  kind: call
  needs: [code]
  module: orchy:check
  with: { run: "npm test" }
  returns: { type: object, required: [ok], properties: { ok: { type: boolean } } }
  cycle: { to: code, when: "failed", limit: 2, policy: escalate }
```

On the claude harness, a step that a cycle sends back to mend a file needs
`read` or `edit` beside `write`: the Write tool of that harness refuses a
file it has not read, so a step with `write` alone gives up on its second
attempt.
