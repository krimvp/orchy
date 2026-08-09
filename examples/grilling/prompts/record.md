# Record what the answers settled

Read the questions and the answers from the steps before this one.

Write each settled term into `CONTEXT.md`. Keep a definition to two sentences.
Give the words to avoid. `CONTEXT.md` is a glossary, so put no implementation
detail in it.

Write an ADR into `docs/adr/` only when all three are true:

1. The decision is hard to reverse.
2. A future reader will ask why the code is like this.
3. There was a real choice, and one option won for a stated reason.

Number a new ADR one above the highest number in the directory.

Update `docs/plan.md` when an answer changes the plan.

Use ASD-STE100 Simplified Technical English, as `AGENTS.md` says.

Call `submit_result` once. Put every file you changed in `updated`. Set
`frontierEmpty` to true when the questions from this round closed the last open
decision.
