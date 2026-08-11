## A `flow` step escapes `validate()` completely — every field on it is dropped in silence

- **Area**: functional
- **Severity**: high
- **What I did**: in my own directory, with a valid `ok.yaml` beside it, I wrote a step of
  kind `flow` carrying fields that `HOLDS` says a flow step cannot act on, and ran it.

  ```yaml
  name: fw4
  steps:
    - id: b
      kind: flow
      flow: ok.yaml
      tools: [read]
      prompt: p.md
      changes: nothing
      fanout: [{ name: x }]
  ```
  `node /home/user/orchy/src/cli.ts run fw4.yaml`

- **What happened**:
  ```
  ◆ edd357ea-f95d-452b-b999-a48d4205f4df
  ▶ b/one
  ✓ b/one
  — done
  EXIT=0
  ```
  Not one word about `tools`, `prompt`, `changes`, or `fanout`. The same test with a
  condition proves the field is not merely unread but actively dropped:

  ```yaml
    - id: b
      kind: flow
      needs: [a]
      flow: ok.yaml
      when: { a: { n: 999 } }     # "a" returns { n: 1 }
  ```
  ```
  ▶ a
  ✓ a
  ▶ b/one
  ✓ b/one
  — done
  ```
  The identical `when` on a `call` step is honoured:
  ```
  ⊘ b does not run
    "a" does not say {"n":999}
  ```

- **What I expected**: `step "b" holds "tools", which a flow step cannot act on.`, the
  sentence `validate()` already produces for every other kind.

- **Where**: `src/cli.ts:199` calls `loadFlow`, and `src/load.ts:36` runs `expandFlows`
  *before* `src/run.ts:200` calls `validate()`. By the time the check runs, no step of
  kind `flow` is left in the flow, so `HOLDS.flow` in `src/flow.ts:527` is dead code on
  the CLI path. This is exactly the fault `docs/shape.md` Finding 1 says it closed, and
  `AGENTS.md` calls the most costly one in the project — reopened for one whole kind of
  step. `docs/shape.md` still advertises `flow step | flow`, `with`, `cycle` as a closed
  set that "`validate()` refuses every field that this table does not name".

## The "New flow" scaffold writes a flow that does not run, and puts the harness you picked in the database instead of the file

- **Area**: devex
- **Severity**: high
- **What I did**: started `orchy daemon --port 4104` in an empty directory, then used the
  editor's New flow (driven in Chromium) and the endpoint behind it:
  ```
  curl -X POST http://127.0.0.1:4104/api/flows/new -H "Origin: http://127.0.0.1:4104" \
       -H "Content-Type: application/json" -d '{"name":"second","harness":"claude"}'
  ```
  then ran the file it wrote, from the CLI, in the same directory.

- **What happened**: the API answers
  ```
  {"id":2,...,"name":"second","harness":"claude","addedAt":"..."}
  ```
  but the YAML it wrote names no harness and no model at all:
  ```yaml
  name: second
  workspace:
    kind: git
    path: .
  budget: 5
  steps:
    - id: work
      kind: agent
      prompt: prompts/work.md
      tools: [read, grep, find, ls]
      changes: nothing
      returns: {type: object, required: [summary], properties: {summary: {type: string}}}
  ```
  `orchy run flows/second/flow.yaml`:
  ```
  ✗ work
    step "work" reached no answer. The model answered: UnrecognizedClientException:
    The security token included in the request is invalid.. Read the message of the
    provider: this is not the step, and not the contract.
  ```
  The same file started through the daemon finishes `done`, `$0.0865`, because
  `src/daemon.ts:170` passes `--harness <row.harness>` from the SQLite row. So one file,
  two harnesses, depending on who starts it.

  In an empty directory that is not a git repository — the ordinary case for a fresh
  daemon root — the scaffolded flow does not even reach the model:
  ```
  ◆ 2ff01cc1-b62f-4dc9-a123-d980e85e26db
  ▶ work
  the workspace at ".../daemonroot" is not a git repository
  ```
  The editor screenshot after "Create it" shows the contradiction plainly: the dialog
  offered me a harness picker, and the flow panel that opens two seconds later reads
  `harness: the default of the run`, `model: the default of the harness`, with a green
  `valid` badge.

