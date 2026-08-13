# The sweep

Fifteen agents wrote flows and ran them against the product for an hour, on
2026-08-11, at commit `a49d039`. This is what they found.

Each agent worked in its own directory, on its own port, with the repository
read-only. Ten wrote a batch of ten flows apiece against one construct — shapes,
gates, fanout, conditions, cycles, budget, a flow inside a flow, the workspace,
contracts, and the harness matrix — and ran each flow at least twice. Five hunted
one area each across the whole product: the engine, harnesses and models, the
page, the developer's first hour, and what a run tells you while and after it
works.

- 401 flow files, and the modules and prompts they name.
- 545 runs on disk, and 568 lines in the batch logs, each naming the outcome the
  agent expected beforehand; **146 did not do what the agent expected**, and each
  of those carries a finding.
- 154 screenshots of the page, taken by a browser driven for the purpose.
- **167 findings: 38 high, 81 medium, 48 low.** By area: 43 observability,
  35 functional, 34 developer experience, 28 experience, 27 page.
- $2.06 of real model spend. The `claude` harness ran; `pi` was not installed,
  which is itself how several findings were found.

The raw reports of every agent are in [`sweep/`](./sweep), one file each, with the
commands and the output they quote.

## What is closed

Of the twenty-two root causes behind the high findings, **sixteen are closed,
three are half closed, and three are open**. About a dozen of the 129 medium and
low findings are closed with them; the rest stand. Every fix carries a test that
fails without it.

Closed, in the order they were closed:

- **Nothing hangs a machine.** A cycle with no limit is refused; a cycle states
  its whole shape. A flow that holds itself, or a chain that comes back to one it
  holds, is refused by the loader instead of loading until the heap goes.
- **Nothing loses money.** A step that fails inside the claude harness hands its
  cost and its transcript out on the error, so the record keeps both and the
  budget counts the attempt. An answer is counted once, by its id, and a cache
  write counts as the input token it was.
- **A promise is read the way git writes a path**, so `./src` and `src` are one
  path. A workspace Orchy cannot read stops the run before it starts, and a
  workspace that goes wrong later is a fault of the step that met it, not a run
  left at "running" for ever. `budget: 0` means what it says.
- **Every rule that looked enforced is enforced.** A harness that does not exist
  is a fault; the harness a run will really use reaches the tool check and the
  model check; `model: ""` names no model; Ajv is strict, so a contract with a
  typo in it is refused instead of checking nothing; a flow step is validated
  before expansion takes it away, and its own fields with it.
- **A run cannot answer itself.** A cycle back past a computed fanout makes the
  members again, over the list as it now stands. A member keeps the values its
  step holds. A gate fills the names in its question. A `required` boolean is a
  choice with nothing chosen, not a box that sends "no" for the person who
  pressed the only button. A contract holding an object, an enum, a list of
  objects, or a property with no type draws a control at last.
- **One answer to one question.** An answer names the gate it was written for,
  and the door refuses it when the run has moved on; the contract is read at that
  door and not later in a child, so a refusal is a 400 with a sentence, not a 200
  and a ticket on another page. A run a person stopped is not a run that did not
  start. A run whose process has gone says "stopped" to every reader.
- **The page shows what happened.** A run the command line started reaches the
  list. The flows page follows the stream. The harness in the file has the last
  word over the row. The focus ring and the labels carry AA.
- **`orchy check <flow file>`** reads a flow and says what is wrong with it,
  spending nothing. A file that will not load ends the command with 2, and the
  documented exit codes are the ones the command really uses.

Half closed, and honest about which half:

- **A budget never stops the first step.** `budget: 0` now stops the first step
  that would spend. A budget smaller than what the first step really costs still
  cannot, because no one knows that cost until it is spent, and a wave of paid
  steps still passes a budget together.
- **What a run has spent, while it runs.** The cost lands when the trajectory is
  written, so a run waiting at a gate now reports what it spent. Between two
  steps of a working run it is still `null`.
