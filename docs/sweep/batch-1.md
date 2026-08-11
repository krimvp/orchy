## A branch that is ready waits for an unrelated branch to finish

- **Area**: functional
- **Severity**: medium
- **What I did**: wrote `f07-two-branches.yaml`: two branches that never meet, all
  `call` steps, no `parallel` field so the width is 8. Branch P is `p1` (200ms)
  → `p2` (900ms). Branch Q is `q1` (200ms) → `q2` (200ms) → `q3` (200ms). Every
  module writes a monotonic timestamp at its start and its end. Ran it three
  times: `node /home/user/orchy/src/cli.ts run f07-two-branches.yaml`.
- **What happened**: the same shape all three times (ms from the first start):

  ```
  run 1                       run 2                       run 3
  p1  start=0.0   end=202.8   p1  start=0.0   end=200.2   p1  start=0.0   end=200.8
  q1  start=0.4   end=204.0   q1  start=0.3   end=201.4   q1  start=0.3   end=202.2
  p2  start=205.3 end=1106.0  p2  start=204.4 end=1105.0  p2  start=204.3 end=1111.0
  q2  start=205.5 end=406.0   q2  start=204.5 end=405.0   q2  start=204.4 end=404.9
  q3  start=1107.4 end=1310.9 q3  start=1112.0 end=1312.8 q3  start=1125.5 end=1441.2
  maxConcurrent 2             maxConcurrent 2             maxConcurrent 2
  ```

  `q3` needs only `q2`, and `q2` passed at ~406ms. `q3` did not start until
  ~1110ms, when `p2` — a step on a branch it never touches — finished. Never
  more than two steps ran at once, so the width of 8 was not the bound. The run
  took ~1310ms where the critical path is 900+200 = 1100ms, and the gap grows
  with the length of the fast branch.
- **What I expected**: a step whose needs have passed starts when they pass, not
  when every other step of the current wave has finished.
- **Where**: `src/run.ts:392` — `ready` is computed once, then
  `await pool(work, parallel, …)` at `src/run.ts:452` awaits the whole wave
  before the loop recomputes `ready`. Every wave is a barrier. `README.md` says
  "A wave runs every step whose needs have passed at the same time", which reads
  as continuous readiness; the barrier and its cost are in no document. With
  agent steps of minutes rather than call steps of milliseconds, a three-step
  branch behind one long step doubles the wall time of a run and nothing says
  why.

## A flow with two ends returns one of them, and which one depends on the order of the file

- **Area**: functional
- **Severity**: medium
- **What I did**: `f02-two-wave.yaml` holds two `call` steps, `a` and `b`, that
  need nothing and that nothing needs. The flow declares no `returns`. Ran it,
  then copied it to `bad/two-wave-swapped.yaml` with `b` written first and ran
  that, then wrote `bad/two-exits-returns.yaml` — the same graph with a
  flow-level `returns` — and ran that.
- **What happened**: both steps passed in both runs. The run value did not.

  ```
  f02-two-wave        -> run value: {"id":"a","ms":600,"saw":[]}
  two-wave-swapped    -> run value: {"id":"b","ms":50,"saw":[]}
  ```

  Same graph, same two ends, one line of the file moved, a different answer for
  the whole run. The other end's record is still under `steps`, but no event and
  no field says that the run had a second end and dropped it — the run reads as
  if `value` were the answer of the flow. With a `returns` on the flow the same
  shape is refused, and the
  message is a good one:

  ```
  the flow is not valid:
  - the flow returns one value, but it ends in 2 steps: "a", "b". A flow that returns a value ends in one step.
  ```

- **What I expected**: either the same refusal when the flow declares no
  `returns`, or a run value that says it dropped an end. Silently picking the
  end that appears first in the YAML is the one answer that cannot be right.
- **Where**: `src/run.ts:578` — `valueOf` takes `exitsOf(state.flow.steps)[0]`,
  and `exitsOf` (`src/flow.ts:266`) filters the steps in file order, not in
  dependency order. `returnProblem` at `src/run.ts:74` only runs when the flow
  declares `returns`.

