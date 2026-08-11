## A cycle back past a computed fanout freezes the members, and drops the new ones in silence

- **Area**: functional
- **Severity**: high
- **What I did**: `cE-cycle-past-computed-fanout.yaml`. `plan` is a `call` step
  whose list grows on every attempt (`a,b` on attempt 1, `a,b,c` on attempt 2,
  `a,b,c,d` on attempt 3). `judge` fans out over it with
  `fanout: { step: plan, key: list }`. `check` needs `judge` and holds
  `cycle: { to: plan, when: { approved: false }, limit: 3, policy: accept }`.
  Ran it three times: `node /home/user/orchy/src/cli.ts run
  cE-cycle-past-computed-fanout.yaml --with '{"tag":"cEa"}'`.
- **What happened**: the same on all three runs, exit 0, status `done`:

  ```
  plan said [{'name': 'a'}, {'name': 'b'}, {'name': 'c'}, {'name': 'd'}]
  members in state.flow ['plan', 'judge/a', 'judge/b', 'check']
  order: plan#1 count#1 count#2 check#1 plan#2 count#3 count#4 check#2 plan#3 count#5 count#6 check#3
  ```

  `plan` ended by naming four members. Only two ever existed. `c` and `d` were
  never judged, no event named them, and the run reports `done`.

  The second proof is sharper. `cE2-stale-member-value.yaml` keeps the list at
  two members and changes what each member carries (`round`):

  ```
  plan last said {'list': [{'name': 'a', 'round': 3}, {'name': 'b', 'round': 3}], 'n': 3}
  members now    {'judge/a': {'name': 'a', 'round': 1}, 'judge/b': {'name': 'b', 'round': 1}}
  member values  {'judge/a': {'round': 1, 'n': 3}, 'judge/b': {'round': 1, 'n': 3}}
  ```

  Each member ran three times and read round 1 every time. The cycle re-ran the
  work and paid for it, on the values of the first round, for ever.
- **What I expected**: a cycle that clears the step a fanout reads must expand
  that fanout again, or `validate()` must refuse a cycle that reaches back
  across a computed fanout.
- **Where**: `src/run.ts:686` — `spread()` writes the expanded steps into
  `state.flow` and its own comment says "The step is gone, so nothing expands it
  a second time". `goBackTo` (`src/run.ts:749`) clears the records but cannot
  put the fanout step back. ADR 0021's own reason for the member retry is a run
  that "judged eleven clauses of a lease" and lost one; this loses them without
  a failure to hang the loss on.

## A cycle to a fanout goes back to the last member only, and nothing says so

- **Area**: functional
- **Severity**: medium
- **What I did**: `c8-cycle-to-fanout.yaml`. `work` fans out over three members
  written in the file (`one`, `two`, `three`). `check` needs `work` and holds
  `cycle: { to: work, when: { approved: false }, limit: 5, policy: accept }`.
  Five runs, three at the command line and one through the daemon on port 4115.
- **What happened**: identical every time.

  ```
  cycles {'check->work/three': 2}
  steps {'work/one': {'n': 1}, 'work/two': {'n': 1}, 'work/three': {'n': 3}, 'check': {'approved': True, 'n': 3}}
  order: work-one#1 work-two#1 work-three#1 check#1 work-three#2 check#2 work-three#3 check#3
  ```

  The event stream says `↻ check goes back to work/three (1)`. The user wrote
  `to: work`. `validate()` passed it without a word, and the run rewrote the
  target to the last member the expansion happened to make. Two of the three
  members were never asked again.
- **What I expected**: either every member runs again, or `validate()` refuses
  `to: <a fanout step>` the way it already refuses a cycle *out of* a fanout,
  and names the member it wants.
- **Where**: `src/flow.ts:377` — `if (cycle?.to === step.id) ... to: id`, inside
  the member loop, so the last member wins. ADR 0021 states the rewrite in one
  line at the end; `docs/shape.md`, `docs/plan.md` and the README never mention
  it.

## The accept policy ends a run `done` and never tells the person it refused their answer

- **Area**: ux
- **Severity**: medium
- **What I did**: two shapes.
  1. `c5-limit3-accept.yaml`: `review` cycles back to `code` on
     `{ approved: false }`, `limit: 3`, `policy: accept`, and `review` never
     approves. Four runs.
  2. `c9-gate-cycle.yaml`: a **gate** with
     `cycle: { to: code, when: { approved: false }, limit: 2, policy: accept }`
     — `validate()` refuses `escalate` on a gate, so this is the only shape a
     gate cycle can take. I answered `{"approved":false}` three times:
     `orchy resume 05ad3b18-… '{"approved":false}'`.
