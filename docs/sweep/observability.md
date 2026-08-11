## A failed agent step records no cost and no trajectory, so the money and the model's own explanation are lost

- **Area**: observability
- **Severity**: high
- **What I did**: `contract.yaml` on `harness: claude`, `model: haiku`, one step whose
  contract is impossible (`count: { type: number, minimum: 100, maximum: 1 }`), prompt
  `Answer with the number 7.`. Started it through `POST /api/flows/3/runs`, then read
  `.orchy/runs/1ce38a33-e21d-4b5d-ab2d-837d56ab2ed3/state.json`,
  `trajectory.json`, `GET /api/runs`, and the run page.
- **What happened**: the step ran the model for 39 seconds over 6 API responses
  (52 input, 2044 output, 30596 cache-read, 7114 cache-write tokens, counted from the
  Claude transcript). The whole record of it is this:

  ```json
  {
   "startedAt": "2026-08-11T22:09:07.029Z",
   "endedAt": "2026-08-11T22:09:46.282Z",
   "status": "failed",
   "error": "step \"count\" ended with no value for its contract",
   "prompt": "Answer with the number 7. ..."
  }
  ```

  No `cost`, no `trajectory` handle. So `trajectory.json` holds
  `"final_metrics": {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0, "cost_usd": 0, "total_steps": 1}`
  and no `subagent_trajectories`. `GET /api/runs` gives `"cost": 0, "tokens": 0`.
  The run page reads: `took 39s · cost — · tokens —` and
  `trajectory: orchy/contract · ATIF-v1.7 · model unknown · 1 step · 0 tokens`.

  The model had already said exactly why it failed, and that sentence is gone from
  the record. It is only in `~/.claude/projects/.../b634e288-….jsonl`:

  > I'm unable to call the StructuredOutput tool due to a schema configuration error.
  > The tool requires the `count` parameter to satisfy contradictory constraints:
  > `must be >= 100` (minimum), `must be <= 1` (maximum). No value can satisfy both.

  The runs the same model finished cost $0.0116 to $0.0207 each, so this failure cost
  at least that and reads as free.
- **What I expected**: a failed agent step keeps its cost and its trajectory handle,
  because README invariant 4 says "Every attempt counts", and ADR 0019 and
  `src/run.ts:855` say "A step that broke a rule spent its tokens all the same".
- **Where**: `src/claude.ts:104-113` throws a plain `Error` on `is_error`,
  a non-`success` subtype, and a missing `structured_output`, dropping
  `answer.total_cost_usd` and the session id it already holds.
  `src/run.ts:841-849` then keeps a trajectory handle only if the thrown error
  carries one, and never keeps a cost.

## The token counts are the number of transcript lines times the real usage, and the cache-write tokens are dropped

- **Area**: observability
- **Severity**: high
- **What I did**: ran `half.yaml`, one `agent` step, `model: haiku`, prompt
  `Answer with the word hi.`. Then compared
  `.orchy/runs/b7982f2b-…/trajectory.json` with the Claude transcript
  `~/.claude/projects/.../8d27140f-….jsonl` that Orchy itself parsed.
- **What happened**: the step made **one** API call. Its real usage is
  `input_tokens 9, output_tokens 143, cache_read 0, cache_creation 5115`.
  The Claude CLI writes that one response as three transcript lines
  (`thinking`, `text`, `tool_use`), each carrying the same `usage` object.
  Orchy adds them all up:

  ```
  $ jq .final_metrics .orchy/runs/b7982f2b-89c8-4fa3-8efb-6e5a59598aca/trajectory.json
  { "prompt_tokens": 27, "completion_tokens": 429, "cached_tokens": 0, "cost_usd": 0.011631, "total_steps": 2 }
  ```

  27 = 9×3. 429 = 143×3. The 5115 cache-creation tokens — the largest part of the
  real consumption — are counted nowhere. `GET /api/runs` shows `"tokens": 456`
  for a step that really moved 5267 tokens.

  The `good` run repeats it: 2 API responses (in 18, out 431, cache-read 4708,
  cache-write 5105) become `prompt_tokens 44, completion_tokens 988, cached_tokens 14124`
  (10+10+8+8+8, 305+305+126+126+126, 0+0+4708+4708+4708).
- **What I expected**: one API response counted once, and
  `cache_creation_input_tokens` counted somewhere.
- **Where**: `src/claude.ts:270-280` gives every assistant entry the message's
  `usage`, and `src/claude.ts:139` pushes each into `metrics`, which
  `src/atif.ts:totalMetrics` sums. Nothing de-duplicates by API response.

## While a run works you cannot learn what it has spent, and a run that stops never says

