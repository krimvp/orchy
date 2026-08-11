## A flow that names itself loops until the process dies, and it takes the daemon with it

- **Area**: functional
- **Severity**: high
- **What I did**: `f7-self.yaml` is one step, `kind: flow`, `flow: f7-self.yaml`. I bounded it
  before running it: `timeout -s KILL 45 node --max-old-space-size=192 /home/user/orchy/src/cli.ts run f7-self.yaml`.
  Then the same through the daemon: registered the file (`POST /api/flows`), read the flow page,
  pressed run (`POST /api/flows/9/runs`), and watched the daemon's RSS every 5s.
  I also tried two files that name each other (`f7b-ping.yaml` -> `f7c-pong.yaml` -> `f7b-ping.yaml`).
- **What happened**: nothing bounds it. From the CLI, 19s of 100% CPU and then

  ```
  FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
  ```

  The mutual pair did the same, in 33s. Through the daemon it is worse. The flow page reported
  the flow clean:

  ```
  problems [] warnings []
  ```

  and the POST never answered. While the loader spun, the daemon answered nothing at all —
  `curl http://127.0.0.1:4117/api/health` returned `000` three times in a row — and its memory
  climbed `161MB -> 501MB` before the log ended with the same `FATAL ERROR ... heap out of memory`.
  The daemon process was gone. Its queue, its four run slots, and every run it was supervising
  went with it. No run was ever recorded, so `.orchy/runs` holds nothing for it and the person who
  pressed the button is told nothing. (I capped my daemon at `--max-old-space-size=384` on purpose;
  with the default heap it eats gigabytes of the machine first.)
- **What I expected**: a flow file that reaches itself is refused when it loads, naming the loop,
  the way `validate()` refuses a cycle that runs backwards — and in no case should one flow file
  take down a daemon that is running other people's work.
- **Where**: `src/flow.ts:412` `expandFlows` recurses through `load` with no depth limit and no set
  of files already opened; `src/load.ts:36` is the recursion; `src/server.ts:601` runs it inside
  the daemon process, so the loop is not in a child.

## An inner flow's `returns` is dropped, so the same flow passes as a sub-flow and fails alone

- **Area**: functional
- **Severity**: high
- **What I did**: `inner/liar.yaml` declares `returns: {type: object, required: [absent], ...}` and its
  one step returns `{who: "inner-echo"}`. I ran it alone, then ran `f9b-inner-liar.yaml`, whose only
  step is `{ kind: flow, flow: inner/liar.yaml }`.
- **What happened**: alone it fails, exit 1:

  ```
  — failed
    the value of "work" breaks what the flow "inner-liar" returns at "/": must have required property 'absent'
  ```

  As a sub-flow it passes, exit 0, twice:

  ```
  ▶ sub/work
  ✓ sub/work
  — done
  ```

  The outer flow's own `returns` *is* checked against the inner exit step (`probe-outer-returns.yaml`
  fails correctly), so the two directions disagree.
- **What I expected**: the contract a flow declares holds wherever the flow runs, or expansion
  refuses to drop it. ADR 0015 says `returns` is "checked at the end of the run"; used as a sub-flow
  there is no end of the run, and nothing says so.
- **Where**: `src/flow.ts:412` — `expandFlows` reads `inner.budget`, `inner.parallel`,
  `inner.workspace`, `inner.changes`, `inner.harness`, `inner.model` and `takes`, and never reads
  `inner.returns`.

## The values of a run cannot reach a sub-flow, and a constant `with` silently beats them

- **Area**: functional
- **Severity**: high
- **What I did**: `inner/returns.yaml` takes `{n: number}` and doubles it. Three outer flows, each
  `takes: {n: number}`, each run with `--with '{"n":5}'`:
  `probe-forward.yaml` (flow step with no `with`), `probe-forward-braces.yaml` (`with: { n: "{{ n }}" }`),
  `probe-forward-dummy.yaml` (`with: { n: 0 }`).
