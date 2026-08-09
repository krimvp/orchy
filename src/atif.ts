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

export function toAtif(state: RunState, version: string): Trajectory {
  const children: Trajectory[] = [];
  const steps: Step[] = [];

  for (const { step, record } of attempts(state)) {
    const child = record.trajectory
      ? fromSession(record.trajectory, `${state.runId}:${steps.length + 1}:${step}`, version)
      : undefined;
    if (child) children.push(child);

    steps.push({
      step_id: steps.length + 1,
      timestamp: record.endedAt,
      source: record.answeredByPerson ? "user" : "agent",
      message: `step "${step}" ended ${record.status}${record.error ? `: ${record.error}` : ""}`,
      metrics: child?.final_metrics,
      subagent_trajectory_ref: child ? { trajectory_id: child.trajectory_id } : undefined,
      extra: {
        orchy: {
          step,
          status: record.status,
          changed: record.changed,
          disagreement: record.disagreement,
          answeredByPerson: record.answeredByPerson,
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
    final_metrics: { ...total(children.map((child) => child.final_metrics)), total_steps: steps.length },
  };
}

/**
 * Every run of every step, in the order they happened. A cycle runs a step more
 * than once, and a record that is dropped from the state is still a cost.
 */
function attempts(state: RunState): Array<{ step: string; record: StepRecord }> {
  const current = state.flow.steps
    .filter((step) => state.steps[step.id])
    .map((step) => ({ step: step.id, record: state.steps[step.id] as StepRecord }));
  return [...(state.history ?? []), ...current].sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
}

function modelOf(children: Trajectory[]): string {
  return children.find((child) => child.agent.model_name !== "unknown")?.agent.model_name ?? "unknown";
}

/** A session file is data from another program, so read it defensively. */
function fromSession(path: string, trajectoryId: string, version: string): Trajectory | undefined {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return undefined;
  }

  const steps: Step[] = [];
  const metrics: Metrics[] = [];
  let model = "unknown";

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message as PiMessage | undefined;
    const step = toStep(message, steps.length + 1, String(entry.timestamp ?? ""));
    if (!step) continue;
    if (message?.role === "assistant" && message.model) model = message.model;
    if (step.metrics) metrics.push(step.metrics);
    steps.push(step);
  }

  return {
    schema_version: SCHEMA_VERSION,
    trajectory_id: trajectoryId,
    session_id: trajectoryId,
    agent: { name: "pi", version, model_name: model },
    steps,
    final_metrics: { ...total(metrics), total_steps: steps.length },
  };
}

interface PiContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role?: string;
  content?: string | PiContent[];
  model?: string;
  toolCallId?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
}

function toStep(message: PiMessage | undefined, id: number, timestamp: string): Step | undefined {
  if (!message?.role) return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const text =
    typeof message.content === "string"
      ? message.content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");

  if (message.role === "user") {
    return { step_id: id, timestamp, source: "user", message: text };
  }

  if (message.role === "toolResult") {
    return {
      step_id: id,
      timestamp,
      source: "system",
      message: "",
      observation: { results: [{ source_call_id: message.toolCallId ?? "", content: text }] },
    };
  }

  if (message.role !== "assistant") return undefined;

  const calls = content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      tool_call_id: part.id ?? "",
      function_name: part.name ?? "",
      arguments: part.arguments ?? {},
    }));
  const thinking = content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking ?? "")
    .join("\n");

  return {
    step_id: id,
    timestamp,
    source: "agent",
    message: text,
    reasoning_content: thinking || undefined,
    tool_calls: calls.length > 0 ? calls : undefined,
    metrics: {
      prompt_tokens: message.usage?.input ?? 0,
      completion_tokens: message.usage?.output ?? 0,
      cached_tokens: message.usage?.cacheRead ?? 0,
      cost_usd: message.usage?.cost?.total ?? 0,
    },
  };
}

function total(parts: Metrics[]): Metrics {
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
