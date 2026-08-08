---
status: proposed
---

# Embed Pi through the SDK

Orchy needs a harness to run one agent step. We choose Pi, and we call the Pi
SDK from a process that Orchy owns. One step becomes one Pi agent session.

## Considered options

- **A Pi extension.** Orchy would live inside a Pi session and register a
  command. Rejected: an extension holds one session, but a flow needs many
  sessions with different prompts, tools, and models. Deterministic control
  flow does not belong inside the session that it controls.
- **A subprocess supervisor.** Orchy would start `pi` processes and talk over
  RPC. Rejected for now: it hides the typed event stream behind a pipe, and it
  makes measurement coarse. It stays the upgrade path if Orchy must drive a
  harness that has no library.
- **A port with adapters for several harnesses.** Rejected: it is an interface
  with one implementation. Add it when a second harness arrives.

## Consequences

Orchy is a TypeScript program on Node, because the Pi SDK is TypeScript.
Orchy inherits the Pi provider list, the Pi tool set, and the Pi session file
format. Orchy is locked to Pi. A change of harness costs a rewrite of the step
runner, but not of the flow model.
