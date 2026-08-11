## A step that fails inside the harness records no cost, so the budget under-counts the money

- **Area**: functional
- **Severity**: high
- **What I did**: `04-fail-cost.yaml` — `budget: 0.005`, one haiku agent step whose
  `returns` no value can meet (`word: { minLength: 10, maxLength: 3 }`), and
  `cycle: { to: one, when: failed, limit: 2, policy: accept }`. Ran
  `node /home/user/orchy/src/cli.ts run 04-fail-cost.yaml`.
- **What happened**: the step ran for 36 seconds and five API calls (the console shows
  six `StructuredOutput` attempts and two long refusals from the model), then:

  ```
  ✗ one
    step "one" ended with no value for its contract
  ↻ one goes back to one (1)
  — failed
    the flow "budget-failed-step" has a budget, and step "one" reported no cost. Orchy does not enforce a budget that it cannot measure. Use a harness that reports a cost, or take "budget" off the flow.
  ```

  The record in `state.history` holds `"status": "failed"` and **no `cost` key at all**;
  `trajectory.json` holds `"final_metrics": {"prompt_tokens": 0, "completion_tokens": 0,
  "cached_tokens": 0, "cost_usd": 0}`, and the index therefore reports the run as $0.
  The `claude` session file for that step
  (`~/.claude/projects/…/8e187391-….jsonl`) holds 5 distinct API messages with
  `output_tokens: 2222`, `cache_creation_input_tokens: 6625`,
  `cache_read_input_tokens: 21826` — roughly **$0.02 of haiku, four times the budget**,
  recorded as nothing.
- **What I expected**: ADR 0019 says "A step that broke its promise or its contract
  counts as well. It spent its tokens before Orchy read its value… The record of a
  failed step now keeps its cost." A step that spent money and failed should carry its
  cost, and the budget should stop on the money and not on a claim that no money is
  measurable.
- **Where**: `src/claude.ts:115` returns `cost` only on the success path, so any error the
  adapter throws loses `total_cost_usd`; `src/run.ts:845` then builds the failed record
  with no `cost`, and `src/run.ts:102` reads that absence as "the harness reports no
  cost". The advice in the message ("use a harness that reports a cost") is wrong: this
  harness reported one and Orchy dropped it.

## A budget never stops the first step, so a budget under one step is a decoration

- **Area**: functional
- **Severity**: high
- **What I did**: `09-budget-fraction.yaml` — `budget: 0.0001`, one haiku agent step with a
  one-line prompt. Ran it twice.
- **What happened**: both runs spent about a hundred times the budget and reported success.

  ```
  exit=0
  b3500eb3-… done   steps {"one": {"status": "done", "cost": 0.010222}}
  3f7690f6-… done   steps {"one": {"status": "done", "cost": 0.010272}}
  ```

  The run page shows a green `DONE`, "This run is done", and
  `cost: $0.0102/$0.0001` in the same grey as every other number — no warning, no colour,
  nothing that says the run went 102× past what the flow allowed
  (`hunt/batch-6/run-fraction.png`).
- **What I expected**: either the run refuses to start the step it cannot afford, or the
  run that blew its budget says so somewhere. A number a run passes by 100× without a
  word is not a budget.
- **Where**: `src/run.ts:395-398` — the check sits at the top of the wave loop, and the
  spend before the first wave is always 0, so the first wave always runs whatever the
  budget says. Combined with `src/flow.ts:570` (`budget` must be **above** zero, so
  `budget: 0` is refused outright), there is no way at all to write "this run may not
  spend": the smallest legal budget still buys one full wave.

## A budget with a cycle hides the real reason a run died

- **Area**: observability
- **Severity**: medium
- **What I did**: `04-D.yaml` — combination D: `model: no-such-model`, `budget: 0.005`, one
  agent step with `cycle: { to: one, when: failed, limit: 2, policy: accept }`.
