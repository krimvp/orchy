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

The adapter must stay small. It holds one method. The method takes a prompt, a
tool list, a contract, and a directory. It returns the value of the step and the
path of the trajectory. Tool names, model names, and session files stay behind
it. An adapter that grows past a few members has become a Pi wrapper, and that
is the signal to delete it and accept the lock-in.

The method returns no event stream. Pi writes the trajectory to disk itself, so
a stream into Orchy would only copy a record that already exists. The step that
converts the trajectory to ATIF reads the file.
