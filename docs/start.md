# Start with Orchy

Orchy runs a flow: a set of steps with rules about their order and results.
One step can run a command. Another can ask an agent to use a model. A gate can
wait for a person. Orchy checks each step and keeps a record of the run.

This guide starts with one step. Each part adds one idea. You can stop after
any part and keep a working flow.

## 1. Run one step

Install Node 22.18 or later. Install Orchy, then make an empty directory for
the first flow:

```bash
npm install -g @krimvp/orchy
mkdir orchy-first-flow
cd orchy-first-flow
```

Save this text as `hello.yaml`:

```yaml
name: hello
steps:
  - id: greet
    kind: call
    command: "node -p 'JSON.stringify({message:\"Hello from Orchy\"})'"
    returns:
      type: object
      required: [message]
      properties: { message: { type: string } }
```

Check the flow, then run it:

```bash
orchy check hello.yaml
orchy run hello.yaml
```

The check reads the flow but starts no step. The run starts `greet`, checks its
JSON value against `returns`, and writes a record under `.orchy/runs/`. The
final state on the output stream holds `"message": "Hello from Orchy"`.
This first flow needs no model or account.

The `command` writes its JSON value to standard output. A command that fails,
or writes a value that breaks `returns`, fails the step. See
[Write a component in any language](./running.md#write-a-component-in-any-language)
for the command input and error rules.

## 2. Add an agent step

An agent step needs a harness. A harness connects Orchy to a model and its
tools. This example uses the `claude` command. Install that command and sign
in before you run this part. [Choose a harness](./running.md#choose-a-harness)
explains Pi and Droid as well.

Save this text as `explain.md` beside `hello.yaml`:

```text
Read the value from the greet step. Explain it in one short sentence.
Return a JSON object with an answer string.
```

Replace `hello.yaml` with this flow:

```yaml
name: hello
harness: claude
steps:
  - id: greet
    kind: call
    command: "node -p 'JSON.stringify({message:\"Hello from Orchy\"})'"
    returns:
      type: object
      required: [message]
      properties: { message: { type: string } }

  - id: explain
    kind: agent
    needs: [greet]
    prompt: explain.md
    tools: []
    returns:
      type: object
      required: [answer]
      properties: { answer: { type: string } }
```

Run the check and the flow again:

```bash
orchy check hello.yaml
orchy run hello.yaml
```

`needs: [greet]` makes `explain` wait for `greet`. Orchy gives the value of
`greet` to `explain` and checks the answer against its contract. The empty
tool list gives the agent no tools. The prompt path starts from the directory
that holds `hello.yaml`.

The run ends with the value of `explain`. The record keeps the prompt that the
agent read, its answer, and its trajectory. See
[What you get from a run](../README.md#what-you-get-from-a-run) for the files.

## 3. Add a gate for a person

Add this step after `explain` in `hello.yaml`:

```yaml
  - id: confirm
    kind: gate
    needs: [explain]
    question: Is the answer clear? Reply with {"approved":true} or {"approved":false}.
    returns:
      type: object
      required: [approved]
      properties: { approved: { type: boolean } }
```

Check and run the flow again:

```bash
orchy check hello.yaml
orchy run hello.yaml
```

The run waits at `confirm` and prints its run id. Its exit code is `3`, which
means it waits for a person. Answer the gate with that id:

```bash
orchy resume <run id> '{"approved":true}'
```

Orchy checks the answer against the gate's contract. The run ends with the
gate's value. It writes the state after each step, so the gate needs no running
terminal while it waits.

## 4. Use the next features

The flow above teaches a command, an agent, order, a contract, and a gate.
Add one feature when your flow needs it:

| Need | Read next | Example |
| --- | --- | --- |
| Give each run different values | [The values a run takes](./running.md#the-values-a-run-takes) | [research](../examples/research/flow.yaml) |
| Send work back for another cycle | [A step that retries itself](./running.md#a-step-that-retries-itself) | [code-review](../examples/code-review/flow.yaml) |
| Run one step for each member | [One prompt over a list](./running.md#one-prompt-over-a-list) | [dependency-audit](../examples/dependency-audit/flow.yaml) |
| Check changed files | [Promises and the workspace](../README.md#what-orchy-guarantees) | [docs-audit](../examples/docs-audit/flow.yaml) |
| Run and watch flows in a page | [The daemon and the page](../README.md#the-daemon-and-the-page) | `orchy daemon` |

Use [the run guide](./running.md) for each field and its rules. Use
[the examples](../examples/README.md) to find a complete flow. Use
[the flow data reference](./api/flow.md) when you build a flow in TypeScript.
