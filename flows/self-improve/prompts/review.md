Review the fix for the fault that the diagnose step proved. Read the diff and the changed tests.

Check that the test failed before the fix. Check that the fix is limited to the proved fault.
Run the fault test again if the verify result does not prove the fault is gone.
When you run a check inside this step, remove `ORCHY_STARTED_BY` from that command's environment.
Approve only when the fault test and all three checks pass, and the diff has no unrelated change.
Put each reason for refusal in `findings`. Change no file.
