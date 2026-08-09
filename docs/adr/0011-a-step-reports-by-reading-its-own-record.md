---
status: accepted
---

# A step reports by reading its own record

A step says what it does while it does it. An adapter does not open a second
channel for this. It reads the record that the harness already writes, one line
at a time, and turns each line into a note.

Pi writes a session file as it works. Claude Code writes a transcript as it
works. Both adapters already read those files to make an ATIF trajectory, and
both already turn one line into one ATIF step. So the live report costs one
file reader and one function, and it uses the same parser as the record.

The other way is to change how each harness is started: a streaming output
format, or an event from the SDK. That is a second shape to parse for each
harness, a second thing to keep in step with the first, and a change to the one
command that is known to work.

## Consequences

The command that starts a harness does not change at all. A fault in the report
cannot break a run.

What a step says and what a run records cannot disagree, because they come from
the same lines through the same parser.

A note arrives when the harness writes the line, not when the model makes the
token. So the report is by the turn, and not by the word.

A note is a view, not a record. It carries one line, cut to 400 characters, and
the daemon holds the last 500 of them for a run in memory. It writes none of
them to the index. The trajectory holds the whole of it, so nothing is lost.
The notes of an older run go, and its trajectory stays.

A deterministic step reports through the same events. A component takes a
second argument, and a component that says nothing ignores it. So one kind of
event covers every step, and the page needs no second view.
