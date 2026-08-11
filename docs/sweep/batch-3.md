## A cycle or a resume back to the step that computed a fanout keeps the old members

- **Area**: functional
- **Severity**: high
- **What I did**: `hunt/batch-3/probe4/cycle2.yaml`. `find` returns `[{name: a}, {name: b}]`
  on its first call and `[{name: c}, {name: d}, {name: e}]` on its second. `work` fans out
  over `{ step: find, key: items }`. `tail` needs `work` and carries
  `cycle: { to: find, when: { done: false }, limit: 1, policy: accept }`.
  `node /home/user/orchy/src/cli.ts run cycle2.yaml`, three times, identical each time.
  The same thing happens without a cycle: run `probe4/flow.yaml` with `list.txt` = `a b`,
  change it to `c d e`, then `orchy resume <id> --from find`.
- **What happened**:

  ```
  ▶ find
  ✓ find
  ▶ work/a
  ▶ work/b
  ✓ work/a
  ✓ work/b
  ▶ tail
  ✓ tail
  ↻ tail goes back to find (1)
  ▶ find
  ✓ find
  ▶ work/a
  ▶ work/b
  ✓ work/a
  ✓ work/b
  ▶ tail
  ✓ tail
  — done
  ```

  and the state of that same run:

  ```
  find value {"items": [{"name": "c"}, {"name": "d"}, {"name": "e"}]}
  tail  value {"seen": ["work/a", "work/b"], "done": true}
  ```

  The second lap ran `work/a` and `work/b` — members that the new list does not hold,
  carrying the old `with` values — and never ran `e`. The run ends `done` and says nothing.
- **What I expected**: the second lap fans out over the list `find` just returned, or the
  run refuses to go back to a step a fanout reads.
- **Where**: `src/run.ts:683` — `spread()` replaces the fanout step in `state.flow` with the
  members it made, so the step is gone and nothing can expand it a second time
  (ADR 0017 states this as the crash-recovery property). `goBackTo` clears the *records* of
  the target and its dependents, but the expanded members stay in `state.flow` forever. This
  is exactly the fault ADR 0017 was written to remove: "a list that changes made the flow
  wrong in silence".

## A computed fanout throws away the values the step already holds, and the error tells you to add them back where they already are

- **Area**: functional
- **Severity**: high
- **What I did**: `hunt/batch-3/probe2/flow2.yaml` — one call step with both
  `with: { tag: fromStep, keep: yes }` and `fanout: { step: find, key: items }`, plus
  `takes` requiring `tag`. Run it. Then `hunt/batch-3/probe7/flow.yaml`, the same shape on
  an `agent` step whose prompt reads `{{ tag }}`. Then `probe3` (a copy of `f10`), where an
  inner flow is called with `with: { tag: outer }` and holds two fanouts, one written in the
  file and one computed.
- **What happened**: the member's `with` **replaces** the step's `with` instead of merging
  with it, so `tag` never reaches the member.

  ```
  fixed/p -> {'values': '{"runValue":"R","name":"p"}'}      # tag and keep are gone
  comp/c1 -> {'values': '{"runValue":"R","name":"c1"}'}     # tag and keep are gone
  ```

  With `takes` declared it becomes a mid-run failure whose advice cannot be followed:

  ```
  ✗ comp/c1
    the values that reach "comp/c1" break what it takes at "/": must have required
    property 'tag'. Add it to "takes" on the flow, or to "with" on the step.
  ```

  The step *does* declare `with: { tag: fromStep }`. `validate()` on that flow returns `[]`.
  On an agent step the same thing kills the step before the model is called:

  ```
  ✗ speak/c1
    step "speak/c1" reads "{{ tag }}" in its prompt, and nothing supplies "tag".
    Add it to "takes" on the flow, or to "with" on the step.
  ```

  In `probe3` the two fanouts of one inner flow disagree: the file-written one keeps the
  values the outer step passed down, the computed one loses them.

  ```
  ✓ part/fixed/p     -> {"name": "p", "tag": "outer"}
  ✗ part/work/x      -> the values that reach "part/work/x" break what it takes at "/":
                        must have required property 'tag'.
  ```

  The same mistake in a file-written fanout is caught before the run, with the right advice:

  ```
  the flow is not valid:
  - member "p" of "fixed" takes "tag", and nothing supplies it. Add "tag" to "takes" on
    the flow, or to "with" on the member.
  ```

- **What I expected**: a member's `with` merges over the step's `with` (the step holds what
  every member shares, the member holds what differs) — or, at the very least, `validate()`
  refuses a computed fanout on a step that holds `with`, and the run-time message says
  "on the **member**", the way the file-written path already does.