- **The reason a dead child leaves.** A run a person stopped no longer reads as
  one that never started. A child that dies some other way still hands its raw
  stderr over as the reason, so a Node warning can still stand in for one.

Open, and each wanting a decision rather than only work: a promise is judged on
the net diff, so a step that puts a file back passes; "I checked and nothing
moved" and "I never looked" are still one record; a run cannot hand its values
to a sub-flow; and a cycle to a fanout step still retargets the last member.

The medium and low findings that stand are led by the page (19), the engine
(11), the developer's first hour (11) and conditions (11): a wave is a barrier,
so a ready branch waits for an unrelated one; a flow with two ends returns one of
them by file order; `policy: accept` ends a run with no event of its own; a skip
never names the value it judged; and every command still pays 1.5 seconds to
import the Pi SDK.

## The faults that must close first

Twenty-two root causes carry the 38 high findings. Where more than one agent
found the same thing by a different road, the count says so. This part is the
record as the sweep wrote it, before any of it was fixed.

### A flow step is never checked at all — 4 agents

`loadFlow` calls `expandFlows` before `run()` calls `validate()`, so no step of
kind `flow` ever reaches the `HOLDS` table. `HOLDS.flow` is dead code. A flow step
carrying `tools`, `prompt`, `changes`, `fanout`, `model`, and `question` ran to
exit 0 without a word. `when` on a flow step is dropped and the inner steps run on
every value, though ADR 0014 says `validate()` refuses it there. The daemon's flow
page lists the problems and leaves the Run button live beside them; pressing it
finishes `done`. `docs/shape.md` Finding 1 reports this class closed; it is open
for a whole kind of step.

### A flow that names itself takes the daemon down with it

`expandFlows` recurses with no depth limit and no set of files already seen. From
the command line: 19 seconds of CPU, then `FATAL ERROR … heap out of memory`. Two
files that name each other do the same. Inside the daemon it is worse — the loader
runs in the daemon's own process (`src/server.ts:601`), so `/api/health` answers
`000` while it spins, RSS climbs 161 MB → 501 MB, and then the daemon dies, taking
its queue and every run it was supervising. No run is ever recorded.

### A cycle with no `limit` runs for ever, and cannot be stopped

`validate()` reads `cycle.limit < 1`, which `undefined` passes. The run then reads
`count > undefined`, which is never true. 2884 cycles in 12 seconds, a 5.7 MB
`state.json`, and `SIGTERM` ignored: a tight wave of synchronous `call` steps never
returns to the event loop, so the signal handler never runs. Only `kill -9` ends
it. Invariant 4 says a flow cannot run for ever. `cycle` is the one composite with
no shape check, which is also why `policy: banana` passes in silence and every
wrong policy quietly means `accept`.

### A cycle or a resume past a computed fanout freezes the members — 2 agents

`spread()` (`src/run.ts:683`) replaces the fanout step in `state.flow` with its
members, so the step is gone and can never expand again, while `goBackTo` only
clears records. A list that grew from two names to four was judged twice on the
first two; the new names were never judged and the run ended `done`, exit 0. With
a fixed list whose payload changed, the planner reached round 3 while both members
still reported round 1 — and were paid for twice on stale values. This is the
silent wrong list that ADR 0017 exists to remove. Reproduced three times of three,
in-run and through `resume --from`.

### A cycle to a fanout step retargets the last member only

`to: work` became `check→work/three`. Two of three members never ran again.
`validate()` says nothing; only ADR 0021 mentions the rewrite.

### A computed fanout throws away the values the step holds

The member's `with` replaces the step's `with` instead of merging
(`src/flow.ts:371`), so `with: { tag: … }` on a fanout step never reaches its
members. With `takes` declared it becomes a mid-run failure whose advice cannot be
followed — "Add it to `with` on the step", when the step already has it — and
`validate()` returns clean. The file-written fanout catches the same mistake
before the run and words it correctly, so the two paths openly disagree.

