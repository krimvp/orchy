---
status: accepted
---

# A component is a process

A call step runs a module or a command, and exactly one. `module` names a
TypeScript file, as before. `command` names a program in any language, run
where the steps act. The protocol is the process itself: the program takes
`{ values, steps }` as JSON on stdin — the values of the run, and the values
of the steps it needs, by step id — answers with its value as JSON on
stdout, reports with lines on stderr, and fails with a code that is not 0.
The contract checks the value the same as any step, and the `changes`
promise still reads the workspace, so no invariant moves.

Orchy also supplies components, named as `orchy:` and the name. `validate()`
refuses a name Orchy does not supply. The first is `orchy:check`: it runs
the command in `with: { run: "npm test" }`, passes only on the code 0, takes
its output as live notes, and fails the step with the last of what the
command said — so a cycle sends the reason back to the step it checks. The
exit code is the whole protocol there, because a test command answers no
JSON.

## Why

A component was TypeScript or nothing. A team whose world is Python wrote a
TypeScript wrapper or gave the work to an agent step, and a wrapper is a
second file that drifts. A process is the one interface every language
holds, and JSON in, JSON out, notes apart is the smallest protocol that
keeps the contract checkable.

Verification wanted the same door. The four checks a flow already holds —
the contract, the promise, the reviewer with a cycle, the gate — lack one
tier: a deterministic check, cheap, with no model in it. With a process as a
component, a check is nothing special: any command-backed step that can
fail, composed with the cycle the flow already holds. `orchy:check` is a
convenience over that, not a mechanism beside it.

## The limits, stated

- stdout is the value, whole. A program that logs to stdout breaks its own
  answer, and the refusal says where notes go.
- A module can write ordinary text to the stdout of the run process. The daemon
  reads control events from a separate file descriptor, so that text cannot
  become an event or stop the daemon.
- A command is not a path of the flow: it runs where the steps act, so
  `resolvePaths` does not touch it, and `missing()` cannot say whether it is
  there. A command that is not there fails its step with the words of the
  shell.
- A command with no `bash` in any tool list runs code all the same. That is
  invariant 1's own words: a step that runs a component was always trusted
  this far, and a command is not wider than a module.
- The shipped components are a list in `flow.ts` (`COMPONENTS`), so
  `validate()` refuses a name before a run learns it. One component ships;
  the list grows when a real flow wants more.
