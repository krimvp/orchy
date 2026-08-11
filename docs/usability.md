# A usability run over Orchy

Status: a record. This document reports one usability run. It is the record of
what happened, so it stays as it was written. Read it before you change the
runner, the daemon, or an error message.

## How I looked

I set the project up from nothing on a clean machine and ran the real thing. No
fake harness, and no reasoning about the code in place of running it. Eight
streams of work ran beside my own, each in its own sandbox directory, and each
case ran two or three times.

- **235 cases**, each repeated 2 or 3 times. About 750 invocations.
- **Two harnesses.** Pi against eight models on Ollama Cloud, and Claude Code
  against `haiku`, `sonnet`, `opus`, and a dated model name.
- **Every shipped flow**, the twelve under `flows/` and the eight under
  `examples/`.
- **The daemon**, its whole HTTP surface, and the page in a real browser.
- `npm test` **24 times**, to measure what CI sees.

Six of the seven high findings were reproduced twice, by two streams that
did not know about each other.

Nothing in this report is predicted. Every line names what a command printed.

## What works

Say this first, because most of it works.

- **`validate()` is the best part of the project.** 24 of 34 broken flow files
  were refused before a step ran, with a message that names the step, the
  problem, and the fix. `step "one" names the model "opus", which the harness
  "pi" cannot read. Write the provider and the model, as "openai/gpt-5".` That
  is the standard AGENTS.md sets, and it is met.
- **Invariant 1 holds.** Every probe of the tool list held: `find` and `ls` both
  became `Glob`, `tools: []` gave the step nothing, and a step told to use
  `Bash` when it had not declared it found no such tool.
- **The live report is good.** A person watching a run sees each tool call, each
  result and each sentence, prefixed with the step that said it.
- **Control flow is correct.** `parallel` holds to the millisecond at 1, 4 and
  8. A diamond runs its two middle steps at once and hands the last one both
  values. Static and computed fanout behave as ADR 0017 describes, including an
  empty list. All five match operators are right. A cycle carries its reason
  back to the step it returns to, and ADR 0021's per-member retry holds.
- **The daemon's door is solid.** A foreign `Origin`, a `Host` it does not
  answer to, `../../etc/passwd`, and an absolute path outside the root are all
  refused, and the message names the address or the root.
- **The page is good.** It builds clean, holds no hardcoded host or port, throws
  no console error, and leads with the thing that needs a person. A failed run
  names the step, quotes the error, and offers to resume from it.
- **Real work comes out right.** A cycle where one model writes `mul()` and
  another bounces it for missing JSDoc converged in one round, five times out of
  five, on two different harness pairings. A five-model panel over one `fanout`
  returned fifteen valid contracts in three runs.

## How the models behaved

Eight models on Pi, over Ollama Cloud, against the same flows. `✓` first try,
`✓!` after Pi rejected a value at least once, `✗` a failed step, `∞` a step that
never stopped.

| Model | trivial contract | hard contract | tools, answer correct? | no tools, prompt needs a file | unsatisfiable contract | median step |
| --- | --- | --- | --- | --- | --- | --- |
| `ollama/glm-5.2` | ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ | invented `0` twice | **∞** (411 calls) | 12.6 s |
| `ollama/qwen3.5:397b` | ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ | invented `0`, `1` | **∞ ∞** (156, 109) | 13.0 s |
| `ollama/gpt-oss:120b` | ✓ ✓ | ✓! ✓! ✓! | ✓ ✓ | invented `0` twice | ✗ ✗ (gave up cleanly) | 20.0 s |
| `ollama/gpt-oss:20b` | ✓ ✓ | ✓! **✗ ✗** | ✓! ✓! | invented `0` twice | — | 18.7 s |
| `ollama/kimi-k2.7-code` | ✓ ✓ | ✓ ✓ ✓ (23 calls once) | ✓ ✓ | **refused, honestly** | — | 25.0 s |
| `ollama/minimax-m3` | ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ | invented `0` twice | — | 19.6 s |
| `ollama/deepseek-v4-flash:preview` | ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ | invented `0` twice | — | 38.2 s |
| `ollama/nemotron-3-nano:30b` | ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ | **fabricated `12`, `15`** | — | 40.1 s |

