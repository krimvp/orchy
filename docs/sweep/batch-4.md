## `when` on a `kind: flow` step is dropped in silence, and the steps run anyway

- **Area**: functional
- **Severity**: high
- **What I did**: `cond-on-flow-step.yaml` holds a `call` step `sort` that returns
  `{severity}` and a `kind: flow` step `sub` with `needs: [sort]` and
  `when: { sort: { severity: high } }`. Ran it three times with
  `--with '{"severity":"low"}'` and once with `"high"`:
  `node /home/user/orchy/src/cli.ts run cond-on-flow-step.yaml --with '{"severity":"low"}'`
- **What happened**: identical on every value.

  ```
  ◆ eef8e72e-da5d-40a6-8440-e2ac2204c525
  ▶ sort
    sort │ source says {"severity":"low"}
  ✓ sort
  ▶ sub/work
  ✓ sub/work
  — done
  ```

  No problem from `validate()`, no `skip` event, no `skipped` record. The
  condition was neither enforced nor refused. `bad/when-on-flow-step.yaml`
  confirms the check is absent: it ran the flow instead of naming the field.
- **What I expected**: ADR 0014 says it in one line — "A flow step holds none,
  because expansion replaces it with the steps of the flow it names… `validate()`
  refuses it there." Either the refusal, or the condition applied to the expanded
  steps.
- **Where**: `src/flow.ts:520-528` names `when` in `HOLDS` for agent, call and
  gate but not for `flow` — yet `src/load.ts:36` expands every flow step *before*
  `validate()` runs (`src/run.ts:200`), so a `flow` kind step never reaches the
  table. `expandFlows` (`src/flow.ts:412-497`) carries `needs`, `with`, `changes`,
  `harness`, `model` and `cycle` onto the moved steps and drops `when` on the
  floor. This is the same fault the shape study reported and closed for ordinary
  steps ("`when` on a step | nothing | The step runs anyway.", `docs/shape.md:92`),
  reopened for one kind of step.

## A condition against a step whose value is not an object is false forever, and nothing says so

- **Area**: functional
- **Severity**: medium
- **What I did**: `cond-scalar-value.yaml` — `sort` is a `call` step with
  `returns: { type: string }` whose module returns the value it was given, and
  `page` holds `when: { sort: { severity: high } }`. Four runs, two with
  `--with '{"severity":"high"}'`.
- **What happened**:

  ```
  ▶ sort
  ✓ sort
  ⊘ page does not run
    "sort" does not say {"severity":"high"}
  — done
  ```

  `sort` said exactly `"high"`. The reason is not merely unhelpful, it is untrue.
  `validate()` reads the contract of the named step (it refuses a key that a
  declared `properties` does not hold — see the probes below) but says nothing
  when `returns.type` is not `object`, where *no* condition can ever hold.
- **What I expected**: `validate()` to refuse a condition on a step whose contract
  cannot produce a matchable object, at load time.
- **Where**: `src/run.ts:765-769` — `matches()` returns false for any value that
  is not an object; `src/flow.ts:975-999` — `conditionProblems` only checks keys
  when `returns.properties` exists.

## A flow that declares `returns` fails when a condition rules out its last step

- **Area**: functional
- **Severity**: medium
- **What I did**: `cond-ruled-out-returns.yaml` is `sort → page (when high) →
  notify → record`, plus a flow-level `returns` for `record`. Ran it with
  `"high"` and twice with `"low"`.
- **What happened**: with `"low"`:

  ```
  ⊘ page does not run
    "sort" does not say {"severity":"high"}
  ⊘ notify does not run
    it needs "page", which the run skipped
  ⊘ record does not run
    it needs "notify", which the run skipped
  — failed
    the flow "cond-ruled-out-returns" returns the value of "record", and the run has no value for it
  ```

  Exit code 1. The same flow without `returns` ends `done` with exit 0.
- **What I expected**: `done`. ADR 0014: "A run that skips its last steps still
  ends `done`. A skipped step is a decision the flow made, not a fault." As it
  stands, a flow with a condition on any branch that can reach the exit can never
  declare what it returns — which is the whole "sort the issue; when it is severe,
  page the on-call, otherwise stop" shape the condition exists for.
- **Where**: `src/run.ts:74-84` (`returnProblem` treats `skipped` like a failure),
  called at `src/run.ts:545`.

## The record a run leaves behind says a step was skipped, but not why

- **Area**: observability
- **Severity**: medium
- **What I did**: ran `cond-ruled-out.yaml` with `"low"` and read
  `.orchy/runs/<id>/trajectory.json`, which is the portable record and what the
  page's trajectory panel draws.
- **What happened**: `state.json` keeps the reason —
  `"skipped": "\"sort\" does not say {\"severity\":\"high\"}"` — and the
  trajectory drops it:

  ```json
  { "message": "step \"page\" ended skipped",
    "extra": { "orchy": { "step": "page", "status": "skipped",
                          "startedAt": "…", "endedAt": "…" } } }
  ```

  A failure carries its reason into the same `message` field
  (`… ended failed: <error>`); a skip does not. The trajectory panel on the page
  shows the same three bare rows: `skipped page 0s`.
