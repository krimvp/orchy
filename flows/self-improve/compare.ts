import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { profileRun } from "./profile.ts";

type SavedStep = { id: string; prompt?: string; module?: string; needs?: string[]; memory?: string };
type SavedRecord = { status?: string; prompt?: string; value?: unknown; endedAt?: string; changed?: { path: string; how: string; to?: string }[] };
type SavedState = {
  with?: unknown;
  startedAt?: string;
  flow?: { name: string; memory?: unknown; steps: SavedStep[] };
  steps?: Record<string, SavedRecord>;
  history?: { step: string; record: SavedRecord }[];
  spread?: Record<string, unknown>;
};

function stateOf(cwd: string, runId: string): SavedState {
  const file = join(cwd, ".orchy", "runs", runId, "state.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function prompts(state: SavedState, step: string): string[] {
  const records = [state.steps?.[step], ...(state.history ?? []).filter((one) => one.step === step).map((one) => one.record)];
  return records.filter((record) => (record?.status === "done" || record?.status === "failed") && typeof record.prompt === "string")
    .map((record) => record?.prompt as string);
}

function ownsFlowFile(state: SavedState, cwd: string, file: string): boolean {
  const flow = state.flow;
  if (!flow || !Array.isArray(flow.steps)) return false;
  const directory = dirname(file);
  if (directory === `flows/${flow.name}`) return true;
  return flow.steps.some((step) => [step.prompt, step.module].some((path) =>
    typeof path === "string" && relative(cwd, resolve(cwd, path)).startsWith(`${directory}/`)));
}

function changedEvidence(cwd: string, original: SavedState, candidate: SavedState, optimizer: SavedState): string[] {
  const changed = optimizer.steps?.apply?.changed;
  if (!Array.isArray(changed) || changed.length === 0) {
    throw new Error('step "compare" has no changed flow or prompt path in the apply record.');
  }
  return changed.map((entry) => {
    const file = entry.path;
    if (typeof file !== "string" || isAbsolute(file) || relative(cwd, resolve(cwd, file)) !== file ||
        !file.startsWith("flows/") || file.startsWith("flows/self-improve/") || entry.how !== "changed" || entry.to) {
      throw new Error(`step "compare" cannot prove the change at "${file}". Use an edited flow or prompt file under flows.`);
    }
    if (/\.ya?ml$/.test(file)) {
      if (!ownsFlowFile(original, cwd, file) || !ownsFlowFile(candidate, cwd, file)) {
        throw new Error(`step "compare" cannot link "${file}" to both stored flow snapshots.`);
      }
      if (Object.keys(original.spread ?? {}).length || Object.keys(candidate.spread ?? {}).length) {
        throw new Error(`step "compare" cannot separate the edit at "${file}" from computed fanout changes.`);
      }
      if (isDeepStrictEqual(original.flow, candidate.flow)) {
        throw new Error(`step "compare" finds no changed flow snapshot for "${file}".`);
      }
      return `${file}: stored flow changed`;
    }
    const path = resolve(cwd, file);
    const before = original.flow?.steps.filter((step) => step.prompt === path).map((step) => step.id) ?? [];
    const after = candidate.flow?.steps.filter((step) => step.prompt === path).map((step) => step.id) ?? [];
    const shared = before.filter((id) => after.includes(id));
    if (shared.length === 0) throw new Error(`step "compare" cannot link "${file}" to an executed step in both runs.`);
    if (!isDeepStrictEqual(original.flow, candidate.flow)) {
      throw new Error(`step "compare" cannot separate the prompt edit at "${file}" from flow changes.`);
    }
    const used = shared.some((id) => {
      const step = original.flow?.steps.find((one) => one.id === id);
      if (original.flow?.memory && step?.memory !== "none") return false;
      if ((original.history ?? []).some((one) => one.step === id) || (candidate.history ?? []).some((one) => one.step === id)) return false;
      if ((step?.needs ?? []).some((need) => !isDeepStrictEqual(original.steps?.[need]?.value, candidate.steps?.[need]?.value))) return false;
      const earlier = prompts(original, id);
      const later = prompts(candidate, id);
      return earlier.length > 0 && later.some((prompt) => !earlier.includes(prompt));
    });
    if (!used) throw new Error(`step "compare" finds no changed prompt for "${file}" in the executed steps.`);
    return `${file}: recorded prompt changed`;
  });
}

export default (steps: Record<string, unknown>, say: (note: string) => void, values: Record<string, unknown>, cwd: string, run: { runId: string }) => {
  const gate = steps.confirm as { candidate_run_id?: unknown; quality_ok?: unknown; quality_evidence?: unknown };
  if (typeof values.run_id !== "string" || typeof gate?.candidate_run_id !== "string" || typeof gate.quality_ok !== "boolean" || typeof gate.quality_evidence !== "string") {
    throw new Error('step "compare" needs two run ids and a human quality verdict.');
  }
  const before = profileRun(cwd, values.run_id);
  const after = profileRun(cwd, gate.candidate_run_id);
  if (before.run_id === after.run_id) throw new Error('step "compare" needs a new candidate run id.');
  const original = stateOf(cwd, before.run_id);
  const candidate = stateOf(cwd, after.run_id);
  if (before.flow !== after.flow || !isDeepStrictEqual(original.with ?? {}, candidate.with ?? {})) {
    throw new Error('step "compare" needs completed runs of the same flow with the same input values.');
  }
  const optimizer = stateOf(cwd, run.runId);
  const applied = Date.parse(optimizer.steps?.apply?.endedAt ?? "");
  const started = Date.parse(candidate.startedAt ?? "");
  if (!Number.isFinite(applied) || !Number.isFinite(started)) {
    throw new Error('step "compare" needs the optimizer apply end time and the candidate run start time.');
  }
  if (started <= applied) throw new Error('step "compare" cannot use a candidate that started before the apply step ended or at the same time.');
  const change_evidence = changedEvidence(cwd, original, candidate, optimizer);
  const delta = {
    flow_steps: after.flow_steps - before.flow_steps,
    executed_attempts: after.executed_attempts - before.executed_attempts,
    agent_attempts: after.agent_attempts - before.agent_attempts,
    wall_ms: after.wall_ms - before.wall_ms,
    attempt_ms: after.attempt_ms - before.attempt_ms,
    attempts: after.attempt_count - before.attempt_count,
    prompt_tokens: before.tokens.unknown_attempts || after.tokens.unknown_attempts ? null : after.tokens.prompt - before.tokens.prompt,
    completion_tokens: before.tokens.unknown_attempts || after.tokens.unknown_attempts ? null : after.tokens.completion - before.tokens.completion,
    cached_tokens: before.tokens.unknown_attempts || after.tokens.unknown_attempts ? null : after.tokens.cached - before.tokens.cached,
    cost_usd: before.cost.total_usd === null || after.cost.total_usd === null ? null : Number((after.cost.total_usd - before.cost.total_usd).toFixed(6)),
  };
  say(`compared ${before.run_id} with ${after.run_id}; one pair does not prove repeatable savings`);
  return { before, after, delta, change_evidence, quality_ok: gate.quality_ok, quality_evidence: gate.quality_evidence, repeatable_savings_proven: false };
};
