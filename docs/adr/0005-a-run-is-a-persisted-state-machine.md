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

Each whole state write advances a revision. A gate answer names the gate and
the revision that the person read. The process claims the run before it checks
both values and changes the state. Thus, two processes cannot apply one answer
twice, and a stale answer cannot advance a later gate.

On Linux, a claim owner includes the boot ID and the process start time. This
prevents PID reuse from keeping or taking a claim. Other systems use the PID
only. A process writes its owner record under a unique name, then publishes it
at `claim` with one hard link. Thus, a reader sees a complete owner or no new
claim. An unreadable claim fails closed and names the file to inspect.

Orchy does not remove an existing claim by itself, even when its owner appears
dead. Two processes can otherwise remove each other's replacement claim. A
person removes a stale claim only after inspection shows that no process drives
the run.

A step that is in progress when the process ends is lost. Orchy runs that step
again on resume. So a step must be safe to run again, or it must be behind a
gate.
