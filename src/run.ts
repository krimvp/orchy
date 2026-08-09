import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type AgentStep,
  type CallStep,
  type Cycle,
  type Flow,
  type Step,
  cycleOf,
  order,
  validate,
} from "./flow.ts";
import type { Harness } from "./harness.ts";
import { pi } from "./pi.ts";
import { toAtif } from "./atif.ts";
import { changed, take } from "./workspace.ts";

const version = String(createRequire(import.meta.url)("../package.json").version);

/**
 * A contract is checked as plain JSON Schema, not as a TypeBox object. A schema
 * that has been through a file, a resume, or a graphical editor is data, and it
 * no longer carries the symbols that TypeBox needs.
 */
const ajv = new Ajv2020({ strict: false });

function contractProblem(step: Step, value: unknown): string | undefined {
  if (ajv.validate(step.returns, value)) return undefined;
  const [first] = ajv.errors ?? [];
  return `the value of "${step.id}" breaks the contract at "${first?.instancePath || "/"}": ${first?.message ?? "unknown"}`;
}

export interface StepRecord {
  status: "done" | "failed";
  startedAt: string;
  endedAt: string;
  value?: unknown;
  error?: string;
  trajectory?: string;
  /** A person supplied this value, so the cycle of the step does not fire again. */
  answeredByPerson?: boolean;
  /** The cycle reached its limit and the policy accepted the disagreement. */
  disagreement?: "accepted";
  /** Invariant 5: what the step changed in the workspace. */
  changed?: string[];
  /** The cost of the step, when the trajectory of the harness does not hold it. */
  cost?: number;
}

export interface RunState {
  runId: string;
  /** The flow is data, so a run holds the whole of it and resumes without the file. */
  flow: Flow;
  status: "running" | "waiting" | "done" | "failed";
  waitingFor?: string;
  question?: string;
  steps: Record<string, StepRecord>;
  cycles: Record<string, number>;
  /** The value that sent the run back, carried to the step it went back to. */
  feedback?: { step: string; value: unknown };
  /** Every step that a cycle dropped. A dropped attempt is still a cost. */
  history?: Array<{ step: string; record: StepRecord }>;
}

export type RunEvent =
  | { type: "step_start"; step: string }
  | { type: "step_end"; step: string; status: "done" | "failed" }
  | { type: "cycle"; step: string; to: string; count: number }
  | { type: "waiting"; step: string; question: string }
  | { type: "run_end"; status: RunState["status"] };

export interface RunOptions {
  cwd?: string;
  harness?: Harness;
  onEvent?: (event: RunEvent) => void;
}

export async function run(flow: Flow, options: RunOptions = {}): Promise<RunState> {
  const problems = validate(flow);
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);

  const cwd = resolve(options.cwd ?? process.cwd());
  const state: RunState = { runId: randomUUID(), flow, status: "running", steps: {}, cycles: {} };
  mkdirSync(directoryOf(cwd, state.runId), { recursive: true });
  return execute(state, cwd, options);
}

export async function resume(runId: string, value: unknown, options: RunOptions = {}): Promise<RunState> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const state = read(cwd, runId);

  if (state.status !== "waiting" || !state.waitingFor) {
    throw new Error(`the run ${runId} is ${state.status}, so it takes no value`);
  }

  const step = state.flow.steps.find((candidate) => candidate.id === state.waitingFor);
  if (!step) throw new Error(`the run ${runId} waits for "${state.waitingFor}", which the flow does not hold`);
  const problem = contractProblem(step, value);
  if (problem) throw new Error(problem);

  const now = new Date().toISOString();
  state.steps[step.id] = { status: "done", startedAt: now, endedAt: now, value, answeredByPerson: true };
  state.waitingFor = undefined;
  state.question = undefined;
  state.status = "running";
  return execute(state, cwd, options);
}

export function read(cwd: string, runId: string): RunState {
  return JSON.parse(readFileSync(join(directoryOf(resolve(cwd), runId), "state.json"), "utf8")) as RunState;
}

function directoryOf(cwd: string, runId: string): string {
  return join(cwd, ".orchy", "runs", runId);
}