- **What happened**:

  ```
  probe-forward         the flow "inner-returns" takes values, and step "sub" supplies none. Supply the values that "takes" names.
  probe-forward-braces  the values step "sub" supplies break what the flow "inner-returns" takes at "/n": must be number
  probe-forward-dummy   done  {"n": 0}
  ```

  The first two are refused before the run starts. The third runs and answers `0`, because
  `valuesOf` lets the step's `with` win over the run's values — so the run's `n: 5` was thrown away
  in silence. There is no third option: a sub-flow that declares `takes` can only ever be given
  constants written into the calling file.
- **What I expected**: "So a sub-flow is reusable, and not fixed" (ADR 0015). A run for issue 412
  should be able to hand 412 to the sub-flow it calls — either by forwarding the run's values when
  the step supplies none, or by a name that resolves, as a prompt's `{{ n }}` does.
- **Where**: `src/flow.ts:446` (`takesProblem(inner, step.with, ...)` reads only `step.with`), and
  `valuesOf` in `src/run.ts` (the step's value wins over the run's).

## Nothing checks a flow step: `when`, `model`, `tools`, `changes` on one are all accepted and dropped

- **Area**: functional
- **Severity**: high
- **What I did**: `probe-when-false.yaml` puts a condition that can never hold on the flow step:
  `when: { first: { seen: { is: "never-matches" } } }`. `probe-junk-flowstep.yaml` puts
  `model: haiku`, `tools: [read]`, `changes: nothing` and `question: what?` on a flow step. I ran
  both, then called `validate()` on the same files through `readFlow` (no expansion), then
  registered `probe-junk-flowstep.yaml` with the daemon and pressed run.
- **What happened**: both flows ran to `done`. The condition that can never be true did not stop
  the sub-flow:

  ```
  ▶ first
  ✓ first
  ▶ sub/work
  ✓ sub/work
  — done
  ```

  `validate()` on the unexpanded file catches every one of them, with good sentences:

  ```
  step "sub" holds "when", which a flow step cannot act on. Only an agent, a call, or a gate step holds it.
  step "sub" holds "model", which a flow step cannot act on. Only an agent step holds it.
  step "sub" holds "tools", which a flow step cannot act on. Only an agent step holds it.
  step "sub" holds "changes", which a flow step cannot act on. Only an agent or a call step holds it.
  step "sub" holds "question", which a flow step cannot act on. Only a gate step holds it.
  ```

  Nothing on the running path ever calls it that way: `orchy run` and the daemon both go through
  `loadFlow`, which expands the flow step away, and only then validate. So the daemon's flow page
  prints those four problems and the Run button next to them starts the run anyway, which ends
  `done`. `HOLDS.flow` in `flow.ts` is a rule that looks enforced and is not — the fault
  `docs/shape.md` Finding 1 was written to close, for the one kind of step it left out.
- **What I expected**: a field a flow step cannot act on is refused before the run, exactly as it is
  on the other three kinds; and the daemon refuses to start a flow whose page it just called invalid.
- **Where**: `src/flow.ts:527` (`HOLDS.flow`), `src/load.ts:36` (expansion runs before any check),
  `src/run.ts:200`, `src/server.ts:601` (`start()` validates the expanded flow only), `ui/src/Editor.tsx:271` (Save is disabled by `problems.length > 0`, Run is not).

## A cycle back to a sub-flow re-runs only its last step, and a retry never fires when it fails early

- **Area**: functional
- **Severity**: medium
- **What I did**: `f-cycle-into-sub.yaml`: a flow step over `inner/pair.yaml` (steps `a` then `b`),
  then a gate `judge` with `cycle: { to: sub, when: { approved: false }, limit: 3, policy: accept }`.
  I ran it and answered `{"approved":false}`. Separately `f-retry-sub.yaml` puts
  `cycle: { to: sub, when: failed, limit: 2 }` on a flow step over `inner/badfirst.yaml`, whose
  *first* step throws.
