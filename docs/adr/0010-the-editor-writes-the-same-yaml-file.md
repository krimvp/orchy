---
status: accepted
---

# The editor writes the same YAML file

The graphical editor reads a flow file, and writes the same file back. It keeps
no flow of its own in the database.

[ADR 0004](./0004-a-flow-is-data-not-code.md) says that a flow is data, and that
the API, a file, and an editor all produce it. An editor with its own store
would break that promise: a flow would live in two places, and the two would
disagree.

The editor sends the flow to `POST /api/validate` while a person types, and the
answer comes from the same `validate()` that a run uses. So the editor states no
rule of its own, and it cannot fall behind the runner.

## Consequences

The editor writes YAML only. A flow in TypeScript can hold a type and a
generic, and no writer turns those back into a file. The editor reads such a
flow, draws it, and says plainly that it will not write it.

A write drops the comments and the anchors of the file, and it writes the fields
in the order of the data. A file is a serialization of the flow, so nothing else
is lost.

`PUT` writes nothing when `validate()` finds a problem. A file on disk is
always a flow that runs.

The editor reads the flow as the file holds it, not as a run sees it. A run
resolves every path and expands a fanout and a flow step. The editor must not
write either of those back, or one save would flatten the flow.
