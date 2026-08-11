## A cycle with no `limit` runs forever, and the process cannot be stopped

- **Area**: functional
- **Severity**: high
- **What I did**: `validate()` never checks that a cycle holds a `limit`. I wrote a
  code-and-review flow with `cycle: { to: draft, when: { approved: false } }` and ran it:
  `node /home/user/orchy/src/cli.ts run t12/nolimit.yaml`. I did the same for a retry:
  `cycle: { to: a, when: failed, policy: accept }`, and for `limit: "abc"`.
- **What happened**: all three run without end. The flow validates with no problem, the
  step count kept climbing, and nothing stopped it:

  ```
  ↻ review goes back to draft (1)
  ↻ review goes back to draft (2)
  ... (no end)
  draft ran 2884 times in 12 seconds
  retry attempt 9125 for the `when: failed` cycle
  ```

  `state.json` grows with every attempt, and the run rewrites the whole file after each
  step: 1.7 MB after 12 seconds, 5.7 MB after 90.

  The process also does not answer `SIGTERM`. `timeout 12 node .../cli.ts run …` left the
  node process alive, and `kill -TERM <pid>` did nothing:

  ```
  972 SURVIVED SIGTERM
  ```

  A run of the same shape with an async step does answer `SIGTERM` and writes `stopped`, so
  the cause is the tight cycle: a wave of synchronous `call` steps never returns to the
  event loop, so the handler in `watchForSignals` never fires. `orchy daemon` stops a child
  the same way, so a runaway run cannot be stopped from the page either. Only `kill -9` ends it.
- **What I expected**: `validate()` refuses a cycle with no `limit`, because invariant 4 says
  "A cycle stops at its declared limit. A flow cannot run forever."
- **Where**: `src/flow.ts:847` checks `cycle.limit < 1`, which `undefined` and `"abc"` both
  pass; `src/run.ts:711` then reads `count > cycle.limit`, which is always false.
  `shapeProblems` (`src/flow.ts:559`) refuses an unknown field on a step, inside `changes`,
  and inside a computed `fanout`, but never looks inside `cycle`.

## A failed agent step throws its cost away, and that poisons the budget

- **Area**: observability
- **Severity**: high
- **What I did**: ran a `claude`/`haiku` agent step whose contract the harness could not
  satisfy (`minProperties: 3` over one declared property), in a flow with `budget: 5` and
  `cycle: { to: a, when: failed, limit: 1, policy: escalate }`.
- **What happened**: the step failed and its record holds no cost:

  ```
  ✗ a
    step "a" ended with no value for its contract
  ↻ a goes back to a (1)
  — failed
    the flow "budget-poison" has a budget, and step "a" reported no cost. Orchy does not
    enforce a budget that it cannot measure. Use a harness that reports a cost, or take
    "budget" off the flow.
  ```

  The money was really spent. I ran the same `claude` command by hand with the same schema:

  ```
  {'subtype': 'success', 'is_error': False, 'total_cost_usd': 0.014737299999999998, 'num_turns': 3}
  structured_output present: False
  ```

  So the harness answered `success` with a cost of $0.0147 and no value, and the adapter
  threw before it could pass the cost on. Three things follow:
  1. The run's own record of what it cost is a lie. `jq .final_metrics trajectory.json`,
     the command the README gives, answers
     `{'prompt_tokens': 0, 'completion_tokens': 0, 'cached_tokens': 0, 'cost_usd': 0, 'total_steps': 1}`
     for a run that spent about $0.015. There is no child trajectory either, although the
     session transcript is on disk.
  2. The declared retry never got its second attempt. The budget check at the top of the
     next wave killed the run after `↻ a goes back to a (1)`.
  3. The message names the wrong fault and gives wrong advice: the harness does report a
     cost, and taking `budget` off the flow would let the retry run.
- **What I expected**: the cost of a failed attempt is recorded, as ADR 0019 and the README
  say ("Every attempt counts, including the ones a cycle threw away").
