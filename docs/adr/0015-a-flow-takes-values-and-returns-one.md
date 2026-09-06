---
status: accepted
---

# A flow takes values, and it returns one

A flow holds `takes`, the JSON Schema of the values that a run supplies. It also
holds `returns`, the JSON Schema of the value that it produces.

```yaml
name: fix-the-issue
takes: { type: object, required: [issue], properties: { issue: { type: number } } }
returns: { type: object, properties: { url: { type: string } } }
```

A run supplies the values, and Orchy checks them against `takes` before the
first step starts. Every step reads them: an agent step gets them in its prompt,
and a component takes them as its third argument, beside what its own step
holds. A prompt that holds `{{ issue }}` takes the value in the sentence that
needs it.

Three callers supply the values, and they all produce the same data:

- `orchy run flow.yaml --with '{"issue":123}'`
- `POST /api/flows/:id/runs` with `{"with":{"issue":123}}`
- a flow step, with `with` on the step that names the sub-flow.

## Why

`docs/plan.md` states the goal as "read the ticket, plan, code, review, open the
merge request". No one could write that flow, because a flow took no values.
There was no way to say "run this flow for issue 123". A person edited the YAML
for each run, or wrote a `call` step that read the environment behind the back
of Orchy. A trigger, a schedule, and a run from CI were all blocked behind this.

The mechanism was already here and already proved. A step holds `with`, and so
does a member of a fanout. This decision lifts that mechanism to the flow. The
words stay apart: `with` is the value that one step holds, and the values of a
run belong to the whole run. A step is the narrower of the two, so a step wins a
name that both supply, by the same rule as the harness of a step.

## Why a schema, and not plain strings

A value that arrives as a string carries no type and no name that anything
checks. Three things follow from a schema that do not follow from strings.

**A run fails before it spends a token.** The check runs before the first step,
with the same Ajv that invariant 2 uses for a contract. A run that supplies
`"123"` where the flow takes a number stops there, and not after the first agent
session already cost money.

**A value that nothing reads must fail.** A run that supplies a value for a flow
that takes none is refused, and so is a flow that takes values and gets none.
This is the rule that this project rates most expensive: a field that Orchy
cannot act on must never pass in silence. Plain strings have no declaration, so
neither refusal could exist.

**A flow states what it needs.** The schema is the one place that says which
values a run wants, so a page, an editor, and a trigger all read it from the
flow. A string bag needs a document beside the flow, and a document falls
behind.

The cost is that a person types JSON on the command line. That cost is one pair
of braces, and `--with` refuses anything that is not one JSON object.

## Why interpolation fails loudly on a name it cannot resolve

A prompt held the values as a trailing JSON block, so a value never reached the
sentence that needed it. A name in braces fixes that. The blocks stay as well,
so a prompt that names nothing works exactly as it did.

A name in a gate question follows the same rule. A name that resolves to
nothing fails the run before a person sees a question. The message names the
step and the name. The two other answers are both worse:

- Leave the braces in the prompt. The model reads `{{ issue }}`, treats it as
  text, and works on the wrong thing. Nothing says a word.
- Write the word `undefined`. The model reads a value that looks real, and it is
  wrong. Nothing says a word.

Both of these are the fault that `docs/shape.md` measured ten times over: a
thing that looks enforced and is not. A run that fails costs one step. A run
that reads the wrong ticket costs every step after it, and a person has to find
out why.

The pattern matches every pair of braces, and not only a name it knows. So a
prompt that holds `{{ issue.title }}` fails as well, because a path is a second
concept and partial support for one hides a failure.

## Why `returns` is a declaration and not only an inference

`expandFlows` already found the step that a flow ends with, by looking for the
step that nothing needs, and it threw when there was more than one. So the rule
existed, and only a sub-flow ever met it.

`returns` states the same rule where a person reads it. `validate()` refuses a
flow that declares `returns` and ends in more than one step, and the message
says that a flow that returns a value ends in one step. At the end of the run,
the value of that step is checked against the schema, and a run that breaks it
fails with a reason on the run state.

A flow that declares no `returns` keeps the behaviour it had. The declaration is
opt-in, so it adds no question for a flow that does not want one.

## Consequences

`FLOW_HOLDS` names `takes` and `returns`, so a file and a graphical editor both
carry them, and `validate()` refuses each one when it is not JSON Schema.

A flow step holds `with`. Expansion drops the inner flow, so the values it takes
ride on each step of it, under whatever that step already holds. A flow step
that supplies a value the sub-flow does not take is refused when the flow loads,
and so is a flow step that supplies none to a sub-flow that takes values. So a
sub-flow is reusable, and not fixed.

A gate holds `with` for the names in its question. Expansion gives it the values
of an inner flow. A value on the gate wins a duplicate name, as it does on an
agent or a call step. Interpolation happens when the gate asks, and only once.

A component reads the values of the run and the value of its own step from one
argument, the third, with the step over the run. A run supplied the first, and
expansion supplied the second, so two arguments made a component read one place
for a run of its own flow and another place inside a sub-flow. A probe caught
that: the same component gave `undefined` as a sub-flow. One argument reads the
same both ways, and a prompt resolves a name by the same rule.

The run state holds the values, so a resume reads them again and needs no flag.
ADR 0005 keeps that true: the state on disk is the run.

The daemon adds no rule of its own. It passes the values to `orchy run --with`,
and the child does the check. ADR 0008 puts every rule in `validate()` or in the
runner.

`RunState` takes an `error` field, for a fault that belongs to the run and not
to one step. The value that a flow returns is the first such fault.
