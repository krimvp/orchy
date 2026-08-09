import { readFileSync } from "node:fs";
import type { RunState, StepRecord } from "./run.ts";

/** Pinned by ADR 0003. ATIF still moves, so Orchy does not follow it silently. */
export const SCHEMA_VERSION = "ATIF-v1.7";

export interface Metrics {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  cost_usd?: number;
}

export interface ToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

export interface Step {
  step_id: number;
  timestamp: string;
  source: "user" | "agent" | "system";
  message: string;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  observation?: { results: Array<{ source_call_id: string; content: string }> };
  metrics?: Metrics;
  subagent_trajectory_ref?: { trajectory_id: string };
  extra?: Record<string, unknown>;
}

export interface Trajectory {
  schema_version: string;
  trajectory_id: string;
  session_id: string;
  agent: { name: string; version: string; model_name: string };
  steps: Step[];
  subagent_trajectories?: Trajectory[];
  final_metrics: Metrics & { total_steps: number };
}

export type ToTrajectory = (step: string, handle: string, trajectoryId: string, version: string) => Trajectory | undefined;

export function toAtif(state: RunState, version: string, toTrajectory: ToTrajectory): Trajectory {
  const children: Trajectory[] = [];
  const steps: Step[] = [];
  const spend: Metrics[] = [];

  for (const { step, record, dropped } of attempts(state)) {
    const child = record.trajectory
      ? toTrajectory(step, record.trajectory, `${state.runId}:${steps.length + 1}:${step}`, version)
      : undefined;
    // A harness that keeps no cost in its trajectory reports it on the result.
    if (child && record.cost !== undefined) child.final_metrics.cost_usd = record.cost;
    if (child) children.push(child);

    // A step with no trajectory still spent money, so its cost must still count.
    const spent: Metrics = child
      ? child.final_metrics
      : { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: record.cost ?? 0 };
    spend.push(spent);

    steps.push({
      step_id: steps.length + 1,
      timestamp: record.endedAt,
      source: record.answeredByPerson ? "user" : "agent",
      message: `step "${step}" ended ${record.status}${record.error ? `: ${record.error}` : ""}`,
      metrics: spent,
      subagent_trajectory_ref: child ? { trajectory_id: child.trajectory_id } : undefined,
      extra: {
        orchy: {
          step,
          status: record.status,
          changed: record.changed,
          disagreement: record.disagreement,
          answeredByPerson: record.answeredByPerson,
          // A cycle threw this run of the step away. It is still a cost.
          dropped: dropped || undefined,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
        },
      },
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    trajectory_id: state.runId,
    session_id: state.runId,
    agent: { name: `orchy/${state.flow.name}`, version, model_name: modelOf(children) },
    steps,
    subagent_trajectories: children,
    final_metrics: { ...totalMetrics(spend), total_steps: steps.length },
  };
}

/**
 * Every run of every step, in the order they happened. A cycle runs a step more
 * than once, and a record that is dropped from the state is still a cost.
 */
export function attempts(state: RunState): Array<{ step: string; record: StepRecord; dropped?: boolean }> {
  const current = state.flow.steps
    .filter((step) => state.steps[step.id])
    .map((step) => ({ step: step.id, record: state.steps[step.id] as StepRecord }));
  const gone = (state.history ?? []).map((one) => ({ ...one, dropped: true }));
  return [...gone, ...current].sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
}

function modelOf(children: Trajectory[]): string {
  return children.find((child) => child.agent.model_name !== "unknown")?.agent.model_name ?? "unknown";
}

export function totalMetrics(parts: Metrics[]): Metrics {
  return parts.reduce<Metrics>(
    (sum, part) => ({
      prompt_tokens: sum.prompt_tokens + part.prompt_tokens,
      completion_tokens: sum.completion_tokens + part.completion_tokens,
      cached_tokens: (sum.cached_tokens ?? 0) + (part.cached_tokens ?? 0),
      cost_usd: (sum.cost_usd ?? 0) + (part.cost_usd ?? 0),
    }),
    { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: 0 },
  );
}
