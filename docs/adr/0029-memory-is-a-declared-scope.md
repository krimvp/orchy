---
status: accepted
---

# Memory is a declared scope, and never a global store

A flow says what it remembers, and where.

```yaml
name: bugfix
takes:
  type: object
  required: [issue]
  properties:
    issue: { type: string }
memory:
  scope: "ticket/{{ issue }}"
  most: 20
```

`scope` is the key of one store. Three words are not keys: `none`, which is the
default and remembers nothing; `flow`, which is one store for every run of this
flow; and `root`, which is the one store of the whole root. Everything else a flow writes
is a key of its own, and it reads the values of the run the way a prompt does.
So `ticket/{{ issue }}` gives each ticket a store, and a follow-up flow that
writes the same scope reads what the first one left.

`most` is how many entries seed the prompt of a step. Twenty when the flow is
silent, and `0` seeds none.

A run resolves the key once, before its first step, and keeps it in its state.
A resume then reads the store the run really used, and not the one the flow file
names today. [ADR 0005](./0005-a-run-is-a-persisted-state-machine.md) already
said that the state on disk is the run; this is one more thing it holds.

## Why a scope, and not a memory

The objection to agent memory is sound: a store that every run writes and every
run reads is a store where one mistake compounds. One wrong claim, written once,
reaches every later run of every flow, and no person ever reviewed it.

The answer is not "no persistence". It is that the reach of a memory is
something a person declares, and never something Orchy picks. A run reads the
one store its flow named, and the default is none. A flow that wants the store
of the whole root writes `root`, in the file, where a reader sees it. The word
is `root` and not `user`, because the store lives under the root's
`.orchy/memory`, beside the runs, and a second root is a second store.

That gives the isolation at the door for free. The key is resolved from the
state of the run, and never from the call, so a step cannot name the store of
another ticket or another flow through the door: there is nothing to ask for.
`recall_memory` and `remember` take no key, and that is the whole of what the
door enforces. It is not a wall: see the limits below.

## Why every entry names its run and its step

A store nobody can correct is a store nobody should trust. Each entry holds the
run and the step that wrote it, an id, and the time. So a wrong claim is found
by where it came from, and dropped by its id:

```
key="$(orchy memory key scope 'ticket/PROJ-14')"
orchy memory list "$key"
orchy memory forget "$key" a41f9c02
```

A person who writes one from the command line is recorded as a person. A
command step, and a claude or droid step, that write from the command line are
recorded as that run and that step, because the process learns who it is from
`$ORCHY_STARTED_BY`, the same variable the door reads, and `orchy memory add`
reads it too. Nothing in the store is anonymous.

## Why one storage, and why a line of JSON

The `Storage` contract is four calls — `recall`, `remember`, `forget`, `keys` —
and one implementation stands behind it: a line of JSON for each entry, under
`.orchy/memory`, one file for each key. The runner reads neither the file nor
the format.

A memory is prose, and prose holds commas, quotes and newlines. A row of CSV
answers that with quoting rules, and a store a person opens by hand is a store
where those rules get broken by hand. A line of JSON escapes what it must,
survives a broken line — that entry is skipped, and the store still opens — and
stays greppable, appendable, and readable in a diff. Which is what a person
correcting an entry actually needs.

One storage, because two are a choice a user must make before they have any
reason to. The `Storage` interface still stands with one implementation behind
it, which AGENTS.md forbids, and this is the second exception after
[ADR 0002](./0002-keep-a-harness-adapter.md), for the same reason: the interface
is the document. Four calls say what a store is, and the runner, the door, the
step, and the command line read that and not the file. The limit is the same as
the adapter's: four calls, and a fifth is the moment to ask whether a second
store has earned its place, not the moment to add one.

## Why the seed and the tools both

The entries earlier runs left in the scope go into the prompt of each step, as
a block, beside the values of the run. What this run records is the state of
this run, and the values of its steps already carry it, so the block holds none
of it. That is deterministic: it happens whether or not the model thinks to
look, and the record of the step keeps it, so a cycle asks again with the same
words whatever the run recorded since.

`most` bounds how many entries, and an entry holds at most 2,000 characters,
whichever door it comes through. So the seed is bounded, and a store of
paragraphs is refused: a document belongs in the repository.

