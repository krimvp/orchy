## An answer the contract refuses returns 200, and the person who gave it is told nothing

- **Area**: functional
- **Severity**: high
- **What I did**: Started `g04-contract` from the daemon (`POST /api/flows/4/runs`),
  opened `#/runs/8dc70d27-547f-4daa-be60-5e9bd968e708` in Chromium, filled the gate form
  built from the contract (`reviewer: ana`, `score: 99`, `passes` ticked,
  `findings: one, two`) and clicked **Answer and continue**. The contract says
  `score: { type: number, minimum: 0, maximum: 10 }`. The same value at the command
  line: `orchy resume <id> '{"reviewer":"ana","score":99,"passes":true,"findings":[]}'`.
- **What happened**: The POST answered `200` with a queue ticket:

  ```
  {"status":200,"body":{"ticket":7,"flowName":"g04-contract","runId":"8dc70d27-…"}}
  ```

  The run page re-rendered the same gate form, with my values still in it, no message,
  no new line in `activity`, status still `waiting`. Nothing on that page ever says the
  answer was refused. The reason only exists on another page, `#/runs`, as a queue row
  labelled **did not start**:

  ```
  did not start   g04-contract
  the value of "verdict" breaks the contract at "/score": must be <= 10
  ```

  The command line refuses the same value at once and exits 1:

  ```
  the value of "verdict" breaks the contract at "/score": must be <= 10
  ```

  Reproduced three times, with three shapes: `score: 99`, a missing required `count`
  (`g07-refused`), and `{}` against a string contract (`g12`, below). Every one: HTTP
  200, run still waiting, run page silent, error only in the queue list.
- **What I expected**: The API refuses a value that breaks the gate contract in the
  response to the POST, the way the command line does, and the page shows the reason
  under the form the person just used.
- **Where**: `src/server.ts:346` (`POST /api/runs/:id/resume` returns `daemon.resume(…)`,
  a ticket), `src/daemon.ts:246` (the check "refuses only what a row already refutes" —
  the contract is checked later, in the child, at `src/run.ts:247`),
  `ui/src/Run.tsx:85` (`.then(() => (setFault(undefined), again()))` — a 200 clears the
  fault).

## `resume` cannot name the gate it answers, so an answer lands on whatever question is waiting now

- **Area**: functional
- **Severity**: high
- **What I did**: `g03-two-gates` holds two independent gates with the same contract
  (`{go: boolean}`). Two people share a run:

  ```bash
  node src/cli.ts run g03-two-gates.yaml          # waits at first-gate
  # alice reads: waitingFor: first-gate | question: Question one — do you approve the plan?
  node src/cli.ts resume $R '{"go":true}'         # bob answers question one
  node src/cli.ts resume $R '{"go":false}'        # alice sends her NO to question one
  ```
- **What happened**: Alice's `no` was recorded as the answer to **question two**, and the
  run went on to `done` without a word:

  ```
  {"first-gate": {"go": true}, "second-gate": {"go": false}, "after": {"ok": true, "seen": 2}}
  ```

  Neither `orchy resume <id> <json>` nor `POST /api/runs/:id/resume` takes the id of the
  step being answered; the value is applied to whatever `state.waitingFor` says at the
  moment the resume runs. The gate that was approved (the plan) and the gate that was
  rejected (the budget) are the exact reverse of what the two people said.
- **What I expected**: An answer names the question it answers, and an answer for a gate
  the run has already passed is refused rather than applied to the next one.
- **Where**: `src/run.ts:238-252` — `resume()` reads `state.waitingFor` and never
  compares it with anything the caller supplied.

## A gate question keeps its `{{ braces }}`, so two runs of one flow ask the same unfilled question

- **Area**: ux
- **Severity**: high
- **What I did**: `g09-gate-takes` takes `{ticket, owner}` and its gate asks
  `Ticket {{ ticket }} belongs to {{ owner }}. Do you approve it?`

  ```bash
  node src/cli.ts run g09-gate-takes.yaml --with '{"ticket":412,"owner":"ana"}'
  node src/cli.ts run g09-gate-takes.yaml --with '{"ticket":77,"owner":"bo"}'
  ```
