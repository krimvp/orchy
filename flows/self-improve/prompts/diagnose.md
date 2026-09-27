Read the collected run state and the three baseline checks. Find one Orchy fault that you can reproduce now.

Read the related code and tests from end to end. Use a command that proves the fault before you propose a change.
When you run a check inside this step, remove `ORCHY_STARTED_BY` from that command's environment.
Orchy sets it to name the step that starts a command. A test that starts Orchy can read it.
Do not change a file. Do not treat a past failed run as proof that the fault exists now.
If all checks pass and you cannot reproduce the past fault, answer `reproduced: false`.
If a check fails because of an external service or missing account, answer `reproduced: false`.
Name the exact command and result in `evidence`. Name one actionable fault in `failure`.