- **What happened**: for (1), the whole terminal output of the last round is

  ```
  ✓ review
  — done
  ```

  exit 0, run value `{"approved": false, "n": 4}`. For (2), the third rejection
  gave:

  ```
  ◆ 05ad3b18-e9f9-454e-87d3-1bdc9ea8272b
  — done
  ```

  exit 0, run value `{"approved": false}`, and in the state
  `sign: {"value":{"approved":false},"answeredByPerson":true,"disagreement":"accepted"}`.
  A person pressed reject and the run answered "done". Nothing on the error
  stream, in the exit code, or in the run value says that a cycle reached its
  limit and the disagreement was taken anyway. `disagreement: "accepted"` is
  written to the state and to ATIF, and only the page draws it.
- **What I expected**: an event on the stream and a line in the reporter, in the
  shape of the `skip` event — the run refused the answer of a person, which is
  exactly the "never hide a failure" case.
- **Where**: `src/run.ts:718` sets `record.disagreement` and emits no event;
  `src/cli.ts:40-67` has no case for it.

## A cycle to a step the voter does not need runs that step again and never re-takes the vote

- **Area**: functional
- **Severity**: medium
- **What I did**: two flows, three runs each.
  1. `c10-cycle-to-ruled-out.yaml` — `maybe` carries
     `when: { seed: { go: true } }` and is ruled out; `check` needs `seed` only
     and cycles to `maybe`.
  2. `c10d-cycle-off-branch.yaml` — the same, with the condition taken off.
- **What happened**: for (1),

  ```
  done cycles {'check->maybe': 1}
  steps {'seed': done, 'check': ('done', {'approved': False}), 'maybe': ('skipped', '"seed" does not say {"go":true}')}
  history [('maybe', 'skipped')]
  order: seed#1 check#1
  ```

  The cycle fired, spent a count, threw the skipped record into history, re-made
  the identical skipped record, and no step ran again. Nothing can ever change
  the condition, because `seed` is not cleared.

  For (2):

  ```
  done cycles {'check->maybe': 1}
  order: seed#1 maybe#1 check#1 maybe#2
  ```

  `maybe` ran a second time and paid for it; `check`, which asked for the
  repeat, kept its first record, never saw the new value, and never voted again.
  The run ends `done` with `check` still saying `approved: false`.
- **What I expected**: `validate()` should refuse a cycle whose target the
  cycling step does not need, or the run should re-run the voter. As it stands
  the construct burns a round and changes nothing, in silence.
- **Where**: `src/run.ts:749` `goBackTo` clears the target and its dependents;
  the voter is not one of them, so it is never ready again.

## The cycle count never resets, so a resume gives a person no more rounds

- **Area**: devex
- **Severity**: medium
- **What I did**: ran `c5-limit3-accept.yaml` to its limit (`review->code: 3`),
  then `node /home/user/orchy/src/cli.ts resume 1746f9aa-f20c-46f4-909f-bf1365762acf --from code`.
- **What happened**:

  ```
  resume --from code exit=0 done cycles {'review->code': 3} value {'approved': False, 'n': 5}
  order after: code#1 review#1 code#2 review#2 code#3 review#3 code#4 review#4 code#5 review#5
  ```

  `code` and `review` ran exactly once more. `review` disagreed again, the count
  went to 4 against a limit of 3, and the run ended `done` without a further
  round and without a word. The same holds after an `escalate` was answered.
- **What I expected**: the README says "`--from` names the step to go back to,
  and every step after it runs again". It does not say that the cycle counters
  survive, so a person who re-runs a disagreeing flow gets one attempt and no
  loop. Either reset the counts of the steps that run again, or say so and print
  the counts that are already spent.
- **Where**: `src/run.ts:274` — `resume` calls `goBackTo` and never touches
  `state.cycles`.

## `orchy run` never prints a cost, so a cycle doubles the spend in silence

- **Area**: observability
- **Severity**: medium
- **What I did**: `cB-paid-cycle.yaml` — one `agent` step on `claude`/`haiku`,
  and a `call` step that cycles back to it once.
