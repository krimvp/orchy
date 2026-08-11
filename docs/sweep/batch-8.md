## A workspace Orchy cannot read kills the run outside the step, and the run is filed as `stopped` with no reason

- **Area**: functional
- **Severity**: high
- **What I did**: a flow whose workspace path does not exist, and one free `call` step that promises `nothing`:

  ```yaml
  name: bad-workspace
  workspace: { kind: git, path: ./nowhere }
  steps:
    - id: quiet
      kind: call
      module: quiet.ts
      changes: nothing
      returns: { type: object, required: [ok], properties: { ok: { type: boolean } } }
  ```

  `node /home/user/orchy/src/cli.ts run flows/15-bad-workspace.yaml --harness claude`. Ran twice, then a third time as an exit-code probe. Then `orchy runs`, then `GET /api/runs/<id>` from a daemon on 4118.
- **What happened**: stderr, whole:

  ```
  ◆ b45d7130-fae5-4f12-a7c5-375fa4b8aef4
  ▶ quiet
  the workspace at "/tmp/.../batch-8/nowhere" is not a git repository
  ```

  No `✗ quiet`, no `— failed`, and stdout is 0 bytes, so nothing prints the state. What was persisted:

  ```json
  { "runId": "b45d7130-...", "status": "running", "steps": {}, "cycles": {}, "pid": 6510 }
  ```

  `orchy runs` showed it as `running` while the pid was still thought live, and as `stopped` later. The API agrees: `"status": "stopped"`, `"endedAt": null`, and no `error` field anywhere in the row or the state. A run that a person stopped and a run that died because its workspace is missing are the same record. The reason existed only on one terminal's stderr, and one of my three attempts is still sitting at `status: running` on disk.
- **What I expected**: `status: failed` with the reason in `error`, the same as every other step failure.
- **Where**: `src/run.ts:816` — `const before = take(state.flow.workspace, cwd)` sits outside the `try` that turns a step fault into a failed record, so the throw escapes `runStep` and `execute` without ever writing an ending status. (The message is also wrong in the plain case: the directory does not exist at all, and it is reported as "is not a git repository". `src/workspace.ts:34`.)

## `changes: { except: [...] }` silently allows everything when the path is spelled `./src`

- **Area**: functional
- **Severity**: high
- **What I did**: two flows, each with a `call` step that writes `src/sneaky.ts`, in a repo whose workspace is `{ kind: git, path: . }`:

  ```yaml
  changes: { except: ["./src"] }     # flow 13b
  changes: { except: [srcc] }        # flow 13, a plain typo
  ```

  Ran each twice.
- **What happened**: all four runs, exit 0:

  ```
  ▶ writes
    writes │ wrote src/sneaky.ts
  ✓ writes
  — done
  ```

  and the step record contradicts its own verdict:

  ```
  writes done [{"path":"src/sneaky.ts","how":"added"}]
  ```

  The run recorded the write into `src`, and passed a promise to change nothing in `src`. `validate()` accepted both flows without a word. It does refuse `except: ["src/**"]` ("A promise holds a name, not a pattern"), so it is already inspecting these strings — it just does not notice that `./src` and `srcc` match nothing in the workspace.
- **What I expected**: either `./src` normalises to `src` and the run fails, or `validate()` refuses a promise about a path the workspace does not hold. ADR 0013 calls a rule that looks enforced and is not "the fault this project rates as the most expensive", and `./` is the natural spelling here because the workspace on the line above is written `path: .`.
- **Where**: `src/run.ts:906` — `under()` is a raw string prefix test, so `"src/sneaky.ts".startsWith("./src/")` is false. `src/flow.ts:655` `changesProblems()` checks for pattern characters and nothing else.

## "I checked the workspace and nothing moved" and "I never looked" are the same record

- **Area**: observability
- **Severity**: high
- **What I did**: two runs. `nothing-kept` — a git workspace, a step that promises `nothing` and writes nothing. `no-workspace` — no `workspace` field at all, and a step that writes `src/sneaky.ts`. Ran each twice, and opened both on the page at `#/runs/<id>`.
- **What happened**: the step records are the same fields with the same values:

  ```
  # nothing-kept, run 8c3fe6d1 — checked, promise held
  { "startedAt": "...", "endedAt": "...", "status": "done", "value": { "ok": true } }

  # no-workspace, run 9a27c2d6 — never watched, and src/sneaky.ts was added
  { "startedAt": "...", "endedAt": "...", "status": "done", "value": { "ok": true } }
  ```

  `git status --porcelain -uall` after the second: `?? src/sneaky.ts`. The pages are the same too — both say `DONE / This run is done`, both show `1 done`, and neither mentions a workspace. `changed` is written only when something moved (`src/run.ts:857`), so its absence carries two opposite meanings, and nothing else in `RunState` or in the page distinguishes them. The only trace is `state.flow.workspace` being `undefined`, which a reader has to know to look for and interpret.
