# What the trials did

Every run below is real: 30 runs of 15 new flows and 7 of the 8 shipped
examples, against Claude Code and against Pi driving thirteen models on Ollama
Cloud. No source file of Orchy was changed. Total spend on the Claude harness
was **$3.59**; the Ollama models reported no cost at all, which turns out to
matter (see *A budget over a free harness is not enforced*).

## The new flows

| Flow | Harness | Status | Steps | Time | Cost |
| --- | --- | --- | --- | --- | --- |
| travel-itinerary | pi (glm-5.2, kimi-k2.7-code, minimax-m2.7, glm-5.1) | done | 7/7 | 237s | — |
| travel-itinerary (budget 1500) | pi, same | done | 7/7 | 278s | — |
| investment-plan | pi (glm-5.2, minimax-m2.7, kimi-k2.7-code) | done | 7/8, 1 skipped | 77s | — |
| deep-research | claude (haiku + sonnet-5) | done, 1 cycle | 7/7 | 689s | $2.446 |
| relocation-debate | pi + claude (cross-harness) | done | 6/6 | 192s | $0.070 |
| incident-postmortem | pi (glm-5.2, kimi-k2.7-code, minimax-m2.7, glm-5.1) | done | 5/5 | 241s | — |
| lease-review | pi (glm-5.2, kimi-k2.7-code, minimax-m2.7) | **failed** | 11/12 | 331s | — |
| curriculum | pi (module step on minimax-m2.7) | **failed** | 4/7 | 107s | — |
| curriculum | pi (module step on glm-5.2) | done | 9/9 | 369s | — |
| meal-plan | pi (glm-5.2, minimax-m2.7, kimi-k2.7-code) | done | 8/8 | 131s | — |
| talk-prep | pi (glm-5.2, glm-5.1, minimax-m2.7, kimi-k2.7-code) | done, 2 cycles | 5/5 | 421s | — |
| portfolio-rebalance | pi (tax step on minimax-m2.7) | **failed** | 2/3 | 54s | — |
| portfolio-rebalance | pi (tax step on glm-5.2) | done | 4/4 | 142s | — |
| retirement-drawdown | pi (glm-5.2, kimi-k2.7-code, minimax-m2.7) | done | 4/4 | 419s | — |
| venture-check (holds market-scan) | pi (glm-5.2, kimi-k2.7-code, minimax-m2.7) | done | 6/6 | 232s | — |
| weekend-guide | claude (haiku + sonnet-5) | done | 3/3 | 171s | $0.653 |
| cross-review | claude (haiku) writes, pi (glm-5.2) reviews | done | 2/2 | 122s | $0.064 |

Every gate was answered with `orchy resume` and every run finished.

## The shipped examples

| Example | Harness | Status | Note |
| --- | --- | --- | --- |
| triage | pi (glm-5.2) | done | the gate overrode the agent; `label.ts` produced `kind/bug, severity/high, needs-info` |
| decision | pi (glm-5.2) | done | three stances, a brief, a person. My first `resume` was refused by the contract, which is invariant 2 doing its job on a human |
| docs-audit | pi (glm-5.2) | done | needs a workaround, see *A member's prompt path is not resolved* |
| release-notes | pi (glm-5.2) | **failed** | `log.ts` read git fine; `draft` never called the submit tool |
| release-notes | claude | timed out | `draft` passed, `check` refused it twice, and my 20-minute limit cut the third round |
| dependency-audit | claude | done | 3 packages fanned out, `gather` said `risky: false`, and `upgrade` was **skipped by the condition**. $0.361 |
| cross-review (my rewrite of code-review) | claude + pi | done | see below |
| grilling | pi (glm-5.2) | done | the first step read every ADR and `docs/plan.md` — 13 minutes — and returned `frontierEmpty: true` with no questions, so the gate was answered with `{"answers":[]}`, `record` changed nothing, and the cycle did not fire |
| research | — | not run | structurally the same as my `deep-research`, which ran instead |

## The headline claim, tested

The README opens with one model writing code and a different model on a
different harness reviewing it with no tool that can change a file.
`trials/cross-review` is that flow, against a real bug: a `parseDuration` that
handles four units and no decimals, against a README promising six units,
decimals, negatives and whitespace, with a 15-case fixture the author is told
not to touch.

Claude Haiku rewrote it, Pi on `ollama/glm-5.2` reviewed with `read, grep,
find, ls` and approved. Checked independently afterwards:

