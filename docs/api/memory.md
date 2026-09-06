# `src/memory.ts` — what a run recovers, and where it stores

This module holds the memory of a run. A flow declares a scope. The runner
resolves it once, keeps its exact key in the run state, and uses one storage
through the `Storage` contract. See [ADR 0029](../adr/0029-memory-is-a-declared-scope.md).

## Exact keys

A key includes its type and exact text. The three forms are `root`, `flow`, and
`scope`. Orchy encodes the typed value as JSON and then as base64url, with a
`v2:` prefix. Thus, these scopes are different:

- `ticket/A/B` and `ticket/A-B`
- `flow` for a flow named `bugfix`, and a custom scope named `flow-bugfix`
- two different Unicode names

The storage file has a readable prefix and the full SHA-256 digest of the exact
key. Its first JSON line records that key. Each line after it is one `Entry`.
A malformed entry costs only that entry. Invalid key metadata fails and names
the file to correct.

`remember`, `forget`, and migration use one cross-process claim. `forget`
writes a complete temporary file and renames it. A reader therefore sees the
old file or the new file. An append cannot race with a rewrite and lose an
entry.

## Commands and migration

`orchy memory keys` prints references that a person can give to the other
memory commands. A current key starts with `key=`. An old flat file starts with
`legacy=`.

Make a current key without copying its encoding by hand:

```sh
orchy memory key root
orchy memory key flow 'Bug Fix'
orchy memory key scope 'ticket/A/B'
```

An unprefixed value on `list`, `add`, or `forget` is a literal custom scope.
`scope=` makes that rule explicit when the text itself starts with `v2:`,
`legacy=`, or `key=`.
A command step can give `$ORCHY_MEMORY_KEY` directly; Orchy recognizes its own
canonical value from that variable.

Old flat files can already hold entries from multiple logical scopes. Orchy
never guesses which scope owns them. It lists one as `legacy=<flat name>` and
requires an explicit target:

```sh
target="$(orchy memory key scope 'ticket/A/B')"
orchy memory migrate legacy=ticket-a-b "$target"
```

Migration checks that the source is a regular file under the root. It publishes
one complete target with exclusive creation. It refuses an existing target.
The legacy source stays for review and explicit later cleanup. A persisted run
that still holds a flat key fails with this migration action. Start a new run
after migration so its state holds the exact key.

## Exports

- `Entry` holds `id`, `at`, `run`, `step`, `text`, and optional `tags`.
- `Storage` holds `recall`, `remember`, `forget`, and `keys`.
- `lines(root)` creates the JSON-line storage.
- `keyOf(memory, flowName, takes?)` resolves the exact key for one run.
- `rootKey()`, `flowKey(name)`, and `scopeKey(scope)` make typed keys.
- `keyReference(key)` and `referencedKey(reference)` write and read `key=`
  references.
- `migrateLegacy(root, source, target)` copies one explicit legacy file.
- `asKey(text)` remains the legacy flat-name conversion for migration only.
- `MOST` is 20. `LONGEST` is 2000 characters.
- `memoryProblems(memory, takes)` reports invalid flow memory declarations.

## Example

```ts
import { keyOf, lines } from "@krimvp/orchy";

const key = keyOf({ scope: "ticket/{{ issue }}" }, "bugfix", { issue: "PROJ-14" });
const store = lines(process.cwd());
store.remember(key as string, {
  run: "r1",
  step: "code",
  text: "the parser lives in src/yaml.ts",
});
```