- **What I expected**: three visibly different outcomes — a promise checked and kept, a promise checked and broken, and a step nobody could check. The first and third are currently one.
- **Where**: `src/run.ts:857`, `src/run.ts:146` (`RunState` has no field for "this run watched nothing"), `ui/src/Run.tsx:581`.

## The promise is judged on the net diff, so the same step passes or fails depending on the tree it started from

- **Area**: functional
- **Severity**: high
- **What I did**: one flow, `changes: nothing` on a `call` step that writes `src/thing.ts` with exactly the text the repository holds. Ran it twice: once with `src/thing.ts` modified beforehand, once from a clean tree. Nothing about the flow or the module changed between the two.
- **What happened**:

  ```
  # 11-a, tree dirty before the run
  ✗ restores
    step "restores" promises to change nothing, but it restored src/thing.ts
  — failed

  # 11-b, tree clean before the run — identical flow, identical module
  ✓ restores
  — done
    restores done []
  ```

  Two more shapes of the same hole, all free `call` steps:
  - `net-zero` (twice, `done`): the step overwrites `src/thing.ts` with `export const x = 666;`, then writes the old text back. It wrote into a tracked source file under `changes: nothing` and the record says `changed []`.
  - `nothing-broken` re-run (`03-b`, `done`): the step writes `docs/written.md`, which a previous run had already left there with the same bytes. The first run of the same flow failed with "promises to change nothing, but it added docs/written.md"; the second passed.
  - the paid step, same flow file both times: `agent-writes` on claude/haiku `failed` when `docs/agent-made.md` was absent, and `done` when the file was already there.
- **What I expected**: a promise about what a step may write should not change its verdict because of work someone else left in the tree. At minimum a run should say which baseline it judged against.
- **Where**: `src/workspace.ts:41` `changed()` compares two snapshots by content hash, so any write whose net effect is zero is invisible to invariant 5. This is a consistent consequence of the design in ADR 0013, but nothing in the README or `docs/shape.md` states it, and the guarantee as written ("fails when anything else moved") reads stronger than what runs.

## A step that made a file and removed it again leaves no trace at all

- **Area**: observability
- **Severity**: medium
- **What I did**: flow `record-truth`, three `call` steps under `{ kind: git, path: . }`: delete the tracked `docs/notes.md`; write a file one directory above the workspace; create `docs/transient.md` and immediately delete it. Ran twice.
- **What happened**:

  ```
  gone      done [{"path":"docs/notes.md","how":"deleted"}]
  outside   done []
  transient done []
  ```

  The delete is recorded properly. The other two steps have no `changed` key, which by the previous finding is indistinguishable from "this step touched nothing". The `outside` step's own return value holds the absolute path it wrote (`/tmp/.../hunt/outside-the-workspace.txt`), so the run state literally contains the evidence in the value while the provenance record says nothing. The README does state that a step writing outside the workspace moved nothing Orchy can see; it does not say the same about a file that existed only during the step, and that is the case a reader auditing "what did this agent do" most wants.
- **What I expected**: the transient file at least visible in the activity record, or a stated limit that provenance is a before/after diff and not a log of writes.

## The daemon indexes the runs directory once, so a run started at the command line never reaches the page

- **Area**: ui
- **Severity**: medium
- **What I did**: started `orchy daemon --port 4118` in my directory, then ran `orchy run flows/16-rename.yaml` in the same directory from a second shell, then `GET /api/runs` and opened `#/runs/<the new id>`.
- **What happened**: `GET /api/runs` returned 33 rows and none of them was the new run, re-checked after five seconds. `GET /api/runs/d4749317-...` returned the run fine, so the state on disk is there and only the index is stale. On the run page the consequence shows as:

  ```
  started
  Invalid Date
  took
  —
  ```

  because the page reads `startedAt` from the index row, which does not exist. An indexed run on the same page says `started 4 min ago`.
- **What I expected**: the page lists every run in its root, or at least does not print `Invalid Date`.
- **Where**: `src/daemon.ts:79` — `store.index(runs)` is called once inside `daemon()` and never again; nothing watches `.orchy/runs`.

## The page throws away where a renamed file went

- **Area**: ui
- **Severity**: medium
- **What I did**: a `call` step running `git mv docs/notes.md src/notes.md`, promising `{ paths: [docs] }`. Ran twice, opened the run page.
- **What happened**: the record and the error keep both halves:

  ```
  "changed": [{ "path": "docs/notes.md", "to": "src/notes.md", "how": "renamed" }]
  step "moves" promises to change only docs, but it renamed docs/notes.md to src/notes.md
  ```

  The step panel on the page shows:

  ```
  changed
  renamed docs/notes.md
  ```

  The destination is gone, and for a rename the destination is the whole point — it is the half that left the promised paths. The engine's own wording (`src/run.ts:898`) appends ` to <to>`; the page does not.
