## A misspelled or unsupported schema keyword turns the whole contract off, and nothing says a word

- **Area**: functional
- **Severity**: high
- **What I did**: Wrote three contracts that a person writes by mistake, and ran each one.
  1. `returns: { type: object, requires: [title], propertys: { title: { type: string } } }` on a call step whose module returns `{}`.
  2. `returns: { type: object, required: [title], properties: { title: { type: string, minimum: 10 } } }` (the typo for `minLength`), module returns `{ title: "hi" }`.
  3. A real haiku step (`f11/loose.yaml`), `returns: { address: { type: string, format: email }, count: { type: string, pattern: "^[0-9]+$" } }`, prompt: *"Give the address as the single word banana, and the count as the word two."*
- **What happened**: All three ended `done`. `validate()` said nothing about any of them.

  ```
  ✓ s
  — done
     "value": "{}"                       # the contract named a required "title"
  ```

  The paid one is the sharpest. The claude command **does** enforce `pattern` — it made the model retry — and it ignores `format`:

  ```
  unknown format "email" ignored in schema at path "#/properties/address"
  unknown format "email" ignored in schema at path "#/properties/address"
  ◆ dc354b03-35e7-439f-a309-3c457378de66
    pick │ StructuredOutput {"address":"banana","count":"two"}
    pick │ Output does not match required schema: /count: must match pattern "^[0-9]+$"
    pick │ StructuredOutput {"address":"banana","count":"2"}
  ✓ pick
  — done
   "value": { "address": "banana", "count": "2" }
  ```

  So a run passed with `banana` in a field the contract declares as an email, and half the contract was enforced and half was not. The one warning that would have told a person is written to the child's stderr twice, above the run banner, naming no step — and through the daemon it lands in `job.stderr`, which the page only shows when the child exits non-zero. On the page: nothing.
- **What I expected**: `validate()` refuses a contract that holds a keyword Ajv does not know (`requires`, `propertys`), and refuses or warns about a `format` no one checks — the same rule `docs/shape.md` finding 1 states, and the same reason: a rule that looks enforced and is not costs more than a missing rule.
- **Where**: `src/flow.ts:12` — `new Ajv2020({ strict: false })`. Strict mode is exactly the setting that reports an unknown keyword, an unknown format, and a keyword that cannot apply to the declared type. `schemaFault` (`src/flow.ts:619`) only catches what breaks the meta-schema, so `type: objekt` is caught and `propertys` is not.

## A gate whose contract holds an object, an enum, or a typeless property cannot be answered from the page at all

- **Area**: ui
- **Severity**: high
- **What I did**: Started `f10/flow.yaml` through the daemon on 4119 and opened `#/runs/<id>`. Its gate returns `verdict` (an enum of three), `files` (an array), and `owner` (a nested object with its own `required: [name, team]`). Then the same for `f14/flow.yaml`, whose three properties are written `{ enum: [yes, no, later] }`, `{ type: [number, "null"] }`, and `{}`.
- **What happened**: The form drew the labels and, for half of them, no control whatsoever.

  ```
  field "verdict · needed" -> controls: ["INPUT:text"]      # an enum, as free text
  field "files · needed"   -> controls: ["TEXTAREA:textarea"]
  field "owner · needed"   -> controls: []
  ```
  ```
  field "choice · needed"  -> controls: []
  field "count · needed"   -> controls: []
  field "note · needed"    -> controls: []
  ```

  Filling in what the form does draw and pressing *Answer and continue* sends `{"value":{"verdict":"ship","files":["src/run.ts","src/flow.ts"],"owner":{}}}` — the empty object passes the form's own "needed" check — and the contract refuses it. On `f14` the button answers with a message about fields that have no input:

  ```
  Fill in choice, count, note first — the flow needs them.
  ```

  The only way through is the *Write JSON* button, and its box is pre-filled with `{"verdict":"","files":[],"owner":{}}` — the skeleton, not the schema, so it names neither the three allowed verdicts nor the two fields `owner` must hold. I answered that way and the run finished at once.