```
all 15 cases pass
```

The workspace record shows `changed: [{ path: "src/duration.js", how: "changed" }]`
and nothing else, so the promise `changes: { except: [TASK.md, test/expected.json] }`
held. Total cost, both steps: $0.064.

## Harness × model: who holds a contract

Fifteen combinations were given the same step — read a file, produce a
ten-element array of objects with four required fields each, and call the
submit tool. One run each:

| Harness | Model | Result | Time |
| --- | --- | --- | --- |
| claude | claude-haiku-4-5 | done | 36s |
| claude | claude-sonnet-5 | done | 49s |
| pi | ollama/glm-5.2 | done | 31s |
| pi | ollama/glm-5.1 | done | 39s |
| pi | ollama/qwen3.5:397b | done | 28s |
| pi | ollama/kimi-k2.7-code | done | 46s |
| pi | ollama/minimax-m2.7 | done | 45s |
| pi | ollama/minimax-m3 | done | 156s |
| pi | ollama/deepseek-v4-flash:preview | done | 29s |
| pi | ollama/gemma4:31b | done | 15s |
| pi | ollama/gpt-oss:120b | **failed** | 11s |
| pi | ollama/gpt-oss:20b | **failed** | 10s |
| pi | ollama/deepseek-v4-pro | **failed** | 30s |
| pi | ollama/mistral-large-3:675b | **failed** | 30s |
| pi | ollama/nemotron-3-super | **failed** | 49s |

Every failure is the same one: `the step ended without a call to
submit_result`. The model wrote the answer as prose and stopped. `gpt-oss` in
both sizes answers in markdown every time.

Repeating the eight survivors three times each gave 23 passes out of 24 — one
`deepseek-v4-flash` run dropped the call. So on this schema the good models are
around 95% reliable, not 100%, and **that is the number that governs a fanout**:
eleven clauses at 95% each is a two-in-five chance that the run fails.

`ollama/kimi-k3` could not be tested: the account has no extra-usage balance
for it, which the harness surfaced as a plain 402.

## Where it broke, and what that shows

### A fanout cannot retry, so one flaky member fails the run

`lease-review` fanned out over eleven clauses. Ten came back. The eleventh
(`kimi-k2.7-code` on the legal-costs clause) wrote its judgement as markdown
and never called the tool, so the run failed with ten good values in hand.
`curriculum` on `minimax-m2.7` lost three of six modules the same way.

The obvious fix is a retry, and `validate()` refuses it:

> step "judge" both fans out and cycles, so which member cycles is unclear

The refusal is reasonable — a cycle on an expanded step is genuinely ambiguous
— but it leaves the one shape that most needs a retry with no way to ask for
one. Today the workaround is picking a model that holds the contract: the same
`curriculum` flow with the module step on `glm-5.2` ran 6 of 6 and finished.

### `changes: { paths }` does not require that the paths were changed

In `deep-research`, the `brief` step returned `{ file: "BRIEF.md", claims: 44 }`
and the run recorded **no change at all**. The promise
`changes: { paths: [BRIEF.md] }` passed, because an empty change set breaks no
promise. The model had called `Write` with a hallucinated absolute path one
directory off, so a 16 KB brief landed outside the workspace.

What caught it was the next step: `check` opened the working directory, found
no `BRIEF.md`, and returned `approved: false`. The cycle fired, `brief` ran
again, wrote to the same wrong path again, and `policy: accept` then let the
run end as **done** with a value naming a file that does not exist.

So the layering worked as designed — a reader with `read` caught what the
workspace could not — but two things are worth knowing: a `paths` promise is
one-sided, and `policy: accept` means the run reports success after the last
refusal. The brief itself was good; it is quoted from a real file, in the wrong
directory.

### A promise costs the whole wave its parallelism

`run.ts` sets the wave width to 1 if **any** step in it declares `changes`:

```ts
const parallel = work.some((step) => changesOf(state.flow, step) !== undefined)
  ? 1
  : (state.flow.parallel ?? WAVE);
```

`travel-itinerary` declares `parallel: 3` and `changes: nothing` on its three
drafters, so they ran one after another. `incident-postmortem` declares
`changes: nothing` **on the flow**, which makes every step of it inherit one,
so `parallel: 3` there is dead text and three lenses took 241s instead of
roughly 90s. Dropping the promise from the four readers in `deep-research` is
what let them run at once.