- **Area**: observability
- **Severity**: high
- **What I did**: ran `half.yaml` — one `agent` step on `haiku`, then a `call` step that
  ticks for 90 seconds. Followed `GET /api/events`, polled `GET /api/runs`, and read
  `state.json` while the second step ran. Then `POST /api/runs/:id/stop`.
- **What happened**: after the agent step ended, `state.json` held
  `steps: [('one', 'done', 0.011631)]`, and at the same moment:

  ```
  --- row while step one is done and step two runs ---
  status running cost None tokens None
  ```

  No event in either stream carries a cost. `step_end` is
  `{"type":"step_end","step":"one","status":"done"}` — no cost, no tokens, no value,
  no length. `GET /api/runs/:id/trajectory` answers
  `{"error":"the run … has written no trajectory yet"}` for the whole run, because
  `trajectory.json` is written once, at the end.

  After the stop, that never repairs itself:

  ```
  row: stopped cost None tokens None endedAt None
  state: stopped steps [('one', 'done', 0.011631)]
  ```

  The run page shows `took — · steps done 1/2 · cost — · tokens —` for a run
  that spent $0.0116. The runs list shows both stopped runs as `— — —`.
  A person who kills a runaway agent flow can never find out what it cost.
- **What I expected**: the total spend so far, live; and a stopped run keeps the cost
  of the steps that finished.
- **Where**: `src/run.ts:366-371` writes `trajectory.json` only in `close()`.
  `src/store.ts:metricsAt` reads that file, so `rowOf` gets no cost until then.
  `src/cli.ts:284-295` `stopRun` writes `status: "stopped"` and no trajectory.

## When a run's process dies the reason a person reads is a Node warning about package.json, and the ticket never clears

- **Area**: observability
- **Severity**: high
- **What I did**: started `watch.yaml` with `beats: 60`, found the run's own child
  (`ps --ppid <my daemon>`), and `kill -9` on it. Then read `GET /api/queue` and
  the runs page. Repeated by pressing stop through `POST /api/runs/:id/stop`.
- **What happened**: `GET /api/queue` keeps the ticket for ever, with this as the
  reason the run ended:

  ```json
  {"ticket":1,"flowName":"watch","runId":"bb6fe9a6-…",
   "error":"(node:15842) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///…/talk.ts is not specified and it doesn't parse as CommonJS.\nReparsing as ES module because module syntax was detected. This incurs a performance overhead.\nTo eliminate this warning, add \"type\": \"module\" to …/package.json.\n(Use `node --trace-warnings ...` to show where the warning was created)"}
  ```

  The page prints that verbatim under the heading **"did not start"** — for a run that
  ran 16 steps of work. The signal that really killed it (SIGKILL) is read nowhere.

  The same happens to a run stopped through the API: ticket 4 below belongs to the
  `half` run, which I stopped, then resumed, and which then finished `done`. The
  queue still shows it, still "did not start", still quoting the Node warning:

  ```
  $ curl -s http://127.0.0.1:4105/api/queue
  2 tickets
  1 bb6fe9a6-…  '(node:15842) [MODULE_TYPELESS_PACKAGE_JSON] Warning: …'
  4 b7982f2b-…  '(node:17258) [MODULE_TYPELESS_PACKAGE_JSON] Warning: …'
  ```

  The page header reads `12 runs · 2 in the queue` and never goes back to 0.
- **What I expected**: the reason names the signal or the exit code, a run that
  produced events is not called "did not start", and a ticket for a finished run goes.
- **Where**: `src/daemon.ts:184-192` — `if (code !== 0 && !job.settled) job.error =
  job.stderr.trim() || \`the run ended with the code ${code}\``. Any noise on stderr
  wins over the fallback, and the `signal` argument of `close` is not read.
  `src/daemon.ts:97` keeps the ticket while `job.error` is set.

## A run whose process died keeps saying "running" in the file the project calls the truth, and one answer holds two statuses

- **Area**: observability
- **Severity**: high
- **What I did**: `kill -9` on my own run's child, then `GET /api/runs/:id`.
- **What happened**:

  ```
  row.status = stopped
  state.status = running state.pid = 15842
  --- is pid 15842 alive? --- no
  ```

  One JSON answer, two statuses. ADR 0009 says "A row can disagree with the file that
  it describes, and the file wins. A reader that wants the truth of one run reads
  `state.json` through `GET /api/runs/:id`." Here the file is the one that is wrong,
  and it stays wrong until the daemon restarts and `index()` reconciles it. `orchy runs`
  from the command line reads the file only, so it prints
  `bb6fe9a6-…  running  watch` for a run whose process has been gone for ten minutes.

  Nothing writes a `run_end` event either. After I killed my daemon mid-run and
  started a new one on the same directory, the restarted daemon marked the run
  `stopped` in the row and the file, but `GET /api/runs/:id/events` still ends like this:

  ```
  {"type":"run_start","runId":"e983ed00-…"}
  {"type":"step_start","step":"talk"}
  ```

  — a run that starts a step and never ends, for ever. `abandon()` does emit a
  `run_end`, so a stop by hand and a stop by death read differently in the log.