- **What happened**:

  ```
  ▶ one
  ✗ one
  ↻ one goes back to one (1)
  — failed
    the flow "budget-cycle-D" has a budget, and step "one" reported no cost. Orchy does not enforce a budget that it cannot measure. Use a harness that reports a cost, or take "budget" off the flow.
  ```

  `state.steps` is `{}` and `state.error` holds only the budget message. The actual
  fault — `could not run the claude command: There's an issue with the selected model
  (no-such-model)` — appears nowhere in the state; the same flow without the budget line
  fails with that message (I ran `02-D.yaml` to confirm the wording).
- **What I expected**: the run should die of the model it cannot use, not of a budget
  complaint about a step that never spent a token; and the advice to "use a harness that
  reports a cost" points at the wrong thing entirely.
- **Where**: `src/run.ts:100-105` — a failed attempt with no `cost` is indistinguishable
  from a harness that prices nothing, and the budget check runs before the run reports
  the failure that the cycle carried forward.

## Every token count Orchy reports is double what the harness reported, and cache writes vanish

- **Area**: observability
- **Severity**: medium
- **What I did**: ran `09-budget-fraction.yaml` and compared
  `.orchy/runs/b3500eb3-…/trajectory.json` with the `claude` session transcript it names
  (`~/.claude/projects/…/108e46fa-….jsonl`).
- **What happened**: the transcript holds **one** API response, written as two lines that
  each repeat the whole usage:

  ```
  msgid msg_011CdwivoPR9KZFUtkqJpBdC req_011Cdwivn blocks ['thinking']  usage {'input_tokens': 10, 'cache_creation_input_tokens': 4414, 'cache_read_input_tokens': 0, 'output_tokens': 147}
  msgid msg_011CdwivoPR9KZFUtkqJpBdC req_011Cdwivn blocks ['tool_use']  usage {'input_tokens': 10, 'cache_creation_input_tokens': 4414, 'cache_read_input_tokens': 0, 'output_tokens': 147}
  ```

  Orchy turns that into two agent turns and sums them:
  `final_metrics {'prompt_tokens': 20, 'completion_tokens': 294, 'cached_tokens': 0}`.
  The page and the runs list then say "314 tokens". The real call was 10 in / 147 out
  with 4414 cache-creation tokens, which Orchy never reads at all.
- **What I expected**: the tokens Orchy reports to match what the harness reported. ADR
  0019 says "the trajectory holds both numbers for a reader who wants them" — the dollars
  are right (they come from `total_cost_usd`), the tokens are exactly doubled and miss
  the cache writes that most of the bill sits in.
- **Where**: `src/claude.ts:285-291` — one usage block per assistant *line*, and Claude
  Code writes one line per content block of the same message; `cached_tokens` reads only
  `cache_read_input_tokens` and drops `cache_creation_input_tokens`.

## `orchy runs` never says what a run cost or why it failed, and a cycled run has no date at all

- **Area**: observability
- **Severity**: medium
- **What I did**: `node /home/user/orchy/src/cli.ts runs` after the batch.
- **What happened**:

  ```
  139e9cbe-…  failed   budget-crossed-first  2026-08-11T22:12:57.243Z
  …
  1c3b1152-…  failed   budget-cycle          
  a837c6cf-…  failed   budget-cycle-D        
  ```

  No cost column, no reason: six of these runs failed on the budget and one failed on a
  model name, and the table cannot tell them apart. Worse, the two runs whose only step a
  cycle moved into `history` show an **empty** start time and sink to the bottom of a
  list that claims to be newest first — the `budget-cycle` run started at 22:10, after
  the 22:08 run above it.
- **What I expected**: the money is the thing a budget makes a person care about, and the
  one place a person looks from a terminal does not hold it. The date should come from
  the history when `steps` is empty, as the daemon's own row builder already does.
- **Where**: `src/cli.ts:253-261` — the CLI has its own `rowOf` that reads only
  `state.steps` and passes no spend, while `src/store.ts:272-285` reads
  `state.history` for the times and takes the cost from the trajectory.

## A wave can pass the budget by the whole wave, and nothing warns before it does

- **Area**: ux
- **Severity**: low
- **What I did**: `05-budget-fanout.yaml` — `budget: 0.005`, a fanout of three haiku
  members and one step after them. Ran twice.