This is a real trade between invariant 5 and speed, and nothing in the flow
file says so. Orchy's own `docs-audit` example found the same thing when it ran
against this repository:

> README.md — "A wave runs every step whose needs have passed at the same time,
> eight at once unless the flow says otherwise" — the code sets `parallel` to 1
> when any step in the wave has a `changes` promise.

### A budget over a free harness is not enforced

`costOf` in `pi.ts` sums `usage.cost.total` across the session. Ollama reports
`0`, not nothing, so a run through Pi reports a cost of exactly zero, the
budget check reads zero, and `budget` never trips. ADR 0019 anticipates the
case where a harness reports *no* cost and refuses to run; a harness that
reports a real, honest zero slips through the same door. Every Ollama run above
shows `cost: $0.0000` — none of that is free, it is just unpriced.

The cross-harness runs are the interesting ones: `relocation-debate` reports
$0.0697, which is the Claude judge alone, with three advocates invisible.

### A member's prompt path is not resolved against the flow file

`resolvePaths` resolves `step.prompt` and `step.module`, and does not touch the
`prompt` or `module` a fanout **member** overrides:

```ts
steps: flow.steps.map((step) => {
  if (step.kind === "agent") return { ...step, prompt: at(step.prompt) };
  if (step.kind === "call") return { ...step, module: at(step.module) };
  return step;
}),
```

So `examples/docs-audit` and `examples/decision`, which both give each member
its own prompt, fail anywhere except their own directory:

```
failed  auditor/readme  error: ENOENT ... /scratchpad/repo/prompts/audit-readme.md
```

The README says "a `prompt` path is relative to the flow file", and for a
member it is relative to the working directory instead. The example test only
calls `validate()`, which never touches the filesystem, so nothing catches it.
Both examples ran once their prompts were copied next to the working directory.

## What worked, and is worth keeping

- **A computed fanout carries real work.** `investment-plan` split into three
  sleeves the flow file never names, `lease-review` into eleven clauses,
  `meal-plan` into five nights, `curriculum` into six modules. The list arrives
  with the value of the step before it, and the ids come out readable:
  `sleeve/short-term bonds`, `dinner/Wednesday`, `judge/early termination`.
- **Conditions really skip.** `investment-plan` returned `shortfall_usd: 0`, so
  the stress-test step recorded `skipped: "projection" does not say
  {"shortfall_usd":{"gt":0}}`. `dependency-audit` skipped its upgrade the same
  way. Nothing downstream had to defend itself against a step that did not run.
- **A module can hold the cycle.** In `travel-itinerary` the decision to send
  the itinerary back is `budget.ts` comparing two numbers, not a model deciding
  whether it likes its own work. In `portfolio-rebalance` the trades are
  computed before any model sees them, and the prompt says the numbers are not
  up for discussion.
- **A flow inside a flow is invisible from the outside.** `venture-check` holds
  `market-scan`; its steps appear as `scan/segments`, `scan/incumbent`,
  `scan/read`, and the values the outer step holds reach all three. The verdict
  read the scan's `wedge` against the module's `big_enough: false` and answered
  `test it first`, which is the right answer.
- **`changes: nothing` on a whole flow holds.** Five steps of
  `incident-postmortem` recorded no change to the workspace at all.
- **`changes: { except }` holds too.** `retirement-drawdown` wrote `DRAWDOWN.md`
  and left `SITUATION.md` and `ASSUMPTIONS.md` alone, and the record says so.
- **The cycle stops.** `talk-prep` went back to the outline twice, hit the
  limit, and accepted: `cycles: {"review->outline": 2}`.
- **Contracts catch people too.** Answering the `decision` gate with the wrong
  shape got `the value of "decide" breaks the contract at "/": must have
  required property 'choice'`, and the run stayed waiting rather than
  proceeding on a malformed answer.

## Setting Pi up for Ollama Cloud

No source change, two files:

`~/.pi/agent/models.json` registers the provider and its models against
`https://ollama.com/v1` with `$OLLAMA_API_KEY`, `api: openai-completions`, and
`compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }`.

`~/.pi/agent/settings.json` needs **both** halves, or Pi falls back to its own
default (which here was an unauthenticated Bedrock model, and the step failed
in under a second with no explanation of why):

```json
{ "defaultProvider": "ollama", "defaultModel": "glm-5.2" }
```

A flow that names `model: ollama/glm-5.2` on every step needs neither.