Two things in that table are about Orchy, not about the models.

**A step that cannot do the work answers anyway.** Given `tools: []` and a
prompt that says "read README.md and report its line count", 14 of 16 runs
ended `done`, exit 0, with a number. Six models answered `0`, nemotron
fabricated `12` and then `15`, and the true answer was 2. Only
`kimi-k2.7-code` refused. A contract that a model can satisfy without doing the
work is a contract that measures nothing, and nothing in the record says the
step never opened a file.

**Pi's rejection never names the allowed values.** When a value breaks the
contract, the model is told `- items.0.kind: must be equal to one of the
allowed values` — and not what they are. `gpt-oss:20b` flailed for four rounds
and gave up with "This is hopeless without schema". `kimi` spent 23 calls on one
enum. This is the largest token sink in the whole run, and it is what turns
finding 3 from a curiosity into a bill.

On the Claude side, all four model forms worked — `haiku`, `sonnet`, `opus`, and
the dated `claude-haiku-4-5-20251001`. Tool mapping and tool enforcement held
every time.

## The twenty shipped flows

All twenty pass `validate()` as written. That is the whole of what validation
catches. Running them is another matter: **not one of them completes as
shipped, on the default harness, in a fresh clone.**

Three walls stand in the way, in this order.

**No flow names a model.** So `pi` picks its own default, which is a Bedrock
model, which has no credentials, and the run dies on the first agent step with
the message from finding 7 — the one that blames the model. There is no
`--model` flag. The only way through is an undocumented `.pi/settings.json` that
needs both `defaultProvider` and `defaultModel`.

**Every one of the twelve flows under `flows/` declares a `budget`.** `costOf()`
maps a provider with no price table to `undefined`, and the runner ends the run
when a step reports no cost. So on any free provider, eleven of the twelve abort
part-way — *after* spending the time and, in several cases, after changing the
workspace. `flows/bugfix` aborted after it had already edited `src/tail.ts`.
`flows/translate-readme` aborted after writing all four translations, 382
seconds in, just before the free `call` step that builds the table.
`flows/standup` is the only survivor, and only because its agent step happens to
be last.

Strip the budget and ten of the twelve run end to end.

**Three examples need a file the README never mentions.** `examples/research`
needs `QUESTION.md`. Without it the run does not fail: the question step returns
`{"question":"ERROR: QUESTION.md could not be found…"}` and the flow spends
**$0.46** running three web readers, an opus brief and two cycles over that
string, then reports `done`.

`examples/decision` and `examples/docs-audit` are broken as documented. Their
fanout prompts say *"Read the rules in `prompts/advise.md`"* — a path relative to
the flow file, and never present in the directory the README tells you to run
from. Every advisor gets an ENOENT on its first tool call and then invents:
`{"position":"assistant","risks":[]}`. `docs-audit` returned `checked: [],
disagreements: []` and exit 0. Both work correctly when re-run from inside the
flow directory, which proves the cause.

`flows/pr-describe` and `examples/release-notes` die in under five seconds on a
plain clone, with raw git output — `fatal: ambiguous argument 'main...HEAD'`,
`unknown revision HEAD~20..HEAD` — and no mention of the `ORCHY_BASE` and
`ORCHY_RANGE` their modules read.

### What the flows produce when they do run

| Flow | Outcome |
| --- | --- |
| `examples/triage` | the best-behaved of the twenty. 21 s, gate override reached `label.ts` correctly |
| `examples/dependency-audit` | a genuinely good audit of ajv, yaml and typebox. The ruled-out `upgrade` step was invisible on the console |
| `flows/typo-hunt` | three planted typos found and fixed, and only `README.md` touched |
| `flows/translate-readme` | four translations, ~20 KB each, good |
| `flows/qa` | a correct answer with correct citations (`src/flow.ts:690`), workspace clean |
| `flows/api-docs` | accurate, well-written module docs. `index.ts` writes no index file, despite its name |
| `flows/security-sweep` | wrote `SECURITY-SWEEP.md` and nothing else — the `changes: { paths }` promise held. Content thin |
| `examples/code-review` | the cycle fired on one run of two; the other found nothing to do |
| `flows/pr-describe`, `examples/release-notes`, `flows/standup` | **fabricate.** Their `call` step hands the model commit *subjects* and no diff, so it invents. `release-notes` produced "a flow may now declare `run: true`", and its own `check` step **approved** it |
| `flows/test-writer` | its `write` step broke its promise — a good, correct failure — but left `package.json`, `package-lock.json`, `tsconfig.json`, two `.js` files and **49 MB of `node_modules`** in the workspace. Orchy reports the breach and undoes nothing |
| `flows/refactor-gate` | applied an 8-file refactor and returned `files: []` |
| `flows/ship` | the sub-flow panel reads well (`review/reviewer/clarity`, `review/verdict`) and gave unanimous approval to a change that edited only the usage string |
| `examples/grilling` | `examples/README.md` says the gate fires "four times over". It fired once |

