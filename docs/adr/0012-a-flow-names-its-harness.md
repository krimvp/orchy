---
status: accepted
---

# A flow names its harness

A flow holds a `harness` field and a `model` field. A step that names neither
takes the ones the flow names. A flow that names neither takes the default of
the run, which `--harness` sets and which is `pi` when nothing sets it.

So the order is the step, then the flow, then the run. The narrower field wins,
which is the rule a step-level `harness` already followed.

## Why

Before this, no flow could say which harness it needs. The default lived in
three places, and none of them was the flow:

- `--harness` on the command line, which was `pi` when absent.
- The `harness` column of the flow table in the index.
- The `harness` field of each step.

[ADR 0009](./0009-the-database-indexes-the-runs-on-disk.md) says the index is
not the run. A setting that changes the result of a run must not live only
there.

Two costs followed. `examples/research/flow.yaml` wrote `harness: claude` on
four steps of four, because that was the only way to state what the flow needs.
And `validate()` could not check a tool against a harness, because it did not
know the harness. A flow that asked for `web` under Pi passed the check and
failed in the middle of the run, after an earlier step already spent its tokens.

## Why not a `defaults` block

A block names one more idea. `workspace` and `parallel` already sit on the flow
with no block, and a step overrides neither. Two flat fields read the same as
the step that overrides them, and the editor draws them with the same control.

## Why the flow beats the command line

`--harness` sets the default for a step that names none, and a step-level
`harness` already beat it. A flow that says `harness: claude` says what it needs
to run at all, in the same way. A flag that overruled it would start a run that
`validate()` already refused.

So a person who wants a flow on another harness edits the flow. The editor
writes that field, and the change is in the file that the run reads.

## Consequences

`SUPPLIES` in `harness.ts` names the tools of each adapter. It lives beside the
adapter names and not inside an adapter, so `validate()` reads it without
loading the SDK of a harness. Each adapter checks its own row of that table, so
one table answers both the check and the run.

A harness name that no adapter holds still fails at the start of a run, and not
in `validate()`. A caller can register an adapter of its own through
`RunOptions.harnesses`, so a name that Orchy does not ship is not wrong on its
face. The run refuses it before any step starts.