- **What happened**: the whole ending of the run is

  ```
  ✓ write
  ▶ judge
    judge │ attempt 2; inputs {"write":{"word":"ok"}}
  ✓ judge
  — done
  ```

  The state and `trajectory.json` hold the truth — `write` ran twice, the
  dropped attempt kept `cost: 0.011697` and the live one `cost: 0.01169`, and
  `final_metrics.cost_usd` is `0.023387` — but neither the event stream nor the
  run state printed on the output stream holds a total. `src/cli.ts` writes no
  `$` anywhere. A cycle is the one construct that multiplies the bill, and the
  command that runs it never names the bill.
- **What I expected**: the reporter to end with the cost and the token count of
  the run, the way the page does.
- **Where**: `src/cli.ts:40-70`.

## The escalation question miscounts the attempts

- **Area**: observability
- **Severity**: low
- **What I did**: `c1-retry-self-never.yaml` — a `call` step that always throws,
  with `cycle: { to: flaky, when: failed, limit: 3, policy: escalate }`.
- **What happened**: the step ran four times (`order: flaky#1 flaky#2 flaky#3
  flaky#4`), and the question is

  ```
  Step "flaky" failed 3 times over: flaky flaky broke on attempt 4. Supply the value for "flaky".
  ```

  It failed four times, not three; the message prints the limit and calls it a
  count. The value-cycle question has the same shape: `Step "review" reached its
  limit of 1 cycles back to "code"` — "1 cycles", and the run in fact ran
  `review` twice.
- **What I expected**: the number of attempts, or wording that says the number
  is the limit.
- **Where**: `src/run.ts:738` `questionFor` interpolates `cycle.limit`.

## A field of the escalation form has no visible box

- **Area**: ui
- **Severity**: low
- **What I did**: opened `http://127.0.0.1:4115/#/runs/712d1673-…` for a
  `c4-limit3-escalate` run that reached its limit, where the page asks a person
  to supply the value of `review` (`{ approved: boolean, n: number }`).
- **What happened**: `approved` draws a checkbox. `n` draws a label and, next to
  it, an input 950 px wide whose computed style is
  `border: 1px solid rgba(0, 0, 0, 0)` and `background: rgba(0, 0, 0, 0)`. On
  screen the row is a bare word with empty space after it. The box appears only
  on hover.
- **What I expected**: the one form that unblocks a stopped run should show
  where to type. `ui/src/styles.css:943` says this is deliberate ("The value
  carries no box until the hand asks for one"), so this is a judgement about
  where that rule fits, not an accident.
- **Where**: `ui/src/styles.css:943`.

## What held up

- A dropped attempt keeps its cost and the budget counts it: `cB2` stopped with
  `the run reached the budget of the flow "cB2-paid-cycle-budget": it spent
  $0.0245 of $0.015`, which is the dropped `write` ($0.011591) plus the live one
  ($0.0129).
- A cycle keeps the branch it does not touch: in `c6-untouched-branch`, `code`
  and `review` ran three times each and `seed`, `far` and `join` ran once.
- A retried step hears its own error: `flaky │ attempt 2; inputs
  {"flaky":{"error":"flaky flaky broke on attempt 1"}}`.
- Each member of a fanout retries itself and keeps its own count, as ADR 0021
  says: `cycles {'judge/one->judge/one': 1, 'judge/two->judge/two': 1,
  'judge/three->judge/three': 1}`, and a wave that loses more than one member
  past the limit fails the run and names all three.
- Two voters in one wave share the turns: `c7-two-cycles` ended
  `{'b->a': 1, 'c->a': 2}`, so the starvation that `docs/usability.md` reports
  ("the first in topological order always wins") is fixed.
- A gate cycle works the same at the command line and through the daemon: two
  rejections sent the run back twice, and the third answer finished it.
- `orchy resume <id> '{"approved":"yes"}'` on an escalated step is refused with
  `the value of "review" breaks the contract at "/approved": must be boolean`.
- A waiting run exits 3 and prints `answer with: orchy resume <id> '<json value>'`.
- The run page draws the cycle edge, marks every dropped attempt in the
  trajectory with "a loop dropped this attempt", says `loop: back to code, 3 of
  3 used`, and builds the escalation form from the contract of the step.
- Nothing looped for ever. A cycle to the step itself on a value match
  (`when: { n: { gt: 0 } }`) is a bounded loop: `spin` ran four times under
  `limit: 3` and stopped.

**Spend**: $0.0479 over 58 runs, all of it in two runs with an `agent` step
(`claude`/`haiku`).