The `changes` promise, the cycle, the gate, the fanout, the `when` condition,
the sub-flow and the deterministic `call` step all did their jobs. The flows
that fail, fail on their surroundings: a model nobody named, a budget that a
free provider cannot satisfy, and a file the documentation does not ask for.

## What is wrong

Ranked by what it costs a user. Each one names the run that found it.

---

### 1. A person who watches a run never learns why it failed — high

Five separate streams of work found this without knowing about each other. It is
the single largest gap between what Orchy knows and what it says.

`report()` in `src/cli.ts` prints `✗ <step>` and then `— failed`. It stops
there. The reason lives in `state.error`, or in `state.steps.<id>.error`, inside
the JSON that goes to the output stream — mixed into a copy of the flow file the
user just wrote.

```
✓ s2
— failed
```

That is the whole console record of a run that stopped on its budget. The
message that ADR 0019 was written to produce, `$0.0246 of $0.02`, is nowhere on
that stream.

Six different `call` module faults — a missing file, a syntax error, no default
export, the wrong shape, a string, `undefined` — printed byte-identical output.

It is worse under `--events`, which is how the daemon reads a run and how any
parent process would: the failure reason is in **no event at all**. `step_end`
and `run_end` carry `status: "failed"` and no `error` field. A parent process
cannot report a reason it never receives.

**Every live note is cut to its first line.** `report()` prints
`event.text.split("\n")[0]`, so a seven-line `ls`, a five-match `grep`, and
`Validation failed for tool "submit_result":` all show one useless line. The
`--events` stream carries the whole text, so this is the CLI alone.

The `skip` event has no case in `report()` either. A 13-step run skipped six
steps, one of them only because the step it needed was ruled out, and the
console said nothing. ADR 0014 exists to make that visible.

*Found by: the CLI run, the validation run, the Claude harness run, the control
flow run, the state machine run.*

---

### 2. The `changes` promise does not hold over a file that is already dirty — high

This is invariant 5, guarantee 5 of the README, and the reason `validate()`
refuses a promise that no workspace can check. It stops holding in the ordinary
case.

`changed()` in `src/workspace.ts:44` compares the two status letters that `git
status --porcelain` prints, not the content of the file:

```ts
.filter((path) => before.files[path] !== after.files[path])
```

A file that is already ` M` before the step is still ` M` after it. A file that
is already `??` is still `??`. The letters do not change, the path is filtered
out, and the promise cannot fail.

Proven three ways, twice each:

```
# one step, changes: nothing, in a repo with one uncommitted edit
→ the step appended to that file.  status done, exit 0, changed: undefined

# one step, changes: nothing, over an untracked file
→ the model replaced the file whole.  status done, no record

# one step, changes: { paths: [docs] }, writing to a pre-dirty file outside docs
→ status done, no record, no failure
```

Three ordinary situations put a file in that state: the developer has
uncommitted work, an earlier step touched the file, or a cycle sent the same
step back. In a cycle, the first attempt records `changed: [{path: calc.js, how:
changed}]` and the second attempt records nothing, though it demonstrably edited
the same file.

**A rename escapes it a second way.** `changed()` records a rename as one
composite path, `"docs/one.md -> src/moved.md"`, and `under()` is a prefix test
over that whole string, so it reads the source and never the destination. A step
promising `paths: [docs]` ran `git mv docs/one.md src/moved.md` and passed.
`except: [src]` passed the same move into `src/`.