- **What I expected**: An `enum` draws a dropdown, an object draws its own fields, and a property whose type the form cannot draw falls back to a JSON box for that field instead of a label with nothing under it.
- **Where**: `ui/src/Run.tsx:726-756` — the `Contract` form has branches for `boolean`, `number`/`integer`, `string`, `array` and nothing else; `blank()` at `ui/src/Run.tsx:786` gives an object `{}` and everything else `""`, and the empty check at `ui/src/Run.tsx:714` treats `{}` as filled in.

## A gate answer the contract refuses looks like it worked, and the reason is on another page

- **Area**: ux
- **Severity**: high
- **What I did**: `POST /api/runs/<id>/resume` with four values the gate contract refuses (a wrong enum, an empty array, a missing nested field, a wrong nested enum), and the same through the page's button.
- **What happened**: Every POST answered 200 with a ticket that reads like success, and the run kept saying `waiting`:

  ```
  {"ticket":2,"flowName":"gate-contract","queuedAt":"...","runId":"164c9f7c-..."}
  status: waiting | error: - | gate: undefined
  ```

  `GET /api/runs/<id>` holds no trace of it. From the page it is worse: the button does nothing visible at all — same question, same empty form, no message. The reason exists, on `GET /api/queue`:

  ```
  2 | the value of "decide" breaks the contract at "/verdict": must be equal to one of the allowed values
  5 | the value of "decide" breaks the contract at "/owner": must have required property 'name'
  ```

  and the page draws it on the *Runs list* and the *flow's runs* page, under the words **"did not start"** — which is wrong twice over, because the run started minutes ago and it is the answer that did not land. Each refused attempt leaves a card that a person must *Dismiss* by hand. The CLI does this right: `orchy resume` prints the reason and exits non-zero.
- **What I expected**: The refusal comes back on the page where the person pressed the button, beside the field it names.
- **Where**: `src/daemon.ts:103` keeps the reason on the ticket; `ui/src/Run.tsx:85` sends the resume and never reads a ticket error back.

## A failed agent step reports no cost, and the trajectory swears it was free

- **Area**: observability
- **Severity**: high
- **What I did**: Ran `f11/impossible.yaml` — one haiku step, contract `answer: { type: integer, minimum: 10, maximum: 5 }`. The model spent 45 seconds and thirteen turns on it and then gave up.
- **What happened**: The step record holds `startedAt, endedAt, status, error, prompt` and **no `cost`**, and the trajectory states a cost:

  ```json
  "final_metrics": { "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0, "cost_usd": 0, "total_steps": 1 }
  ```

  The session that claude wrote for that step holds 13 assistant turns, 114 input, 5109 output, 55088 cached-read and 17646 cached-write tokens — about **$0.053** at haiku 4.5 prices. Across every run I made, Orchy recorded **$0.0127** of the roughly **$0.066** I actually spent; the missing 80% is all in the run that failed. The trajectory is empty besides, because the session id only comes back on the success path, so there is no link to the transcript either.
- **What I expected**: A step that spent money records what it spent, whatever its status — otherwise a budget (ADR 0019) cannot see the most expensive failure mode there is, a step that retries an impossible contract.
- **Where**: `src/claude.ts:110` throws before `src/claude.ts:115` ever returns `{ cost: answer.total_cost_usd }`, so the cost the command reported is dropped on every failure path.

## The model says exactly why the contract cannot be met, and Orchy keeps none of it

- **Area**: ux
- **Severity**: medium
- **What I did**: The same `f11/impossible.yaml` run.
- **What happened**: The model worked the problem out and said so, four times over:

  ```
  pick │ StructuredOutput {"answer":7}
  pick │ Output does not match required schema: /answer: must be <= 5, /answer: must be >= 10
  pick │ The output schema has contradictory constraints: the answer must be both `<= 5` and
  pick │ `>= 10` simultaneously, which is impossible. No whole number can satisfy both at once.
  ```

  What the run kept, in the state on disk and on the page:

  ```
  step "pick" failed: step "pick" ended with no value for its contract
  ```

  The sentence that tells a person what to fix lives only in the streamed notes, which the daemon holds in memory for the last few runs and then drops. The trajectory holds one line, and it is the same useless one.
- **What I expected**: When a harness answers with words but no value, the words go on the record — a step that cost 13 turns should not be summarised as "no value".
- **Where**: `src/claude.ts:110` — the throw carries no part of `answer.result`.

## A broken enum never names the values it allows