## Every command loads the Pi SDK, so a flow with no agent step still pays ~1.6s

- **Area**: devex
- **Severity**: medium
- **What I did**: timed, five times interleaved so a busy machine cannot skew the
  minimum: bare Node, importing `src/flow.ts`, importing the Pi SDK, and
  `node src/cli.ts --version`.
- **What happened** (best of five, milliseconds):

  ```
  node -e '1'                                      43
  import src/flow.ts                              213
  import @earendil-works/pi-coding-agent         1561
  node src/cli.ts --version                      1605
  ```

  `orchy --version` prints one line and costs 1.6s, essentially all of it the Pi
  SDK. `src/cli.ts:8` imports `./pi.ts` at the top, `src/pi.ts:2-10` imports the
  whole coding-agent SDK at the top, and `src/run.ts:33` imports it again. So
  `orchy runs`, `orchy run` on a flow of pure `call` steps, and every child
  process the daemon starts for a run pay it. My one-step flow with 400ms of work
  took 2.28s of wall clock; the run itself was 400ms.
- **What I expected**: a command that starts no Pi agent does not load the Pi
  SDK. The daemon already does this correctly for `node:sqlite` and `server.ts`
  — `src/cli.ts:229` imports those behind `await import(…)` for exactly this
  reason.

## Nothing a person can read says when a step started, so a wave is invisible

- **Area**: observability
- **Severity**: medium
- **What I did**: ran `f09-parallel-eight.yaml` (12 `call` steps, one wave,
  `parallel: 8`, each 600ms) from the daemon at 127.0.0.1:4111, then opened
  `#/runs/<id>` and its trajectory view in Chromium, then read
  `.orchy/runs/<id>/trajectory.json`.
- **What happened**: the run page reports the run as `took 1s`, `steps done
  12/12`, and each step, when chosen, shows one time field: `Took`. The
  trajectory view lists twelve rows, each `1s`. Neither view shows a start time,
  so a reader cannot tell that the wave was capped and four steps queued. The
  file underneath holds it:

  ```
  t1 start+0ms   end+637ms      t7  start+25ms  end+654ms
  t2 start+25ms  end+639ms      t8  start+25ms  end+656ms
  …                             t9  start+638ms end+1241ms
                                t12 start+652ms end+1256ms
  ```

  Twelve steps of 600ms each in a run that took 1.25s is the whole point of a
  wave, and the page cannot say it. Durations are also rounded with
  `Math.round(millis / 1000)` (`ui/src/Runs.tsx:192`), so every step of my
  deterministic flows reads `0s` or `1s`; a 400ms step reads `0s`.
- **What I expected**: a start time beside the duration, or a strip that draws
  the wave, given that `state.json` and `trajectory.json` both already hold
  `startedAt` and `endedAt` per step.
- **Where**: `ui/src/Run.tsx:564` shows only `Took`; `ui/src/Runs.tsx:192`
  rounds to whole seconds.

## A save through the editor moves `needs` above `id` on every step that has one

- **Area**: devex
- **Severity**: low
- **What I did**: copied `f04-diamond.yaml` to `roundtrip.yaml`, registered it
  with `POST /api/flows`, read it back with `GET /api/flows/5`, and sent that
  same flow back with `PUT /api/flows/5` — the round trip the editor performs on
  every save. Answer: `{"problems":[],"saved":true}`.
- **What happened**: the file on disk now reads

  ```yaml
    - id: split
      kind: call
      module: tick.ts
    - needs:
        - split
      id: left
      kind: call
  ```

  A step with no needs keeps `id` first; a step with needs does not. One file now
  has two key orders, and the identifier of most steps is no longer the first
  thing on the line. Every `{ ... }` in the file also expands to block form, so
  a one-field change in the drawing produces a diff over the whole file.
