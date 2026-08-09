---
status: accepted
---

# A match holds a plain value, or one operator

A condition matches a value. The match against one key is a plain value, which
tests that the two are equal, or one operator from a closed set.

```yaml
when: { sort: { severity: high } }          # equal, as before
when: { review: { findings: { empty: false } } }
cycle: { to: code, when: { approved: { not: true } }, limit: 3, policy: accept }
```

## Why an operator at all

A match tested equality only. So a flow could not say "go back while there are
findings", or "run this step when the score is under seven".

A user worked around it. The model returned a boolean beside the findings it
already returned, and the two could disagree. The flow then trusted the boolean
and not the work.

## Why the set is closed

An expression language grows. Every release adds an operator, a function, and
then a way to join two of them. A graphical editor cannot draw one, so the
editor and the file stop being the same flow. [ADR
0004](./0004-a-flow-is-data-not-code.md) says that a flow is data, and an
expression is code in a string.

A closed set is a dropdown. The editor draws the list, the file holds the same
words, and `validate()` names every one of them in a message.

## The set

| Operator | What it tests | Reads |
| --- | --- | --- |
| `is` | the value is equal to this | any value |
| `not` | the value is not equal to this | any value |
| `empty` | a list, a string, or an object holds nothing | a boolean |
| `lt` | the value is below this | a number |
| `gt` | the value is above this | a number |

Five operators cover the conditions that the flows here want: a rejection
(`not`), a list of findings (`empty`), and a threshold (`lt`, `gt`). `is` is
the one that a plain value already says, and the next section says why it is
here.

`some` is not in the set. `empty: false` says it, and one word for one meaning
is the rule of [CONTEXT.md](../../CONTEXT.md). `lte` and `gte` are not in the
set, because they add two operators for one idea. `in`, a pattern, and a
regular expression are not in the set, because each one is a small language.

Nothing nests. An operator reads a plain value, so `{ not: { empty: true } }`
is a problem and not a rule. Nothing reads another step: a condition on a step
already names the step it reads, and a condition on a cycle reads the step it
sits on.

## The trap, and why `is` exists

`{ approved: { not: true } }` and a match against the object `{ not: true }`
are the same shape. Orchy cannot read both, and a guess hides a failure.

So an object is always an operator. `validate()` refuses an object that does
not hold exactly one known operator, and it names the ones that exist:

```
step "page" runs when "sort" says "severity" with {"equals":"high"}, which is
not one operator. Use one of: is, not, empty, lt, gt. Write { is: ... } to test
the value itself.
```

`is` keeps a match against a whole object possible, and it says so with no
guess: `when: { result: { is: { ok: true } } }`. Without `is`, the rule would
take away a match that works today, and the message could name no fix.

A match against an object that holds exactly one key with the name of an
operator is the one value that no match reaches. `{ is: { empty: true } }` reads
as a nest, and Orchy refuses it.

## What a user does outside the set

The step answers the question. An agent step returns the decision beside the
work, and a `call` step computes one from the value of an earlier step. Both
are one line of a flow, and both are data that a person reads.

This is the same workaround that the set removes for the common conditions. It
stays for the rare ones, and it costs one step and no new language.

## Consequences

`when` on a step and `when` on a cycle are one idea, so both take an operator
in the same change. The two keep their own shapes: a step keys its condition by
step id, and a cycle matches the value of the step it sits on. Nothing unifies
them here.

`validate()` reads the contract of the step that the condition names, so it
refuses more than a name it does not know:

- `{ score: { lt: "seven" } }` — the operator `lt` reads a number.
- `{ severity: { lt: 7 } }` — `severity` holds a string.

A run reads an operator with no schema in front of it, so `lt` and `gt` match
nothing when the value is not a number, and a value that is not there is empty.
A cycle on `empty: false` never fires on a key that no step returned.