- **Where**: `src/claude.ts:111` throws before it can return `total_cost_usd`;
  `src/run.ts:848` builds the failed record with no `cost`.

## A workspace fault leaves the run at `running` for ever, with no reason in the record

- **Area**: functional
- **Severity**: high
- **What I did**: `workspace: { kind: git, path: /tmp/orchy-norepo }`, where that directory
  exists and is not a repository. Also a path that does not exist at all.
- **What happened**: the command ends with 1 and one bare line, and the run record keeps
  nothing:

  ```
  ◆ b366e837-e85e-4962-b859-23d4b605e125
  ▶ a
  the workspace at "/tmp/orchy-norepo" is not a git repository
  ```

  There is no `✗ a`, no `— failed`, and no `run_end` event. On disk:

  ```
  status running pid 18998 error None
  steps {}
  ```

  The directory holds `state.json` and no `trajectory.json`. `orchy runs` then lists four
  such runs as live:

  ```
  53345cf1-…  running  fresh
  b366e837-…  running  fresh
  c7c2244c-…  running  fresh
  f5ccb93f-…  running  fresh
  ```

  `orchy resume <id>` refuses them: *"says it runs, and the process that drove it has gone.
  Name the step to run again, with --from."* Through the daemon the index says `stopped`,
  which `CONTEXT.md` defines as "what a person or a dead daemon leaves; a run never writes
  it itself". The reason lives only on the queue ticket. So a run that failed reads
  `running` on disk, `stopped` in the index, and `failed` nowhere.
- **What I expected**: the step fails, the run fails, and the reason is in the record.
- **Where**: `src/run.ts:816` — `take(state.flow.workspace, cwd)` sits outside the
  `try` of `runStep`, so a workspace fault escapes `pool`, `execute`, and `run`, past
  `fail()` and `close()`.

## The `returns` of a flow is dropped when that flow is used as a step

- **Area**: functional
- **Severity**: high
- **What I did**: wrote `inner.yaml` with
  `returns: { type: object, required: [score, verdict], … }`, whose last step returns only
  `score`. Ran it alone, then ran an outer flow that holds it as `kind: flow`.
- **What happened**: alone it fails, as a contract should:

  ```
  "error": "the value of \"score\" breaks what the flow \"inner\" returns at \"/\":
            must have required property 'verdict'"
  ```

  As a step it passes with no word:

  ```
  ▶ audit/fetch
  ✓ audit/fetch
  ▶ audit/score
  ✓ audit/score
  — done
  ```

  A `kind: flow` step cannot hold a `returns` of its own (`HOLDS.flow` allows only `needs`,
  `with`, and `cycle`), so the inner `returns` is the only contract on the whole sub-flow,
  and expansion throws it away. `expandFlows` refuses an inner `budget`, `parallel`, and a
  different `workspace`, and carries `changes`, `harness`, `model`, and `takes` across. Only
  `returns` goes silently.
- **What I expected**: either the inner contract is checked, or expansion refuses the flow
  and says why — AGENTS.md: "A field that Orchy cannot act on must fail, and must say why."
- **Where**: `src/flow.ts:429` onward, `expandFlows`.

## `cycle.policy` accepts any word, and every wrong one silently means `accept`

- **Area**: functional
- **Severity**: medium
- **What I did**: ran a cycle at its limit with `policy: banana`, `policy: Escalate`,
  `policy: 7`, and with no `policy` at all. I also put an unknown field inside the cycle
  (`retries: 5`) and posted each flow to `POST /api/validate`.
- **What happened**: every one validates clean —

  ```
  {"problems":[],"warnings":[]}  <= cycle with a policy that is not a policy
  {"problems":[],"warnings":[]}  <= cycle with no policy
  {"problems":[],"warnings":[]}  <= unknown field inside cycle
  ```

  and every one behaves as `accept`:

  ```
  status done review disagreement accepted
  ```

  A person who writes `Escalate` with a capital letter asks for a human and gets none.
- **What I expected**: `validate()` refuses a policy that is not `escalate` or `accept`, and
  an unknown field inside a cycle, the way it refuses one on a step.