- **Area**: ux
- **Severity**: medium
- **What I did**: Broke a three-way enum (`verdict`) and a nested one (`findings[0].severity`), from a call step, from a gate answer, and through the page.
- **What happened**: Every one of them:

  ```
  the value of "shape" breaks the contract at "/verdict": must be equal to one of the allowed values
  ```

  Ajv knows the allowed values — they are in `errors[0].params.allowedValues` — and Orchy prints only `message`. This is the message a person reads when a gate refuses their answer, the message the `escalate` policy hands someone who must now type the value themselves, and the message a retrying agent step "hears" as the error of its last attempt.
- **What I expected**: `... must be one of: ship, hold, drop`.
- **Where**: `src/flow.ts:18-21` — `schemaProblem` drops `first.params`.

## `takes` cannot name a value that a step it needs returns, and the advice it gives does not apply

- **Area**: devex
- **Severity**: medium
- **What I did**: A two-step flow. `first` returns `{ ticket: 42, title: "a bug" }`; `second` needs it, reads `inputs.first.ticket`, and declares `takes: { required: [ticket], properties: { ticket: { type: number } } }`.
- **What happened**:

  ```
  the flow is not valid:
  - step "second" takes "ticket", and nothing supplies it. Add "ticket" to "takes" on the flow, or to "with" on the step.
  ```

  Both fixes are wrong: the ticket comes from `first`, and adding it to the flow's `takes` or the step's `with` would make the run supply a second, unrelated one. The same declaration with no `required` loads and runs — and checks nothing at all: the module printed the values it was given as `{}`, because `takes` is matched against the run's values under the step's `with` and never against the inputs. So `takes` with only optional properties is a field that can never fail.
- **What I expected**: Either the message says that `takes` reads the run's values and not the inputs of the step, or `takes` covers the inputs too.
- **Where**: `src/flow.ts:925` returns early when `required` is empty; `src/run.ts:52` checks `takes` against `{ ...state.with, ...step.with }` only.

## A conflict between what the flow takes and what a step takes waits until the step runs

- **Area**: functional
- **Severity**: medium
- **What I did**: Flow `takes: { ticket: { type: string } }`, a later step `takes: { ticket: { type: number } }`, with a step before it.
- **What happened**: The first step ran, and only then:

  ```
  ▶ first
  ✓ first
  ▶ second
  ✗ second
    the values that reach "second" break what it takes at "/ticket": must be number.
    Add it to "takes" on the flow, or to "with" on the step.
  ```

  Both schemas are in the file, and neither depends on the run. ADR 0015 promises "a run fails before it spends a token" for exactly this class of fault; here every step before the broken one runs first, and on a real flow those are paid agent steps.
- **What I expected**: `validate()` refuses a step whose `takes` contradicts the flow's `takes` on a name both declare.
- **Where**: `src/flow.ts:915-942` — `takenProblems` compares names, never types.

## `returns: {}` passes the check, and then means two different things

- **Area**: devex
- **Severity**: medium
- **What I did**: `returns: {}` on a call step, and on a haiku agent step.
- **What happened**: On the call step the run passed and the contract checked nothing — an empty schema accepts anything, so a required field is not required and a `returns` a person wrote is decoration. On the agent step the run failed in the middle with the harness's own plumbing:

  ```
  ✗ pick
    step "pick" could not run the claude command: API Error: 400 tools.0.custom.input_schema.type: Field required
  ```

  `validate()` said nothing in either case, and the session was already open when the 400 arrived. Orchy refuses an empty condition with precisely the right words — `step "after" runs on an empty condition for "s", so it always runs` — and accepts the same emptiness in a contract.
- **What I expected**: `step "pick" returns "{}", which checks nothing. Name what the step must answer.`
- **Where**: `src/flow.ts:614` — `isSchema` accepts any non-array object, so `{}` is a schema.

## `required` may name a property the schema never declares, and only the run finds out

- **Area**: devex
- **Severity**: medium
- **What I did**: `returns: { type: object, required: [count], properties: { ok: { type: boolean } } }`, module returns `{ ok: true }`.
- **What happened**: The flow loaded, the step ran, and it failed:

  ```
  ✗ s
    the value of "s" breaks the contract at "/": must have required property 'count'
  ```

  For an agent step that failure costs a whole session. The same mistake one field over — a `when` naming a key the step does not declare — is caught before the run starts: `step "after" runs when "s" says "stray", which "s" does not return`. So Orchy already knows how to say this, and does not say it about `required`.
