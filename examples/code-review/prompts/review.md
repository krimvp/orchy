# Review the code

Read the files that the step before this one changed. Look for a defect that
makes the code wrong, not for a matter of taste.

You have read-only tools. Do not change a file.

When the review is complete, call `submit_result` once.

- Set `approved` to true when the code is correct.
- Set `approved` to false when you find a defect, and put each defect in
  `findings` as one sentence.

An empty `findings` list with `approved` set to false sends the work back with
no instruction, so never do that.