- **What happened**: Both runs, and the page, print the template:

  ```
  ⏸ decide waits for a person
    Ticket {{ ticket }} belongs to {{ owner }}. Do you approve it?
  ```

  `validate()` says nothing, the run does not fail, and the two waiting runs are
  indistinguishable in `orchy runs`. A prompt in the same flow would have been filled in
  — `fill()` runs for `agent` prompts only. `docs/running.md` states the hazard for the
  other case ("A prompt that keeps the braces sends a model to do the wrong work, and
  says nothing about it"); here it is a person who is asked to approve `{{ ticket }}`.
  The `#/runs` list does print the run's values beside the question
  (`g09-gate-takes · ticket 412 · owner ana`), which is the only place the two runs can
  be told apart — the run page itself hides them behind a collapsed
  "The values this run takes".
- **What I expected**: Either the question is filled from the values of the run and the
  step, the way a prompt is, or `validate()` refuses a question holding `{{ }}`.
- **Where**: `src/run.ts:434` and `src/run.ts:590-603` — `stop()` stores
  `step.question` verbatim; `fill()` (`src/run.ts:946`) is only reached from the prompt
  path.

## A gate whose contract is not an object gets a form with no fields, and the button does nothing

- **Area**: ui
- **Severity**: medium
- **What I did**: `g12-string-gate` asks one word:
  `question: In one word, what should we do?` with `returns: { type: string }`.
  `validate()` accepts it and `orchy resume <id> '"ship"'` works. Started the same flow
  from the daemon and opened its run page.
- **What happened**: The hero shows the question and two buttons and **zero input
  controls** (`inputs in hero: 0`). Clicking **Answer and continue** posts `{}`, gets
  200, and the page does not change. The refusal appears only in the queue list:

  ```
  the value of "ask" breaks the contract at "/": must be string
  ```

  A person cannot answer this gate from the page at all unless they guess that
  "Write JSON" is the way in.
- **What I expected**: The form serves a contract that is not `type: object` (one field),
  or the page says it cannot build a form for this contract and offers the JSON box.
- **Where**: `ui/src/Run.tsx:699-701` — `Contract` reads `schema.properties` only, and
  `send()` posts the object it built.

## The page and the command line disagree about which runs exist, and a gate started at the command line cannot be answered on the page

- **Area**: observability
- **Severity**: medium
- **What I did**: Ran `orchy daemon --port 4112` in a directory, then started flows both
  ways in that same directory. Counted:

  ```
  on disk: 19    cli lists: 19    api lists: 5    waiting on disk: 8
  ```

  Then opened a run the command line had started
  (`533b7249-cc9b-4f2f-ad11-3838df9f6829`, `g06-cli-gate`, waiting) on the page and
  answered it.
- **What happened**: `GET /api/runs/:id` serves the run happily (it reads the state file),
  so the page draws the whole thing — "YOUR TURN", the question, a form built from the
  contract — and the answer is refused:

  ```
  this daemon holds no run 533b7249-cc9b-4f2f-ad11-3838df9f6829
  ```

  The same page reports `started: Invalid Date`, and its `activity` panel says
  "Nothing yet." The tab title counted `(5) Your turn` while eight runs in that directory
  were waiting for a person. The index is built once, at `daemon()` (`store.index(runs)`),
  and never catches up while the daemon lives.
- **What I expected**: A run in the daemon's own root either appears in its list and can
  be answered, or the run page says plainly that this daemon does not hold it instead of
  offering a form.
- **Where**: `src/daemon.ts:79` (`store.index(runs)` runs once at start),
  `src/daemon.ts:252` (`resume` refuses on a missing row), `src/server.ts:326`
  (`GET /api/runs/:id` reads the state from disk regardless).

## A run the daemon stopped still says "This run waits for you" and offers a form it will refuse

- **Area**: ui
- **Severity**: medium
- **What I did**: Started `g01-gate-first` from the daemon, stopped it while it waited
  (`POST /api/runs/:id/stop` → `{"stopped":true,"abandoned":true}`), then reopened the
  gate at the command line (`orchy resume <id>`, which correctly re-asks the question),
  then went back to the run page and answered.
- **What happened**: The state file says `waiting`, the daemon row still says `stopped`,
  and the page believes the state file:

  ```
  g01-gate-first   waiting          (page header)
  YOUR TURN / This run waits for you / May the work start? / go · needed
  the run ef7b3098-0202-4ecf-9131-4add28037d70 is stopped, so it takes no value
  ```

  So the page invites an answer and then refuses it, on the same screen. The run-list row
  and the run page show two different statuses for one run.
- **What I expected**: One status. The page reconciles `running` against the row already
  (`ui/src/Run.tsx:53`); `waiting` against a `stopped` row goes unchecked.
- **Where**: `ui/src/Run.tsx:53-55`, `src/daemon.ts:299-311` (`abandon` writes the row and
  the file, and a later CLI resume rewrites only the file).

## Malformed JSON in the gate's "Write JSON" box throws, and the person sees nothing at all

- **Area**: ui
- **Severity**: medium
- **What I did**: On a waiting `g04-contract` run, clicked **Write JSON**, typed
  `{"reviewer": "ana", oops}`, clicked **Answer and continue**.
- **What happened**: Nothing visible. The click handler threw, uncaught:

  ```
  pageerror: Expected double-quoted property name in JSON at position 20 (line 1 column 21)
  ```

  No message under the box, no message anywhere on the page; only the browser console
  holds it. The form and the run stay as they were.
- **What I expected**: "That is not JSON", under the box, the way the command line says
  `the answer holds {approved:true}, which is not JSON. Write the value as JSON.`
- **Where**: `ui/src/Run.tsx:713` — `if (raw) return onSend(JSON.parse(text));`, no `try`.

## Both documents say a waiting run ends with 0. It ends with 3

- **Area**: devex
- **Severity**: medium
- **What I did**: `node src/cli.ts run g01-gate-first.yaml; echo "EXIT=$?"`, and the same
  with `--events`.
- **What happened**:

  ```
  ⏸ approve waits for a person
  EXIT=3
  ```

  `README.md:182` and `docs/running.md:453` both say "It ends with 0 when the run finishes
  or waits, and 1 when the run fails." The CLI's own `--help` says the truth ("3 when a
  run waits for a person"). A CI job written from the README — the very use the README
  sells for gates, "So a flow works in CI" — fails on every gate.
- **What I expected**: The two documents and the command agree.
- **Where**: `src/cli.ts:39` and `src/cli.ts:172` against `README.md:182`,
  `docs/running.md:453`.

## `orchy runs` hides the runs that are waiting for you: last in the list, no date, no question

- **Area**: observability
- **Severity**: medium
- **What I did**: `node src/cli.ts runs`, in a directory holding finished runs and eight
  runs waiting at a gate.
- **What happened**: Every waiting run that had not run a step yet sorts to the bottom and
  carries an empty date:

  ```
  6a0656c4-…  done     g07-refused        2026-08-11T22:15:24.945Z
  …
  260b67bd-…  waiting  g04-contract       
  533b7249-…  waiting  g06-cli-gate       
  8c36ebbb-…  waiting  g01-gate-first     
  c68110f5-…  waiting  g09-gate-takes     
  da5c3bb1-…  waiting  g09-gate-takes     
  ```

  The rows say neither what step waits nor what it asks, so the two `g09-gate-takes` rows
  cannot be told apart. `--events` adds `waitingFor` but never the question. To learn what
  a gate is asking you must read `.orchy/runs/<id>/state.json` by hand. The page does all
  of this well — "your turn", the question, the run's values — which makes the command
  line the odd one out.
- **What I expected**: The runs that need a person read first, with what they ask.
- **Where**: `src/run.ts:333-337` (`startOf` returns `""` for a run with no step record,
  "or nothing to sort it last"), `src/cli.ts:253-267` (`rowOf`/`table` drop
  `waitingFor` and the question).

## A refused answer never says what shape it wanted

- **Area**: ux
- **Severity**: low
- **What I did**: Answered a gate wrongly six ways at the command line.
- **What happened**: The messages name the fault well but never the contract, and the
  waiting hint never showed it in the first place:

  ```
  answer with: orchy resume 8c36ebbb-… '<json value>'
  the value of "strict" breaks the contract at "/": must NOT have additional properties
  the value of "strict" breaks the contract at "/": must be object
  ```

  Which property was additional, and what the object should hold, is nowhere in the
  output. A person answering a gate a day later has `'<json value>'` and a run id.
- **What I expected**: The waiting hint prints the contract, or an example answer built
  from it — the page builds a whole form from the same schema.
- **Where**: `src/cli.ts:167-169`, `src/run.ts:247-249`.

## Two gates ready at once are asked one at a time, and nothing says another is coming

- **Area**: ux
- **Severity**: low
- **What I did**: `g03-two-gates` — two gates with no needs, both ready in the first wave.
- **What happened**: The run stops at `first-gate` only; the second question is invisible
  until the first is answered, and then the whole run must be resumed again:

  ```
  ⏸ first-gate waits for a person / Question one — do you approve the plan?
  (resume) ⏸ second-gate waits for a person / Question two — do you approve the budget?
  ```

  The state holds one `waitingFor` and one `question`, so the page and the list also show
  one of two. A person who answers and walks away believes the run has moved on.
- **What I expected**: A run that waits says how many answers it needs, even if it takes
  them one at a time.
- **Where**: `src/run.ts:431-435` — `ready[0]` becomes the one question.

## A refused answer leaves a "did not start" ticket that outlives the run

- **Area**: ui
- **Severity**: low
- **What I did**: Sent a contract-breaking answer to `g04-contract`, then answered the
  same gate correctly, and let the run finish.
- **What happened**: The queue still lists the refused answer, labelled as though a run
  never began:

  ```
  did not start   g04-contract
  the value of "verdict" breaks the contract at "/score": must be <= 10   (run 8dc70d27 — done)
  ```

  The run did start, and has since finished; what did not start was one answer. The row
  stays until someone clicks Dismiss.
- **What I expected**: The label names what was refused (an answer), and a ticket whose
  run has since moved on clears itself.
- **Where**: `ui/src/Runs.tsx:74-84`.

## What held up

- The contract check on an answer is exact and names the path: `must be <= 10`,
  `/findings/0: must be string`, `must have required property 'go'`, `must NOT have
  additional properties`, `must be object` for `true`, `"yes"` and `null`.
- `stop` a waiting run, then answer it: both surfaces refuse with the same sentence,
  `the run … is stopped, so it takes no value`; a plain `orchy resume <id>` re-asks the
  gate cleanly.
- Answering a run that has finished is refused identically at the command line and over
  the API: `the run … is done, so it takes no value`.
- Two answers posted at the same instant: one wins, the other gets
  `the run … is already on its way`. No double application, no lost run.
- `resume --from <gate>` re-asks the gate, and the earlier answer goes to `history`
  rather than disappearing.
- A gate with `when` behaves on both branches, and the skip says why:
  `⊘ escalate does not run / "sort" does not say {"severity":"high"}`.
- A flow that is one gate and nothing else runs, and the person's value becomes the value
  of the flow, checked against the flow's `returns`.
- A 500-character question survives whole through YAML, the event stream, the state file
  and the page.
- `validate()` on a gate missing its parts names each one and the kind:
  `step "ask" has no "question", and a gate step needs one`.
- The run page shows the value of the step the gate needs, under
  `What before answered`, so a person answers with the evidence in front of them; the
  `#/runs` list shows each waiting run's question and its values; the tab title reads
  `(5) Your turn — Orchy`.
- Gates cost nothing: 42 runs, `final_metrics.cost_usd` totals **$0.00**. No agent step
  was spent in this batch.
