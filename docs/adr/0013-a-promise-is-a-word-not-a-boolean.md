---
status: accepted
---

# A promise is a word, not a boolean

`changes` takes the word `nothing`, or a list of paths. It took `false` before.

```yaml
changes: nothing
changes: { paths: [docs, CONTEXT.md] }
```

## Why

`changes?: false` held one legal value, so it was not a boolean. It was a
promise with one setting, and three things followed.

`changes: true` reads as "this step must change something". It meant nothing,
and nothing said so.

The field could not grow. A step that may write documents and nothing else had
no way to say it. `changes: { only: [docs/**] }` passed the check and enforced
nothing, so the promise looked enforced when it was not. That is the fault this
project rates as the most expensive.

The editor already drew the field as a checkbox labelled `Promises to change
nothing in the workspace`. The page named the concept, and the data named a
boolean.

[ADR 0006](./0006-one-workspace-field-with-no-default.md) met the same question
for the workspace and answered it with a tagged value, so a new kind costs no
change to the format. This is the same answer.

## Why a path, and not a pattern

A path names a file, or a directory and everything under it. A pattern language
invites `**/*.md`, and partial support for one is a hidden failure. The rule
fits in one sentence, which is what a rule of this project must do.

`git status` reports a wholly untracked directory as one entry, such as `docs/`.
A promise about paths cannot read that, so the snapshot now runs `-uall` and
names every file. The record is more precise for every step, not only for a step
that promises.

A commit moves `HEAD`, which no path holds. So a step that commits breaks a
promise about paths, and the error names `HEAD`. A promise about paths says
nothing about a commit, and this states that limit rather than hiding it.

## Consequences

`changes: false` no longer runs. `validate()` refuses it and says what to write
instead, so a flow written against the old shape gets a sentence and not a
silent change of meaning. Orchy is before its first release, and one loud break
costs less than two spellings of one idea.
