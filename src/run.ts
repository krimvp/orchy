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
  type Changes,
  type Cycle,
  type Flow,
  type GateStep,
  type Match,
  type Step,
  WAVE,
  cycleOf,
  expandFanout,
  harnessOf,
  modelOf,
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
  /** A condition ruled a skipped step out, or a step it needs was skipped. */
  status: "done" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  value?: unknown;
  error?: string;
  trajectory?: string;
  /** A person supplied this value, so the cycle of the step does not fire again. */
  answeredByPerson?: boolean;
  /** The cycle reached its limit and the policy accepted the disagreement. */
  disagreement?: "accepted";
  /** Why a condition ruled the step out, so a reader needs no second look. */
  skipped?: string;
  /** The step voted to cycle, and the run acted on a vote to an earlier step. */
  votedToCycle?: string;
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
  /** Each value that sent the run back, and the step it goes back to. */
  feedback?: Array<{ step: string; to: string; value: unknown }>;
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
  /** A condition ruled the step out. It never starts, so it never ends. */
  | { type: "skip"; step: string; why: string }
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
  // The members go before the expansion does, so check the flow a user wrote first.
  refuse(validate(input));
  const flow = expandFanout(input);
  // A sub-flow needs a file, so only the loader can expand one. Say so plainly.
  const nested = flow.steps.find((step) => step.kind === "flow");
  if (nested) throw new Error(`step "${nested.id}" holds a flow, and only loading a file expands one`);

  refuse(validate(flow));

  for (const step of flow.steps) harnessFor(flow, step, options.harness ?? pi, options.harnesses);

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