AGENTS.md: *"a rule that looks enforced and is not costs more than a missing
rule."* This is that rule, in the common case.

A fix has to compare content: hash each path in `status()`, or read `git diff`
between the two snapshots. The rename needs the promise to read both halves.

*Found independently by the orchestrator and by the state machine run.*

---

### 3. A step can run for ever, and invariant 4 does not stop it — high

README guarantee 4: *"A cycle stops at its declared limit. A flow cannot run
forever."* The limit bounds a cycle. Nothing bounds what one step does inside
itself.

Give a step a contract it cannot satisfy — `{ type: number, minimum: 100,
maximum: 10 }` — and the model calls `submit_result`, Pi refuses the value, and
the model calls it again. For ever.

```
answer │ submit_result {}
answer │ Validation failed for tool "submit_result":
```

Measured: glm-5.2 made **411** rejected calls, qwen3.5 made 156 and then 109.
Every one was killed by an external `timeout`, not by Orchy. I confirmed it
separately: 31 rejected calls in 100 seconds, still going when I killed it.
There is no step timeout and no cap on the calls.

`pi.ts` bounds one failure and only one — a model that answers in prose gets a
single reminder and then the step fails. A model that answers with a value the
contract refuses gets no bound at all.

Two things make it likely rather than exotic. Pi's rejection **never names the
allowed values**, so a weak model has nothing to correct towards: gpt-oss:20b
gave up saying "This is hopeless without schema", and kimi burned 23 calls on an
enum. And a schema that cannot be satisfied is easy to write by hand and easier
to write from a generator.

*Found by the Pi harness run, verified by the orchestrator.*

---

### 4. A run can reach a state that nothing can leave — high

`kill -9` (or `Ctrl-C`) an `orchy run`. The state file is left at `status:
"running"` — nothing on the CLI path ever writes `stopped`. `resume()` tests
`state.status === "running"` **before** it reads `--from`, so both doors are
shut:

```
node src/cli.ts resume <id>            → the run <id> is running, so there is nothing to continue
node src/cli.ts resume <id> --from a   → the same refusal
```

The state itself is intact — valid JSON, the values of the steps that passed
still there — exactly as ADR 0005 predicts. ADR 0005 also promises that *"a
crash and a gate become the same case, and both recover through resume."* They
do not.

The only recovery is to start `orchy daemon` in that directory for a few
seconds, because `store.index()` rewrites `running` to `stopped`. No `orchy`
command does it and no document says so.

A second route into the same state: a malformed JSON Schema (`returns: { type:
objekt }`) passes `validate()` untouched, the step runs and spends its tokens,
and then Ajv throws `schema is invalid: data/type must be equal to one of the
allowed values` — naming no step, no field, no file and no fix. Five run
directories were left at `"running"` this way.

A third: `parallel: abc`. `validate()` only tests `parallel < 1`, which is false
for `NaN`, so `pool()` builds zero workers and the wave loop spins on
microtasks for ever. It prints nothing, ignores SIGTERM, and leaves a **0-byte
`state.json`**. I confirmed it separately: two minutes, no output, no step
started, empty state file.

*Found by: the state machine run, the validation run, the control flow run.
All three verified by the orchestrator.*

---

### 5. The daemon and a run disagree about who owns the run — high

**A client cannot answer a gate at the moment the gate appears.**
`daemon.resume()` refuses while the run is still in the `jobs` map
(`src/daemon.ts:233`), but the store already reports `waiting`, because the
child writes its event before the parent reaps the child. In that window every
answer is refused with `the run … is already on its way`, which says the
opposite of the truth.

```
poll GET /api/runs until status === "waiting"
POST /api/runs/<id>/resume {"value":{"approved":true}}
→ 400, nine times in ten
```

Insert 100 ms and it passes six times in six. A person clicking a button is slow
enough to miss it. Anything that reacts to the state hits it every time.

**That race is why CI is flaky.** `node --test test/daemon.test.ts`, 24 runs: 5
failed, about one in five. Two different tests, one assertion,
`400 !== 200`, both on `POST /api/runs/:id/resume`:

- `the daemon runs a flow, stops at a gate, and ends when a person answers`
  (`test/daemon.test.ts:143`)
