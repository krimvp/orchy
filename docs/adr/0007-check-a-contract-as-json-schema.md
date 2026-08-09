---
status: accepted
---

# Check a contract as JSON Schema

A user writes a contract with TypeBox, because TypeBox gives the static types
that make `cycle.when` safe. Orchy checks a value with Ajv against the plain
JSON Schema, not with the TypeBox value checker.

The reason came from the code. A TypeBox schema carries hidden symbols, and the
TypeBox checker needs them. A schema loses those symbols when it goes through
JSON. So the checker fails on every path that [ADR
0004](./0004-a-flow-is-data-not-code.md) promises: a run that resumes from disk,
a flow from a file, and a flow from a graphical editor. Only a flow built in the
same process still worked.

So the contract is JSON Schema, and TypeBox is the way a TypeScript user writes
one. The two roles do not overlap.

## Consequences

Orchy depends on Ajv as well as TypeBox. A user who writes a flow in YAML needs
no TypeBox at all.

A contract can use only the JSON Schema that Ajv supports. A TypeBox type with
no JSON Schema form, such as a function or a symbol, cannot be a contract. This
is correct, because a value crosses a file between the steps.
