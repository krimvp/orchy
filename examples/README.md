# Examples

Each directory holds one flow. A test checks that every one of them is valid,
so a broken example fails the build.

Each flow names its harness and its model, so a run needs no flag. The table
says what else each one needs before it starts.

| Flow | What it shows | Harness and model | Needs |
| --- | --- | --- | --- |
| [code-review](./code-review) | a cycle: review sends the work back to code. The same flow twice, as `flow.ts` and as `flow.yaml` | claude, `sonnet` | a repository with work to do |
| [grilling](./grilling) | a gate: the run stops for a person in each round. The cycle goes back to the questions, at most six times | claude, `sonnet` | this repository: `docs/plan.md`, `CONTEXT.md`, and `docs/adr/` |
| [research](./research) | the `web` tool, three readers at once, a budget in dollars, and a check that reads the sources again | claude, `sonnet`, and `opus` for the brief | `--with '{"question":"..."}'` |
| [triage](./triage) | a gate that overrides the agent, and no workspace at all | pi, `ollama/gpt-oss:120b` | `ISSUE.md` in the working directory |
| [docs-audit](./docs-audit) | one promise on the flow, so the workspace checks every step | pi, `ollama/glm-5.2` | a repository with `src/` and `docs/` |
| [release-notes](./release-notes) | a deterministic step reads git and hands the model the patch, so no model spends tokens on the log and none invents a feature | pi, `ollama/glm-5.2` | a git clone with history, and `--with '{}'` or `--with '{"range":"v0.1.0..HEAD"}'` |
| [decision](./decision) | three fixed stances argue from one prompt, then one brief, then a person decides | pi, `ollama/glm-5.2` | `DECISION.md` in the working directory |
| [dependency-audit](./dependency-audit) | one prompt over a list, a value every member supplies, a step that retries itself, and a step a condition rules out | claude, `sonnet` | a repository with `package.json` |

## Run one

```bash
cd <the directory you want the flow to work in>
orchy run <path to>/examples/triage/flow.yaml
orchy run <path to>/examples/research/flow.yaml --with '{"question":"..."}'
```

A prompt path is relative to the flow file. The working directory is where the
steps act, so run the command from there.

A flow that names `claude` needs the `claude` command on the path and an
account. A flow that names `pi` needs the provider in
`~/.pi/agent/models.json`; these flows name `ollama`. See
[docs/running.md](../docs/running.md) to declare one, or to name another model
in the flow file.

A flow that declares `takes` needs `--with`, and Orchy refuses the run without
it, before the first step spends a token. Write `--with '{}'` to take the
default of every value.

## What each one costs

A flow with a panel spends more than a flow with one step. `research` runs
three readers and then re-reads the sources, so it costs the most.
`dependency-audit` runs one step for each package, so it costs what its list is
long. `triage` and `decision` read one file and spend the least.

Only `research` declares a budget. A budget needs a cost that a harness
reports, and a provider with no price table reports none. Orchy stops a run
whose budget it cannot measure, so a flow on a free provider declares no
budget. See [ADR 0019](../docs/adr/0019-a-run-has-a-budget.md).

Read the trajectory of a run for the real number:

```bash
cat .orchy/runs/<run id>/trajectory.json | jq .final_metrics
```
