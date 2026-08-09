---
status: accepted
---

# A flow is data, not code

The Orchy API builds a data structure. It does not run the steps as the user
writes them. A user writes TypeScript inside a component, but never in the
wiring between the steps.

A graphical editor is a goal of this project. An editor can draw data, but an
editor cannot draw arbitrary TypeScript. A file format and the API must also
produce the same flow, or the two layers become two products.

## Consequences

A user cannot write `if (x) step(...)` in a flow. Every branch, and every cycle,
is a declared field that the runner reads. This costs expressive power, and it
is the reason a user cannot do some things that a script makes easy.

The API gives its developer experience through types and autocompletion over the
data, not through control flow.
