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
flow; and `user`, which is the one global store. Everything else a flow writes
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
one store its flow named, and the default is none. A flow that wants the global
store writes `user`, in the file, where a reader sees it.

That gives the isolation for free. The key is resolved from the state of the
run, and never from the call, so a step cannot name the store of another ticket,
another flow, or another user: there is nothing to ask for. `recall_memory` and
`remember` take no key, and that is the whole of the enforcement.

## Why every entry names its run and its step

A store nobody can correct is a store nobody should trust. Each entry holds the
run and the step that wrote it, an id, and the time. So a wrong claim is found
by where it came from, and dropped by its id:

```
orchy memory list ticket-proj-14
orchy memory forget ticket-proj-14 a41f9c02
```

A person who writes one from the command line is recorded as a person. Nothing
in the store is anonymous.

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
reason to. The seam is there when a second one earns its place.

## Why the seed and the tools both

The entries the scope holds go into the prompt of each step, as a block, beside
the values of the run. That is deterministic: it happens whether or not the
model thinks to look, and the record of the step keeps it, so a cycle asks again
with the same words.

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
  holds no `orchy` tool. A command step reads `$ORCHY_MEMORY_KEY` for the same
  reason.
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
- Nothing expires. An entry lives until a person or a flow forgets it. A time
  limit is a field this can grow; nobody knows the right default yet.
- The store is not the run. It is not indexed, it is not in the trajectory, and
  losing `.orchy/memory` loses no run — the same relation
  [ADR 0009](./0009-the-database-indexes-the-runs-on-disk.md) draws for the
  index.
- Durable project knowledge still belongs in reviewed, human-readable records in
  the repository. A store is where one run tells the next what it found, and
  not where an organisation keeps what it knows.