- **What happened**: the cycle goes back into the middle of the sub-flow:

  ```
  ↻ judge goes back to sub/b (1)
  ▶ sub/b
  ✓ sub/b
  ⏸ judge waits for a person
  ```

  `sub/a` never ran again. And the retry of a whole sub-flow is not a retry of the sub-flow: after
  expansion it reads `{"id":"sub/b","needs":["sub/a"],"cycle":{"to":"sub/b","when":"failed","limit":2}}`,
  so when `sub/a` fails the cycle is on a step that never ran, and the run just ends:

  ```
  ▶ sub/a
  ✗ sub/a
    inner step exploded on purpose
  — failed
  ```
- **What I expected**: `to: <a flow step>` sends the run back to the beginning of that flow, and
  `when: failed` on a flow step retries the flow when any step of it fails. If the exit step really
  is the only target, `validate()` should say so where the person writes it.
- **Where**: `src/flow.ts:496` — `map.set(step.id, [id(exits[0].id)])` maps a flow step to its exit
  step alone, and `rename` uses that map for `needs` and for `cycle.to`.

## The editor cannot give a sub-flow the values it takes

- **Area**: ui
- **Severity**: medium
- **What I did**: opened `f3-inner-takes.yaml` in the editor (`#/flows/6`) and clicked the `sub` node.
- **What happened**: the whole step panel is

  ```
  the step
  id / kind / runs after / flow file / loop / Add a loop / Delete this step
  ```

  There is no field for `with`. The only "holds, as JSON" box in the editor belongs to a fanout
  member. So from the page a person can point a flow step at `inner/takes.yaml`, and can never
  supply what it takes — and `validate()` refuses a flow step that supplies none to a sub-flow that
  takes values, so the flow the editor produces cannot run at all.
- **What I expected**: the field the file supports (`FlowStep.with`, and `retype()` even preserves it)
  is drawable, the way a member's `with` is.
- **Where**: `ui/src/Editor.tsx:711` (the flow-step fields), `ui/src/Editor.tsx:1546` (the only `with` input).

## The editor calls a flow valid, and the daemon then refuses to start it

- **Area**: devex
- **Severity**: medium
- **What I did**: `f3b-no-with.yaml` is `f3-inner-takes.yaml` with the `with` line deleted.
  Registered it, read `GET /api/flows/7`, posted `POST /api/validate` with the same flow, then
  pressed run.
- **What happened**:

  ```
  problems [] warnings []
  ```

  then

  ```
  HTTP/1.1 400 Bad Request
  {"error":"the flow \"inner-takes\" takes values, and step \"sub\" supplies none. Supply the values that \"takes\" names."}
  ```

  `validate()` never opens the file a flow step names, so every rule about the boundary — the values,
  the inner budget, the inner workspace, the one exit — is invisible to the editor's lamp and to
  `/api/validate`. The lamp says `valid` with a green dot while the flow cannot run.
- **What I expected**: the check that reads a flow reads what its flow steps name, or the lamp says
  it cannot judge a flow that calls another one.
- **Where**: `src/server.ts:307` (`/api/validate`), `src/server.ts:215` (`GET /api/flows/:id` uses
  `readFlow`, which does not expand).

## A condition on the result of a sub-flow must name the inner flow's private step id

- **Area**: devex
- **Severity**: medium
- **What I did**: `probe-when-after-flow.yaml`: `after` has `needs: [sub]` and
  `when: { sub: { who: { is: inner-echo } } }`, where `sub` is the flow step right above it.
- **What happened**:

  ```
  the flow is not valid:
  - step "after" runs when "sub" matches, but it does not need "sub"
  ```

  It does need `sub` — the line is two rows up in the same file. The rename fixes `needs` and
  `cycle.to` and leaves `when` keys alone, so the only spelling that works is
  `when: { sub/work: { ... } }` (I ran it: that passes), which is the inner flow's own step id.
  Rename the last step of the inner flow and every caller breaks.
- **What I expected**: `when` keyed by the flow step id, renamed with `needs`; or a message that says
  which name to write.
