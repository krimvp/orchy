## A flow that names no harness gets no tool check and no model check, so the run pays before it fails

- **Area**: functional
- **Severity**: high
- **What I did**: Wrote `c3-late-model.yaml` with no `harness` on the flow and no
  `harness` on either step, step `first` with `model: haiku` and step `second`
  with `model: anthropic/claude-haiku`. Ran
  `node /home/user/orchy/src/cli.ts run c3-late-model.yaml --harness claude`,
  which is the command README documents for "a flow that names none". Then wrote
  `c2-noharness-webtool.yaml` with `tools: [web]` and no harness, registered it
  in the daemon with `harness: pi`, and started it with
  `POST /api/flows/3/runs {}`.
- **What happened**: `validate()` said nothing for either flow (`node check.ts` →
  `c3-late-model.yaml: OK`, `c2-noharness-webtool.yaml: OK`). The run then spent
  money and died halfway:

  ```
  ▶ first
  ✓ first
  ▶ second
  ✗ second
    claude wants a plain model name, not "anthropic/claude-haiku"
  — failed
  ```

  `state.json` shows `"first": { ..., "cost": 0.0125459 }`. The daemon behaved
  the same way for the tool: it accepted the ticket, started the child, and the
  child failed with `step "say" failed: pi has no tool for "web"`.
- **What I expected**: The same two checks that fire when the flow names its
  harness, because the run and the daemon both know the harness before the first
  step starts.
- **Where**: `src/flow.ts:877` and `src/flow.ts:908` — both read
  `harnessOf(flow, step)`, which is `undefined` when neither the step nor the
  flow names one, so `supplies`/`reads` are `undefined` and every check is
  skipped. `src/run.ts:213` already has the effective name (`options.harness`)
  and passes it to `harnessFor` only to look up the adapter; `src/server.ts:607`
  has `row.harness` and passes it to the child, not to `validate()`. ADR 0012
  says this class of fault ("a flow that asked for `web` under Pi passed the
  check and failed in the middle of the run, after an earlier step already spent
  its tokens") is closed. It is closed only for a flow that writes `harness:`.

## A claude step that fails inside the harness loses its trajectory and its cost

- **Area**: observability
- **Severity**: high
- **What I did**: Ran `f1-impossible.yaml` — `harness: claude`, `model: haiku`,
  one agent step whose contract no value can satisfy
  (`ok: { type: string, minLength: 10, maxLength: 2 }`).
- **What happened**: The step ran for 21 seconds and then:

  ```
  ✗ say
    step "say" ended with no value for its contract
  ```

  The model really worked. Its transcript is on disk at
  `~/.claude/projects/-tmp-…-hunt-harness/f4989f0e-dd4d-4053-9a84-8c68920f8026.jsonl`,
  16 lines, 2,366 output tokens and 32,620 cached-read tokens — about three
  times the work of a step that passed. Orchy kept none of it. `state.json` for
  the step holds no `trajectory` and no `cost`. `trajectory.json` reads
  `"final_metrics": {"prompt_tokens":0,"completion_tokens":0,"cost_usd":0,"total_steps":1}`
  with zero children. The page says `cost —/$1`, `tokens —`, and the trajectory
  view says `orchy/f1-impossible · ATIF-v1.7 · model unknown · 1 step · 0 tokens`
  with `activity — Nothing yet.` The same run through `/api/runs` reports
  `"cost":0,"tokens":0`.
- **What I expected**: The step a reader most wants to read is the one that
  failed, and the money it spent still counts. Pi does exactly that
  (`src/pi.ts:120` throws with `{ trajectory: file }` attached, and `src/run.ts:846`
  picks it up).
- **Where**: `src/claude.ts:105-112` — the three throw sites drop `sessionId` and
  `answer.total_cost_usd`, which the adapter already holds in `answer`.

## The budget guard blames the harness for a cost the adapter threw away

- **Area**: ux
- **Severity**: medium
- **What I did**: Ran `i1-budget-lost.yaml`: `harness: claude`, `model: haiku`,
  `budget: 0.01`, one step with the impossible contract above and
  `cycle: { to: say, when: failed, limit: 3, policy: accept }`.
- **What happened**: Two attempts ran, roughly $0.04 of real model work, and the
  run ended with:

  ```
  — failed
    the flow "i1-budget-lost" has a budget, and step "say" reported no cost.
    Orchy does not enforce a budget that it cannot measure. Use a harness that
    reports a cost, or take "budget" off the flow.
  ```

- **What I expected**: The guard stopping the run is right. The advice is wrong:
  the `claude` harness does report a cost on every answer, and following either
  suggestion (change harness, drop the budget) makes the user worse off. The
  message should not be reachable for a harness that reports cost when it
  succeeds.
- **Where**: `src/run.ts:104`, reached because `src/claude.ts:105-112` dropped
  `total_cost_usd`.

## The daemon lets a person choose a harness that the run then ignores

- **Area**: ux
- **Severity**: medium
- **What I did**: `POST /api/flows {"path":"a2-claude.yaml","harness":"pi"}` —
  the file itself says `harness: claude`, `model: haiku`. Then
  `POST /api/flows/1/runs {"harness":"pi"}`. Opened `#/flows` in the browser.
- **What happened**: Both calls were accepted with no word about the conflict.
  The run finished `done` with `"cost":0.0131512,"tokens":606` and
  `agent.model_name: claude-haiku-4-5-20251001` — it ran on claude, not on pi.
  The flows page draws the row as `a2-claude … last run 3 min ago · done · 10s ·
  $0.01 ● pi`, so the page states the harness the run did not use.
- **What I expected**: Either the pick wins, or the daemon says the file names
  `claude` and the pick does nothing. ADR 0012 chose "the flow beats the command
  line", which is defensible, but the daemon still offers the pick twice (at
  register and at start) and the page prints the losing value as fact. Here it
  is money: a person who picks `pi` to avoid spend gets a claude bill.
