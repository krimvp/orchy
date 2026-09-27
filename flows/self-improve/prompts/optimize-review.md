Review the proposed change, the diff, and the results of all three repo checks.

Confirm every changed path is a YAML flow or a Markdown prompt under `flows/`.
Reject a component edit or a change under `flows/self-improve/`.
Confirm it matches one measured source of repeated work.
Confirm the proposed quality check and same-task run still apply.
Refuse a change that has no repeatable quality check or depends on a one-off state.
Put each reason for refusal in `findings`. Change no file.