- **What I expected**: The load refuses `required` naming a name that `properties` does not hold, when `properties` is written at all.

## An unknown name is refused on the flow's `takes` and waved through everywhere else

- **Area**: devex
- **Severity**: low
- **What I did**: Supplied one extra name in four places: `--with`, a step's `with`, a step's returned value, and a gate answer.
- **What happened**: Only the first is refused.

  ```
  --with '{"issue":7,"extra":1}'
    the flow "takes-contract" does not take extra, and this run supplies it. Add the name to "takes", or leave it out.

  with: { a: 1, stray: 2 }  against  takes: { required: [a], properties: { a: {type:number} } }
    ✓ s          (the module was handed {"a":1,"stray":2})

  a module returning { ok: true, stray: "nobody declared me", junk: { deep: [1,2,3] } }
    ✓ s          (and the next step was handed all of it)

  a gate answered {"approved":true,"لماذا":"🎉 لأنه جيد"}
    — done       (the extra key is on the record for good)
  ```

  The rule that ADR 0015 rates most expensive — "a value that nothing reads must fail" — holds for one of the four places a value enters a run. And a step really can return a name it never declared, which the next step really can read, while a `when` on that same name is refused at load. A person who wants to branch on it must declare it; a person who wants to smuggle it need not.
- **What I expected**: One rule for all four, whichever it is.

## Small things

- `returns: true` is refused with `which is not JSON Schema`. A boolean **is** a JSON Schema — `true` is the schema that accepts anything and `false` the one that accepts nothing — so the message tells a person something untrue. (`src/flow.ts:614`.)
- A value that breaks a contract in three places reports one: with `verdict` wrong, `findings` empty and `owner.contact.email` missing, the run said only `at "/verdict"`. Ajv is running with `allErrors` off, so a person fixes one break per run — and a retrying agent step is told one thing at a time too.
- A run refused for its values (`--with` of the wrong type, or none) exits **1**, the same code as a failed run, though nothing ran and no run id exists. `orchy --help` reserves 2 for "the command itself is wrong".
- The harness's own warnings arrive unattributed and out of order: `unknown format "email" ignored in schema at path "#/properties/address"` is printed twice, before the `◆ <run id>` banner, with no step name.

## What held up

- Every contract Ajv actually reads is enforced exactly, on a call step, a gate answer and an agent step alike, and the message names the path: `at "/findings/0/severity"`, `at "/owner/contact": must have required property 'email'`, `must NOT have fewer than 1 items`, `must be integer` for `3.5`, `must be boolean` for `"true"`. No coercion anywhere.
- The flow's `takes` is strict in all three directions — wrong type, none supplied, and a name the flow does not take — and it refuses the run before any step starts, with no run id and no cost.
- A malformed schema is caught at load with Ajv's own words and the step's name: `step "s" returns "{"type":"objekt"}", which Ajv refuses: schema is invalid: data/type must be equal to one of the allowed values`. `required: ok`, `properties: [ok]` and a misspelled `type` value are all caught the same way, and so is a broken `takes` on the flow.
- `model: no-such-model` fails first and fails cheaply: the step never reached the contract, the run spent nothing, and the message is the harness's own — `There's an issue with the selected model (no-such-model). It may not exist or you may not have access to it.`
- A megabyte string survived the contract (`maxLength: 2000000`), the state on disk, the next step's inputs, the daemon's child process and the run page: 6.5s at the CLI, `done`, `GET /api/runs/<id>` answered 1,049,999 bytes in 0.04s, and the page drew it without complaint.
- Emoji, an RTL override, Hebrew, Japanese, a ZWSP and a family emoji all round-tripped through a contract, a state file and a gate question unchanged, and a gate answered with an Arabic key kept it verbatim.
- `validate()` catches `changes: nothing` on a flow with no workspace before anything runs: `step "pick" promises what it changes, but the flow has no workspace to check it`.
- The flow-level `returns` is checked at the end and the run fails with a reason of its own: `the value of "s" breaks what the flow "flow-returns" returns at "/url": must be string`.
