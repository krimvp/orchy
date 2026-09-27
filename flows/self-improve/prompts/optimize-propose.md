Read the profile of the completed run. Read the flow and prompt files that produced it.

Find one specific YAML flow or Markdown prompt change that can reduce repeated work.
Use a YAML file under `flows/`, or an `.md` file under a `prompts/` directory in `flows/`.
Do not propose a component or a file under `flows/self-improve/`.
Name the source file and measured attempt that support it. Distinguish flow steps from executed attempts.
Name a repeatable quality check.
Name how a person can run the same task again with the same input values.
If the task depends on a one-off repository state, answer `candidate: false`.
If no repeatable check or same-task run exists, answer `candidate: false`.
If the evidence is too weak to justify one local change, answer `candidate: false`.
Use empty strings for the other fields when there is no candidate. Change no file.
