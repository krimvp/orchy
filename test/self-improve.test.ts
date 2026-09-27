import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import compare from "../flows/self-improve/compare.ts";
import { profileRun } from "../flows/self-improve/profile.ts";
import { readFlow } from "../src/load.ts";
import { schemaProblem } from "../src/flow.ts";

test("the optimization proposal accepts YAML flows and Markdown prompts only", async () => {
  const flow = await readFlow("flows/self-improve/optimize.yaml");
  const step = flow.steps.find((one) => one.id === "propose");
  assert.ok(step && step.kind === "agent");
  const schema = step.returns;
  const proposal = { candidate: true, change: "Shorten one step", evidence: "Run step 2", quality_check: "Run the same check", rerun: "Use the same input" };
  assert.equal(schemaProblem(schema, { ...proposal, file: "flows/sample/flow.yaml" }), undefined);
  assert.equal(schemaProblem(schema, { ...proposal, file: "flows/sample/prompts/write.md" }), undefined);
  assert.match(schemaProblem(schema, { ...proposal, file: "flows/sample/component.ts" }) ?? "", /file/);
  assert.equal(schemaProblem(schema, { candidate: false, file: "", change: "", evidence: "", quality_check: "", rerun: "" }), undefined);
});

function fixture(cwd: string, runId: string, withValue: object, cost?: number, cached?: number, startedAt = runId === "changed" ? "2026-01-01T00:00:10.000Z" : "2026-01-01T00:00:00.000Z", prompt = runId === "changed" ? "Changed prompt" : "Original prompt"): void {
  const directory = join(cwd, ".orchy", "runs", runId);
  mkdirSync(directory, { recursive: true });
  const state = {
    runId,
    startedAt,
    status: "done",
    flow: { name: "sample", steps: [{ id: "write", kind: "agent", prompt: join(cwd, "flows", "sample", "prompt.md") }] },
    with: withValue,
    steps: {
      write: {
        status: "done",
        startedAt,
        endedAt: new Date(Date.parse(startedAt) + 2000).toISOString(),
        prompt,
        ...(cost === undefined ? {} : { cost }),
      },
    },
  };
  const trajectory = {
    schema_version: "ATIF-v1.7",
    trajectory_id: runId,
    steps: [{
      extra: { orchy: { step: "write" } },
      subagent_trajectory_ref: { trajectory_id: `${runId}:1:write` },
    }],
    subagent_trajectories: [{
      trajectory_id: `${runId}:1:write`,
      final_metrics: {
        prompt_tokens: 100,
        completion_tokens: 20,
        ...(cached === undefined ? {} : { cached_tokens: cached }),
        cost_usd: 0,
      },
    }],
  };
  writeFileSync(join(directory, "state.json"), JSON.stringify(state));
  writeFileSync(join(directory, "trajectory.json"), JSON.stringify(trajectory));
}

function optimizer(cwd: string, path = "flows/sample/prompt.md"): { runId: string } {
  const runId = "optimizer";
  const directory = join(cwd, ".orchy", "runs", runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    runId,
    steps: { apply: { endedAt: "2026-01-01T00:00:05.000Z", changed: [{ path, how: "changed" }] } },
  }));
  return { runId };
}

function changeFlow(cwd: string, runId: string): void {
  const file = join(cwd, ".orchy", "runs", runId, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.flow.model = "new-model";
  writeFileSync(file, JSON.stringify(state));
}

test("a profile keeps agent cost and missing token counts unknown", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-profile-"));
  try {
    fixture(cwd, "original", { task: 1 });
    const result = profileRun(cwd, "original");
    assert.equal(result.flow_steps, 1);
    assert.equal(result.executed_attempts, 1);
    assert.equal(result.agent_attempts, 1);
    assert.equal(result.attempt_ms, 2000);
    assert.equal(result.cost.total_usd, null);
    assert.equal(result.cost.unknown_attempts, 1);
    assert.equal(result.tokens.unknown_attempts, 1);
    assert.equal(result.attempts[0]?.cached_tokens, null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison requires the same input values", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 2 }, 0.05, 5);
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    assert.throws(() => compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd)), /same input values/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison reports measured deltas and leaves repeatability unproved", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 1 }, 0.05, 5);
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    const result = compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd));
    assert.equal(result.delta.cost_usd, -0.05);
    assert.equal(result.delta.flow_steps, 0);
    assert.equal(result.delta.agent_attempts, 0);
    assert.equal(result.repeatable_savings_proven, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison refuses a candidate started before the optimizer applied its change", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 1 }, 0.05, 5, "2026-01-01T00:00:04.000Z");
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    assert.throws(() => compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd)), /started before the apply step ended/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison refuses a later run that used the old prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 1 }, 0.05, 5, "2026-01-01T00:00:10.000Z", "Original prompt");
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    assert.throws(() => compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd)), /no changed prompt/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison accepts a changed stored flow tied to the edited YAML path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 1 }, 0.05, 5);
    changeFlow(cwd, "changed");
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    const result = compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd, "flows/sample/flow.yaml"));
    assert.deepEqual(result.change_evidence, ["flows/sample/flow.yaml: stored flow changed"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a comparison refuses a flow difference outside the edited YAML path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-compare-"));
  try {
    fixture(cwd, "original", { task: 1 }, 0.1, 5);
    fixture(cwd, "changed", { task: 1 }, 0.05, 5);
    changeFlow(cwd, "changed");
    const steps = { confirm: { candidate_run_id: "changed", quality_ok: true, quality_evidence: "same check" } };
    assert.throws(() => compare(steps, () => {}, { run_id: "original" }, cwd, optimizer(cwd, "flows/other/flow.yaml")), /cannot link/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