- **What I expected**: `id` stays first. ADR 0010 accepts losing comments and
  anchors and says fields go "in the order of the data", but the order here is an
  artifact: `src/yaml.ts:26` builds each step as `{ needs: [], ...step }`, which
  puts `needs` first for any step that declares one. `{ ...step, needs: … }`
  reads the same and writes the file a person wrote.
- **Where**: `src/yaml.ts:26`.

## A flow file that cannot run and a run that failed leave the same exit code

- **Area**: devex
- **Severity**: low
- **What I did**: ran six flows that `validate()` refuses (`bad/dup.yaml`,
  `bad/ghost.yaml`, `bad/loop.yaml`, `bad/selfneed.yaml`, `bad/nosteps.yaml`,
  `bad/p-abc.yaml`) and one flow whose step throws
  (`bad/wave-throw.yaml`), and read `$?` for each.
- **What happened**: every one ended `1`, the same code as a run that started and
  failed. `orchy --help` states the contract: "It ends with 0 when a run
  finishes, 1 when a run fails, 2 when the command itself is wrong". A flow file
  that no run can start is the command being wrong — no run directory is even
  created — but CI cannot tell "your YAML is broken" from "the agent failed".
- **What I expected**: `2` for a flow that `validate()` refuses, or a line in the
  help that says a refused flow ends with 1.
- **Where**: `src/cli.ts:245` — only a `Wrong` gets `EXIT.usage`; everything
  thrown out of `run()`, including `refuse(validate(flow))`, gets `EXIT.failed`.

## The editor draws a twenty-step chain five screens wide, with no zoom and no fit

- **Area**: ui
- **Severity**: low
- **What I did**: registered `f06-chain-twenty.yaml` (20 `call` steps in a line)
  and opened `#/flows/1` at 1280×900.
- **What happened**: five steps are on screen. The canvas is a single strip:
  `scrollWidth 5112`, `clientWidth 1188`, `overflow-x: auto`. It scrolls, so
  nothing is lost, but there is no zoom, no fit-to-view, and no minimap
  (`ui/src/Graph.tsx` holds no zoom or scale at all). The hint under the drawing
  says "Drag a step's right dot onto another to link them", which for `c1` and
  `c20` means a drag across four screens that the browser will not autoscroll.
- **What I expected**: a way to see a whole flow of twenty steps at once, given
  that the editor is offered as the way to build a flow.
- **Where**: `ui/src/styles.css:656` (`.canvas`, `overflow-x: auto`, no scale).

## What held up

- A wave really is a wave: two steps started 0.3ms apart and the pair took 602ms,
  six started inside 1.1ms and took 605ms — one step's worth of time, three runs
  each.
- `parallel` bounds a wave exactly: `parallel: 1` gave one step at a time in file
  order (1209/1213/1213ms for 4×300ms), `parallel: 8` and the default both held
  12 steps to 8 at once, three runs each.
- The pool refills rather than running fixed groups: in every run of the twelve,
  `t9` started within 3ms of `t1` ending, not after all eight finished.
- A join waits for the slowest branch and for nothing else: `after` started 1.4ms
  after the 900ms middle ended, and its inputs held exactly its two needs.
- A chain of twenty ran strictly in order with ~4–8ms of engine overhead per step
  (2076–2153ms for 2000ms of sleep).
- File order does not matter: a flow whose last step is written first ran in
  dependency order.
- Every malformed shape I tried was refused before any run directory existed, in
  one plain sentence each: a repeated id, a need that does not exist, a loop, a
  step that needs itself, no steps, an empty id, and `parallel` of `abc`, `0`,
  and `2.5`. The infinite spin on `parallel: abc` that `docs/usability.md`
  reports is closed.
- One step throwing in a six-wide wave: the other five finished and kept their
  values in `state.json`, and the run ended `failed` with
  `step "bad" failed: boom from bad` — the reason, not the class of the error.
- The daemon's child process scheduled a run exactly as the CLI did, and the page
  indexed forty runs made outside it.
- Notes from six concurrent steps interleaved on the console without ever losing
  which step said what: every line carries its step id.

**Spend: $0.00.** Every step of this batch is a `call` step; no agent step ran.
