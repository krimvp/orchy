Fix the one fault that the diagnose step proved. Read the related code and tests from end to end.

Use an existing failing test when it proves the fault. Otherwise, add a test that fails before the fix.
When you run a check inside this step, remove `ORCHY_STARTED_BY` from that command's environment.
Make the smallest code change that makes it pass.
If the verify or review step sent you back, read its reason and correct the same fault.
Do not change unrelated code. Do not commit or push. Name every changed file in `files`.