### A step that fails inside the harness loses its cost and its trajectory — 5 agents

`src/claude.ts:110` throws before `:115` returns the cost, and nothing carries the
session id out. Measured: a step that ran 13 turns and spent $0.053 recorded as no
cost at all; another burned 39 seconds over 6 API responses and left one sentence.
The `claude` command had answered `success` with `total_cost_usd: 0.0147` — proved
by running the command by hand. Three consequences follow: the run reads `$0` and
`0 tokens` everywhere; the model's own diagnosis of the fault ("contradictory
constraints: must be >= 100, must be <= 1") survives only in
`~/.claude/projects/…jsonl`; and the next budget check fails the whole run with
*"step 'a' reported no cost… use a harness that reports a cost"*, which blames a
harness that did report one and kills the step's own declared retry. Pi attaches
its trajectory on failure. Claude does not.

### The token counts are fabricated

The Claude CLI writes one API response as several transcript lines, each carrying
the same `usage`, and `src/claude.ts:270-280` sums every line. Measured on one
step: real usage 9 in / 143 out / 5115 cache-write, reported 27 / 429 / 0 —
exactly three times, with the largest class dropped. Another agent measured
exactly two times on a different shape. The multiplier is the number of lines the
response happened to take. Dollars are right, because they come from the CLI.
Tokens are not.

### What a run has spent is unobservable while it runs

`trajectory.json` is written once, in `close()`, and `metricsAt` reads only that
file. So `GET /api/runs` says `cost: null` for a run's whole life, `step_end`
carries no cost, and a run that is stopped never reports a cost at all — while
`state.json` has held it per step the whole time. The page shows `cost —` for a
run that had spent $0.0116.

### A missing or misspelled harness turns off the tool check and the model check — 3 agents

`validate()` reads the harness from the flow. When it comes from `--harness` or
from the daemon's stored flow row — the path the README documents — no harness is
in hand, so neither check runs (`src/flow.ts:877,908`). `tools: [web]` with
`model: haiku` validates clean and then dies at run time with `pi has no tool for
"web"`, naming no step. A two-step flow spent $0.0125 on step one and died on step
two for a model name that `validate()` would have caught for free. A *typo* is
worse than an omission: `harness: clade` with `tools: [web]` and
`model: openai/gpt-5` produces no problem for any of the three.

### A workspace fault escapes every handler — 2 agents

`take()` sits outside the `try` in `runStep` (`src/run.ts:816`), so a `git`
workspace that is not a repository skips `fail()` and `close()`: no `✗`, no
`step_end`, no `run_end`, no trajectory, and `state.json` left at
`status: "running"` with a live pid. Runs sit in `orchy runs` as live for ever.
Through the daemon the index later files them as `stopped` — the one status
`CONTEXT.md` says a run never writes for itself, and the same word a person's own
`Stop` leaves. The run failed, and no status anywhere says so.

### `changes: { except: ["./src"] }` allows every write to `src`

`under()` is a raw prefix test, so `./src` matches nothing. `validate()` refuses
`src/**` but accepts `./src` and the plain typo `srcc`. The run reports `done` and
records `added src/sneaky.ts` in the same step: the verdict contradicts its own
record. ADR 0013 rates this the most expensive kind of fault in the product.

### A promise is judged on the net diff

The same flow file and the same module: `failed` from a dirty tree, `done` from a
clean one. A step that overwrites a file and writes the old text back passes
`changes: nothing`. A paid step showed it too — `failed` when the file was absent,
`done` when it was already there.

### "I checked and nothing moved" and "I never looked" are the same record

A git-workspace step that kept its promise and a no-workspace step that added a
source file produce byte-identical records and identical pages. `changed` is
written only when something moved, and no field says the run watched.