- **Where**: `src/flow.ts:77` declares the type; nothing checks the value.
  `src/run.ts:718` treats everything that is not `"escalate"` as accept.

## A misspelled harness name turns off the tool check and the model check

- **Area**: devex
- **Severity**: medium
- **What I did**: posted the same flow to `POST /api/validate` three times, changing only
  the harness name. The step asks for `tools: [web]` and `model: ollama/glm`.
- **What happened**:

  ```
  === harness: pi ===
  {"problems":["step \"a\" asks for the tool \"web\", and the harness \"pi\" has none"]}
  === harness: piii ===
  {"problems":[]}
  === harness: claude ===
  {"problems":["step \"a\" names the model \"ollama/glm\", which the harness \"claude\" cannot read. …"]}
  ```

  A name that is not an adapter makes `validate()` skip both checks and report a clean flow.
  The run then throws at the first step: `step "seven" names the harness "gemini", which this
  run does not have`. The editor would save such a flow without a word.
- **What I expected**: `validate()` refuses a harness name that no adapter answers to, so the
  two checks the README advertises are never skipped in silence.
- **Where**: `src/flow.ts:877` and `src/flow.ts:908` — both fall back to `undefined` when the
  name is not in `ADAPTERS`, and then check nothing.

## A `call` module cannot read its inputs when its flow becomes a step

- **Area**: functional
- **Severity**: medium
- **What I did**: `inner.yaml` holds `fetch` and then `score`, and `score.ts` reads
  `inputs.fetch.size`. I ran the flow alone, then as `kind: flow` under an outer flow.
- **What happened**: alone the value is right; as a step it is quietly zero.

  ```
  standalone value {'score': 30, 'of': 'cli'}
  nested     value {'score': 0,  'of': 'cli'}
  ```

  Expansion renames every inner step to `audit/fetch`, `audit/score`, and `inputs` is keyed
  by step id, so `inputs.fetch` is `undefined`. The contract still passed, because `0` is a
  number, so the run reported `done`. Nothing warns that a component written for a flow
  breaks when the flow is reused.
- **What I expected**: either the keys keep the ids the module was written against, or the
  documents say plainly that a module must not read a need by name.
- **Where**: `src/run.ts:808` builds `inputs` from `step.needs`, after `expandFlows`
  (`src/flow.ts:429` onward) has renamed them.

## A cycle that reaches its limit and accepts the disagreement says nothing

- **Area**: observability
- **Severity**: medium
- **What I did**: ran a review cycle with `limit: 2, policy: accept` where the reviewer never
  approves, and read every event with `--events`.
- **What happened**: the run ends `done` with exit 0, and no event mentions the limit or the
  policy:

  ```
  {'type': 'cycle', 'step': 'review', 'to': 'draft', 'count': 2}
  {'type': 'step_start', 'step': 'draft'} … {'type': 'step_end', 'step': 'review', 'status': 'done'}
  {'type': 'step_start', 'step': 'publish'} …
  {'type': 'run_end', 'status': 'done'}
  ```

  `disagreement: "accepted"` is written to `state.json` only. So the console, the event
  stream, and anything that reads events (the daemon and the page) show a flow that went
  ahead over a reviewer who said `approved: false`, and never say so. `CONTEXT.md` calls a
  policy "the choice that Orchy makes when a cycle reaches its limit"; the run never reports
  making it.
- **What I expected**: an event, and a word in the run report, when a policy resolves a
  disagreement.
- **Where**: `src/run.ts:718`.

## In a parallel wave, every step is recorded as having made another step's change

- **Area**: observability
- **Severity**: medium
- **What I did**: a git workspace, `parallel: 4`, three `call` steps that all promise
  `changes: nothing`, one of which writes `docs/oops.md` while the other two are still in
  their own window.
