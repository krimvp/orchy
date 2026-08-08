# AGENTS.md

Orchy composes agent flows. A user wires steps together, and Orchy runs them and
enforces the rules that the user declares.

Read [CONTEXT.md](./CONTEXT.md) before you use a domain word.

## How to write code

- Write the minimum code that makes the flow work.
- Do not write code for a need that does not exist yet.
- Do not add a configuration knob unless a real flow needs it. Start with an
  assumption and record the assumption.
- When you are in doubt about a knob, defer the knob or ask the user.
- Delete code before you add code.
- Do not add an interface that has one implementation.
- Do not add a dependency for work that a few lines of code do.
- Keep the number of files small.

Understand the problem fully before you make the code short. A small change in
the wrong place is a second bug.

## How to write comments

- Write a comment only when the code is complex.
- Do not write a comment that repeats the code.
- Write a comment when the reason for the code is not visible in the code.
- Mark a deliberate shortcut with a `ponytail:` comment. Name the limit and the
  upgrade path.

## How to write English

All documents, comments, and commit messages use ASD-STE100 Simplified Technical
English.

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

## Documents

- `CONTEXT.md` is the glossary. It holds no implementation details.
- `docs/adr/` holds the decisions. Write an ADR only when the decision is hard
  to reverse, is surprising, and comes from a real trade-off.
- `docs/plan.md` holds the current plan.

## Skills

This repository enables two plugins in `.claude/settings.json`:

- `ponytail` keeps the code minimal. It is active in every session.
- `mattpocock-skills` supplies `grilling`, `domain-modeling`, `tdd`, and
  `code-review`.

Use `/mattpocock-skills:grill-with-docs` to stress-test a plan. The session
updates `CONTEXT.md` and `docs/adr/` as the decisions become clear.