The seed alone is not enough. A model cannot go looking for something that was
not preloaded, a long turn compacts away what arrived at turn 0, and how much to
preload has to be guessed before the run. So a step that holds the `orchy` tool
also reaches `recall_memory`, and reads past the seed when the seed runs out.

## The ways in

Four, and all of them write the same entries:

- `remember`, at the door of the run — the agent decides, mid-run.
- `orchy:remember`, a call step — the flow decides, and it always happens.
  Bookkeeping as a step is not a choice the model makes on the fly.
- `orchy memory add`, at the command line — a person, and any harness that
  holds no `orchy` tool. A command step, and a claude or droid step, read the
  key as `$ORCHY_MEMORY_KEY` for the same reason, and who they are as
  `$ORCHY_STARTED_BY`. A Pi step runs inside the runner, where one environment
  serves every step of the run, so it reads neither: a Pi flow records with the
  `orchy:remember` step, and reads the seed.
- A hand, in the file. It is a line of JSON.

Orchy is uninterested in which. It holds no opinion on what belongs in a store,
and it extracts nothing by itself: a flow that wants a summary at the end writes
an agent step that produces one and a `orchy:remember` step that records it.

## The limits, stated

- A step says `memory: none` and reads no seed, and the door refuses it both
  tools. The scope itself belongs to the flow: a step does not declare one.
  A step that reviews the work of another must be able to say that it saw
  nothing but the work.
- `recall_memory` matches a substring, in the text and in the tags. There is no
  ranking and no embedding. A store large enough to need one is a store that
  wants a second implementation behind the contract.
- A flow held by a `flow` step declares no memory, the way it declares no
  budget: expansion drops the flow and keeps its steps, and a scope reads the
  values of the run, which expansion turns into values of a step. Both would be
  rules that look enforced and are not, so the load refuses them.
- The door is not a sandbox, the way [ADR 0018](./0018-a-tool-list-is-not-a-sandbox.md)
  says a tool list is not one. A step that holds `bash` reaches every store of
  the root through `orchy memory`, and can add to or forget any of them. The
  door keeps a step from naming another store by mistake; it does not keep a
  model that runs commands from reaching one on purpose. A flow that must not
  reach the store of another ticket runs in another root.
- Memory changes take one claim. A claim whose owner died stays until a person
  inspects it. This can stop writes, but it cannot guess that a live write is
  stale and remove its owner.
- A legacy key is a flat file name and is not a scope boundary. The amendment
  below replaces it with an exact typed key and gives legacy data an explicit
  migration.
- Nothing expires. An entry lives until a person or a flow forgets it, and the
  store grows by one file for each key. A time limit is a field this can grow;
  nobody knows the right default yet.
- The store is not the run. It is not indexed, it is not in the trajectory, and
  losing `.orchy/memory` loses no run — the same relation
  [ADR 0009](./0009-the-database-indexes-the-runs-on-disk.md) draws for the
  index.
- Durable project knowledge still belongs in reviewed, human-readable records in
  the repository. A store is where one run tells the next what it found, and
  not where an organisation keeps what it knows.

## Amendment: a scope keeps its exact identity

The original file-name rule flattened a scope with `asKey`. That rule was not
safe. `ticket/A/B` and `ticket/A-B` became one store. Different Unicode scopes
could both become `memory`. A custom scope could also become the `flow` store.
This broke the declared boundary between scopes.

A current key now holds a type and exact text: `root`, a flow name, or a custom
scope. Orchy encodes that value as a `v2:` key. The file name keeps a readable
prefix and the full SHA-256 digest. The first line of the file records the exact
key, so `keys()` can recover it and can refuse bad metadata.

The old files do not record the logical scope that made their flat name. They
can already hold mixed entries. Therefore, Orchy does not read or copy one by
itself. `orchy memory keys` marks it as `legacy=`, and a person selects one
exact `key=` target with `orchy memory migrate`. The command keeps the legacy
source. It creates the target exclusively, so two migrations do not merge or
overwrite it.

Memory changes use one claim across processes. An append, a forget, and a
migration cannot change the files at the same time. A stale or unreadable claim
fails closed and tells a person to inspect it. Orchy does not remove a claim
that it cannot prove it owns.
