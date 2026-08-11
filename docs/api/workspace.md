# `src/workspace.ts` — snapshots of a git workspace, and the diff between them

This module is how a run sees what a step really did to the files, as opposed
to what the step says it did. It takes a snapshot of a git workspace — the
HEAD commit plus the `git status --porcelain -uall` code of every path — and
diffs two snapshots into a list of changes, each named by kind: not only
"changed" but "deleted", "renamed", "added", "restored", or, for HEAD itself,
"moved". Invariant 5 (a step changes only what its flow promises) is checked
against this list, and the kind matters because a reader who sees "changed"
where the truth is "deleted" loses the worst case in the vaguest word.

Two details of the snapshot are deliberate. Untracked files are listed one by
one (`-uall`), because git otherwise collapses a new directory into a single
entry such as `docs/`, and a promise about paths cannot read that. And paths
under `.orchy/` are excluded, because the run state of Orchy is not the work
of the step.

## Exports

- `take(workspace, cwd)` — takes a `Snapshot` of the workspace, with
  `workspace.path` resolved against `cwd`. Returns `undefined` when the
  workspace is `undefined` or of kind `"none"` — a workspace that records
  nothing returns nothing — and throws when the path is not inside a git
  repository.

- `changed(before, after)` — the difference between two snapshots as a
  sorted `Change[]`. If either snapshot is `undefined` the list is empty.
  A path whose status code differs becomes one entry; a path git no longer
  reports is `"restored"` (a commit or an undo put it back as the repository
  holds it); and if HEAD moved between the snapshots — a commit — the entry
  `{ path: "HEAD", how: "moved" }` leads the list.

- `Workspace` — a tagged value: `{ kind: "none" }` or
  `{ kind: "git"; path: string }`. Tagged so that a remote sandbox becomes a
  new kind and not a change to the format (ADR 0006).

- `Snapshot` — `{ head, files }`: the HEAD commit hash and a map from path
  to its two-character porcelain status.

- `Change` — `{ path, how }`, where `how` is one of `"added"`, `"changed"`,
  `"deleted"`, `"renamed"`, `"restored"`, or `"moved"`. `"moved"` belongs to
  HEAD alone.

## Example

Snapshot the workspace around a step and see what the step touched:

```ts
import { take, changed, type Workspace } from "./workspace.ts";

const workspace: Workspace = { kind: "git", path: "." };

const before = take(workspace, cwd);
// ... the step runs ...
const touched = changed(before, take(workspace, cwd));

for (const one of touched) console.log(one.how, one.path);
// e.g.  added docs/api/workspace.md
```

In practice `src/run.ts` is the caller: it takes a snapshot before and after
each step and holds the diff against the step's `changes` promise, failing the
step that broke it. `src/flow.ts` uses the `Workspace` type as the shape of
the flow's `workspace` field and validates its kind and path. `take`,
`changed`, and the three types are re-exported from `src/index.ts` as part of
the package's public surface.