- `a failed run resumes from the step that failed, and keeps the work that
  passed` (`test/daemon.test.ts:621`)

AGENTS.md says CI runs these on every push and every merge request.

**Starting a daemon rewrites a live run's state.** `store.index()` flips any run
marked `running` to `stopped`. Start `orchy daemon` in a directory where an
`orchy run` is in flight and its `state.json` says `stopped` seven seconds
later, while the process is still working and goes on to finish normally. ADR
0008 says the daemon *"never rewrites the state on disk"*. I reproduced this
directly.

**A gate answer that breaks the contract is lost.** `POST
/api/runs/:id/resume {"value":{"approved":"yes"}}` answers 200 with a ticket.
The run stays `waiting`, the ticket vanishes, no error reaches the API and no
event is sent. The CLI, given the same answer, prints the reason and exits 1.

**Two runs in one directory blame each other.** The promise check reads the
whole git tree, so a run that changed nothing fails on a file the other run
wrote: `step "s" promises to change nothing, but it added made-by-writer.txt`.
The daemon starts four runs at once by design, so this is not the edge case.

*Found by: the orchestrator, the daemon run, the state machine run.*

---

### 6. Fields that vanish without a word — high

`docs/shape.md` is the record of a study that found eleven fields doing nothing
in silence, and closing them is the reason the shape table exists. Four more are
open.

**A sub-flow's `harness`, `model`, `parallel` and `workspace`.** `expandFlows`
copies `changes`, checks `takes`, and throws a clear error for an inner
`budget`. The other four disappear. A sub-flow declaring `harness: claude, model:
haiku` ran on `pi` / `glm-5.2`. A sub-flow declaring `parallel: 1` ran its two
steps at once. The same file behaves differently depending on whether it is the
root of a run or a `kind: flow` step, and `modelProblems()` cannot catch it,
because the name it checks now comes from the outer flow.

**`--with` accepts a key the flow does not declare.** `docs/running.md`: *"A run
that supplies a value the flow does not take is refused."* It is not.
`--with '{"issue":7,"bogus":"x"}'` against a `takes` that names only `issue` runs
to completion, exit 0. The type check and the missing-value check are both
excellent; this one claim is not kept.

**A second reviewer's cycle never fires, and the run calls that `done`.**
`docs/plan.md` says a wave settles one cycle and keeps the vote it does not act
on, which is deliberate. What it does not say is what happens on the next wave.
Two reviewers, each `cycle: {to: a, limit: 1}`, both answering `approved:
false`: `b` cycles once and reaches its limit. On the next wave the run picks
`b` again — the sort by target is stable, so the first in topological order
always wins — finds it spent, and ends. `c`'s vote is recorded
(`votedToCycle: "a"`) and never acted on, and its own limit is untouched.

```
cycles: {"b->a":1}
b {status: done, disagreement: "accepted"}
c {status: done, votedToCycle: "a"}
status done, exit 0
```

The run ends `done` with two reviewers on record saying the work is not
approved. I reproduced this with `call` steps, so no model is involved. The run
should fall through to the next voter that still has a cycle left.

**A malformed `returns` schema.** Covered under finding 3: `isSchema()` asks
only "is this a non-array object", so any object passes.

*Found by: the control flow run, the CLI run, the validation run.*

---

### 7. Nothing runs until you configure a provider that no document names — high

`pi` is the default harness. On a clean machine its default model is a Bedrock
model with no credentials, and every run fails. The README's opening example
names `ollama/glm-5.2`, and `docs/running.md` says *"Write the provider and the
model"* — but no document says where a provider comes from, that
`~/.pi/agent/models.json` is the file, or that Ollama has to be registered there
by hand. I had to write that file before the README's own example would run.

The failure a new user meets does not point at the cause:

```
step "code" ended without a call to submit_result, and again when reminded.
Give the step a cycle on "failed", or name a model that calls a tool.
```

