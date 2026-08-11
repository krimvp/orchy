# AGENTS.md

Orchy runs agent flows. A user declares the steps and the rules. Orchy runs the
steps and enforces the rules.

Read [CONTEXT.md](./CONTEXT.md) before you use a domain word. Read
[docs/plan.md](./docs/plan.md) before you change the design. Read
[docs/adr](./docs/adr) before you reverse a decision.

## Look before you write

Do this first, every time. Most of the work is already here.

1. Search this repository for the thing you need. A helper, a type, or a
   pattern that already exists is the answer.
2. Look at the standard library of Node. It holds more than most people think.
3. Look at a package that is already a dependency.
4. Only then write new code.

Read the code that your change touches, from end to end, before you change it.
The smallest change in the wrong place is a second bug, not a small one.

## How to write code

- Write the minimum code that makes the flow work.
- Do not write code for a need that does not exist yet.
- Delete code before you add code.
- Do not add an interface that has one implementation. [ADR
  0002](./docs/adr/0002-keep-a-harness-adapter.md) is the one exception, and it
  states the reason and the limit.
- Do not add a dependency for work that a few lines of code do. Ajv, yaml, and
  the Pi SDK are the only ones a run needs. Count the cost of a new one out
  loud before you add it.
- Keep the number of files small. One idea lives in one file.
- Write in the style of the file you are in. Match its names, its shape, and
  how much it says in a comment.

## Do not add a knob

A configuration knob is a question that every user must answer. Most questions
have one good answer, so make that answer the only one.

- Start with an assumption. Write the assumption down.
- Add a knob only when a real flow fails without it.
- When you are in doubt, leave the knob out and ask the user.
- A knob that changes a result needs a stronger reason than a knob that only
  paces the work.

## Never hide a failure

This is the rule that matters most in this project. Orchy sells a guarantee, so
a rule that looks enforced and is not costs more than a missing rule.

- A field that Orchy cannot act on must fail, and must say why. It must never
  be quietly ignored. Eleven fields did nothing at all for a while, and nothing
  said so. [docs/shape.md](./docs/shape.md) names every one of them.
- Do not promise what you do not check. `validate()` refuses a `changes`
  promise when no workspace can check it, for this reason.
- State the limit of a rule in the words of the rule. Invariant 1 says that a
  tool list is not a sandbox, because `bash` walks through it.
- An error message names the step, what went wrong, and what to do.

## Check against the real thing

Reasoning about a dependency is not knowledge of it.

- Read the types or the help output of a package before you call it. Its
  documentation and its behaviour do not always agree.
- Run the flow against a real model before you say that it works. Faults found
  this way include a harness that chose the wrong provider in silence, a path
  that lost its first letter, and a cycle that sent a step back with no reason
  attached. No amount of reading found any of them.
- When a test passes and the live run fails, the test was wrong. Fix the test
  first, and prove it fails without the fix.
- Report what you ran. Do not report what you expect.

## The UI

The page lives in `ui/`, and it holds its own `package.json`. React and Vite
stay there, and no run reaches them. `npm run ui:build` writes `ui/dist`, and
the daemon serves that directory.

- The UI states no rule of its own. It asks the daemon, and the daemon asks
  `validate()`. A copy of a rule falls behind.
- The tool list, the harness list, and the operators of a match come from `GET
  /api/health`, for the same reason. A set that the page must draw goes there.
  The answer names the set and holds no rule: `validate()` still refuses.
- The page is a terminal: a title bar, one dark well under it, one monospaced
  typeface, and a hairline wherever two things meet. `styles.css` holds every
  colour as a token. A terminal is dark, so there is one set of tokens and no
  second theme. A component names a token. No component names a colour.
- Motion uses the two curves that the stylesheet declares, and it carries
  meaning: a step that runs pulses, and a cycle keeps moving. Every animation
  stops under `prefers-reduced-motion`, and nothing is invisible when it does.
- The drawing is a diagram, not a sketch. Every segment is flat or upright. An
  edge that jumps a column passes above the steps, a cycle passes below them,
  and an upright run sits in the gap between two columns. So no line crosses a
  step. Keep that true for any edge you add.
- Where two edges meet, the flat one steps over the upright one. Every edge is
  built before any is drawn, because an edge cannot step over a line that does
  not exist yet.
- An edge leaves and arrives by its own place on the side of a step. Two edges
  that share one line read as one edge, and that is a join the flow does not
  hold.
- The UI adds no package. React, and nothing else.

## Tests

- `npm test` runs everything. `npm run check` runs the compiler.
- CI runs the tests, the compiler, and the page build on every push to main and
  on every merge request. See `.github/workflows/ci.yml`. A change that breaks
  an example breaks the build.
- A test for the daemon uses a flow of `call` steps and a gate, so it needs no
  model. It drives the real API over HTTP.
- A test of the door of the daemon writes its own headers, because `fetch`
  holds `Host` and `Origin` back. See [ADR
  0020](./docs/adr/0020-the-daemon-refuses-a-foreign-page.md).
- A field that a step cannot act on needs a test that proves it fails. Ten of
  them passed in silence once.