- **Where**: `src/flow.ts:327` `rename()` maps `needs`, `cycle.to` and `fanout.step`, not `when`.

## A missing inner flow file names no step and no caller

- **Area**: devex
- **Severity**: low
- **What I did**: `node src/cli.ts run f6-missing-inner.yaml`, whose flow step names `inner/not-here.yaml`.
- **What happened**: exit 1, and one line with no run behind it:

  ```
  there is no flow file at "/tmp/.../batch-7/inner/not-here.yaml". Name a file that is there, as a path from this directory.
  ```

  It does not say which flow was being loaded, which step named the file, or that "this directory"
  means the directory of the flow file and not the working directory. In a two-level flow the same
  message is all you get for a file named three files down.
- **What I expected**: `step "sub" of "f6-missing-inner" names a flow at ..., and there is no file there`.
- **Where**: `src/load.ts:14`.

## The run page draws a sub-flow flat, with no sign of where it came from

- **Area**: ui
- **Severity**: low
- **What I did**: ran `f10-inner-fanout.yaml` (a fanout inside a sub-flow) and `f2-two-levels.yaml`
  from the daemon and read the run pages.
- **What happened**: the drawing, the activity list and the trajectory list all show
  `sub/each/alpha`, `sub/join`, `sub/deep/work` as plain steps in one flat graph. Nothing groups
  them, nothing names the file they came from, and nothing links back to it. The flow page for the
  same flow shows a single node `sub` with the subtitle `fanout.yaml` — the basename only, though
  the file says `inner/fanout.yaml`, so two inner flows of the same basename in different
  directories read identically. Between the two pages a reader has no way to see what the one node
  turned into except by reading the slashes.
- **What I expected**: the run page marks the steps that came from a flow step, or at least names the
  file once.
- **Where**: `ui/src/Graph.tsx`, `ui/src/Run.tsx`.

## What held up

- The `takes`/`with` messages across the boundary are the best in the product: no value
  (`the flow "inner-takes" takes values, and step "sub" supplies none`), a wrong type
  (`break what the flow "inner-takes" takes at "/n": must be number`) and an extra name
  (`the flow "inner-takes" does not take extra, and step "sub" supplies it`) each name the flow, the
  step, and the fix, and each stops the run before a step spends anything.
- An inner flow that holds a `budget`, a `parallel`, or a different `workspace` is refused with a
  sentence that explains why the field belongs to the run, not to a step.
- An inner flow that ends in two steps is refused: `ends in 2 steps, and step "sub" needs exactly one`.
- The tool check crosses the boundary in both directions and fires before any money moves:
  `step "sub/look" asks for the tool "web", and the harness "pi" has none` — both when the inner flow
  names `pi` under a `claude` outer flow and when the inner flow inherits `pi` from the outer one.
- A gate inside a sub-flow behaves exactly like a gate: the outer run stops at `sub/ask` with exit 3,
  the state persists, and both `orchy resume <id> '{"approved":true}'` and
  `POST /api/runs/:id/resume` finish the run and hand the answer to the outer step.
- Values of the run reach a call step inside a sub-flow (`echo sees values={"tag":"hello"}`), and a
  member's `with` inside a sub-flow's fanout reaches its module.
- Two levels deep (`sub/deep/work`), a fanout inside a sub-flow (`sub/each/alpha`), and a `../`
  module path inside an inner flow all expand and run correctly.
- One run, one run id, one page, one cost: the inner steps are steps of the outer run, and the
  `cost` column of the runs list is their sum ($0.0135 for the one paid step of `f8-harness-split`).
  There is no hidden second run to find.
- An agent step inside a sub-flow reads the outer steps' values in its prompt, and the harness and
  model of the inner flow ride onto it: the `pi` step of `f8` really tried `openai/gpt-5` while the
  outer step ran on `claude`/`haiku`.

Spend for this batch: **$0.0259** (two runs of `f8-harness-split`, $0.0135015 + $0.0123836; every
other run was `call` and `gate` steps only).