- **What I expected**: the state on disk says `stopped`, and the event log says the
  run ended and why.
- **Where**: `src/store.ts:index()` repairs `state.json` and the row but adds no event.
  `src/daemon.ts:record()` marks the row `stopped` on close and leaves the file alone.
  `src/cli.ts:rowOf` (the `orchy runs` table) never checks `alive(state.pid)`.

## What a deterministic step says is written nowhere, so a daemon restart erases it

- **Area**: observability
- **Severity**: medium
- **What I did**: ran `watch.yaml`, a single `call` step that says `beat 1 of 5` …
  `beat 5 of 5` through `say`. Watched them arrive on `GET /api/events`. Then killed my
  daemon, started a new one on the same directory, and read
  `GET /api/runs/db0bd849-…/events` again.
- **What happened**: before the restart the replay held all five notes. After it:

  ```
  {"type":"run_start", …}
  {"type":"step_start","step":"talk", …}
  {"type":"step_end","step":"talk","status":"done", …}
  {"type":"run_end","status":"done", …}
  ```

  The five notes are gone. `.orchy/runs/db0bd849-…/trajectory.json` holds one step,
  `"message": "step \"talk\" ended done"`, and nothing the step said. So for a `call`
  step, the notes exist only in daemon memory, for the last 20 runs, and then never
  again anywhere.
- **What I expected**: ADR 0011 says "A note is a view, not a record… The trajectory
  holds the whole of it, so nothing is lost." That is true for an agent step and false
  for a deterministic one, and ADR 0011's last paragraph says a deterministic step
  "reports through the same events".
- **Where**: `src/daemon.ts:117-129` holds an `output` event in memory and returns
  before `store.addEvent`. `src/atif.ts:toAtif` writes no note for a step with no
  harness trajectory.

## The trajectory records a tool result before the call that produced it, and its timestamps run backwards

- **Area**: observability
- **Severity**: medium
- **What I did**: read `.orchy/runs/b7982f2b-…/trajectory.json` and the transcript
  it was built from.
- **What happened**: the Claude CLI wrote the `tool_result` line to its JSONL before
  the `tool_use` line, although the entries' own timestamps say the opposite. Orchy
  reads lines in file order and numbers them by position, so the ATIF child trajectory
  is:

  ```
  4 2026-08-11T22:17:45.790Z system  obs ['toolu_01VkevcGsveDXGXsbjyBAmwF']
  5 2026-08-11T22:17:45.762Z agent   tools ['StructuredOutput']
  ```

  `step_id` 4 observes a call that appears at `step_id` 5, and its timestamp is later
  than the one after it. The live stream carries the same inversion, so the page's
  activity list shows `Structured output provided successfully` above
  `StructuredOutput {"said":"hi"}`. ADR 0003 says a converter turns this file into
  OpenTelemetry spans; a converter would build a child span before its parent.
- **What I expected**: steps in causal order, sorted by their own `timestamp`.
- **Where**: `src/claude.ts:126-145` numbers a step by its position in the file and
  never sorts by `entry.timestamp`.

## `final_metrics` does not use the field names ADR 0003 and the README promise, and `total_steps` leaks into a step's metrics

- **Area**: observability
- **Severity**: medium
- **What I did**: ran the README line
  `jq .final_metrics .orchy/runs/<run id>/trajectory.json`.
- **What happened**:

  ```json
  { "prompt_tokens": 27, "completion_tokens": 429, "cached_tokens": 0, "cost_usd": 0.011631, "total_steps": 2 }
  ```

  ADR 0003 says the file "holds `final_metrics` with `total_prompt_tokens`,
  `total_completion_tokens`, `total_cached_tokens`, and `total_cost_usd`, which covers
  the measurement that a user needs", and the README repeats the `jq` line as the way
  to read a run's cost. A tool that reads ATIF v1.7 finds none of those four keys.

  Separately, a parent step's `metrics` object carries `total_steps`, which is not a
  metric of that step and not part of the `Metrics` type:

  ```json
  "metrics": {"prompt_tokens": 66, "completion_tokens": 3149, "cached_tokens": 21258,
              "cost_usd": 0.0206529, "total_steps": 11}
  ```