- **Where**: `ui/src/Runs.tsx:188` — `said()` renders `${one.how} ${one.path}` and ignores `one.to`.

## A promise written on the flow is invisible on every step of the page

- **Area**: ui
- **Severity**: medium
- **What I did**: flow `except` with `changes: { except: [src] }` at flow level and two `call` steps, one writing `docs/`, one writing `src/`. Opened the run page and read the step panel of the step that broke it.
- **What happened**: the step panel shows `kind`, `needs`, `module`, `status`, `took`, `changed`, `what went wrong` — and no `Promise` row, even for the step that just failed its promise. The same panel does show `promise: changes only docs` when the promise is written on the step (the `rename` flow). So a step that is under a promise looks unpromised, and a reader has no way to see what rule the flow put on it.
- **What I expected**: the panel to show the promise the engine actually applied, which is `step.changes ?? flow.changes`. This hits the README's own advertised example — `examples/docs-audit`, described as "one promise on the flow, which the workspace checks on every step" — where no step would show a promise at all.
- **Where**: `ui/src/Run.tsx:540` renders the row only `{step.changes && ...}`, while the engine resolves it through `changesOf()` at `src/flow.ts:285`.

## A missing flow file and an invalid flow exit 1, the same as a run that failed

- **Area**: devex
- **Severity**: low
- **What I did**: four commands, each `; echo $?`:

  ```
  run flows/17-gate-promise.yaml   (invalid flow)   => 1
  run flows/no-such-file.yaml      (no such file)   => 1
  run flows/15-bad-workspace.yaml  (dead workspace) => 1
  run flows/05-paths-broken.yaml   (a real failure) => 1
  ```
- **What happened**: all four are 1. `orchy --help` says "It ends with 0 when a run finishes, 1 when a run fails, 2 when the command itself is wrong". Exit 2 is reserved for argv faults only (`orchy run` with no file, an unknown verb). A script cannot tell "your flow file has a typo in it" from "the agent broke its promise", which are opposite things to do next.
- **Where**: `src/cli.ts:37` `EXIT`, and the `Wrong` class which only argv parsing throws.

## A run's total cost is nowhere in the run

- **Area**: observability
- **Severity**: low
- **What I did**: ran the paid `agent-writes` flow and read `.orchy/runs/<id>/state.json`, then `orchy run`'s printed state.
- **What happened**: the cost lives on the step (`"cost": 0.014966499999999999`) and nowhere else. `RunState` has no total, and the CLI never prints one — the `— failed` line is the last thing it says. To answer "what did this run cost" from the command line you must parse the JSON and sum `steps[*].cost` plus `history[*].record.cost`, which is what I had to write to report my own spend. The daemon's index does compute a per-run `cost` column, so the page has the number and the CLI does not.
- **What I expected**: one line from `orchy run` saying what the run spent, given that a budget is an advertised feature.

## What held up

- Every promise message names the kind of change and not just the path: `added docs/written.md`, `deleted docs/notes.md`, `renamed docs/notes.md to src/notes.md`, `restored src/thing.ts`, `moved HEAD`. That wording made every failure self-explaining.
- A step that commits fails a promise about paths, and the error says `moved HEAD` exactly as ADR 0013 promises it would.
- A dirty tree before a run is handled correctly at the baseline: pre-existing untracked and modified files never appear in any step's `changed`, only what the step itself moved.
- `.orchy/` is excluded from the record even when it is not in `.gitignore` — my first run wrote `.orchy/runs/*/state.json` into the tree and no step reported it.
- `validate()` refuses `changes` on a `gate` before the run: `step "ask" holds "changes", which a gate step cannot act on. Only an agent or a call step holds it.`
- `validate()` refuses a promise on a flow with no workspace, before the run: `step "writes" promises what it changes, but the flow has no workspace to check it`.
- A promise on the outer flow reaches the steps of an inner flow: `step "inner/writes" promises to change nothing, but it added src/sneaky.ts`.
- The step that broke its promise kept its cost (`0.0150`) and its trajectory id, and the daemon's index carries that cost for a failed run — a broken promise does not lose the money it spent.
- `workspace: { kind: none }` and no workspace at all both run without complaint and cost nothing, which is what ADR 0006 says they should do.
- The paid claude/haiku step was caught by invariant 5 on the first try: the model created `docs/agent-made.md` under `changes: nothing`, the run failed and named the file. The check works against a real model, not just a `call` step.

**Spend: $0.0319** across 39 runs (two agent runs on claude/haiku, at $0.0150 and $0.0169; every other run was `call`/`gate` only and free).