- **Where**: `src/flow.ts:371-373` — `const overrides = pick(member, holds); const one = { ...base, ...overrides, id }`.
  `with` is in `MEMBER_HOLDS` (`src/flow.ts:531`) beside `module`, `prompt`, `model`, so a
  data field is spread like a configuration override. The check that catches the file case is
  `takenProblems` in `validate()`; the computed case has no equivalent.

## The run reports one member of a fanout as the value of the whole run

- **Area**: observability
- **Severity**: medium
- **What I did**: `hunt/batch-3/f01/flow.yaml` — one call step fanned out over three members
  written in the file, no other step, no `returns` on the flow.
  `node /home/user/orchy/src/cli.ts run flow.yaml`, three times.
- **What happened**: the run state ends with

  ```
  "value": {
    "item": "apples",
    ...
  }
  ```

  which is the value of `work/alpha` alone. `work/beta` and `work/gamma` are simply not in
  it, and nothing says the run had three ends. The same in `f07` after the escalated member
  was answered: `value` is `{"item": "steady", ...}`. In `f03` with an empty list the run
  ends `done` with `"value": null`, because the first exit was skipped, while `aside` did
  produce a value.
- **What I expected**: a run with several ends reports no single value, or reports all of
  them keyed by step. The README says "the flow returns the value of the step it ends with";
  when there are three such steps, picking the first in file order without a word is a
  reader's trap.
- **Where**: `src/run.ts:578` `valueOf()` takes `exitsOf(state.flow.steps)[0]`.
  `validate()` refuses this only when the flow declares `returns` (`src/flow.ts:773`).

## A member whose name is only spaces becomes a step called `work/  `

- **Area**: functional
- **Severity**: low
- **What I did**: `hunt/batch-3/probe/flow.yaml` with a source step returning
  `[{ name: "two words" }, { name: "  " }]`, and other cases: `a/b`, `..`, `.`, 300 `z`s,
  emoji, right-to-left text.
- **What happened**: every one of them is accepted.

  ```
  ▶ work/two words
  ▶ work/  
  ✓ work/two words
  ✓ work/  
  ```

  and with `[{name: "a/b"}, {name: "c"}]` the ids read `work/a/b` and `work/c`, so the id of
  a member is indistinguishable from a step of a sub-flow (`part/work/x` in `f10`). An empty
  name is refused with a good message; a whitespace name, a `..`, and a slash are not.
- **What I expected**: the same refusal an empty name gets — the check already exists one
  line away, and a name that a person cannot read or point at defeats the reason ADR 0017
  gives for demanding names at all ("a name that means nothing hides the change").
- **Where**: `src/run.ts:673-676` — `typeof name !== "string" || name === ""` is the whole test.

## `resume --from` cannot name the step a fanout came from, and the error does not say why

- **Area**: ux
- **Severity**: low
- **What I did**: ran `f02` (a computed fanout named `audit` in the file), then
  `orchy resume <id> --from audit`.
- **What happened**:

  ```
  the run 29fa6ecf-3d60-40f5-a56a-1bfd68eac9fe holds no step "audit", so it cannot go
  back to it
  ```

  The user is reading their own flow file, where the step is called `audit`. Nothing says the
  step became `audit/core`, `audit/cli`, `audit/ui`. (`--from audit/cli` does work, and runs
  exactly that member.)
- **What I expected**: "the run expanded `audit` into `audit/core`, `audit/cli`, `audit/ui`;
  name one of them" — the run state holds all three ids.
- **Where**: `src/run.ts:271`.

## A member that holds a field the step itself may hold is refused with a false reason

- **Area**: devex
- **Severity**: low
- **What I did**: `hunt/batch-3/probe5/member-when.yaml` — a call step whose member holds
  `when`.
- **What happened**:

  ```
  the flow is not valid:
  - member "a" of "work" holds "when", which a call step cannot act on
  ```

  A call step *can* act on `when` — `f08` uses exactly that and it works. What cannot hold
  it is a member.
- **What I expected**: "a member holds only name, module and with", or "`when` belongs on
  the step, not on a member".
- **Where**: `src/flow.ts:710` reuses the step-level wording for the member-level check.

## A fanout on a gate is refused twice, in two voices

- **Area**: devex
- **Severity**: low
- **What I did**: `hunt/batch-3/probe5/bad-gate.yaml` — `fanout` on a gate step.
- **What happened**:

  ```
  the flow is not valid:
  - step "ask" holds "fanout", which a gate step cannot act on. Only an agent or a call step holds it.
  - step "ask" fans out, but only an agent step and a call step can
  ```

  Two problems are reported for one mistake, and the second says less than the first.