### A mistyped contract is no contract

Ajv runs with `strict: false`, so `requires`, `propertys`, or `minimum` on a
string load clean and check nothing. Proved with a paid step: with `format: email`
beside `pattern`, the harness enforced the pattern and ignored the format, and the
run ended `done` with `address: "banana"`. The one warning that says so goes to
the child's stderr, twice, unattributed, and never reaches the daemon.

### An answer the contract refuses returns 200 — 3 agents

`POST /api/runs/:id/resume` queues the answer and returns a ticket. The contract
is checked later, in the child. The page redraws the same form with no message,
the run stays `waiting`, and the reason appears on a different page, as a queue row
headed "did not start". The command line refuses the identical value at once, with
the exact message, and exits 1.

### `resume` cannot name the gate it answers

Two people on a two-gate run: one answered question one, and the other's "no",
written for question one, was recorded as the answer to question two. The run
finished. Neither surface takes a step id; the value goes to whatever
`state.waitingFor` holds at that moment.

### A gate asks its question with the braces still in it

`fill()` runs for agent prompts only. A flow taking `{ticket, owner}` asks
"Ticket {{ ticket }} belongs to {{ owner }}" in every run. `validate()` says
nothing, and two waiting runs are indistinguishable at the command line.

### A gate answers "no" by default, and some gates cannot be answered at all

A `required` boolean draws an unticked checkbox labelled `needed`; pressing
**Answer and continue** sends `{"approved": false}` with no complaint, which on a
flow that cycles on `approved: false` silently sends the run backwards. A contract
holding a nested object, an enum, or a property with no type draws labels and no
controls, then refuses to send: the `Contract` form has branches for boolean,
number, string, and array only. Only *Write JSON* gets through — and malformed
JSON there throws with nothing shown.

### A run you stop reads as "did not start", for ever — 2 agents

`src/daemon.ts:287` never sets `job.settled` on a stop, so `:194` reads the
SIGTERM exit as a start failure and copies the child's stderr in as the reason.
What a person reads is `[MODULE_TYPELESS_PACKAGE_JSON] Warning: … add "type":
"module" to package.json` — for a run that did sixteen steps of work. The ticket
never clears, so five stopped runs dominated the runs page under a header that
claimed "5 in the queue" beside an empty queue.

### A budget never stops the first step

The budget is read at the top of a wave, so the first wave always runs whatever
the budget says, and a wave overshoots as a whole: three fanout members spent
$0.0308 against a budget of $0.005. A one-step flow with `budget: 0.0001` spent
$0.0102 and ended `done`. `validate()` refuses `budget: 0`, so "spend nothing"
cannot be said at all.

### The values of a run cannot reach a sub-flow

No `with` is refused; `with: { n: "{{ n }}" }` is refused, because interpolation
is for prompts only; a constant `with: { n: 0 }` runs and silently beats the run's
own `--with '{"n":5}'`. A sub-flow takes constants written into its caller, and
nothing else. Its `returns` is dropped as well, so the same flow fails standalone
and passes nested.

## The rest

