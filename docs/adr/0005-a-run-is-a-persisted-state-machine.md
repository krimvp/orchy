---
status: accepted
---

# A run is a persisted state machine

Orchy writes the state of a run to disk after each step. A run is not a function
call that blocks until the flow ends.

A gate waits for a person, and Orchy must run on a server and in CI. A process
cannot block for a person there. So the process ends at a gate, and
`orchy resume <run-id>` continues the run from the state on disk.

## Consequences

A crash and a gate become the same case, and both recover through resume. Orchy
gets step-level restart and replay without more code.

The state must stay serializable, which is the same rule that [ADR
0004](./0004-a-flow-is-data-not-code.md) puts on a flow. A step passes a
JSON value to the next step, and the value goes into this state.

A step that is in progress when the process ends is lost. Orchy runs that step
again on resume. So a step must be safe to run again, or it must be behind a
gate.
