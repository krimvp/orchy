---
status: accepted
---

# The daemon runs each run in a child process

The daemon does not call `run()` in its own process. It starts
`orchy run <flow file> --events` as a child, and it reads one JSON event for
each line of the output stream of that child.

A run drives a model for minutes or hours, and it loads a module that a user
wrote. Both can hang the process, and both can end it. A daemon that holds a
run holds that risk for every other run and for the UI.

## Consequences

A run that dies takes nothing else with it. The daemon reads the state of that
run from disk and reports what it reached.

The command line and the daemon run a flow the same way, through one code path.
A fault that one finds, the other has as well.

The daemon needs the run id of a child, so a run emits `run_start` as its first
event. A resume emits it again, because a resume is a second child that drives
the same run.

The daemon starts four runs at the same time. This is a constant, not a
setting. A user who wants more starts a second daemon in another directory.

A child that ends before it reports a run id leaves no run to look at. The
daemon keeps the ticket of that child, and the text of its error stream, so the
fault reaches the UI instead of a log that nobody reads.

`stop` sends `SIGTERM` to the child. The state on disk keeps what the run
reached. A run whose state says `running` when no child drives it is `stopped`,
and the daemon says so. The daemon writes this to the index only. It never
rewrites the state on disk, because that state is the run.