81 medium and 48 low findings sit in the reports. The ones that shape a person's
day, as the sweep wrote them and before any of it was fixed — [what is
closed](#what-is-closed) above says which of these still stands:

- **The page misses runs the command line started.** `store.index()` runs once, at
  boot (`src/daemon.ts:79`), so 22 runs on disk showed as 17 on the page, and a
  gate started at the command line is drawn with a form and then refused with
  "this daemon holds no run", under a start time of `Invalid Date`. Found by three
  agents.
- **The flows list shows the harness of the registration, not of the flow**, and
  for a flow that names none, that column decides the run: the same file failed as
  `pi` and finished `done` as `claude`.
- **A ready branch waits for an unrelated one.** A wave is a barrier, so a step
  whose need passed at 406 ms started at 1110 ms, when a step on the other branch
  finished. Only two steps ran at once against a width of eight.
- **A flow with two ends returns one of them, chosen by file order**, and says
  nothing. With a flow-level `returns` the same shape is refused cleanly.
- **`policy: accept` ends a run `done` with no event and no line anywhere**, so a
  person's third rejection reads as success.
- **A skip never names the value it judged**, and the trajectory records a skip
  with no reason at all. `count: "5"` against `gt: 2` reads exactly like
  `count: 1`.
- **Every command pays 1.5 seconds to import the Pi SDK**, including
  `orchy --version` and every daemon child.
- **The page says "Every step passed." beside "1 done · 3 skipped".**
- **`--text-3` measures 2.68:1**, below AA, on every field label and column
  heading; the focus ring is `rgb(16,16,16)` on `rgb(10,10,11)`, which is
  invisible.
- **The flows page never follows the event stream** — the only view that needs a
  reload.
- **Both the README and `docs/running.md` say a waiting run exits 0.** It exits 3,
  which breaks the CI use they advertise. A broken file exits 1, the code `--help`
  reserves for a failed run.
- **There is no way to check a flow without running it** from the command line.
- **The "New flow" scaffold writes a flow that does not run**: the harness a person
  picks is stored in the database, not in the file, so the same file finishes
  through the daemon and dies at the command line. It also hard-codes a git
  workspace it never checks.
- **`orchy runs` shows dead runs as `running`**, sorts waiting runs last under a
  blank date, and prints no cost and no reason.

## What held up

Worth as much as the rest, and none of it was assumed — every line was run.

- Every shape check that `validate()` does reach: duplicate ids, a missing need, a
  loop, a self-need, an empty id, no steps, `parallel: abc|0|2.5`, nine distinct
  fanout refusals, twelve wrong condition files answered with twelve precise
  messages naming the fix. The `parallel: abc` infinite spin in `docs/usability.md`
  is closed.
- The wave is a real wave: six steps started within 1.1 ms, and `parallel: 1`, `8`,
  and the default all bound exactly, refilling as workers free rather than in
  fixed groups.
- Fanout under ADR 0017 and ADR 0021: member naming, per-member records, values and
  trajectories, the empty-list skip and its cascade, sibling isolation on failure,
  per-member retries and escalation, 200 members, `resume --from <member>`.
- Cycle accounting to the cent: three attempts at $0.011794, $0.011811 and
  $0.011645 summed exactly to the run's $0.03525, with dropped attempts marked and
  keeping their own trajectories. The untouched branch stays untouched. The
  two-voter starvation in `docs/usability.md` is fixed.
- The budget refusal itself: it names both numbers and what happens next, in the
  state, on stderr, and on the page.
- Contracts that Ajv actually reads are enforced precisely, with the instance path.
  Flow-level `takes` is strict in all three directions and refuses before spending.
  A megabyte value, and a payload of emoji, right-to-left text and CJK, round-tripped
  through contract, disk, daemon and page unharmed.
- The boundary of a called flow: one run, one run id, one page, one cost. Its
  `takes`/`with` messages are the best in the product, the tool check crosses in
  both directions before any spend, and a gate inside a sub-flow stops the outer
  run and is answerable from both surfaces.
- Invariant 1 under a real model, with an empty tool list and with all eight Claude
  tools; step-over-flow harness override in both directions.
- Stop→answer, answering a run that is done, and two answers at once are all
  refused cleanly and identically on both surfaces. `resume --from <gate>` re-asks
  and keeps the history.
- The live note stream: the filled prompt, reasoning, tool calls, results and text,
  about 250 ms behind the work.
- Killing the daemon and starting it again on the same directory re-marked the dead
  run exactly as ADR 0009 says.
- Every editor gesture: drag to link, drag to loop, cut a link, save, and the guard
  on leaving with unsaved changes.
- `npm test` — 215 tests, 50 seconds, and the repository byte-identical afterwards.
