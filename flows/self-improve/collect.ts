import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type RecordOfStep = { status?: string; error?: string };
type State = {
  runId?: string;
  status?: string;
  startedAt?: string;
  error?: string;
  flow?: { name?: string };
  steps?: Record<string, RecordOfStep>;
};

const COMMANDS = ["npm test", "npm run check", "npm run ui:build"];
const LIMIT = 2400;

function bounded(value: string, failed = false): string {
  if (value.length <= LIMIT) return value;
  if (failed) {
    const at = value.search(/^not ok\b|^error:|^Error:/m);
    if (at >= 0) return `[failure and end of output]\n${value.slice(at, at + 1600)}\n...\n${value.slice(-700)}`;
  }
  return `[last ${LIMIT} characters]\n${value.slice(-LIMIT)}`;
}

function failedRun(cwd: string, runId: string, requested = false): State | undefined {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", runId, "state.json"), "utf8")) as State;
    if (!state || typeof state !== "object" || !state.flow || !state.steps) {
      throw new Error("the state is malformed");
    }
    if (state.flow.name === "self-improve" || state.status !== "failed") {
      if (requested) throw new Error(`the run is ${state.status ?? "unknown"} or belongs to self-improve`);
      return undefined;
    }
    return state;
  } catch (error) {
    if (requested) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`step "collect" cannot use run "${runId}": ${why}. Name a failed Orchy run.`);
    }
    return undefined;
  }
}

export default (
  _steps: unknown,
  say: (note: string) => void,
  values: Record<string, unknown>,
  cwd: string,
  run: { runId: string },
) => {
  const wanted = values.run_id;
  if (wanted !== undefined && (typeof wanted !== "string" || !/^[\w-]+$/.test(wanted))) {
    throw new Error('step "collect" needs a run_id made of letters, numbers, dashes, or underscores.');
  }
  let ids: string[] = [];
  try {
    ids = readdirSync(join(cwd, ".orchy", "runs"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (wanted === run.runId) throw new Error(`step "collect" cannot use its own run "${wanted}". Name an earlier failed run.`);
  if (wanted && !ids.includes(wanted)) {
    throw new Error(`step "collect" finds no run "${wanted}". Use "orchy runs" to list run ids.`);
  }
  const failed = ids
    .filter((id) => id !== run.runId && (!wanted || id === wanted))
    .map((id) => failedRun(cwd, id, Boolean(wanted)))
    .filter((state): state is State => state !== undefined)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const prior = failed[0];
  const brokenStep = prior && Object.entries(prior.steps ?? {}).find(([, record]) => record.status === "failed");
  const historical = prior
    ? {
        run_id: prior.runId ?? "unknown",
        flow: prior.flow?.name ?? "unknown",
        step: brokenStep?.[0] ?? "run",
        error: bounded(brokenStep?.[1].error ?? prior.error ?? "The run ended in failure without a recorded reason."),
      }
    : null;
  const checks = COMMANDS.map((command) => {
    const result = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: 180_000, maxBuffer: 2_000_000 });
    const code = result.status ?? -1;
    const output = bounded(`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(), code !== 0);
    say(`${command}: ${code === 0 ? "passed" : `failed (${code})`}`);
    return { command, ok: code === 0, code, output: result.error ? bounded(`${output}\n${result.error.message}`, true) : output };
  });
  return { actionable: historical !== null || checks.some((check) => !check.ok), historical, checks };
};