- **What I expected**: the names the ADR pins, and a step's metrics holding only metrics.
- **Where**: `src/atif.ts:12-17` (`Metrics`) and `src/atif.ts:88` write the short names;
  `src/atif.ts:57` assigns `child.final_metrics` — a `Metrics & { total_steps }` — as a
  step's `metrics`.

## The timeline of a run is only in the index, which the project calls disposable

- **Area**: observability
- **Severity**: medium
- **What I did**: answered questions about a finished run from
  `.orchy/runs/<id>/` alone, as a person would a week later.
- **What happened**: the directory holds only `state.json` and `trajectory.json`. From
  them I could get: what each step cost, how long it took, the prompt Orchy really sent,
  the value, the changed paths, and what the model said in a step that passed. I could
  not get: the order and the clock of `step_start` / `step_end` / `skip` / `cycle` /
  `waiting`, because those live only in `.orchy/index.db`, which ADR 0009 says is an
  index that `index()` rebuilds — and `index()` rebuilds run rows and no events.
  `store.trim()` also drops the events of any run past the newest 200.

  So the two things that make a run readable after the fact — the event timeline and
  the notes — are both in the one file the project says you may lose, while the run
  directory itself has no log at all.
- **What I expected**: a run directory that answers "what happened, in order" without
  a database.

## A run that stops has no length, for ever

- **Area**: observability
- **Severity**: medium
- **What I did**: stopped a run, then looked at `GET /api/runs` and the page.
- **What happened**: `"endedAt": null` on a `stopped` row, so the list and the run page
  both print `took —`. Two of my runs have been stopped for a quarter of an hour and
  still report no length. The page also still says `1 done · 1 running` for the stopped
  run and `This step has not ended yet.` under the step that was killed.
- **What I expected**: a stopped run ends at the moment it stopped.
- **Where**: `src/store.ts:rowOf` — `endedAt` is set only when the status is `done` or
  `failed`.

## The global event stream sends no history

- **Area**: observability
- **Severity**: low
- **What I did**: opened `GET /api/events` while nothing was happening, then again
  after a run finished.
- **What happened**: the only thing that arrives is `{"kind":"queue","pending":[]}` and
  then a `: beat` comment every 20 seconds. `GET /api/runs/:id/events` replays a run's
  past, but the global stream never does, so a person who opens the runs list learns
  nothing until the next event fires. Events on the global stream also carry only a
  `runId` — no flow name — so two runs at once cannot be told apart without a second
  request.
- **Where**: `src/server.ts:stream()` — the replay block is inside `if (runId)`.

## A budget refusal says what was spent, not what the next step would have cost

- **Area**: observability
- **Severity**: low
- **What I did**: `budget.yaml` with `budget: 0.005` and two `haiku` agent steps.
- **What happened**:

  ```
  the run reached the budget of the flow "budget": it spent $0.0116 of $0.005. It stops before the next step.
  ```

  It does not name the step it refused (`two`), and it gives no estimate of what that
  step would have cost, so a person cannot tell whether raising the budget by a cent
  would finish the run or whether five more steps wait behind it.
- **What I expected**: the message names the step it stopped before.
- **Where**: `src/run.ts:109-110`.

## What held up

- A cycle's cost is exact: three attempts of `work` at $0.011794, $0.011811 and
  $0.011645 sum to the run's $0.03525, and the two dropped attempts are marked
  `"dropped": true` in the trajectory with their own child trajectories.
- The live note stream is rich and honest: the filled-in prompt, the reasoning, every
  tool call with its arguments, every tool result, and the model's text, each cut to
  400 characters, arriving within about 250 ms of the harness writing the line.
- `GET /api/runs/:id/events` merges the stored events and the in-memory notes back into
  one ordered replay, so a person joining a run in progress sees it from the start.
- The failure of an unsupplied prompt value is instant, free, and exact:
  `step "greet" reads "{{ nobody }}" in its prompt, and nothing supplies "nobody".
  Add it to "takes" on the flow, or to "with" on the step.`
- A model name the harness cannot reach fails with the harness's own words:
  `step "one" could not run the claude command: There's an issue with the selected
  model (nosuchmodel). It may not exist or you may not have access to it.`
- Killing my daemon mid-run and starting a new one on the same directory correctly
  re-marked the dead run `stopped`, exactly as ADR 0009 says.
- `state.json` keeps the prompt Orchy really sent, the values the run took, and the
  changed paths with the kind of each change — so a passing step is fully readable
  from the run directory alone.
- The run page follows the acting step by itself and offers `Fix it and resume from
  <step>` on a failure, without being asked.
