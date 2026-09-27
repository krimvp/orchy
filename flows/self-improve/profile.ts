import { readFileSync } from "node:fs";
import { join } from "node:path";

type RecordOfStep = { status: string; startedAt: string; endedAt: string; cost?: number };
type State = {
  runId: string;
  status: string;
  flow: { name: string; steps: { id: string; kind: string }[] };
  with?: Record<string, unknown>;
  steps: Record<string, RecordOfStep>;
  history?: { step: string; record: RecordOfStep }[];
};
type Metrics = { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cost_usd?: number };
type RootStep = { metrics?: Metrics; extra?: { orchy?: { step?: string } }; subagent_trajectory_ref?: { trajectory_id: string } };
type Trajectory = {
  schema_version: string;
  trajectory_id: string;
  steps: RootStep[];
  subagent_trajectories?: { trajectory_id: string; final_metrics?: Metrics }[];
};

const MAX_ATTEMPTS = 24;

function readJson(file: string, runId: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(`run "${runId}" has no readable ${file.endsWith("state.json") ? "state" : "ATIF trajectory"}: ${why}`);
  }
}

function amount(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${where} must be a finite number of zero or more.`);
  }
  return value;
}

export function profileRun(cwd: string, runId: string) {
  if (!/^[\w-]+$/.test(runId)) throw new Error(`run "${runId}" has an invalid id.`);
  const at = join(cwd, ".orchy", "runs", runId);
  const state = readJson(join(at, "state.json"), runId) as State;
  const trajectory = readJson(join(at, "trajectory.json"), runId) as Trajectory;
  if (state?.runId !== runId || state.status !== "done" || !state.flow?.name || !Array.isArray(state.flow.steps) || !state.steps) {
    throw new Error(`run "${runId}" needs a completed Orchy state with a flow name.`);
  }
  if (state.flow.name === "self-improve-optimize") throw new Error(`run "${runId}" is an optimizer run. Name an earlier completed run.`);
  if (trajectory?.schema_version !== "ATIF-v1.7" || trajectory.trajectory_id !== runId || !Array.isArray(trajectory.steps)) {
    throw new Error(`run "${runId}" needs its ATIF-v1.7 trajectory.`);
  }
  const records = [
    ...(state.history ?? []),
    ...state.flow.steps.filter((step) => state.steps[step.id]).map((step) => ({ step: step.id, record: state.steps[step.id] as RecordOfStep })),
  ].sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
  if (records.length !== trajectory.steps.length) throw new Error(`run "${runId}" has different attempt counts in its state and trajectory.`);
  const kinds = new Map(state.flow.steps.map((step) => [step.id, step.kind]));
  const children = new Map((trajectory.subagent_trajectories ?? []).map((child) => [child.trajectory_id, child]));
  let knownCost = 0;
  let unknownCost = 0;
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let unknownTokens = 0;
  let attemptMs = 0;
  let executedAttempts = 0;
  let agentAttempts = 0;
  const attempts = records.map(({ step, record }, index) => {
    const root = trajectory.steps[index];
    if (root?.extra?.orchy?.step !== step) throw new Error(`run "${runId}" has a different step at attempt ${index + 1}.`);
    const start = Date.parse(record.startedAt);
    const end = Date.parse(record.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error(`run "${runId}" has invalid times for step "${step}".`);
    }
    const duration_ms = end - start;
    attemptMs += duration_ms;
    const child = root.subagent_trajectory_ref && children.get(root.subagent_trajectory_ref.trajectory_id);
    const agent = kinds.get(step) === "agent" && record.status !== "skipped";
    if (record.status !== "skipped") executedAttempts++;
    if (agent) agentAttempts++;
    const metrics = agent ? child?.final_metrics : root.metrics;
    const token = (value: number | undefined, name: string) => agent && value === undefined ? null : amount(value ?? 0, `step "${step}" ${name}`);
    const prompt_tokens = token(metrics?.prompt_tokens, "prompt tokens");
    const completion_tokens = token(metrics?.completion_tokens, "completion tokens");
    const cached_tokens = token(metrics?.cached_tokens, "cached tokens");
    if (prompt_tokens === null || completion_tokens === null || cached_tokens === null) unknownTokens++;
    prompt += prompt_tokens ?? 0;
    completion += completion_tokens ?? 0;
    cached += cached_tokens ?? 0;
    const cost_usd = agent ? record.cost ?? null : 0;
    if (cost_usd === null) unknownCost++;
    else knownCost += amount(cost_usd, `step "${step}" cost`);
    return { step, status: record.status, duration_ms, prompt_tokens, completion_tokens, cached_tokens, cost_usd };
  });
  const starts = records.map(({ record }) => Date.parse(record.startedAt));
  const ends = records.map(({ record }) => Date.parse(record.endedAt));
  return {
    run_id: runId,
    flow: state.flow.name,
    flow_steps: state.flow.steps.length,
    attempt_count: attempts.length,
    executed_attempts: executedAttempts,
    agent_attempts: agentAttempts,
    attempts: attempts.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, MAX_ATTEMPTS),
    omitted_attempts: Math.max(0, attempts.length - MAX_ATTEMPTS),
    wall_ms: starts.length ? Math.max(...ends) - Math.min(...starts) : 0,
    attempt_ms: attemptMs,
    tokens: { prompt, completion, cached, unknown_attempts: unknownTokens },
    cost: { known_usd: Number(knownCost.toFixed(6)), unknown_attempts: unknownCost, total_usd: unknownCost ? null : Number(knownCost.toFixed(6)) },
  };
}

export default (_steps: unknown, say: (note: string) => void, values: Record<string, unknown>, cwd: string) => {
  if (typeof values.run_id !== "string") throw new Error('step "profile" needs run_id. Supply a completed run id.');
  const result = profileRun(cwd, values.run_id);
  say(`run ${result.run_id}: ${result.attempt_count} attempts; ${result.omitted_attempts} omitted from the list`);
  return result;
};
