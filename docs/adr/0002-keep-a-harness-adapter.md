---
status: accepted
---

# Keep a harness adapter

Orchy uses one harness, Pi. Orchy still puts an adapter between the flow runner
and the harness. A reader will ask why, because an interface with one
implementation is usually waste.

The reason is the goal of the project. Orchy claims to be a generic tool that a
user hooks their own flow into. If Pi calls reach into the runner, that claim
becomes false in the first month, and the cost to reverse it grows with every
step type. The adapter also makes the runner testable without a model.

The adapter must stay small. It held one method until the second harness
arrived. It now holds two. `run` takes a prompt, a tool list, a contract, and a
directory, and returns the value of the step. `toTrajectory` reads the record
that the harness left. Tool names, model names, and session files stay behind
them. An adapter that grows past a few members has become a wrapper, and that
is the signal to delete it and accept the lock-in.

The method returns no event stream. Pi writes the trajectory to disk itself, so
a stream into Orchy would only copy a record that already exists.

## What the second harness cost

The Claude Code adapter cost one member: `toTrajectory`. A trajectory has a
different shape in every harness, so only the adapter can read one. The value
of `trajectory` on the result became an opaque handle, which each adapter reads
its own way: Pi answers a file path, and Claude Code answers a session id.

Nothing else changed. The runner, the flow data, and the five invariants took
no edit. That is the evidence this ADR asked for. Two members of five spent.