- **What happened**: all three fail, and each record says it added the file:

  ```
  ✗ reader1
    step "reader1" promises to change nothing, but it added docs/oops.md
  ✗ reader2
    step "reader2" promises to change nothing, but it added docs/oops.md
  ✗ writer
    step "writer" promises to change nothing, but it added docs/oops.md
  ```

  `readerN.changed` holds `[{path: "docs/oops.md", how: "added"}]`, which is not what those
  steps did. The comment in `run.ts` accepts a wide failure ("names too many steps and never
  too few"), but invariant 5 also sells the record: "Orchy records what each step changed in
  the workspace." For two of the three, that record is wrong.
- **What I expected**: the record of a step names what that step changed, or says that a
  concurrent wave cannot tell them apart.
- **Where**: `src/run.ts:448` — a wave where every step promises `nothing` runs at full
  width, and each step takes its own before/after snapshot of the whole workspace.

## `orchy runs` shows a dead run as `running`

- **Area**: observability
- **Severity**: medium
- **What I did**: started a run with a long step, `kill -9`ed the process I started, then ran
  `orchy runs`.
- **What happened**:

  ```
  ab4cc51f-0b1d-4cb6-b36b-d8569fe8d01b  running  long  2026-08-11T22:12:05.353Z
  ```

  The run is dead and stays `running` for ever. `resume` knows better and says so —
  *"says it runs, and the process that drove it has gone"* — because it calls `alive(pid)`.
  The list never calls it, so the one place a person looks first is the one place that
  cannot tell a live run from a dead one.
- **What I expected**: `orchy runs` uses the pid it already stores, as `resume` does.
- **Where**: `rowOf` in `src/cli.ts`, and `list` in `src/run.ts`. `alive` is at `src/run.ts:301`.

## A run whose last step never ran still ends `done`, with no value and exit 0

- **Area**: ux
- **Severity**: medium
- **What I did**: a flow that branches on a condition and joins again — `wake` when severity
  is high, `label` otherwise, and `report` needing both. Also a fanout over an empty
  computed list, with a step after it.
- **What happened**: the join is skipped, because a step that needs a skipped step is
  skipped, and the run reports success:

  ```
  ⊘ report does not run
    it needs "wake", which the run skipped
  — done
  ```

  ```
  status done
  'value' in state: False
  {'classify': 'done', 'wake': 'skipped', 'label': 'done', 'report': 'skipped'}
  ```

  Exit code 0. The empty-fanout case is the same: `gather` runs, `each` and `after` are
  skipped, and the run says `done` with no value. A flow that declares `returns` is caught
  (*"the flow \"cond\" returns the value of \"report\", and the run has no value for it"*),
  so the hole is only for a flow that declares none — which is most of them, and which CI
  reads as a pass.
- **What I expected**: a run that produced nothing does not report the same word as a run
  that produced a result.

## A run that fails on its first step sorts to the bottom of `orchy runs`, with no date

- **Area**: observability
- **Severity**: low
- **What I did**: read `orchy runs` after the budget failure above, where the only step
  record had gone to `history`.
- **What happened**: the newest run is the last row, with an empty start time:

  ```
  1:ccf37e73-…  done     budget-poison  2026-08-11T22:25:34.604Z
  …
  45:d72cbabc-…  failed   budget-poison
  ```

  `startOf` reads `state.steps` only, and a run whose records all moved to `history` has
  `steps: {}`. The list is sorted newest first, so this run sorts last of 46.
- **What I expected**: the run I just started is at the top, with the time it started.
- **Where**: `src/run.ts:333`, `startOf`.

## The API takes a gate answer that breaks the contract, and answers with a ticket

- **Area**: ux
- **Severity**: low
- **What I did**: `POST /api/runs/<id>/resume` with `{"value":{"approved":"yes"}}`, where the
  gate returns `{ approved: boolean }`. The same value through the CLI is refused at once
  with exit 1.
- **What happened**: the API answers 200 with a ticket, as if it had been accepted:

  ```
  {"ticket":3,"flowName":"gated","runId":"caba5053-…","queuedAt":"…"}
  ```

  The run stays `waiting` and the reason turns up only on the queue entry, where it stays
  for ever — the run went on to finish, and ticket 3 is still pending:

  ```
  [{"ticket":3, "runId":"caba5053-…",
    "error":"the value of \"ask\" breaks the contract at \"/approved\": must be boolean"}]
  ```

  Keeping the ticket is deliberate (`src/daemon.ts:103`), but nothing clears it and nothing
  ties it to the run in the run's own record, so the queue collects one dead entry for every
  wrong answer a person types.
- **What I expected**: the same door answers the same way as the CLI, or the run's record
  keeps the refusal.

## `takes` on a step does not read the values of the steps it needs

- **Area**: devex
- **Severity**: low
- **What I did**: step `b` needs `a`, which returns `{ severity }`. I wrote
  `takes: { required: [severity] }` on `b`.
- **What happened**:

  ```
  the flow is not valid:
  - step "b" takes "severity", and nothing supplies it. Add "severity" to "takes" on the
    flow, or to "with" on the step.
  ```

  `takes` reads only what the run supplies and what the step holds in `with`. The README says
  "a step declares `takes`, and the values that reach it must match that schema as well", and
  the value of `a` does reach `b` — as an argument to the module, and in the prompt block
  "The values of the steps before this one". So the one thing a step most wants to declare
  about what reaches it is the one thing `takes` cannot say.
- **What I expected**: the words to say which values `takes` covers, in the README and in
  `CONTEXT.md`.
- **Where**: `takenProblem` in `src/run.ts:51`, `takenProblems` in `src/flow.ts`.

## A workspace holds any extra field it likes

- **Area**: devex
- **Severity**: low
- **What I did**: `POST /api/validate` with
  `workspace: { kind: none, path: "nowhere", junk: 1 }`.
- **What happened**: `{"problems":[],"warnings":[]}`. A person who moves a flow from `git` to
  `none` and leaves `path` behind hears nothing, and neither does one who misspells a field.
  `changesProblems` and `computedShape` both refuse an unknown field; `workspaceProblems`
  does not.
- **What I expected**: the same rule as everywhere else in `shapeProblems`.
- **Where**: `workspaceProblems`, `src/flow.ts`.

## What held up

- A wave runs every ready step at once, and `parallel: 2` really paces it: two starts, two
  ends, two more starts.
- A wave that holds a promise and a writer runs one step at a time, and it overrides
  `parallel: 4` to do it.
- A promise is enforced exactly as written: `nothing`, `{ paths }`, and `{ except }` all fail
  with the kind of change and the path — *"promises to change only docs, but it added
  notes.md"*. A flow-level promise reaches a step that declares none.
- A fanout over a computed list expands right, and every bad list has its own sentence: an
  empty list skips the step and everything after it, an item with no `name`, two items with
  one name, and a value that is not a list.
- A member that fails retries only itself, hears the error of its last attempt, and the
  member that passed keeps its work and does not run again.
- A cycle to an earlier step clears only the target and what needs it: the branch it does not
  touch ran once, not three times.
- `escalate` at the limit stops the run with a readable question and exit 3, and the answer a
  person gives is checked against the contract of the step.
- A condition skips a step, says why, and cascades to every step that needs it.
- The budget stops the run before the next step, with the numbers:
  *"it spent $0.0154 of $0.005. It stops before the next step."*
- A `claude`/`haiku` agent step honoured its contract, its cost was recorded ($0.0101), and
  with `tools: [read]` it read the file, reported `wrote: false`, and wrote no file.
- `orchy resume <id>` after a failure goes back to the failed step and keeps the work that
  passed; `--from <step>` runs that step and everything after it, and every dropped attempt
  goes to `history`.
- A flow that returns the value of its last step returns it, and the flow-level `returns` is
  checked even when the last step came out of a sub-flow.
- A malformed schema is caught before the run, and the message names the step and quotes Ajv.
- `--with` refuses a missing value, a wrong type, and a name the flow does not take.
- The `pi` harness is not installed here, and the step fails with *"pi does not know the model
  ollama/glm-5.2"* — no hang, no silence.
