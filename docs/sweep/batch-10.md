## A typo in the harness name turns off the tool check and the model check

- **Area**: devex
- **Severity**: high
- **What I did**: asked the daemon to validate a flow whose harness is `clade`
  (a typo for `claude`), with `tools: [web, telepathy]` and
  `model: openai/gpt-5`:

  ```
  curl -s -X POST http://127.0.0.1:4120/api/validate -H "Origin: http://127.0.0.1:4120" \
    -d '{"flow":{"name":"x","harness":"clade","model":"openai/gpt-5","steps":[{"id":"only",
        "kind":"agent","needs":[],"prompt":"prompts/tiny.md","tools":["web","telepathy"],
        "returns":{"type":"object","required":["word"],"properties":{"word":{"type":"string"}}}}]}}'
  ```

  and ran `node src/cli.ts run s-bad-harness.yaml`, a flow that says
  `harness: gpt-cli`.
- **What happened**: the check reports one problem and misses three:

  ```
  {"problems":["step \"only\" asks for the tool \"telepathy\", which does not exist"],"warnings":[]}
  ```

  Nothing about the harness `clade`, which does not exist; nothing about `web`,
  which no adapter would supply under that name; nothing about
  `model: openai/gpt-5`, which the intended harness cannot read. Under
  `harness: claude` the same two lines are both refused (I ran that: see
  `k-pi-web`, `e-wronggrammar`). From the command line the only refusal comes
  from the runner, not the check, and it names no alternative:

  ```
  step "only" names the harness "gpt-cli", which this run does not have
  ```

