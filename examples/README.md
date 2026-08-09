# Examples

Each directory holds one flow. A test checks that every one of them is valid,
so a broken example fails the build.

| Flow | What it shows | Needs |
| --- | --- | --- |
| [code-review](./code-review) | a cycle: review sends the work back to code. The same flow twice, as `flow.ts` and as `flow.yaml` | a repository |
| [grilling](./grilling) | a gate: the run stops for a person, four times over | a repository |
| [research](./research) | the `web` tool, three readers at once, and a check that reads the sources again | Claude Code |
| [triage](./triage) | a gate that overrides the agent, and no workspace at all | `ISSUE.md` |
| [docs-audit](./docs-audit) | `changes: nothing` on every step, so the workspace proves nothing moved | a repository |
| [release-notes](./release-notes) | a deterministic step reads git, so no model spends tokens on it | a repository |
| [decision](./decision) | three fixed stances argue, one brief, then a person decides | `DECISION.md` |
| [dependency-audit](./dependency-audit) | one prompt over a list, a step that retries itself, and a step a condition rules out | a repository |

## Run one

```bash
cd <the directory you want the flow to work in>
orchy run <path to>/examples/triage/flow.yaml --harness claude
```

A prompt path is relative to the flow file. The working directory is where the
steps act, so run the command from there.

## What each one costs

A flow with a panel spends more than a flow with one step. `research` runs
three readers and then re-reads the sources, so it costs the most.
`dependency-audit` runs one step for each package, so it costs what its list is
long. `triage` and `decision` read one file and spend the least.

Read the trajectory of a run for the real number:

```bash
cat .orchy/runs/<run id>/trajectory.json | jq .final_metrics
```