- **What happened**: all three members ran, and then

  ```
  the run reached the budget of the flow "budget-fanout": it spent $0.0308 of $0.005. It stops before the next step.
  ```

  (the second run: `$0.0314 of $0.005`). Six times the budget, in one wave. The same
  shape with two plain steps in one wave (`07-budget-mid-wave.yaml`) spent `$0.0203 of
  $0.005`. The default `parallel: 8` makes eight the worst case.
- **What I expected**: this is what ADR 0019 says happens ("A wave of eight steps can
  cross the budget by a whole wave"), so it is the design and not a fault — but nothing in
  the editor, `validate()`, or the run page warns that a budget over a wide fanout is a
  soft number, and the editor's own hint ("A run stops before the step that would pass
  it") reads as if it stops that step.
- **Where**: `src/run.ts:395-398`, `ui/src/Editor.tsx:465`.

## Small things

- **A run page says "took 0s" and "0/1 steps done" for a step that ran for nine seconds**
  (ui, low). `#/runs/1c3b1152-…` for `04-budget-cycle.yaml`: the cycle moved the only
  record into `history`, so the page reports `steps done: 0/1`, `took: 0s`, and still
  `cost: $0.0103/$0.005`. Same root as the blank date above.
- **An unrunnable flow file exits 1, not 2** (devex, low). `orchy run 01-budget-zero.yaml`
  prints `the flow is not valid: - the flow has a budget of 0. A budget is a number of
  dollars above zero.` and exits 1, which `--help` defines as "a run fails". No run was
  ever created, so this is the "the command itself is wrong" case (2). A script cannot
  tell "your flow is broken" from "your run failed".
- **The flows page rounds the money to cents** (ui, low). `ui/src/Flows.tsx:414` prints
  `$0.01` via `toFixed(2)`, so every run under half a cent reads `$0.00` — while the same
  number on the run page reads `$0.0102`.
- **A registered flow shows the wrong harness** (ui, low, seen in passing). `POST
  /api/flows {"path":"02-budget-crossed-first.yaml"}` stored `"harness": "pi"` for a file
  whose first lines are `harness: claude`, and the flows page prints `pi` under the flow.
  The run I started from that row nonetheless ran on claude and cost $0.01003, so the
  label is decoration.

## What held up

- The refusal names the money, both numbers, and what it does next: `the run reached the
  budget of the flow "budget-crossed-first": it spent $0.0101 of $0.005. It stops before
  the next step.` — in `state.error`, on stderr, and on the run page.
- The run page shows spend against budget (`cost $0.0101/$0.005`) and the failure banner
  carries the same sentence.
- `resume` cannot buy more: `orchy resume <id>` on a budget-failed run re-fails instantly
  with the same message and spends nothing, and `--from one` cannot re-run the paid step
  either.
- A sub-flow with its own budget is refused before anything runs: `the flow at
  "./10-inner-budget.yaml" has a budget, and step "sub" holds it.`
- A paid step inside a sub-flow counts against the outer budget (`sub/inside` cost
  $0.0103, run stopped before `after`).
- `validate()` refuses `budget: 0`, `budget: -1`, `budget: "0.50"`, and a budget on a flow
  where nothing spends — all before a token is spent.
- A cycle stops at the budget rather than at its limit, and the thrown-away attempt in
  `state.history` keeps its cost and counts.
- The daemon enforces exactly what the CLI does (`POST /api/flows/1/runs` → failed, `it
  spent $0.01 of $0.005`), and the cost the index reports for every run equals the sum of
  the step costs in `state.json`, which equals `final_metrics.cost_usd` in the trajectory.

## Money

27 things I ran; 18 of them reached a run state on disk (the rest were refused by
`validate()` or by `expandFlows` before a run existed). `$0.2344` summed from the step
records — `state.steps` plus `state.history` — of all 18, one of which I stopped myself
at cost 0. Add roughly `$0.02` that Orchy failed to record for the
contract-failure attempt above, and `$0.0567` for one direct `claude -p --model haiku
--output-format json` call I made to compare what the harness reports with what Orchy
reports. **Total spent: about $0.31.**
