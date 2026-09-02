# `src/memory.ts` — what a run recovers, and where it stores

This module holds the memory of a run: the store a flow declares, the key that
names it, and the one implementation behind the contract. The runner recovers
from it before a step, four doors write to it, and none of them knows the shape
of the file. See [ADR 0029](../adr/0029-memory-is-a-declared-scope.md) for the
decision and its limits.

A flow that declares nothing remembers nothing. That is the default, and it is
the whole answer to the failure a global agent memory has: a store that every
run writes and every run reads is a store where one mistake compounds.

## The scope

`memory.scope` on a flow is the key of one store. Three words are not keys:

| written | the key | what it means |
| --- | --- | --- |
| absent, or `none` | none | remembers nothing |
| `flow` | `flow-<name>` | one store for every run of this flow |
| `user` | `user` | the one global store, asked for by name |
| anything else | that, as a key | a key of your own |

A key of your own reads the values of the run the way a prompt does, so
`ticket/{{ issue }}` gives each ticket a store, and a follow-up flow that writes
the same scope reads what the first run left. `asKey` turns whatever comes out
into a file name — lowercased, and everything but `[a-z0-9._-]` becomes a dash.
A key becomes a file name and never a path, so a walk out of the store is not
something that can be spelled.

The run resolves the key once, before its first step, and keeps it in
`state.memory`. So a resume reads the store the run really used, and not the one
the flow file names today.

## Exports

- `Entry` — one thing a run recorded: `id`, `at`, `run`, `step`, `text`, and
  optional `tags`. Every entry names where it came from, so a wrong one is
  found by its provenance and dropped by its id.
- `Storage` — the contract, and the only one: `recall(key, most?)`,
  `remember(key, entry)`, `forget(key, id?)`, and `keys()`. `recall` with no
  `most` answers with every entry; with a number, the last that many; with `0`,
  none.
- `lines(root)` — the one implementation: a line of JSON for each entry, under
  `<root>/.orchy/memory`, one file for each key. A line a hand broke costs that
  line and not the store.
- `keyOf(memory, flowName, takes?)` — the key one run reads and writes, or
  nothing when the flow remembers none. It throws when the scope reads a name
  that nothing supplies, and `run()` turns that into a refusal.
- `asKey(text)` — a key as a file name. The command line reads a scope through
  this too, so a person types the scope their flow declares and reaches the
  store the run wrote.
- `MOST` — how many entries seed a prompt when the flow names no number: 20.
- `memoryProblems(memory, takes)` — what a flow gets wrong about its memory, for
  `validate()`. A scope that reads a value the flow does not take is refused
  here, where `orchy check` says it and nothing has started.

## Who calls it

- `src/run.ts` resolves the key in `run()`, seeds each agent prompt with what
  the scope holds — a block named *What earlier runs recorded*, beside the
  values of the run — and gives a `command` step the key as
  `$ORCHY_MEMORY_KEY`. A step that declares `memory: none` gets no seed.
- `src/mcp.ts` serves `recall_memory` and `remember` to a step that holds the
  `orchy` tool. Neither takes a key: the door reads `state.memory` of the run
  whose step opened it, so a step cannot name the store of another ticket,
  another flow, or another user.
- `src/components/remember.ts` is the `orchy:remember` call step, which makes
  the bookkeeping something the flow decides rather than something the model
  chooses on the fly.
- `src/cli.ts` serves `orchy memory keys | list | add | forget`, for a person
  and for a harness that holds no `orchy` tool.

## Example

```ts
import { keyOf, lines } from "@krimvp/orchy";

const key = keyOf({ scope: "ticket/{{ issue }}" }, "bugfix", { issue: "PROJ-14" });
// "ticket-proj-14"

const store = lines(process.cwd());
store.remember(key as string, { run: "r1", step: "code", text: "the parser lives in src/yaml.ts" });

for (const entry of store.recall(key as string, 5)) {
  console.log(entry.id, entry.step, entry.text);
}
```
