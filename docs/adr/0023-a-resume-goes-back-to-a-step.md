---
status: accepted
---

# A resume goes back to a step

`orchy resume <run id>` continues a run that ended. A failed run goes back to
the step that failed. A stopped run continues where it stood. `--from <step>`
names the step to go back to, and every step after it runs again. The steps
that passed keep their work.

The record of a step that runs again goes to history first. Every attempt is a
cost, so the budget counts the attempt that failed and the attempt that
follows it, the same way it counts an attempt a cycle threw away.

## Why

A run that failed at the last step threw away every step before it, and a
person paid for the whole run again. The state on disk already held the value
of every step that passed (ADR 0005), so the run could continue; only the way
back in was missing.

The same door serves the authoring loop. A step reads its prompt from disk
when it runs, not when the flow loads. So a person edits the prompt, goes back
to the step, and pays for one step instead of one run.

## The limits, stated

- A run that waits takes a value, as before. A resume with no value and no
  step refuses a waiting run, because the gate is the question to answer.
- A done run goes back only to a step a person names. With no step there is
  nothing to continue, and the resume says so.
- A resume reads the flow from the state of the run, not from the flow file.
  A budget raised in the file does not raise the budget of an old run; a new
  run carries the new flow. The prompt is the one thing read fresh, because
  the state holds its path and not its text.
- The cycle counts of the run stay. A step that spent its cycles before the
  resume has none after it, because the limit bounds the run and not the
  sitting.