- `npm --prefix ui run build` runs the compiler over the page.
- One test states one behaviour. Its name says that behaviour in a sentence.
- Test through the public surface: `run`, `validate`, `expandFanout`,
  `expandFlows`. A fake harness stands in for a model.
- A test for a fault must fail before the fix. Prove it.
- Do not test a one-line pass-through.

## How to write comments

- Write a comment only when the code is complex, or when the reason for it is
  not in the code.
- Do not write a comment that repeats the code.
- Name the invariant or the ADR that a piece of code serves.
- Mark a deliberate shortcut with a `ponytail:` comment. Name the limit and the
  upgrade path.

## How to write English

Everything you write uses ASD-STE100 Simplified Technical English: a
document, a comment, a commit message, an error message, and every answer
you give a person.

An answer follows the same rules as a document. A person who reads a plain
answer reads a plain repository, and one voice keeps the two the same. Say
what you did and what you found. Do not use a word that this list refuses,
and do not fall back to loose English because an answer is not a file.

- Use short sentences. Keep an instruction to 20 words or less. Keep a
  description to 25 words or less.
- Use the active voice.
- Give one instruction in one sentence.
- Use one word for one meaning. Do not use synonyms. `CONTEXT.md` holds the
  approved words.
- Use the present tense.
- Use the articles `a` and `the`.
- Do not put more than three nouns together.
- Do not use jargon when a simple word is correct.

## The shape of the project

Know these before you change the runner.

- **A flow is data.** See [ADR
  0004](./docs/adr/0004-a-flow-is-data-not-code.md). The API, a YAML file, and
  a graphical editor all produce the same data. So no field may hold code, and
  a contract is JSON Schema.
- **A fanout and a flow step are expansions.** They become plain steps before
  the run. The runner knows neither. Put a new construct here first: an
  expansion costs the runner nothing. A flow step is a `kind` because it
  replaces one step. A fanout is a field because it multiplies one.
- **The runner performs one expansion, and only one.** A fanout over a list that
  a step computes has no list until that step gives one, so the run expands it
  when the step is ready. It calls `expandFanout`, the same function a file
  uses, because two expansions drift apart, and it writes the steps it made to
  the state on disk. See [ADR
  0017](./docs/adr/0017-a-fanout-over-a-value-the-run-computes.md). Add no
  second one.
- **The shape comes before the meaning.** `validate()` refuses a field that the
  kind of a step cannot act on, before it reads any field. A table in `flow.ts`
  names what each kind holds. Add a field to that table in the same change, or
  the field passes in silence. See [docs/shape.md](./docs/shape.md).
- **A run is a state machine on disk.** See [ADR
  0005](./docs/adr/0005-a-run-is-a-persisted-state-machine.md). A gate and a
  crash recover the same way. Anything you add to the run state must be JSON.
- **A harness sits behind an adapter** with two methods. Tool names, model
  names, and session files stay behind it. Nothing outside an adapter may read
  a trajectory.
- **The daemon sits above the runner.** It starts `orchy run --events` as a
  child process for each run, and it adds no rule about a flow. See [ADR
  0008](./docs/adr/0008-the-daemon-runs-each-run-in-a-child-process.md). Put a
  rule in `validate()` or in the runner, never in the daemon or in the UI. The
  daemon holds one rule of its own, and it is its door: it refuses a foreign
  `Origin`, a `Host` it does not answer to, and a flow file outside the root.
  See [ADR 0020](./docs/adr/0020-the-daemon-refuses-a-foreign-page.md).
- **The index is not the run.** The state on disk is. See [ADR
  0009](./docs/adr/0009-the-database-indexes-the-runs-on-disk.md).
- **A note is not the record.** The trajectory is. An adapter reports by reading
  the file that its harness already writes, so never start a harness a different
  way to get output. See [ADR
  0011](./docs/adr/0011-a-step-reports-by-reading-its-own-record.md).
- **Five invariants** carry the value of the project. Read them in
  [docs/plan.md](./docs/plan.md) before you touch the runner.

## Documents

- `CONTEXT.md` is the glossary. It holds no implementation detail. Add a word
  when a word becomes load-bearing.
- `docs/adr/` holds the decisions. Write an ADR only when a decision is hard to
  reverse, is surprising, and comes from a real trade-off. Amend an ADR when
  its reasoning proves wrong, and say what changed.
- `docs/plan.md` holds the design and the milestones.
- `docs/running.md` tells a user how to run a flow.
- `docs/usability.md` reports one usability run over the whole product. It is a
  record, so it stays as it was written. Read it before you change an error
  message, the reporter, or the daemon.
- `docs/shape.md` studies the flow data, and names where it is weak. Read it
  before you add a field or change one. It is the record of one study, so keep
  the study as it was written, hold its table of fields to the code, and say
  what later work closed.

Update the document in the same change as the code. A document that disagrees
with the code is worse than no document.

## Skills

`.claude/settings.json` enables two plugins:

- `ponytail` keeps the code minimal. It is active in every session.
- `mattpocock-skills` supplies `grilling`, `domain-modeling`, `tdd`, and
  `code-review`.

Use `/mattpocock-skills:grill-with-docs` to stress-test a design before you
build it. The session writes the words into `CONTEXT.md` and the decisions into
`docs/adr/`.