- **What I expected**: `validate()` names an unknown harness and lists the ones
  that exist, instead of quietly skipping the two checks the README advertises
  ("`validate()` refuses … a tool that the harness of the flow does not supply,
  a model name that the harness cannot read").
- **Where**: `src/flow.ts:877` and `src/flow.ts:908` — both read
  `ADAPTERS.includes(harness) ? … : undefined` and return no problem when the
  name is unknown; no rule anywhere checks the harness name itself. The runner
  catches it later at `src/run.ts:624`.

## A flow that names no harness gets no tool check and no model check either

- **Area**: functional
- **Severity**: high
- **What I did**: wrote `q-no-harness.yaml` — no `harness` on the flow or the
  step, `model: haiku`, `tools: [web]` — and ran it three ways:

  ```
  node src/cli.ts run q-no-harness.yaml
  node src/cli.ts run q-no-harness.yaml --harness claude
  POST /api/flows {"path":"q-no-harness.yaml","harness":"pi"}   then POST /api/flows/15/runs
  POST /api/flows {"path":"q-no-harness.yaml","harness":"claude"} then POST /api/flows/15/runs
  ```

- **What happened**: `validate()` said nothing in any of them. The default run
  starts, prints the prompt, and dies inside the step:

  ```
  ✗ only
    pi has no tool for "web"
  — failed
    step "only" failed: pi has no tool for "web"
  ```

  The same file with `--harness claude` ran to `done` and cost `$0.011988`. A
  sibling flow with `tools: []` and the same missing harness failed the same
  way on the model instead: `step "only" failed: pi wants a model named
  "provider/model", not "haiku"`. Through the daemon the two registrations of
  the one file gave `failed` and `done` respectively.
  Note the run-time message names no step (`pi has no tool for "web"`), unlike
  the check's message, which does.
- **What I expected**: either the check reads the harness the run will really
  use (`--harness`, or the daemon's stored one), or a flow that names no harness
  is refused. `docs/shape.md` Finding 4 says this hole is closed; it is closed
  only for a flow that names its harness.
- **Where**: `src/flow.ts:868` (`harnessOf` returns `undefined`, so both checks
  return nothing), `src/cli.ts:96` (the default is `pi`, and it never reaches
  `validate()`), `src/server.ts:601`.

## The page misses every run started from the command line while the daemon is up

- **Area**: observability
- **Severity**: medium
- **What I did**: started the daemon in my directory, then ran five flows from
  the command line in that same directory (`o-no-tools`, `p-read-tool`,
  `q-no-harness` twice, `r-no-harness-model`), then compared
  `orchy runs` with `GET /api/runs` and the page.
- **What happened**:

  ```
  ls .orchy/runs | wc -l      → 22
  node src/cli.ts runs | wc -l → 22
  curl /api/runs               → 17   (the page header says "17 runs")
  ```

  The five command-line runs, and the $0.0507 they spent, are invisible on the
  page. They appear only after the daemon restarts.
- **What I expected**: the page either shows the runs on disk or says that it is
  showing only its own.
- **Where**: `src/daemon.ts:79` — `store.index(runs)` runs once, at start.
  README says "the daemon builds this from the runs, and rebuilds it", which
  reads like it keeps up.

## The flow list shows the harness someone picked, not the harness the flow names

- **Area**: ui
- **Severity**: medium
- **What I did**: registered all fourteen of my flows through
  `POST /api/flows` with no `harness` field, then opened `#/flows`.
- **What happened**: every flow carries a `pi` pill, including `a-default`,
  `b-haiku`, `c-sonnet` and `j-all-tools`, which all say `harness: claude` in
  the file and all really ran on Claude (the trajectories say
  `claude-haiku-4-5-20251001`, `claude-sonnet-5`). The pill is the value stored
  at registration, which the API defaults to `pi`, and the "Add a flow" form
  defaults its picker to `pi` too. Screenshot: `hunt/batch-10/flows.png`.

  The same column is not decoration for a flow that names no harness: I
  registered one file twice, and the stored value decided the run.

  ```
  registered with harness pi     → failed: step "only" failed: pi has no tool for "web"
  registered with harness claude → done, $0.011968
  ```

- **What I expected**: the pill reads the flow's own `harness` when it has one,
  and says which value a flow without one will run under.
- **Where**: `ui/src/Flows.tsx:189` (`flow.harness` is the index row),
  `ui/src/Flows.tsx:20` (`useState("pi")`), `src/server.ts:607`. ADR 0009 says
  the index is not the run; for a flow that names no harness, it is.

## A pi failure arrives raw: no step named, and it points into Orchy's node_modules

- **Area**: ux
- **Severity**: medium
- **What I did**: ran `f-pi-ok.yaml` (`harness: pi`, `model: openai/gpt-5`) from
  the command line and through the daemon.
- **What happened**:

  ```
  ✗ only
    No API key found for openai.

    Use /login to log into a provider via OAuth or API key. See:
      /home/user/orchy/node_modules/@earendil-works/pi-coding-agent/docs/providers.md
      /home/user/orchy/node_modules/@earendil-works/pi-coding-agent/docs/models.md
  ```

  The same four lines are the whole of `state.json`'s `error` and the whole of
  the run header on the page. `/login` is a Pi command that Orchy never exposes,
  and the two paths are inside Orchy's own `node_modules`, not the user's
  project. Compare the Claude adapter, which wraps its failure: `step "only"
  could not run the claude command: …`.
- **What I expected**: the message names the step, and points at
  `~/.pi/agent/auth.json` or `npx pi auth check --provider openai`, the way
  README's install section does.
- **Where**: `src/pi.ts` — the SDK error is rethrown untouched;
  `src/claude.ts:89` shows the wrapping the other adapter does.

## The step panel says "the default" for a step whose harness and model the flow names

- **Area**: observability
- **Severity**: medium
- **What I did**: opened the run page of `b-haiku` (flow says
  `harness: claude`, `model: haiku`; the step names neither) and clicked its
  step.
- **What happened**: the drawing labels the node `only / the default`, and the
  panel reads:

  ```
  kind     agent
  harness  the default
  tools    none
  ```

  No model anywhere on that view, though the trajectory panel of the same run
  names `claude-haiku-4-5-20251001`. A run that failed before it reached the
  model (`d-nomodel`) shows `the default` too, so the page never says which
  harness and model a step was configured with — only the error text does.
  Screenshot: `hunt/batch-10/run-b.png`. When the step names them itself
  (`h-two-harnesses`) the same panel correctly reads `claude · haiku` and
  `pi · openai/gpt-5`.
- **What I expected**: the panel resolves the flow's `harness`/`model` the way
  the runner does, and says "claude · haiku (from the flow)".
- **Where**: `ui/src/Run.tsx:501` — `{step.harness ?? "the default"}`, with no
  fall back to `flow.harness`. `harnessOf()` in `src/flow.ts:272` is the rule it
  should use.

## The run list counts tokens without the cached ones

- **Area**: observability
- **Severity**: low
- **What I did**: ran `b-haiku` from the command line, then compared the run
  list with the trajectory.
- **What happened**: the list (and the run header) say `490` tokens for
  `$0.0113`. The trajectory of that run says:

  ```
  {"prompt_tokens":40,"completion_tokens":450,"cached_tokens":8830,"cost_usd":0.0112985}
  ```

  So 95% of the input the model read is missing from the number a person reads,
  and the cost cannot be reconciled with it.
- **What I expected**: the total names cached tokens, or the column says
  "prompt + completion".
- **Where**: `src/store.ts:317` — `tokens: (prompt_tokens ?? 0) + (completion_tokens ?? 0)`.

## The command line prints the model's reply inside the block that says "asks"

- **Area**: ux
- **Severity**: low
- **What I did**: ran `d-nomodel.yaml` (`model: no-such-model`).
- **What happened**:

  ```
  ✎ only asks:
    only │ Answer with the word ok. Do not use any tool.
    only │
    only │ The working directory is `…`. Read and write by a path inside it.
    only │ There's an issue with the selected model (no-such-model). It may not exist or you may not have access to it.
  ```

  The last line is the harness's failure, not part of the prompt, but it carries
  the same `only │` prefix and sits under the `asks:` header with no separator.
  In `p-read-tool` the tool call and the file contents land in the same block.
- **What I expected**: a header, a rule, or a different mark for what the step
  said back, so a reader can tell the prompt from the answer.
- **Where**: `src/cli.ts:54-55` — only the `prompt` note gets a header; every
  other note reuses `indent()`.

## What held up

- A tool list of `[]` really is no tools: the step answered `no-tools`, and the
  same prompt with `tools: [read]` read the file. Invariant 1 holds through
  `--tools ""`.
- Every wrong-grammar model and every unsupplied tool is refused by `validate()`
  before the run starts, with the same words from the CLI and from the daemon,
  and the daemon's refusal is a 400 with no run row: `step "only" names the
  model "gpt-5", which the harness "pi" cannot read. Write the provider and the
  model, as "openai/gpt-5".`; `step "only" asks for the tool "web", and the
  harness "pi" has none`; `step "only" asks for the tool "telepathy", which does
  not exist`.
- A model name that is good grammar and no model costs nothing: `no-such-model`
  died in the `claude` command in 3s with `cost` absent and a trajectory of one
  step at `cost_usd: 0`.
- A step overriding its flow's harness works both ways: `harness: pi,
  model: openai/gpt-5` on the flow with `harness: claude, model: haiku` on the
  step ran on Claude, and a step that overrides only the harness is refused
  before the run (`names the model "openai/gpt-5", which the harness "claude"
  cannot read`).
- Two steps on two harnesses in one flow run in order, and the money the first
  one spent is kept on the failed run: `cost $0.0123`, step `first` done, step
  `second` failed.
- A flow naming all eight Claude tools (`read write edit bash grep find ls web`)
  validates and runs.
- The page turns a run that could not start into a dismissible "did not start"
  card carrying the reason, instead of a silent nothing.

## What I spent

$0.2311 over 23 runs (`sum of every step cost in .orchy/runs/*/state.json`).