- **What I expected**: one line.
- **Where**: `src/flow.ts:587` and `src/flow.ts:697`.

## The page says "Every step passed" for a run where two steps were skipped

- **Area**: ui
- **Severity**: low
- **What I did**: started `f03` (empty computed fanout) through the daemon on port 4113 and
  opened `#/runs/<id>`.
- **What happened**: the banner reads

  ```
  DONE
  This run is done
  Every step passed. Choose one in the drawing to read what it answered.
  ```

  while the line under it reads `2 done · 2 skipped` and `steps done: 2/4`. The drawing and
  the activity log are right (`audit` and `report` are drawn with a broken outline, and the
  log holds `skipped, because "find" returned no "packages" to fan out over`).
- **What I expected**: "two steps passed and two were skipped", since a fanout that found
  nothing is the case the sentence is most likely to be read in.
- **Where**: `ui/src/Run.tsx:337`.

## A step that a failed member kept from running leaves no record and no event

- **Area**: observability
- **Severity**: low
- **What I did**: `hunt/batch-3/f06/flow.yaml` — three members, the middle one throws, and
  `after` needs the step. Ran it three times.
- **What happened**: the siblings finish and keep their values, the run fails and names the
  member — all good — but `after` is absent from `state.steps` altogether and no event
  mentions it. A skipped step gets a record and a `skip` event; a step that a failure kept
  from starting gets neither, so a reader of the state cannot tell `after` apart from a step
  that does not exist.
- **What I expected**: a record or an event that says `after` never started, and why.

## The editor cannot write the values a step holds

- **Area**: ui
- **Severity**: low
- **What I did**: opened `#/flows/1` on the daemon and clicked the `audit` step (screenshot
  in `hunt/batch-3/f02-step.png`).
- **What happened**: the step panel draws id, kind, needs, module, promise, `takes`,
  `returns`, `when`, loop and the whole fanout (including "a list a step returns", the step,
  and the key). There is no control for `with`. A member's `with` is editable as JSON
  (`ui/src/Editor.tsx:1547`); the step's own `with` is only carried through
  (`ui/src/Editor.tsx:1680`). So a flow whose fanout members share a value cannot be written
  on the page at all.
- **What I expected**: the same JSON field the member row already has.

## What held up

- Member naming for a computed fanout is exactly what ADR 0017 promises: `find` returning
  `[{name: core}, ...]` gives `audit/core`, `audit/cli`, `audit/ui`, each with its own record,
  its own value, and its own line in the activity log and the trajectory.
- An empty list skips the step with the reason quoted, skips every step that needs it, and
  leaves a sibling branch that needs only the source alone. `done`, not `failed`, as ADR 0017 says.
- One member's failure does not touch its siblings: they finish, they keep their values, and
  the run fails naming each failed member.
- A retry per member is right in every detail: `state.cycles` holds
  `work/once->work/once: 1` and `work/always->work/always: 2`, only the failing member runs
  again, `escalate` asks a person for that one member with a form built from its contract,
  and two members past their limit fail the run instead of asking twice — ADR 0021, line by line.
- Every dropped attempt is in `state.history` with its own error, and the page shows
  "3 attempts that a loop dropped" under a step that has not ended.
- `orchy resume <id>` on a run a member failed re-runs only that member;
  `resume <id> --from audit/cli` re-runs exactly one member.
- A condition on a computed fanout skips the whole step before it expands; on a file-written
  fanout it skips each member, each with the reason.
- Members feeding a later step arrive keyed by member id, in list order, with whatever shape
  each member returned — three different shapes came through untouched and identically on
  every run.
- A fanout inside a called flow namespaces cleanly (`part/work/x`), and both fanouts of that
  inner flow expand at the right moment.
- `validate()` refuses, with one clear sentence each: a fanout on a gate, `fanout: []`, a
  source the step does not need, a key the source does not return, a source that fans out
  itself, a third field inside `{ step, key }`, a cycle that leaves a fanout, a member field
  the kind cannot hold, and a computed fanout at the end of a flow that returns a value.
- Twelve members run eight at a time under the default `parallel`; 200 computed members run
  and record fine (202 steps, 171 KB of state, ~5 s).
- The editor draws a computed fanout as a stack labelled `audit.ts ×?` — the count it cannot
  know — and lets a person choose the source step and the key.
- Every one of the ten flows was run at least three times and produced byte-identical values,
  step statuses and step ids each time.

**Spend: $0.00** over 79 runs (every step was `call` or `gate`; the one agent flow failed at
prompt-fill, before the harness was called, and recorded no cost).
