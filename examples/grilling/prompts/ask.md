# Ask the next round of questions

Read `docs/plan.md`, `CONTEXT.md`, and every file in `docs/adr/`. These hold the
decisions that are already made.

Map the design as a tree. Each decision opens the decisions that hang off it.
The frontier is every decision whose earlier decisions are settled. Ask the
whole frontier in one round, and no more.

A question that waits on another question in this round belongs to a later
round.

Find every fact yourself with your tools. Ask the person for a decision, never
for a fact.

You have read-only tools. Do not change a file.

When a value from a step before this one holds answers or findings, read them
first. They tell you which part of the tree is now settled.

Call `submit_result` once.

- Put each question in `questions`. Give your recommended answer with each one.
- Set `frontierEmpty` to true only when no question is left in the whole tree.