- **What I expected**: the scaffold writes the harness I picked, writes a model (the
  README says "the default of Pi is a model that most machines cannot reach. So name
  one." — and then its own scaffold does not), and does not declare a git workspace it
  never checked exists.

- **Where**: `src/server.ts:162-192`. `const harness = adapterOf(body.harness)` is used
  only in `daemon.store.addFlow(path, flow.name, harness)`; the `flow` object built two
  lines below carries no `harness` and no `model`. `docs/shape.md` Finding 4 named this
  exact fault ("ADR 0009 says the index is not the run. A setting that changes the result
  of a run should not live there") and the scaffold reintroduces it.

## There is no way to check a flow without starting a run

- **Area**: devex
- **Severity**: medium
- **What I did**: `node /home/user/orchy/src/cli.ts --help`, and looked for a check
  command; then `grep '"/api' src/server.ts`.
- **What happened**: the CLI has `run`, `resume`, `runs`, `daemon`. The daemon has
  `POST /api/validate`, which answers cleanly:
  ```
  {"problems":["the flow has no steps"],"warnings":[]}
  ```
  The CLI exposes no equivalent. To learn whether a flow is well formed you must type
  `orchy run` and let it start a run — and for a valid flow that means spending money to
  find out you were right.
- **What I expected**: `orchy check flow.yaml`, exit 0 or 2, no run written to `.orchy`.
  `validate()` is the product's central promise (the README names it five times) and the
  command line cannot call it.

## `--harness` is accepted and ignored when the flow names a harness

- **Area**: devex
- **Severity**: medium
- **What I did**: `node /home/user/orchy/src/cli.ts run examples/triage/flow.yaml --harness claude`
  (`triage` declares `harness: pi`).
- **What happened**:
  ```
  ✗ read
    pi does not know the model "ollama/gpt-oss:120b"
  — failed
  ```
  No note that `--harness` was overridden or unused. `--help` documents the flag as
  `[--harness pi|claude]` and never says it applies only to a flow that names none; only
  a code comment in the README does. This is a flag Orchy cannot act on, passing in
  silence — the thing `AGENTS.md` says must never happen.
- **What I expected**: either the flag wins, or `orchy` says `the flow "triage" names the
  harness "pi", so --harness claude does nothing`.
- **Where**: `src/cli.ts:95` reads the flag; `src/flow.ts:271` `harnessOf` gives the flow
  the last word.

## Half the shipped examples cannot be run, and nothing in the command can redirect them

- **Area**: devex
- **Severity**: medium
- **What I did**: copied `examples/` to my own directory and ran `triage` as shipped, with
  `ISSUE.md` in place as the table demands.
- **What happened**:
  ```
  "error": "pi does not know the model \"ollama/gpt-oss:120b\""
  ```
  `triage`, `docs-audit`, `release-notes`, and `decision` — four of the eight — name
  `harness: pi` with an `ollama/*` model. `examples/README.md` says a pi flow "needs the
  provider in `~/.pi/agent/models.json`", i.e. a running Ollama server the reader must
  supply, and there is no flag that moves them onto the harness the reader does have.
  Editing the shipped file is the only route. When I did edit my copies (`harness:
  claude`, `model: haiku`) all four ran correctly and cheaply — `docs-audit` $0.0495,
  `release-notes` $0.0433, `triage` a few cents.
- **What I expected**: the newcomer's first `orchy run examples/...` succeeds, or the
  table says loudly which examples need a second piece of software installed first. The
  README lists all eight as "Eight flows in examples" with no such warning.

## Nothing says how to get the `orchy` command, and the Install block ends in a command that fails

- **Area**: devex
- **Severity**: medium
- **What I did**: followed the README Install section literally:
  `git clone … && cd orchy && npm install` then `node src/cli.ts run flow.yaml`.
- **What happened**:
  ```
  there is no flow file at "/home/user/orchy/flow.yaml". Name a file that is there, as a path from this directory.
  EXIT=1
  ```
  There is no `flow.yaml` in the repository, so the last line of the install instructions
  cannot work. And every other code block on the page — fifteen of them — begins `orchy
  run`, `orchy resume`, `orchy daemon`, while `which orchy` finds nothing.
  `grep -n "npm link\|npm i -g\|npx orchy\|alias orchy\|PATH" README.md docs/running.md`
  returns nothing.
- **What I expected**: the install block ends with a command that works (`node src/cli.ts
  run examples/triage/flow.yaml`), and one line saying `npm link` or `alias orchy="node
  $PWD/src/cli.ts"` so the rest of the page is executable.

## A flow in TypeScript cannot be written outside the checkout

- **Area**: devex
- **Severity**: medium
- **What I did**: copied the README's TypeScript block verbatim into my own directory and
  ran it; then tried the package name that `package.json` exports.
- **What happened**:
  ```
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../ts/src/index.ts' imported from .../ts/flow.ts
  ```
  ```ts
  import { agent, flow } from "orchy";
  ```
  ```
  Cannot find package 'orchy' imported from .../ts/f2.ts
  ```
  and a copy of a shipped TypeScript example outside the repo:
  ```
  Cannot find package '@sinclair/typebox' imported from .../ex/code-review/flow.ts
  ```
- **What I expected**: one working import specifier for a flow file in my own project.
  The README sells the TypeScript API prominently ("`agent()` is generic over its
  contract, so TypeScript catches a `cycle.when` key that the step never returns") but the
  only import path that resolves is `../../src/index.ts` from inside the checkout, and no
  document says so. `orchy` is not on npm, so `import from "orchy"` cannot work either.

## A flow file that is a directory gets a raw Node error naming Orchy's own source

- **Area**: devex
- **Severity**: medium
- **What I did**: `node /home/user/orchy/src/cli.ts run .`
- **What happened**:
  ```
  Directory import '/tmp/.../hunt/devex/errs' is not supported resolving ES modules imported from /home/user/orchy/src/load.ts
  EXIT=1
  ```
- **What I expected**: `"…/errs" is a directory, not a flow file. Name a .yaml, .yml, or
  .ts file.` Every other bad-path case in the CLI is handled well; this one leaks an
  internal file and offers no fix.
- **Where**: `src/load.ts:16-18` — `existsSync` passes for a directory, then the `.ya?ml`
  test fails and it falls through to `import()`.

## Exit codes do not match what `--help` promises

- **Area**: devex
- **Severity**: medium
- **What I did**: ran twelve wrong commands and recorded `$?` against the contract in
  `--help`: *"0 when a run finishes, 1 when a run fails, 2 when the command itself is
  wrong, and 3 when a run waits for a person."*
- **What happened**:

  | command | exit |
  | --- | --- |
  | YAML that does not parse | 1 |
  | flow with no steps / duplicate id / missing need | 1 |
  | flow file that does not exist | 1 |
  | flow file that is a directory | 1 |
  | `--with '{oops'` | **2** |
  | `--with` the flow refuses (`the flow "ok" takes no values…`) | 1 |
  | run id that does not exist | 1 |
  | `--from` a step that does not exist | 1 |
  | port already taken | 1 |
  | unknown command | 2 |
  | gate waiting | 3 |

  A broken file and a rejected `--with` produce no run, no run id, and nothing in
  `.orchy` — yet they report 1, the code reserved for "a run fails". Meanwhile a
  malformed `--with` reports 2. A CI script cannot tell "your YAML is broken" from "the
  model failed the contract".
  Two smaller inconsistencies: `orchy` with no arguments prints the usage to **stdout**,
  while `orchy wibble` prints the same usage to **stderr**.
- **What I expected**: anything Orchy refuses before a run starts exits 2.

## A run whose process dies before the first step stays `running` forever

- **Area**: observability
- **Severity**: medium
- **What I did**: piped a run into `head`, which closed the pipe and killed it; and
  separately let the git-workspace check kill a run at start. Then `orchy runs`.
- **What happened**:
  ```
  cd59c420-7a8c-45fb-b508-8050c7217ca1  running  code-and-review
  ```
  and `state.json` holds `"status": "running"`, `"steps": {}`, no error, forever. The
  daemon's row for the same shape of failure says `"status":"stopped"`,
  `"endedAt":null`, `"cost":null` with no error field; the error text survives only
  inside the `pending[].error` of the queue, which never clears:
  ```
  [{"ticket":1,...,"error":"the workspace at \".../daemonroot\" is not a git repository"}]
  ```
  (The page itself does draw a `did not start` banner with that text, so a browser user
  is told; `orchy runs` and `GET /api/runs` are the two places that are not.)
- **What I expected**: `orchy runs` marks a run whose pid is gone as failed or
  interrupted. `orchy resume` already detects it correctly —
  `the run … says it runs, and the process that drove it has gone. Name the step to run
  again, with --from.` — so the knowledge exists and the listing does not use it.

## A gate asks you to judge a value it never shows you

- **Area**: ux
- **Severity**: medium
- **What I did**: ran `examples/triage` (with the harness switched to claude/haiku) to its
  gate.
- **What happened**:
  ```
  ⏸ confirm waits for a person
    Do you agree with the sort? Answer with {"agreed":true} or with
    {"agreed":false,"kind":"bug","severity":"high"} to correct it.

  answer with: orchy resume 3a9c1a2c-1d0b-40d7-8324-c7336f73424c '<json value>'
  ```
  The sort itself — `kind: bug`, `severity: high`, five missing facts — appears nowhere.
  To answer I had to run
  `jq -r '.steps.read.value' .orchy/runs/<id>/state.json`.
- **What I expected**: the gate prints the values of the steps it needs, or at least names
  the file to read. The resume line is otherwise excellent (exact run id, exact command,
  exit 3).

## A missing `call` module blames Orchy's own source file

- **Area**: devex
- **Severity**: low
- **What I did**: `module: nope.ts` on a call step.
- **What happened**:
  ```
  step "a" cannot load its module at "/…/errs/nope.ts": Cannot find module '/…/errs/nope.ts' imported from /home/user/orchy/src/run.ts
  ```
- **What I expected**: the first half of that sentence, plus `A module path is relative to
  the flow file.` — the wording the prompt case already uses (`step "a" has no prompt at
  "…". A prompt path is relative to the flow file.`). The tail naming `src/run.ts` sends a
  reader into Orchy's source for a mistake in their own file.

## A `call` module in an ordinary Node project prints a Node warning that gives bad advice

- **Area**: devex
- **Severity**: low
- **What I did**: ran any flow with a `call` step from a directory whose nearest
  `package.json` lacks `"type": "module"`.
- **What happened**, in the middle of the event stream:
  ```
  (node:22781) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///…/gather.ts is not
  specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was
  detected. This incurs a performance overhead.
  To eliminate this warning, add "type": "module" to /…/scratchpad/package.json.
  ```
  It fires on the shipped `examples/dependency-audit/gather.ts` and
  `examples/release-notes/log.ts`. The remedy it names is to edit a `package.json` the
  user may not own and which may be CommonJS on purpose. Nothing in the README or
  `docs/shape.md` mentions that a `call` module must be ESM or live under a
  `"type": "module"` package.
- **What I expected**: one line in the docs about what a `call` module is, or the warning
  suppressed on the child that loads it.

## `docs/shape.md` against `src/flow.ts`

I checked every row of the "What a flow holds" table against `FLOW_HOLDS`,
`HOLDS`, `MEMBER_HOLDS`, `FANOUT_HOLDS`, `CHANGES_HOLDS`, and `OPERATORS`.

- Every field the table names is real and spelled the same way. Every field the code takes
  is in the table, with one exception: the flow row never names `steps`, though
  `FLOW_HOLDS` includes it and the table claims to hold "every field that runs today".
  Cosmetic.
- The one place the document promises a rule the code does not deliver is `flow step`. The
  table lists it as holding `flow`, `with`, `cycle`, and the sentence under the table says
  "`validate()` refuses every field that this table does not name". It does not, for that
  kind — see the first finding.
- Everything else the document claims about `validate()` is true; see below.

## What held up

- All five `validate()` claims in the README are real and each message names the step and
  the fix: `step "a" asks for the tool "web", and the harness "pi" has none`;
  `the flow promises what it changes, but it has no workspace to check it`;
  `step "a" names the model "provider/model", which the harness "claude" cannot read.
  Write a plain model name, as "opus".`; `step "a" takes "zzz", and nothing supplies it.
  Add "zzz" to "takes" on the flow, or to "with" on the step.`;
  `step "a" holds "tool", which an agent step cannot act on.` — with the second sentence
  `step "a" has no "tools", and an agent step needs one` on the same run.
- Broken YAML gives the file, the line, the column, and a caret.
- `two steps use the id "a"`, `step "a" needs "ghost", which does not exist`,
  `step "a" has no "returns", and a call step needs one` — all name the thing and the fix.
- `another program listens on 127.0.0.1:4104. Name a free port with --port.`
- The daemon's boundary messages are the best writing in the product:
  `the flow at "…" is outside the root "…". Put the flow file under the root.`,
  `there is already a file at "…". Register it instead.`,
  `the page at "http://evil.com" is not this daemon, so it starts nothing here. Open the
  page at http://127.0.0.1:4104.`
- The gate cycle works end to end: exit 3, the exact resume command, and
  `orchy resume <id> '{"agreed":true}'` finishes the run.
- `orchy resume` on a run whose process died says so and tells you to use `--from`.
- `⊘ upgrade does not run / "gather" does not say {"risky":true}` — a skipped step
  explains itself in one line.
- `npm test`: 215 tests, 0 failures, 50s, and the repository was byte-identical
  afterwards. Loud (raw TAP, every test followed by a `duration_ms` block) but honest.
- `npm run check`: 11s, silent, clean.
- `npm run ui:build` (run against a copy of `ui/`, not the repo): 12s install, 10s build,
  no warnings, 278 kB of JS.
- Once the harness is switched to one that exists, the examples do what they claim.
  `dependency-audit` ran the fanout, the gather, the retry, and correctly ruled out
  `upgrade` — six steps, $0.124. `docs-audit` ran both members of its fanout in one wave
  under a flow-level `changes: nothing` — $0.0495. `release-notes` ran its deterministic
  git step and both agents — $0.0433.
