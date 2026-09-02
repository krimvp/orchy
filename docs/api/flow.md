# `src/flow.ts` — the flow data model

This module defines what a flow *is*: the types for a flow and its steps, the
builders that construct one in TypeScript, the validator that checks one from
a file or the graphical editor, and the expansions that turn fanouts and
nested flows into the plain step list that the runner and the editor see. It
holds no runtime — running a flow is `src/run.ts`'s job; this module only
describes and checks the data.

A flow is a named list of steps with optional flow-wide defaults (workspace,
harness, model, a `changes` promise, `takes`/`returns` schemas, a dollar
`budget`, and `parallel`, which defaults to `WAVE = 8`). Each step has an
`id`, a `needs` list naming the steps it waits for, and one of four kinds:

- **agent** — runs a prompt under a harness with declared tools, and returns
  a value shaped by a JSON Schema.
- **call** — runs a component instead of an agent: a TypeScript `module`, a
  `command` in any language (JSON on stdin and stdout, notes on stderr — ADR
  0026), or a shipped component named as `orchy:check`. Exactly one of
  `module` and `command`; `COMPONENTS` names what Orchy supplies.
- **gate** — stops the run until a person answers a question.
- **flow** — embeds a whole other flow as one step; expansion inlines it.

Steps can be conditional (`when` matches against the values of steps they
need), can `cycle` back to an earlier step when a match holds (with a limit
and an `escalate`/`accept` policy), and agent/call steps can fan out — one
copy per member, either listed in the file or computed from a list another
step returns. Matches use a closed operator set (`is`, `not`, `empty`, `lt`,
`gt`) rather than an expression language, so a dropdown in the editor can
draw the whole set; the set lives here and the daemon serves it, so no copy
in the page falls behind.

## Exports

Types: `Flow`, `Step` (the union), `AgentStep`, `CallStep`, `GateStep`,
`FlowStep`, `Cycle`, `When`, `Match`, `Matched`, `Operator`, `Changes`
(`"nothing"`, `{ paths }`, or `{ except }` — what a step promises to change),
`Memory` (`{ scope, most }` — what a run recovers and where it stores, ADR
0028), `Member`, `Computed`, and `Fanout` (`Member[] | Computed`).

Building:

- `flow(name, definition)` — builds a `Flow`, copying only the fields the
  definition sets.
- `agent(step)`, `call(step)`, `gate(step)` — build one step each, filling in
  `kind` and an empty `needs`.
- `WAVE` — the default for `parallel`, 8.
- `OPERATORS` — the closed operator list, each with its name, what it reads,
  and what it tests; `GET /api/health` serves this to the page.

Checking:

- `validate(flow)` — the main gate. Returns a list of human-readable
  problems, empty when the flow is sound. It checks shape first (unknown
  fields, missing required ones, malformed schemas and promises), then
  meaning: duplicate ids, missing or self-referential needs, dependency
  loops, cycle targets that do not run earlier, tools and model grammar
  against the tables in `src/harness.ts`, conditions against what the named
  step returns, fanout rules, and that a budget or a promise has something to
  enforce it. Every flow from a file or the editor passes through here before
  it runs.
- `schemaProblem(schema, value)` — where a value breaks a JSON Schema, or
  `undefined` when it holds. Checked as plain JSON Schema (Ajv), because a
  schema that has been through a file is data, not a TypeBox object.
- `takesProblem(flow, values, who)` — whether supplied values match what the
  flow `takes`, failing before any step spends a token.
- `operatorOf(match)` — the one operator a match names, or `undefined` when
  the match is a plain value.

Expanding:

- `expandFanout(flow)` — replaces each fanned-out step with one step per
  member, id `stepId/memberName`, rewriting every reference. A computed
  fanout stays whole, because its list only arrives during the run.
- `expandFlows(flow, load)` — inlines each flow step's inner flow (loaded via
  the `load` callback), prefixing inner ids with the step id so two uses
  never collide. Throws when the inner flow carries a budget, takes values
  the step does not supply, or ends in more than one step.
- `resolvePaths(flow, directory)` — makes the `prompt`, `module`, and
  `starts.flows` paths of every step, and of every member of a file-written
  fanout, absolute against the flow file's own directory; a `command` and an
  `orchy:` name stay as they are. Call it after loading from a file.

Reading:

- `harnessOf`, `modelOf`, `changesOf` — a step's own value, or the flow's
  default.
- `cycleOf`, `fanoutOf`, `membersOf`, `computedOf` — a step's cycle or fanout
  where the kind allows one.
- `exitsOf(steps)` — the steps no step needs; a flow that returns a value
  ends in exactly one of them.
- `order(steps)` — the steps sorted so each comes after everything it needs
  (invariant 3). Throws when they cannot be ordered.

## Example

Build a two-step flow — an agent summarizes, and a person approves only when
the agent flags risk — and validate it before running:

```ts
import { Type } from "@sinclair/typebox";
import { agent, flow, gate, validate } from "./flow.ts";

const review = flow("review", {
  harness: "claude",
  steps: [
    agent({
      // A prompt is the path of a file, relative to the flow file, and not
      // the text itself. `resolvePaths` makes it absolute after a load.
      id: "summarize",
      prompt: "prompts/summarize.md",
      tools: ["read"],
      returns: Type.Object({ summary: Type.String(), risky: Type.Boolean() }),
    }),
    gate({
      id: "approve",
      needs: ["summarize"],
      when: { summarize: { risky: { is: true } } },
      question: "The change looks risky. Ship it anyway?",
      returns: Type.Object({ ship: Type.Boolean() }),
    }),
  ],
});

const problems = validate(review);
if (problems.length > 0) throw new Error(problems.join("\n"));
```

A flow written in YAML instead of TypeScript arrives through `src/load.ts`
and reaches the same `validate()`; the builders here exist so a TypeScript
flow gets its `kind` and `needs` filled in without repeating them.