- **What I expected**: the reason in the trajectory, the way an error is. ADR 0014
  says "a reader of the events is never left to work out why a step never
  started", and the trajectory is the record that outlives the events.
- **Where**: `src/atif.ts:69` builds the message from `record.error` only, and
  `src/atif.ts:72-82` copies `changed`, `disagreement`, `answeredByPerson`,
  `dropped` — never `record.skipped`.

## A run with three skipped steps out of four says "Every step passed"

- **Area**: ui
- **Severity**: medium
- **What I did**: started `cond-ruled-out` from the daemon on port 4114 with
  `{"severity":"low"}` and opened `#/runs/b39241e0-…`.
- **What happened**: the hero reads

  ```
  DONE
  This run is done
  Every step passed. Choose one in the drawing to read what it answered.
  ```

  with `1 done · 3 skipped` and `steps done: 1/4` immediately underneath it.
  Screenshot: `hunt/batch-4/run-step-panel.png`.
- **What I expected**: a sentence that counts the skips, e.g. "One step passed and
  three never ran." The two lines contradict each other, and the wrong one is the
  big one.
- **Where**: `ui/src/Run.tsx:330-343`.

## A skip reason quotes the condition and never the value, so a type mismatch reads like an honest "no"

- **Area**: ux
- **Severity**: medium
- **What I did**: `cond-chain.yaml` — `measure` returns `{count}` and `page` holds
  `when: { measure: { count: { gt: 2 } } }`. Ran it with `count: 1` and with
  `count: "5"` (a string, which the contract allows because the property declares
  no type).
- **What happened**: both runs print the same line.

  ```
  ⊘ page does not run
    "measure" does not say {"count":{"gt":2}}
  ```

  `cond-lt` with `--with '{"score":"2","name":true}'` skips all four dependents
  with four lines of the same shape. ADR 0016 is explicit that `lt`/`gt` match
  nothing when the value is not a number, so the behaviour is right — but the
  reason is the only thing the user gets, and it never says what the value was or
  that it was of the wrong sort. The page is the same: the step panel shows
  `runs when: sort says {"severity":"high"}` and
  `status: skipped "sort" does not say {"severity":"high"}` — two ways of writing
  the condition, and no sight of the value without clicking the other step.
- **What I expected**: the value in the reason —
  `"measure" said {"count":"5"}, and the condition wants {"count":{"gt":2}}` —
  and a word when an operator read a value it cannot compare.
- **Where**: `src/run.ts:632-646` (`skipOf` has `state.steps[id]?.value` in hand
  when it writes the reason).

## A contract with no `properties` switches off every check on a condition that reads it

- **Area**: devex
- **Severity**: medium
- **What I did**: `cond-missing-key.yaml` holds `loose`, a `call` step with
  `returns: { type: object }`, and two steps conditioned on
  `{ loose: { ghost: yes } }` and `{ loose: { ghost: { empty: true } } }`.
- **What happened**: `validate()` passes. At run time `on_ghost` is skipped with
  `"loose" does not say {"ghost":"yes"}` and `ghost_empty` *runs*, because a key
  that is not there is empty. So a misspelled key silently inverts which branch of
  a flow runs, and nothing in the file, the validation or the run says the key does
  not exist. The same flow's `sort` step, which declares `properties`, is checked
  properly: `bad/key-not-returned.yaml` is refused with
  `step "page" runs when "sort" says "missing", which "sort" does not return`.
- **What I expected**: either a warning that a condition reads a contract that
  declares nothing, or the check applied to `required`/`additionalProperties`.
- **Where**: `src/flow.ts:988-993` — `const properties = …; if (properties && …)`.

## No way to match a field inside a value, and the obvious try is silently false

- **Area**: devex
- **Severity**: medium
- **What I did**: `cond-nested.yaml`. `sort` returns
  `result: { severity, count }`. Three conditions: `{ result: { is: {severity:
  high, count: 2} } }`, `{ result: { is: { severity: high } } }`, and on a
  contract with no properties, `{ "result.severity": high }`.
- **What happened**: only the whole-object `is` ever runs. The partial object is
  false whenever the value carries any other key:

  ```
  ⊘ part_of_object does not run
    "sort" does not say {"result":{"is":{"severity":"high"}}}
  ```

  The dotted path is false on every run, with no complaint from `validate()`:

  ```
  ⊘ dotted_path does not run
    "loose" does not say {"result.severity":"high"}
  ```

  Against a step that declares `properties`, the dotted path is refused with a
  good message (`bad/dotted-path.yaml`: `runs when "sort" says "severity.inner",
  which "sort" does not return`) — so the trap only springs on the loose contract.
- **What I expected**: `docs/shape.md` and ADR 0016 say a match is "partial", which
  a reader takes to mean partial at depth; it is partial only at the top level, and
  deep equality below it. Say so where a user reads it, and name the workaround
  (a `call` step that flattens the decision) beside it.
- **Where**: `src/run.ts:765-769`, `src/run.ts:776-788`.

