---
status: accepted
---

# One active run claims a Git workspace

One active Orchy run can use one Git working tree at a time. Before Orchy
creates or changes run state, it resolves the Git top-level directory and takes
a process claim for that canonical path. A path alias and a subdirectory find
the same claim. A separate Git worktree has a different path and a different
claim.

The claim covers active execution only. A run releases it when the run is done,
fails, or waits at a gate. A resume takes it again before it changes state. This
keeps an idle gate from holding a workspace for an unknown time.

The runner releases the claim before it writes or emits the done, failed, or
waiting state. A reader can act on a terminal event at once without racing the
old owner of the workspace.

This claim gives Orchy mutual exclusion. It is not workspace isolation. A
person and another program can still change files. Another run can change the
workspace while the first run waits at a gate. A separate Git worktree gives
each run files of its own when this difference matters.

## Process ownership

A direct run releases its claim after its adapters and command processes end.
The daemon runner leaves its claim in place when the daemon cancels it. The
daemon reads the exact owner token, device, and inode before it sends a signal.
It releases that claim only after process-group termination confirms that the
full group is absent.

The runner is the only releaser during normal execution. After a daemon stop,
the terminated group cannot release or replace its old claim. Thus, one release
authority exists at a time. If a normal end already released the claim and a
new run took it, the daemon sees a different token or inode and changes nothing.

A crash, an external hard kill, or an unconfirmed process-group stop leaves the
claim in place. Orchy fails closed. The refusal names the canonical workspace,
the owner when readable, the run state, and the claim path. A person removes
the claim only after the owner process and its descendants have ended.

## Claim location

Claims use the home directory that the operating system reports for the current
account. `HOME`, `XDG_STATE_HOME`, and `TMPDIR` do not select another claim
directory. The directory is private to its owner on POSIX systems. Orchy
refuses a symbolic link, a different owner, or access for a group or other
users. Claim names are SHA-256 hashes of canonical paths, so a path does not
become a file name.

The claim coordinates Orchy processes for one account on one machine. It does
not coordinate different accounts or machines that share a working tree.
Windows compares canonical paths without letter case. Other systems use the
path that `realpath` returns.