That is a credentials failure wearing the face of a model-behaviour failure, and
the advice sends the user to change their model. The session file on disk says
what really happened — `"stopReason":"error","errorMessage":"UnrecognizedClient
Exception: The security token included in the request is invalid"` — and the
adapter never reads it. The same masking hides a real disagreement: given a
contract the prompt contradicts, models said so plainly (*"The tool rejected it
because its validation requires n to be a multiple of 2 … which directly
conflicts with your requirement"*) and Orchy still reported "answered in prose
instead".

The same masking happens on the Claude side from the other direction: when the
`claude` command exits non-zero, the recorded error is Node's raw `Error: Command
failed: claude --print <the entire prompt> --json-schema … --model gpt-4`. The
real reason — `There's an issue with the selected model (gpt-4)` — is printed
live and then thrown away, and the whole prompt is dumped into the record.

The README's own **TypeScript example fails**, twice out of two, for this
reason: `run()` with no harness and no model falls to pi's default.

*Found by: the orchestrator, the Claude harness run.*

---

### 8. The command line has no help, and one exit code for three meanings — medium

`--help`, `help`, `-h`, `--version`, and a genuine typo all print the same usage
blob to the **error** stream with **exit 2**. `orchy --help > f.txt` writes an
empty file. There is no version flag.

Exit 1 covers an agent that failed, a flow that `validate()` refused, and a file
that is not there. Only usage and an unknown harness get 2. CI cannot tell
"retry this" from "your YAML is broken". A **waiting** run exits 0, so CI cannot
tell "finished" from "needs a person" either.

There is no way to list past runs. Run directories are bare UUIDs, and the only
way to find yesterday's run is `ls .orchy/runs`.

A `.ts` flow written as the plain object the README shows dies with
`step.needs is not iterable` — no step name, no file. `src/yaml.ts` defaults
`needs: []`; the `import()` path in `src/load.ts` does not, so the object form
never reaches `validate()`. I reproduced this exactly.

*Found by: the CLI run, the state machine run, verified by the orchestrator.*

---

### 9. A flow declares `returns`, and the run never reports the value — medium

`docs/running.md`: *"A flow declares `returns`, the value it produces … Orchy
checks that value at the end of the run."* It checks it (`src/run.ts:75-83`) and
keeps nothing. The final `RunState` holds `runId, flow, status, steps, cycles,
with` and no field for the value.

To read what a flow returned you must know which step ends it, then find
`steps.<that id>.value` inside 3 KB of JSON that is mostly an echo of the flow
file you wrote.

The same shape shows over HTTP: `POST /api/flows/:id/runs` answers with a
**ticket** and no run id. Every client has to poll `/api/runs` and guess which
row is its own. My own probe script got it wrong the first time and answered the
wrong run.

---

### 10. Cost is real, and hard to see — medium

The budget stop works and its message is right (`$0.0246 of $0.02`, word for
word per ADR 0019). Around it:

- **A `budget` and a free provider cannot both be true.** `costOf()` maps a
  provider with no price table to `undefined`, and the runner ends the run when
  a step reports no cost. Eleven of the twelve flows Orchy ships declare a
  budget, so eleven of them abort part-way on such a provider — after spending
  the time, and sometimes after changing the workspace. The same rule breaks any
  mixed pi and Claude flow: `step "p1" reported no cost`, mid-run, after
  spending. `validate()` could know both statically. And if the pi step is last,
  the check never runs at all, so the same flow shape passes or fails on the
  order of its steps.
- Per-step `cost_usd` in a Claude trajectory is a hard `0`; only `final_metrics`
  is patched. The **run total is printed nowhere**.
- Token metrics in a Claude trajectory are double-counted (354 where 177 is
  right).
- A budget stop is reported as `failed`, exit 1, and the step that never ran
  gets no record at all.
- In a flow across two harnesses the top-level `agent.model_name` names one
  model, though the run used two, and `agent.version` is Orchy's `0.1.0` on both
  children rather than the version of the harness. The per-step children are
  right.
- A pi trajectory writes `cost_usd: 0` on every step, because `toStep()` falls
  back to `?? 0` where `costOf()` deliberately returns `undefined`. `store.ts`
  reads that, so the daemon's run list reports a pi run as costing $0.00 — the
  exact confusion the comment in `pi.ts` warns against.
- **A failed pi step records no trajectory at all.** `pi.ts` throws before it
  returns, so `record.trajectory` is unset, `toAtif` writes no
  `subagent_trajectories`, and `agent.model_name` becomes `"unknown"`. The
  session file is on disk the whole time — two lines earlier the same function
  reads it to build the error message. The runs a user most wants to read are
  the ones with nothing in them.
- Every Claude step pays a **2.5 to 3 second stdin tax**: `execFile` leaves stdin
  open and the CLI waits out its own timeout. Measured 2.93 s with `</dev/null`
  against 5.39 s the way Orchy calls it.

---

### 11. Smaller things a user meets — low to medium

- Node's `ExperimentalWarning: SQLite` lands in the middle of every run's live
  output, including `--events` runs whose error stream is otherwise empty. The
  README predicts it; `src/index.ts` pulls the store in even for a library run
  that never opens an index.
- A YAML syntax error names a line and a column but never the file, in the words
  of the parser: `Nested mappings are not allowed in compact mappings at line 4,
  column 11`.
- A missing prompt file, a missing flow file and an unknown run id all give a raw
  `ENOENT`. The run-id one leaks the path `.orchy/runs/<id>/state.json`.
- Three messages state the problem and no fix: `the tool "sudo" … does not exist`
  does not list the tools that do; `the harness "pi" has none` does not say which
  harness has it; `the flow holds "step"` does not hint at `steps`.
- With `workspace: { kind: none }` a promise is refused with *"the flow has no
  workspace to check it"* — but the flow does declare one, so the sentence sends
  the user hunting for a field that is present.
- `changes: { paths: [docs/**] }` validates and can never pass: every write under
  `docs/` is refused with `promises to change only docs/**, but it added
  docs/two.md`. ADR 0013 chose paths over patterns precisely so this could not
  come back; `validate()` should refuse the `*`.
- `validate()` accepts `returns: { type: number }` for a Claude step, which the
  harness cannot take; the run dies on an API 400 mid-flight.
- The daemon prints a raw Node stack trace (`Unhandled 'error' event`,
  `EADDRINUSE`) when its port is taken. `--port abc` and a bare `--port` fall
  back to 4000 without a word, and `--port 0` prints `http://127.0.0.1:0`.
- `POST /api/runs/:id/stop` on a live run answers `{"stopped":true}`, and a
  moment later `/api/runs/:id` holds two statuses at once — `row stopped`,
  `state running` — so the same run "stops" successfully twice.
- 21 flow files in the daemon's root give `GET /api/flows → []`. Registering a
  flow is a deliberate step, and the page says so, but a new user who starts the
  daemon in their project sees nothing.
- On the page, a step card says `Harness: the default` instead of `pi`, and never
  names the model the flow sets.
- A cycle that reaches its limit prints nothing and exits 0. The console line for
  a cycle, `↻ review goes back to code (1)`, names no reason; the reason is in
  `history`, in the JSON.
- A gate never shows the shape of the answer it wants.
- **`.orchy/` lands inside the directory the step works in**, so the agent's own
  tools see it: `ls` returned `.git/ .orchy/ CHANGELOG.md docs/ NOTICE
  README.md src/`. A second run's `grep` can match the first run's
  `trajectory.json`. The promise check skips `.orchy/`; the agent's tools do
  not, so any flow that searches its working directory is measuring Orchy as
  well as the repository.
- Repeated flags are silently first-wins; `--from` and `--port` on `run` are
  silently ignored; a `.json` flow file gives a raw Node loader error.

## What later work closed

The change that follows this report closes most of it. This section says what,
so a reader knows which finding above is history and which still stands. The
findings stay as they were written.

**Closed.**

| Finding | What changed |
| --- | --- |
| 1 — no reason on the console | `step_end` and `run_end` carry `error`, so the console and `--events` both say why. `report()` prints the whole note instead of its first line, and it has a `skip` case. |
| 2 — the promise misses a dirty file | `status()` hashes what each path holds, so a second write to a dirty file is a change. A rename keeps both halves, and a promise reads both. |
| 3 — a step runs for ever | Pi counts the values a contract refuses and stops the step at eight, with a message that names the count and the reason. |
| 4 — a run nothing can leave | The state holds the pid of the process that drives it. `orchy run` writes `stopped` on a signal, `resume --from` opens a run whose process has gone, and `validate()` refuses a `parallel` that is not a whole number. A malformed contract is refused before the run starts. |
| 5 — the daemon and the run disagree | A job is settled when its child reports `waiting` or `run_end`, so an answer at that moment is accepted. A run keeps one child. The index leaves a live run alone. A resume that a contract refuses keeps its ticket and its reason. |
| 6 — fields that vanish | A sub-flow carries its `harness` and `model` onto each step; a `parallel`, a `budget` or another `workspace` is refused. |
| 7 — no provider, no run | The README says where a model comes from. Pi reports what the provider said instead of blaming the model. The `claude` adapter reports what the command said instead of its own argument list. A `.ts` flow written as a plain object loads. |
| 8 — no help, one exit code | `--help` and `--version` write to the output stream and end with 0. `orchy runs` lists the runs. A wrong command ends with 2, a failed run with 1, and a waiting run with 3. |
| 9 — the value a flow returns | `state.value` holds it. |
| 10 — cost | A Claude trajectory keeps no per-step zero. A busy port, a bad `--port`, a missing file, a missing prompt, a missing module and an unknown run id all say what to do. The Claude adapter closes the input stream it never writes to, which takes about 2.5 s off every step. |
| 6 — `--with` accepts a key the flow does not take | It is refused, and the message names the key. |
| 6 — only the first voter cycles | A voter that has spent its own limit lets the next one take its turn. |
| 10 — a failed pi step keeps no trajectory | The record rides on the error, so the step a reader most wants to read has its session. |
| 11 — the SQLite warning on every run | The daemon loads `node:sqlite` when a person asks for the daemon, so a run prints nothing. |
| the shipped flows | Every flow names a harness and a model. A `budget` stays only where the harness reports a cost. The prompts carry their own rules. The git modules take values instead of reading the environment. `examples/research` declares what it takes. |

**Still open.** The rejection that Pi writes still does not name the values a
contract allows, because Pi builds that message. A `changes` promise still sees
nothing a step writes outside the workspace, which the README states. A step
that answers without doing the work still passes: a contract measures the shape
of a value and not the work behind it.

## What to fix first

In this order. The first three cost the least and buy the most.

1. **Print the reason.** Give `report()` a case for the error on `step_end` and
   on `run_end`, and put the reason in those events so `--events` carries it.
   Add the `skip` case. One small change closes the complaint that five separate
   runs made.
2. **Close the resume race.** Take the run out of `jobs` before the child's
   `waiting` event reaches the store, or let `resume()` accept a run whose child
   has already reported that it waits. This also makes CI green.
3. **Write `stopped` on the way out.** A signal handler in `orchy run` that
   marks the state `stopped`, and a `resume` that reads `--from` before it reads
   the status. ADR 0005 already promises this.
4. **Bound a step.** Cap the rejected `submit_result` calls the way the prose
   failure is capped, and pass the allowed values into the rejection so a model
   can correct itself.
5. **Make `changed()` compare content.** Hash each path in `status()`, and read
   both halves of a rename. Until this lands, invariant 5 does not hold on a
   dirty tree, and the README should say so.
6. **Refuse what cannot work.** A malformed `returns` schema, a non-numeric
   `parallel`, a `*` in a promised path, and the four sub-flow fields that
   `expandFlows` drops. `validate()` is good at this; these four are the ones it
   does not see.
7. **Say where a model comes from.** One section in the Install part of the
   README naming `~/.pi/agent/models.json`, and an error that separates "the
   provider refused me" from "the model did not call the tool".
8. **`--help`, a version, and a run list.** All three are small, and each one is
   the first thing a user reaches for.
9. **Make the shipped flows run.** Name a model in each one, drop the `budget`
   from the eleven that a free provider cannot satisfy, and give the three that
   need a file of their own either a default or a `takes` that says so.

## What I did not test

- A Windows or macOS machine. Everything here ran on Linux, Node 22.22.
- A model over a slow or failing network. Nothing here provoked a timeout, a
  rate limit, or a partial response from a provider.
- The graphical editor's write path. The page was read and driven, and a flow
  was not drawn and saved back through it.
- A schedule or a webhook start (ADR 0022). Both were read, neither was fired.
- More than four runs at once through the daemon.
