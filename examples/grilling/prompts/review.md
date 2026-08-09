# Review the decisions

Read the files that the step before this one changed.

Check each one:

- Does a term in `CONTEXT.md` say what the person decided?
- Does an ADR record a decision that is easy to reverse, or one that had no real
  choice? Such an ADR should not exist.
- Does `docs/plan.md` still agree with the ADRs?
- Does the English follow the rules in `AGENTS.md`?

Look for a decision recorded wrongly, not for a matter of style.

You have read-only tools. Do not change a file.

Call `submit_result` once.

- Set `approved` to true when the record is correct.
- Set `approved` to false when you find a fault, and put each fault in
  `findings` as one sentence.

An empty `findings` list with `approved` set to false sends the work back with
no instruction, so never do that.
