---
status: accepted
---

# Write trajectories as ATIF

Orchy writes the record of a run in the Agent Trajectory Interchange Format
(ATIF), version 1.7. Orchy does not design its own format, and Orchy does not
emit OpenTelemetry spans directly.

ATIF fits the shape of a flow. A trajectory holds `steps` and
`subagent_trajectories`, so one run becomes one trajectory and each step becomes
a child trajectory. It also holds `final_metrics` with `total_prompt_tokens`,
`total_completion_tokens`, `total_cached_tokens`, and `total_cost_usd`, which
covers the measurement that a user needs.

Tools already read ATIF. Arize Phoenix ingests ATIF and converts it to
OpenTelemetry span trees, and NVIDIA NeMo Relay exports to it. So Orchy gets
OpenTelemetry through a converter and ships no exporter and no dashboard.

## Consequences

Orchy converts the Pi session file, which is JSONL with an `id` and `parentId`
tree, into ATIF. This conversion lives in the Pi adapter.

ATIF is at version 1.7 and it still changes. Orchy pins the version and records
it in `schema_version`.

One field does not meet this decision yet. `src/atif.ts` writes the per-step
names in `final_metrics` — `prompt_tokens`, `completion_tokens`,
`cached_tokens`, `cost_usd` — where ATIF names the four totals above, so a tool
that reads ATIF finds none of them. The sweep recorded it, and it is open. See
[docs/sweep/observability.md](../sweep/observability.md).

Sources: the [Harbor trajectory
format](https://www.harborframework.com/docs/agents/trajectory-format) and the
[NVIDIA NeMo Relay ATIF
exporter](https://docs.nvidia.com/nemo/relay/v0.6.0/configure-plugins/observability/atif).