- **Where**: `src/server.ts:607` (`harness: harness ?? row.harness` becomes only
  `--harness`, the weakest of the three), `ui/src/Flows.tsx:189` (the pill is the
  registered value, not the file's).

## Nothing checks that a harness can run at all, so a flow pays for step one and dies on step two

- **Area**: ux
- **Severity**: medium
- **What I did**: Ran `d1-mixed.yaml` — flow `harness: pi`, `model: openai/gpt-5`;
  step `first` overrides with `harness: claude`, `model: haiku`; step `second`
  takes the flow's pi. `node …/cli.ts run d1-mixed.yaml --harness claude`.
- **What happened**: Precedence was right (step, then flow, then the flag), and
  the failure was fast — but it came second:

  ```
  ✓ first
  ▶ second
  ✗ second
    No API key found for openai.
    Use /login to log into a provider via OAuth or API key. See:
      /home/user/orchy/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
  ```

  Step `first` cost $0.012707. Step `second` failed 63 ms after it started; pi
  could have said so before the run began. The message also points a user at a
  file inside `node_modules`, which is not where a user of an installed Orchy
  looks.
- **What I expected**: The run checks each harness it will need before the first
  step spends, the same way `--with` is checked "before the first step spends a
  token".
- **Where**: `src/run.ts:213` — the pre-flight resolves the adapter name only.

## An empty harness name on a step silently overrides the flow

- **Area**: functional
- **Severity**: medium
- **What I did**: `g6-step-empty-harness.yaml`: flow `harness: claude`,
  `model: haiku`; step `say` holds `harness: ""`. Validated, then ran it with no
  `--harness`.
- **What happened**: `validate()` said `OK` (it reads the flow's `claude`, so
  `haiku` looks right). The run said:

  ```
  ✗ say
    pi wants a model named "provider/model", not "haiku"
  ```

  The flow never mentions pi. `harnessOf` uses `??`, so the empty string is a
  value: it beats `harness: claude` on the flow, and then `!name` sends the step
  to the run default, which is pi.
- **What I expected**: An empty harness name is refused, or it means "not set".
  A field that Orchy cannot act on must fail and say why.
- **Where**: `src/flow.ts:272` (`??` keeps `""`) with `src/run.ts:621`
  (`if (!name) return fallback`). The same hole sits on the flow: `harness: ""`
  passes `validate()` and quietly turns off both the tool check and the model
  check.

## An empty or missing model name passes the check and quietly takes another model

- **Area**: devex
- **Severity**: medium
- **What I did**: Validated and ran three flows on `harness: claude`:
  `model: haiku`, `model: ""`, and `model:` (null).
- **What happened**: `a6-claude-emptymodel.yaml` (`model: ""`) and
  `g1-nullmodel.yaml` (`model:`) both validate `OK`. `model: ""` ran as
  `claude-sonnet-5` and cost $0.0219; the same one-line prompt on `haiku` cost
  $0.0132. A user who meant to name a model and left the value empty pays for a
  bigger model and is told nothing. `model: " "` is refused correctly
  (`names the model " ", which the harness "claude" cannot read`), so the
  grammar check exists — the empty string just never reaches it.
- **What I expected**: `model: ""` is refused with the same sentence as
  `model: " "`, or the run says which model it fell back to.
- **Where**: `src/flow.ts:909` (`if (!named …) return []`) and
  `src/claude.ts:56,76` (a falsy model skips both the check and `--model`).

## `orchy runs` names no harness, no model and no cost

- **Area**: observability
- **Severity**: medium
- **What I did**: Ran fourteen flows across both harnesses and both models, then
  `node /home/user/orchy/src/cli.ts runs`.
- **What happened**:

  ```
  f8ff435e-…  failed   d1-mixed               2026-08-11T22:06:40.025Z
  3faf9b17-…  done     e6-emptytools-read     2026-08-11T22:06:05.174Z
  f6c11e61-…  failed   a4-claude              2026-08-11T22:05:05.454Z
  ```

  Four columns: id, status, flow, time. The daemon's own list of the same runs
  carries `cost` and `tokens`, and the page draws them. From the command line a
  person cannot tell which harness ran, which model answered, or what any run
  spent, without opening `.orchy/runs/<id>/trajectory.json` by hand. `state.json`
  holds no total either — only a `cost` per step.
- **What I expected**: The list that README calls "what you get from a run" says
  what a run cost, on the harness it used.
- **Where**: `src/cli.ts` `runs` command, `src/run.ts:list`.

## `GET /api/health` reports harnesses that cannot run and tools that a harness does not supply

- **Area**: observability
- **Severity**: low
- **What I did**: `curl http://127.0.0.1:4102/api/health` on a machine where the
  `pi` binary and `~/.pi` are absent, then ran a pi step.
- **What happened**:

  ```json
  {"adapters":["pi","claude"],"tools":["read","bash","edit","write","grep","find","ls","web"],…}
  ```

  Every pi step fails in about 60 ms with `No API key found for openai`, and the
  answer that the editor draws its harness picker from still lists `pi` beside
  `claude` with nothing to tell them apart. `tools` is the union of both rows of
  `SUPPLIES`, so the editor offers `web` under pi; the mistake is caught after
  the fact by the problem line (`step "say" asks for the tool "web", and the
  harness "pi" has none`), which is the right gate but the wrong moment for a
  control that should never have offered the choice.
- **What I expected**: A route called health says whether each harness can run,
  and names the tools each one supplies, since `SUPPLIES` already sits beside
  `ADAPTERS` for exactly this reason.
- **Where**: `src/server.ts:42-51`.

## The run page and the drawing say "the default" for a harness the flow names

- **Area**: ui
- **Severity**: low
- **What I did**: Opened `#/runs/<id>` for `f1-impossible` (flow declares
  `harness: claude`, `model: haiku`) and the editor for `e1-web-on-pi` (flow
  declares `harness: pi`, `model: openai/gpt-5`).
- **What happened**: The run page step panel reads `harness / the default`. The
  step node in the drawing reads `say / the default`. Neither view shows the
  harness or the model that the flow declares one line above them, so the two
  places that answer "what ran this step" answer wrongly.
- **What I expected**: The step shows the harness and model it will really use:
  its own, else the flow's, else "the default of the run".
- **Where**: `ui/src/Run.tsx:501` and `ui/src/Graph.tsx:596` — both read
  `step.harness` and never fall back to `flow.harness`.

## The claude adapter names the step twice in one sentence

- **Area**: ux
- **Severity**: low
- **What I did**: Ran `a4-claude.yaml` with `model: no-such-model`.
- **What happened**:

  ```
  — failed
    step "say" failed: step "say" could not run the claude command: There's an
    issue with the selected model (no-such-model). It may not exist or you may
    not have access to it.
  ```

  The adapter writes `step "say" …` and the runner writes `step "say" failed: `
  in front of it. Pi's messages do the same (`step "say" failed: step "say"
  reached no answer…`).
- **What I expected**: One name for one step.
- **Where**: `src/claude.ts:93,107,111` and `src/pi.ts:205,209,213` prefix a step
  name that `src/run.ts` adds again at the run level.

## An empty tool list makes a step that cannot work, and it still passes

- **Area**: ux
- **Severity**: low
- **What I did**: `e6-emptytools-read.yaml`: `harness: claude`, `model: haiku`,
  `tools: []`, prompt "Read the file marker.txt … answer with the exact word it
  holds, or with the word denied if you cannot read it."
- **What happened**: `validate()` said OK, the step ended `done`, and the value
  of the flow was 1,500 characters of the model arguing with itself:
  `"ok": "I need to read the file first. Let me use a tool to do that… Looking at
  the available tools, I only have StructuredOutput. However, the instructions
  mention I should prefer dedicated tools…"`. Cost $0.0126. The tool limit does
  hold — the model reached nothing — but Claude's own system prompt keeps telling
  it that Read, Edit, Write, Glob and Grep are there, so it spends its turn on
  the contradiction and Orchy calls the result a pass.
- **What I expected**: An agent step with no tools is worth a word from
  `validate()`, since only a step that needs no tool at all can use one.
- **Where**: `src/claude.ts:73,75` sends `--tools ""` and `--allowedTools ""`.

## What held up

- `validate()` refuses a wrong-grammar model before any spend, whenever the flow
  or the step names its harness: `anthropic/claude-haiku` under claude, `haiku`
  under pi, and `" "` under claude all fail with the right sentence and the right
  advice (`Write a plain model name, as "opus"`).
- `validate()` refuses a tool that does not exist (`browse`, and `READ` for
  case), and `web` under pi, naming the step and the harness.
- `model: no-such-model` on claude fails in 7 s with the harness's own words —
  `There's an issue with the selected model (no-such-model). It may not exist or
  you may not have access to it` — and spends nothing.
- Precedence works exactly as ADR 0012 states: the step beats the flow, the flow
  beats `--harness`. Proved with one run where step one took claude from the step
  and step two took pi from the flow, under `--harness claude`.
- All eight tool names map on claude: a step with
  `[read, bash, edit, write, grep, find, ls, web]` runs, and the duplicate
  `find`/`ls` → `Glob` is de-duplicated.
- Invariant 1 holds on claude: a step with `tools: [read]`, asked to run `id`
  with Bash, answered `denied`.
- Cost, tokens and the model name land on a claude run that passes — in
  `state.json`, in `trajectory.json` (`claude-haiku-4-5-20251001`, $0.0132, 606
  tokens), in `/api/runs`, and on the page.
- The daemon's start door refuses an invalid flow with the validate message, and
  refuses an unknown harness name at register and at start
  (`there is no harness "gpt". Use one of: pi, claude`).
- A flow that names a harness no adapter holds never starts a step; the CLI says
  `step "say" names the harness "codex", which this run does not have`, and the
  page shows the ticket as `did not start` with that same reason and a Dismiss
  button.
- `orchy run --harness gpt` ends with 2 and lists the harnesses that exist.