## `empty` reads a boolean or a number as "not empty", and the file cannot say the same thing

- **Area**: functional
- **Severity**: low
- **What I did**: `cond-empty.yaml` with
  `--with '{"findings":0,"note":null,"bag":"","flag":[]}'` and with
  `'{"findings":["a"],"note":"x","bag":{"a":1},"flag":false}'`, where every
  property is declared with no type.
- **What happened**: `flag: false` satisfies `{ flag: { empty: false } }` — the
  step ran. `findings: 0` satisfies `{ findings: { empty: false } }` — the step
  ran. So a boolean and a number are always "not empty", and `empty: true` can
  never hold for either. Write the same thing with a declared type and the file is
  refused before the run: `step "page" runs when "sort" says "ok" with "empty",
  and "ok" holds a boolean. The operator "empty" tests a list, a string, or an
  object.`
- **What I expected**: the same answer in both places. ADR 0016 does say a run
  "reads an operator with no schema in front of it", so this is the documented
  cost — but the run could say `empty` read a boolean, in the skip reason, instead
  of quietly counting it as full.
- **Where**: `src/run.ts:792-797`.

## A `resume --from` is reported in the trajectory as a loop

- **Area**: observability
- **Severity**: low
- **What I did**: `orchy resume b39241e0-… --from page` on a done run whose `page`
  was skipped, then reopened the run page.
- **What happened**: the run behaved correctly (it re-read the condition and
  skipped the three steps again). But the trajectory panel now lists seven steps,
  and the three older records carry

  ```
  skipped   page   a loop dropped this attempt
  ```

  No loop exists anywhere in that flow. `resume --from` pushes the old records to
  history through the same path a cycle uses, and ATIF marks them `dropped: true`.
- **What I expected**: "a resume replaced this attempt", or a neutral word for
  both.
- **Where**: `ui/src/Trajectory.tsx:46`; the records are moved by `goBackTo` from
  `src/run.ts:273`.

## Saving a flow from the page deletes the comments in the file

- **Area**: devex
- **Severity**: low
- **What I did**: registered `cond-ruled-out.yaml` (`POST /api/flows`), then sent
  back exactly what `GET /api/flows/1` returned (`PUT /api/flows/1`), which is what
  the editor's Save does. Diffed the file against a copy.
- **What happened**: `{"problems":[],"saved":true}`, and the two comment lines at
  the top of the file are gone, along with every inline `{...}` form. The `when`
  itself survived the round trip unchanged.
- **What I expected**: the round trip not to throw away what a person wrote for
  other people. ADR 0010 accepts the reformatting; it does not mention comments.
- **Where**: `src/server.ts:241` writes `formatFlow(flow)` over the file.

## The message for a property with two types reads as one type

- **Area**: devex
- **Severity**: low
- **What I did**: `bad/operator-over-mixed-type.yaml` declares
  `mixed: { type: [string, number] }` and conditions on `{ mixed: { lt: 7 } }`.
- **What happened**: `step "page" runs when "sort" says "mixed" with "lt", and
  "mixed" holds a string,number. The operator "lt" tests a number.` — "a
  string,number" is neither the type nor English, and the refusal itself is
  arguable, since the value can well be a number at run time.
- **Where**: `src/flow.ts:1027-1029`.

## What held up

- `validate()` on the operators is the best part of this area: twelve deliberately
  wrong files, twelve messages that name the step, the key, the operator and the
  fix — including the trap ADR 0016 is written around
  (`{"equals":"high"} … Use one of: is, not, empty, lt, gt. Write { is: ... } to
  test the value itself.`).
- The editor draws the condition as rows with the operator list it takes from
  `GET /api/health`, offers only the steps the step needs and only the keys the
  named step returns, and refuses to save an empty condition — one click on
  "Runs only when a step it needs says so" turned the badge to `1 problem` with
  `step "notify" runs on an empty condition for "page", so it always runs`, and
  greyed Save out.
- The skip reason reaches four places for a daemon run: the `skip` event, the
  activity feed ("skipped, because it needs \"page\", which the run skipped"), the
  step panel, and `state.json`. The graph draws a skipped step with a broken
  outline, and the progress bar counts `1 done · 3 skipped`.
- Every operator did exactly what ADR 0016 says against the values it was written
  for: `is`/`not` deep-equal against strings, nulls and whole objects; `empty`
  over lists, strings and objects and over a key that is not there; `lt`/`gt`
  exclusive at the boundary and false against strings, booleans, lists and nulls.
- A condition that is only true after a cycle works: `cond-after-cycle` sends
  `tick` back to itself while `count` is under three, and the dependents are
  evaluated once, against the final value (`only_after` ran, `only_first` did not).
- A resume from a skipped step re-reads the condition rather than forcing the step.
- The join cost ADR 0014 admits to is exactly what happens, and it says so:
  `cond-join` skips `record` with `it needs "page", which the run skipped` while
  the other branch passed.

## Spend

$0.00. Every step in this batch is a `call` step; no agent step ran, and no
harness was invoked. 93 runs.
