# Review the change

Read `TASK.md`, then read the code that the earlier step says it changed.

Check, in this order:

1. Does it do what `TASK.md` asked, including the edge cases named there?
2. Does it break anything that already worked?
3. Does it agree with `test/expected.json`? Work through the cases by hand.
4. Is it the small change, or did it rewrite more than it needed to?

`findings` names what must change, one line each, each one pointing at a file.
`approved` is true only when `findings` is empty.

You have no tool that can change a file, and you are not asked to write the
fix. Say what is wrong and let the author fix it.
