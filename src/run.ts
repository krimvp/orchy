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
  type GateStep,
  type Step,
  WAVE,
  cycleOf,
  expandFanout,
  order,
  validate,
} from "./flow.ts";
import type { Harness, Note } from "./harness.ts";
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
  if (step.kind === "flow") return `step "${step.id}" is a flow that no one expanded`;
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
  /** The value that sent the run back, and the step it goes back to. */
  feedback?: { step: string; to: string; value: unknown };
  /** Every step that a cycle dropped. A dropped attempt is still a cost. */
  history?: Array<{ step: string; record: StepRecord }>;
}

export type RunEvent =
  /** A resume emits this as well, so a parent process learns the run it drives. */
  | { type: "run_start"; runId: string }
  | { type: "step_start"; step: string }
  /** What a step reports while it works. The trajectory holds the whole of it. */
  | { type: "output"; step: string; kind: Note["kind"]; text: string }
  | { type: "step_end"; step: string; status: "done" | "failed" }
  | { type: "cycle"; step: string; to: string; count: number }
  | { type: "waiting"; step: string; question: string }
  | { type: "run_end"; status: RunState["status"] };

export interface RunOptions {
  cwd?: string;
  /** The harness for a step that names none. */
  harness?: Harness;
  /** The adapters a step can name. */
  harnesses?: Record<string, Harness>;
  onEvent?: (event: RunEvent) => void;
}

export async function run(input: Flow, options: RunOptions = {}): Promise<RunState> {
  const flow = expandFanout(input);
  // A sub-flow needs a file, so only the loader can expand one. Say so plainly.
  const nested = flow.steps.find((step) => step.kind === "flow");
  if (nested) throw new Error(`step "${nested.id}" holds a flow, and only loading a file expands one`);

  const problems = validate(flow);
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);

  for (const step of flow.steps) harnessFor(step, options.harness ?? pi, options.harnesses);

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
  // Each step may use a different harness, so each trajectory is read by its own.
  const convert = (id: string, handle: string, trajectoryId: string, at: string) => {
    const step = state.flow.steps.find((candidate) => candidate.id === id);
    if (!step) return undefined;
    return harnessFor(step, harness, options.harnesses).toTrajectory(handle, trajectoryId, at);
  };
  const close = () => {
    save();
    const file = join(directoryOf(cwd, state.runId), "trajectory.json");
    writeFileSync(file, JSON.stringify(toAtif(state, version, convert), null, 2));
  };
  save();
  emit({ type: "run_start", runId: state.runId });

  const sorted = order(state.flow.steps);
  const done = (id: string) => state.steps[id]?.status === "done";

  for (;;) {
    // Every step whose needs have passed runs together. Invariant 3 still holds,
    // because a step with an unfinished need is not in the wave.
    const ready = sorted.filter((step) => !done(step.id) && step.needs.every(done));
    if (ready.length === 0) break;

    const work = ready.filter((step) => step.kind !== "gate");
    if (work.length === 0) {
      const waiting = ready[0] as GateStep;
      return stop(state, waiting.id, waiting.question, close, emit);
    }

    const feedback = state.feedback;
    state.feedback = undefined;

    const records = await pool(work, state.flow.parallel ?? WAVE, async (step) => {
      emit({ type: "step_start", step: step.id });
      const watch = (note: Note) => emit({ type: "output", step: step.id, ...note });
      const record = await runStep(step, state, cwd, harnessFor(step, harness, options.harnesses), watch, feedback);
      emit({ type: "step_end", step: step.id, status: record.status });
      return record;
    });

    work.forEach((step, index) => {
      state.steps[step.id] = records[index] as StepRecord;
    });

    const broken = work.find((step) => state.steps[step.id]?.status === "failed");
    if (broken) {
      state.status = "failed";
      close();
      emit({ type: "run_end", status: state.status });
      return state;
    }

    // One wave settles one cycle. A second would fight the first for the same steps.
    const turning = work.find((step) => {
      const cycle = cycleOf(step);
      const record = state.steps[step.id] as StepRecord;
      return cycle && !record.answeredByPerson && matches(cycle.when as Record<string, unknown>, record.value);
    });

    if (turning) {
      const cycle = cycleOf(turning) as Cycle;
      const record = state.steps[turning.id] as StepRecord;
      const key = `${turning.id}->${cycle.to}`;
      const count = (state.cycles[key] ?? 0) + 1;

      if (count > cycle.limit) {
        // Invariant 4: the cycle stops here whatever the steps still think.
        if (cycle.policy === "escalate") {
          state.history = [...(state.history ?? []), { step: turning.id, record }];
          delete state.steps[turning.id];
          return stop(state, turning.id, questionFor(turning, cycle), close, emit);
        }
        record.disagreement = "accepted";
      } else {
        state.cycles[key] = count;
        // A cycle that drops the reason for it sends the step back blind.
        state.feedback = { step: turning.id, to: cycle.to, value: record.value };
        goBackTo(cycle.to, state, sorted);
        emit({ type: "cycle", step: turning.id, to: cycle.to, count });
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

/** Runs at most `limit` at once, and keeps the answers in the order it was given. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      answers[index] = await work(items[index] as T);
    }
  });
  await Promise.all(workers);
  return answers;
}

function harnessFor(step: Step, fallback: Harness, named?: Record<string, Harness>): Harness {
  if (step.kind !== "agent" || !step.harness) return fallback;
  const chosen = named?.[step.harness];
  if (!chosen) throw new Error(`step "${step.id}" names the harness "${step.harness}", which this run does not have`);
  return chosen;
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

async function runStep(
  step: Step,
  state: RunState,
  cwd: string,
  harness: Harness,
  watch: (note: Note) => void,
  feedback?: RunState["feedback"],
): Promise<StepRecord> {
  const startedAt = new Date().toISOString();
  const at = () => ({ startedAt, endedAt: new Date().toISOString() });
  const inputs = Object.fromEntries(step.needs.map((need) => [need, state.steps[need]?.value]));
  // Only the step the cycle went back to hears why it went back.
  if (feedback && feedback.to === step.id) inputs[feedback.step] = feedback.value;

  const before = take(state.flow.workspace, cwd);

  let result: { value: unknown; trajectory?: string; cost?: number };
  try {
    result =
      step.kind === "agent"
        ? await harness.run(
            {
              step: step.id,
              prompt: buildPrompt(step, inputs, cwd),
              tools: step.tools,
              returns: step.returns,
              cwd,
              model: step.model,
            },
            watch,
          )
        : { value: await callModule(step as CallStep, inputs, cwd, watch) };
  } catch (error) {
    return { ...at(), status: "failed", error: String(error) };
  }

  // Invariant 5: what the step really did, not what it says it did.
  const touched = changed(before, take(state.flow.workspace, cwd));
  if ((step.kind === "agent" || step.kind === "call") && step.changes === false && touched.length > 0) {
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

/**
 * A component takes the values of the steps before it, and a way to say what it
 * does. A component that says nothing ignores the second argument.
 */
async function callModule(
  step: CallStep,
  inputs: Record<string, unknown>,
  cwd: string,
  watch: (note: Note) => void,
): Promise<unknown> {
  const module = await import(pathToFileURL(resolve(cwd, step.module)).href);
  return module.default(inputs, (text: string) => watch({ kind: "text", text: String(text) }));
}