async function execute(state: RunState, cwd: string, options: RunOptions): Promise<RunState> {
  const harness = options.harness ?? pi;
  const emit = options.onEvent ?? (() => {});
  // ADR 0005: the state on disk is the run. A gate and a crash recover the same way.
  const file = join(directoryOf(cwd, state.runId), "state.json");
  const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
  const close = () => {
    save();
    writeFileSync(join(directoryOf(cwd, state.runId), "trajectory.json"), JSON.stringify(toAtif(state, version, (h, i, v) => harness.toTrajectory(h, i, v)), null, 2));
  };
  save();

  const sorted = order(state.flow.steps);

  for (;;) {
    const next = sorted.find((step) => state.steps[step.id]?.status !== "done");
    if (!next) break;

    if (next.kind === "gate") {
      return stop(state, next.id, next.question, close, emit);
    }

    emit({ type: "step_start", step: next.id });
    const record = await runStep(next, state, cwd, harness);
    state.steps[next.id] = record;
    emit({ type: "step_end", step: next.id, status: record.status });

    if (record.status === "failed") {
      state.status = "failed";
      close();
      emit({ type: "run_end", status: state.status });
      return state;
    }

    const cycle = cycleOf(next);
    if (cycle && !record.answeredByPerson && matches(cycle.when as Record<string, unknown>, record.value)) {
      const key = `${next.id}->${cycle.to}`;
      const count = (state.cycles[key] ?? 0) + 1;

      if (count > cycle.limit) {
        // Invariant 4: the cycle stops here whatever the steps still think.
        if (cycle.policy === "escalate") {
          state.history = [...(state.history ?? []), { step: next.id, record }];
          delete state.steps[next.id];
          return stop(state, next.id, questionFor(next, cycle), close, emit);
        }
        record.disagreement = "accepted";
      } else {
        state.cycles[key] = count;
        // A cycle that drops the reason for it sends the step back blind.
        state.feedback = { step: next.id, value: record.value };
        goBackTo(cycle.to, state, sorted);
        emit({ type: "cycle", step: next.id, to: cycle.to, count });
      }
    }

    save();
  }

  state.status = "done";
  close();
  emit({ type: "run_end", status: state.status });
  return state;
}

function stop(
  state: RunState,
  step: string,
  question: string,
  close: () => void,
  emit: (event: RunEvent) => void,
): RunState {
  state.status = "waiting";
  state.waitingFor = step;
  state.question = question;
  close();
  emit({ type: "waiting", step, question });
  return state;
}

function questionFor(step: Step, cycle: Cycle): string {
  return `Step "${step.id}" reached its limit of ${cycle.limit} cycles back to "${cycle.to}" and still disagrees. Supply the value for "${step.id}".`;
}

/**
 * ponytail: clears every step from the target onward, not only the steps that
 * depend on it. A run is sequential, so the extra work is never done twice.
 */
function goBackTo(target: string, state: RunState, sorted: Step[]): void {
  const from = sorted.findIndex((step) => step.id === target);
  const dropped = state.history ?? [];
  for (const later of sorted.slice(from)) {
    const record = state.steps[later.id];
    if (record) dropped.push({ step: later.id, record });
    delete state.steps[later.id];
  }
  state.history = dropped;
}

function matches(when: Record<string, unknown>, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(when).every(([key, wanted]) => isDeepStrictEqual(record[key], wanted));
}

async function runStep(step: Step, state: RunState, cwd: string, harness: Harness): Promise<StepRecord> {
  const startedAt = new Date().toISOString();
  const at = () => ({ startedAt, endedAt: new Date().toISOString() });
  const inputs = Object.fromEntries(step.needs.map((need) => [need, state.steps[need]?.value]));
  if (state.feedback) inputs[state.feedback.step] = state.feedback.value;
  state.feedback = undefined;

  const before = take(state.flow.workspace, cwd);

  let result: { value: unknown; trajectory?: string; cost?: number };
  try {
    result =
      step.kind === "agent"
        ? await harness.run({
            step: step.id,
            prompt: buildPrompt(step, inputs, cwd),
            tools: step.tools,
            returns: step.returns,
            cwd,
          })
        : { value: await callModule(step as CallStep, inputs, cwd) };
  } catch (error) {
    return { ...at(), status: "failed", error: String(error) };
  }

  // Invariant 5: what the step really did, not what it says it did.
  const touched = changed(before, take(state.flow.workspace, cwd));
  if (step.kind !== "gate" && step.changes === false && touched.length > 0) {
    return {
      ...at(),
      status: "failed",
      error: `step "${step.id}" promises to change nothing, but it changed ${touched.join(", ")}`,
      value: result.value,
      changed: touched,
    };
  }

  // Invariant 2: the value must match the contract of the step.
  const problem = contractProblem(step, result.value);
  if (problem) return { ...at(), status: "failed", error: problem, value: result.value, changed: touched };

  const record: StepRecord = { ...at(), status: "done", value: result.value, trajectory: result.trajectory };
  if (result.cost !== undefined) record.cost = result.cost;
  if (touched.length > 0) record.changed = touched;
  return record;
}

function buildPrompt(step: AgentStep, inputs: Record<string, unknown>, cwd: string): string {
  const text = readFileSync(resolve(cwd, step.prompt), "utf8");
  if (Object.keys(inputs).length === 0) return text;
  return `${text}\n\n## The values of the steps before this one\n\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\`\n`;
}

async function callModule(step: CallStep, inputs: Record<string, unknown>, cwd: string): Promise<unknown> {
  const module = await import(pathToFileURL(resolve(cwd, step.module)).href);
  return module.default(inputs);
}