function refuse(problems: string[]): void {
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);
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
    return harnessFor(state.flow, step, harness, options.harnesses).toTrajectory(handle, trajectoryId, at);
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
  // A skipped step never passes, so a step that needs it never starts either.
  const settled = (id: string) => done(id) || state.steps[id]?.status === "skipped";

  for (;;) {
    // Every step whose needs have settled runs together. Invariant 3 still holds,
    // because a step with an unfinished need is not in the wave.
    const ready = sorted.filter((step) => !settled(step.id) && step.needs.every(settled));
    if (ready.length === 0) break;

    const ruled = ready.map((step) => [step, skipOf(step, state)] as const).filter(([, why]) => why !== undefined);
    if (ruled.length > 0) {
      const now = new Date().toISOString();
      for (const [step, why] of ruled) {
        state.steps[step.id] = { status: "skipped", startedAt: now, endedAt: now, skipped: why };
        emit({ type: "skip", step: step.id, why: why as string });
      }
      save();
      continue;
    }

    const work = ready.filter((step) => step.kind !== "gate");
    if (work.length === 0) {
      const waiting = ready[0] as GateStep;
      return stop(state, waiting.id, waiting.question, close, emit);
    }

    const feedback = state.feedback;
    state.feedback = undefined;

    // Invariant 5: a promise needs a workspace that no other step disturbs, so a
    // wave that holds a promise runs one step at a time.
    // ponytail: two runs in one working directory still disturb each other, so a
    // promise holds inside one run only. A workspace for each run lifts that.
    const parallel = work.some((step) => promiseOf(step) !== undefined) ? 1 : (state.flow.parallel ?? WAVE);

    await pool(work, parallel, async (step) => {
      emit({ type: "step_start", step: step.id });
      const watch = (note: Note) => emit({ type: "output", step: step.id, ...note });
      const chosen = harnessFor(state.flow, step, harness, options.harnesses);
      const record = await runStep(step, state, cwd, chosen, watch, feedback);
      // ADR 0005: the state on disk is the run, so a wave that dies keeps what settled.
      state.steps[step.id] = record;
      save();
      emit({ type: "step_end", step: step.id, status: record.status === "failed" ? "failed" : "done" });
    });

    const failures = work.filter((step) => state.steps[step.id]?.status === "failed");
    if (failures.length > 0) {
      // A step that cycles on a failure goes back instead of ending the run, and
      // every failure in the wave takes its own cycle.
      const retries = failures.flatMap((step) => {
        const retry = retryOf(step, state);
        return retry ? [{ step, retry }] : [];
      });
      const spent = retries.filter(({ retry }) => retry.count > retry.cycle.limit);

      // A failure past its limit, or one with no cycle, has no way back.
      if (spent.length > 0 || retries.length < failures.length) {
        // Invariant 4: the retry stops here. A failure carries no value to accept,
        // so only `escalate` has somewhere to go: it asks a person for the value.
        // A stop takes one step, and a failed record that lives through the stop
        // runs again past its limit. So a wave with a second failure fails.
        const asking =
          failures.length === 1 ? spent.find(({ retry }) => retry.cycle.policy === "escalate") : undefined;
        if (!asking) {
          state.status = "failed";
          close();
          emit({ type: "run_end", status: state.status });
          return state;
        }
        const record = state.steps[asking.step.id] as StepRecord;
        state.history = [...(state.history ?? []), { step: asking.step.id, record }];
        delete state.steps[asking.step.id];
        return stop(state, asking.step.id, questionFor(asking.step, asking.retry.cycle, record), close, emit);
      }

      // A retry that drops the reason for it makes the same mistake again. The
      // record goes to history when the step goes back, so read the error first.
      state.feedback = retries.map(({ step, retry }) => ({
        step: step.id,
        to: retry.cycle.to,
        value: { error: (state.steps[step.id] as StepRecord).error },
      }));
      for (const { step, retry } of retries) {
        state.cycles[retry.key] = retry.count;
        goBackTo(retry.cycle.to, state, sorted);
        emit({ type: "cycle", step: step.id, to: retry.cycle.to, count: retry.count });
      }
      save();
      continue;
    }

    const voters = work.filter((step) => {
      const cycle = cycleOf(step);
      const record = state.steps[step.id] as StepRecord;
      if (!cycle || cycle.when === "failed" || record.answeredByPerson) return false;
      return matches(cycle.when as Match, record.value);
    });
    // One wave settles one cycle. A second would fight the first for the same
    // steps, so the run goes back to the earliest target and runs the rest again.
    const place = (step: Step) => sorted.findIndex((one) => one.id === (cycleOf(step) as Cycle).to);
    const [turning] = [...voters].sort((one, other) => place(one) - place(other));

    if (turning) {
      // A vote the run does not act on is still information, so the record holds it.
      for (const other of voters) {
        if (other !== turning) (state.steps[other.id] as StepRecord).votedToCycle = (cycleOf(other) as Cycle).to;
      }
      const cycle = cycleOf(turning) as Cycle;
      const record = state.steps[turning.id] as StepRecord;
      const key = `${turning.id}->${cycle.to}`;
      const count = (state.cycles[key] ?? 0) + 1;

      if (count > cycle.limit) {
        // Invariant 4: the cycle stops here whatever the steps still think.
        if (cycle.policy === "escalate") {
          state.history = [...(state.history ?? []), { step: turning.id, record }];
          delete state.steps[turning.id];
          return stop(state, turning.id, questionFor(turning, cycle, record), close, emit);
        }
        record.disagreement = "accepted";
      } else {
        state.cycles[key] = count;
        // A cycle that drops the reason for it sends the step back blind.
        state.feedback = [{ step: turning.id, to: cycle.to, value: record.value }];
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

/** Runs at most `limit` items at once. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await work(items[index] as T);
    }
  });
  await Promise.all(workers);
}

/** The step names a harness, then the flow does, then the run does. */
function harnessFor(flow: Flow, step: Step, fallback: Harness, named?: Record<string, Harness>): Harness {
  const name = harnessOf(flow, step);
  if (!name) return fallback;
  const chosen = named?.[name];
  if (!chosen) throw new Error(`step "${step.id}" names the harness "${name}", which this run does not have`);
  return chosen;
}

/**
 * Why a condition rules a step out, or nothing when it runs. A step that needs
 * a skipped step is skipped too, because the value it waits for never arrives.
 */
function skipOf(step: Step, state: RunState): string | undefined {
  const gone = step.needs.filter((need) => state.steps[need]?.status === "skipped");
  if (gone.length > 0) return `it needs "${gone[0]}", which the run skipped`;
  if (step.kind === "flow" || !step.when) return undefined;

  for (const [id, wanted] of Object.entries(step.when)) {
    if (!matches(wanted, state.steps[id]?.value)) {
      return `"${id}" does not say ${JSON.stringify(wanted)}`;
    }
  }
  return undefined;
}

/** The cycle that sends a failed step back, and the count of this attempt. */
function retryOf(step: Step, state: RunState): { cycle: Cycle; key: string; count: number } | undefined {
  const cycle = cycleOf(step);
  if (!cycle || cycle.when !== "failed") return undefined;
  const key = `${step.id}->${cycle.to}`;
  return { cycle, key, count: (state.cycles[key] ?? 0) + 1 };
}

function questionFor(step: Step, cycle: Cycle, record: StepRecord): string {
  if (cycle.when === "failed") {
    return `Step "${step.id}" failed ${cycle.limit} times over: ${record.error}. Supply the value for "${step.id}".`;
  }
  return `Step "${step.id}" reached its limit of ${cycle.limit} cycles back to "${cycle.to}" and still disagrees. Supply the value for "${step.id}".`;
}

/**
 * Clears the target and every step that needs it, so a branch that the cycle
 * does not touch keeps its work and spends no tokens twice.
 */
function goBackTo(target: string, state: RunState, sorted: Step[]): void {
  // A sorted step comes after everything it needs, so one pass finds them all.
  const again = new Set([target]);
  for (const step of sorted) {
    if (step.needs.some((need) => again.has(need))) again.add(step.id);
  }

  const dropped = state.history ?? [];
  for (const step of sorted.filter((one) => again.has(one.id))) {
    const record = state.steps[step.id];
    if (record) dropped.push({ step: step.id, record });
    delete state.steps[step.id];
  }
  state.history = dropped;
}

function matches(when: Match, value: unknown): boolean {
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
  for (const one of feedback ?? []) if (one.to === step.id) inputs[one.step] = one.value;

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
              model: modelOf(state.flow, step),
            },
            watch,
          )
        : { value: await callModule(step as CallStep, inputs, cwd, watch) };
  } catch (error) {
    return { ...at(), status: "failed", error: String(error) };
  }

  // Invariant 5: what the step really did, not what it says it did.
  const touched = changed(before, take(state.flow.workspace, cwd));
  const broken = brokenPromise(promiseOf(step), touched);
  if (broken) {
    return {
      ...at(),
      status: "failed",
      error: `step "${step.id}" ${broken}`,
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

/** What a step promises about the workspace. Only these two kinds promise. */
function promiseOf(step: Step): Changes | undefined {
  return step.kind === "agent" || step.kind === "call" ? step.changes : undefined;
}

/**
 * Invariant 5: what a step promises about the workspace. A promise of `nothing`
 * refuses every path. A promise of paths refuses a path that is not one of them,
 * and not inside one of them. A commit moves HEAD, which no path holds.
 */
function brokenPromise(changes: Changes | undefined, touched: string[]): string | undefined {
  if (changes === undefined || touched.length === 0) return undefined;
  if (changes === "nothing") return `promises to change nothing, but it changed ${touched.join(", ")}`;

  const outside = touched.filter((path) => !changes.paths.some((allowed) => under(path, allowed)));
  if (outside.length === 0) return undefined;
  return `promises to change only ${changes.paths.join(", ")}, but it changed ${outside.join(", ")}`;
}

/** A path is the file itself, or anything under it as a directory. */
function under(path: string, allowed: string): boolean {
  const root = allowed.replace(/\/+$/, "");
  return path === root || path.startsWith(`${root}/`);
}

function buildPrompt(step: AgentStep, inputs: Record<string, unknown>, cwd: string): string {
  const parts = [readFileSync(resolve(cwd, step.prompt), "utf8")];
  // A member of a fanout differs by this value, so the step must read it.
  if (step.with) parts.push(block("The values this step holds", step.with));
  if (Object.keys(inputs).length > 0) parts.push(block("The values of the steps before this one", inputs));
  return parts.join("\n\n");
}

function block(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/**
 * A component takes the values of the steps before it, a way to say what it
 * does, and the value that its step holds. A component that wants neither of
 * the last two ignores them.
 */
async function callModule(
  step: CallStep,
  inputs: Record<string, unknown>,
  cwd: string,
  watch: (note: Note) => void,
): Promise<unknown> {
  const module = await import(pathToFileURL(resolve(cwd, step.module)).href);
  const say = (text: string) => watch({ kind: "text", text: String(text) });
  return module.default(inputs, say, step.with ?? {});
}
