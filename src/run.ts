import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  type AgentStep,
  type CallStep,
  type Changes,
  type Computed,
  type Cycle,
  type Flow,
  type GateStep,
  type Match,
  type Member,
  type Step,
  WAVE,
  changesOf,
  computedOf,
  cycleOf,
  exitsOf,
  expandFanout,
  harnessOf,
  modelOf,
  operatorOf,
  order,
  schemaProblem,
  takesProblem,
  validate,
} from "./flow.ts";
import { ADAPTERS, type Harness, type Note } from "./harness.ts";
import { pi } from "./pi.ts";
import { attempts, toAtif } from "./atif.ts";
import { type Change, type Snapshot, changed, take } from "./workspace.ts";

const version = String(createRequire(import.meta.url)("../package.json").version);

// Orchy runs from source as TypeScript and from a published copy as JavaScript,
// so a file it starts or loads takes the extension it is running under itself.
const EXT = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";

function contractProblem(step: Step, value: unknown): string | undefined {
  if (step.kind === "flow") return `step "${step.id}" is a flow that no one expanded`;
  const problem = schemaProblem(step.returns, value);
  return problem && `the value of "${step.id}" breaks the contract ${problem}`;
}

/**
 * The other half of invariant 2: what a step takes, checked against the values
 * that reach it, before a component runs and before a prompt is built. A
 * component that reads a value that no longer arrives fails inside itself, and
 * a model asks or guesses. `validate()` answers what a file already knows.
 */
function takenProblem(step: Step, values: Record<string, unknown>): string | undefined {
  const schema = (step as CallStep).takes;
  if (!schema) return undefined;
  const problem = schemaProblem(schema, values);
  return (
    problem &&
    `the values that reach "${step.id}" break what it takes ${problem}. Add it to "takes" on the flow, or to "with" on the step.`
  );
}

/**
 * The values a step works on: what the run takes, under what the step holds.
 * The step is the narrower one, so it wins, by the same rule as the harness.
 */
function valuesOf(step: Step, state: RunState): Record<string, unknown> {
  return { ...state.with, ...(step as AgentStep).with };
}

/**
 * A flow that declares `returns` is checked once, at the end. `validate()`
 * refuses a flow that declares it and ends in more than one step, so the step
 * that holds the value of the run is the one end.
 */
function returnProblem(state: RunState): string | undefined {
  const schema = state.flow.returns;
  if (!schema) return undefined;
  const exit = exitsOf(state.flow.steps)[0] as Step;
  const record = state.steps[exit.id];
  if (record?.status !== "done") {
    return `the flow "${state.flow.name}" returns the value of "${exit.id}", and the run has no value for it`;
  }
  const problem = schemaProblem(schema, record.value);
  return problem && `the value of "${exit.id}" breaks what the flow "${state.flow.name}" returns ${problem}`;
}

/**
 * Invariant 4 in dollars: a run stops at the budget that the flow declares. The
 * run counts every attempt, so a run that a cycle threw away counts as well,
 * and it counts the same records that the trajectory reports. See ADR 0019.
 *
 * A cost that no harness reported is not a cost of zero. A budget that reads it
 * as zero is a budget that looks enforced and is not, so the run says so and
 * stops. Only an agent step spends, so a call step and a gate report nothing.
 *
 * What a budget cannot do: no one knows what a step will cost before it runs,
 * so a budget stops the run between waves and never in the middle of one. A
 * wave of paid steps can pass it together. `budget: 0` is the one budget that
 * stops a step before it spends, because nothing needs to be measured first.
 */
function budgetProblem(state: RunState, ready: Step[]): string | undefined {
  const budget = state.flow.budget;
  if (budget === undefined) return undefined;
  const kinds = new Map(state.flow.steps.map((step) => [step.id, step.kind]));

  let spent = 0;
  for (const { step, record } of attempts(state)) {
    const spends = kinds.get(step) === "agent" && record.status !== "skipped" && !record.answeredByPerson;
    if (spends && record.cost === undefined) {
      return `the flow "${state.flow.name}" has a budget, and step "${step}" reported no cost. Orchy does not enforce a budget that it cannot measure. Use a harness that reports a cost, or take "budget" off the flow.`;
    }
    spent += record.cost ?? 0;
  }

  if (spent < budget) return undefined;
  // Nothing has been spent yet, so nothing has been passed: this is a budget of
  // nothing meeting a wave. A wave that cannot spend is not what such a budget
  // refuses, so a flow of free steps under `budget: 0` runs, and the first step
  // that would spend does not.
  if (spent === 0 && !ready.some((step) => step.kind === "agent")) return undefined;
  return `the run reached the budget of the flow "${state.flow.name}": it spent ${money(spent)} of ${money(budget)}. It stops before the next step.`;
}

/** `$3.4`, and not `$3.400000000000001`. A cost is a sum of small numbers. */
function money(amount: number): string {
  return `$${Number(amount.toFixed(4))}`;
}

export interface StepRecord {
  /** A condition ruled a skipped step out, or a step it needs was skipped. */
  status: "done" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  value?: unknown;
  error?: string;
  trajectory?: string;
  /**
   * What the step asked, after Orchy read the file the step names and filled
   * every `{{ name }}` in it. A prompt lives in a file, so the run keeps the
   * text it really sent, and a reader needs no second file to know what it was.
   */
  prompt?: string;
  /** A person supplied this value, so the cycle of the step does not fire again. */
  answeredByPerson?: boolean;
  /** The cycle reached its limit and the policy accepted the disagreement. */
  disagreement?: "accepted";
  /** Why a condition ruled the step out, so a reader needs no second look. */
  skipped?: string;
  /** The step voted to cycle, and the run acted on a vote to an earlier step. */
  votedToCycle?: string;
  /** Invariant 5: each path the step changed, and what it did to that path. */
  changed?: Change[];
  /** What the step spent, when its harness reports it. A budget counts this. */
  cost?: number;
}

export interface RunState {
  runId: string;
  /** The flow is data, so a run holds the whole of it and resumes without the file. */
  flow: Flow;
  /** The values this run supplies for what the flow takes. Every step reads them. */
  with?: Record<string, unknown>;
  /**
   * The run and the step that started this run, when a step did through the
   * door of its own root. The record is the bound: a chain of runs is read
   * from here, and the door refuses one that stands too deep. ADR 0025.
   */
  startedBy?: { runId: string; step: string };
  /**
   * When the run started. A run that stops at a gate before any step runs has
   * no step to date it by, and a list showed it with no time and sorted it last.
   */
  startedAt?: string;
  /** `stopped` is what a person or a dead daemon leaves; a run never writes it itself. */
  status: "running" | "waiting" | "done" | "failed" | "stopped";
  /**
   * The process that drives this run, while it runs. A reader asks after it to
   * tell a run that works from a run that died with its state at `running`.
   */
  pid?: number;
  /** Why the run failed, when the fault belongs to the run and not to one step. */
  error?: string;
  waitingFor?: string;
  question?: string;
  steps: Record<string, StepRecord>;
  /** The value of the step the flow ends with. A flow that returns one keeps it. */
  value?: unknown;
  cycles: Record<string, number>;
  /** Each value that sent the run back, and the step it goes back to. */
  feedback?: Array<{ step: string; to: string; value: unknown }>;
  /** Every step that a cycle dropped. A dropped attempt is still a cost. */
  history?: Array<{ step: string; record: StepRecord }>;
  /**
   * The step each computed fanout was, before the run expanded it into members.
   * A cycle back past the step that gave the list expands it again from here.
   */
  spread?: Record<string, Step>;
}

export type RunEvent =
  /** A resume emits this as well, so a parent process learns the run it drives. */
  | { type: "run_start"; runId: string }
  | { type: "step_start"; step: string }
  /** What a step reports while it works. The trajectory holds the whole of it. */
  | { type: "output"; step: string; kind: Note["kind"]; text: string }
  /** `error` says why a step failed. A parent reports no reason it never gets. */
  | { type: "step_end"; step: string; status: "done" | "failed"; error?: string }
  /** A condition ruled the step out. It never starts, so it never ends. */
  | { type: "skip"; step: string; why: string }
  /** `count` is this pass, and `limit` is how many the flow allows. */
  | { type: "cycle"; step: string; to: string; count: number; limit: number }
  /**
   * The cycle reached its limit and the policy accepted the disagreement. The
   * run goes on, and a reader must not learn that from the state alone.
   */
  | { type: "accept"; step: string; to: string; limit: number }
  | { type: "waiting"; step: string; question: string }
  | { type: "run_end"; status: RunState["status"]; error?: string };

export interface RunOptions {
  cwd?: string;
  /** The values the flow takes. `--with` and the daemon both supply them. */
  with?: Record<string, unknown>;
  /** The harness for a step that names none. */
  harness?: Harness;
  /** The name of that harness, so the checks read what it supplies. */
  harnessName?: string;
  /** The adapters a step can name. */
  harnesses?: Record<string, Harness>;
  /** The run and the step that started this run, when a step did. ADR 0025. */
  startedBy?: { runId: string; step: string };
  onEvent?: (event: RunEvent) => void;
}

export async function run(input: Flow, options: RunOptions = {}): Promise<RunState> {
  // The members go before the expansion does, so check the flow a user wrote first.
  const adapters = [...ADAPTERS, ...Object.keys(options.harnesses ?? {})];
  refuse(validate(input, options.harnessName, adapters));
  // The values come before the first step, so a value that no step can use costs
  // no token.
  const takes = takesProblem(input, options.with, "this run");
  if (takes) throw new Refused(takes);

  const flow = expandFanout(input);
  // A sub-flow needs a file, so only the loader can expand one. Say so plainly.
  const nested = flow.steps.find((step) => step.kind === "flow");
  if (nested) throw new Error(`step "${nested.id}" holds a flow, and only loading a file expands one`);

  refuse(validate(flow, options.harnessName, adapters));

  for (const step of flow.steps) harnessFor(flow, step, options.harness ?? pi, options.harnesses);

  const cwd = resolve(options.cwd ?? process.cwd());
  // The workspace belongs to the flow, not to one step, so a workspace Orchy
  // cannot read stops the run here — before a run directory exists, and before
  // a step spends anything. A workspace that goes wrong later is a fault of the
  // step that met it, and the step records it.
  take(flow.workspace, cwd);
  const state: RunState = {
    runId: randomUUID(),
    flow,
    startedAt: new Date().toISOString(),
    status: "running",
    steps: {},
    cycles: {},
  };
  // ADR 0005: the state on disk is the run, so a resume reads the values again.
  if (options.with) state.with = options.with;
  if (options.startedBy) state.startedBy = options.startedBy;
  mkdirSync(directoryOf(cwd, state.runId), { recursive: true });
  return execute(state, cwd, options);
}

/**
 * Continues a run. A value answers the gate of a run that waits. No value
 * continues a run that ended: from the step that `from` names, from the steps
 * that failed, or where a stop left it. The record of a step that runs again
 * goes to history first, because every attempt is a cost.
 */
export async function resume(
  runId: string,
  value: unknown,
  options: RunOptions & { from?: string } = {},
): Promise<RunState> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const state = read(cwd, runId);

  // The two ways in exclude each other, and one taken in silence over the
  // other sent a run forward when a person meant to send it back.
  if (value !== undefined && options.from) {
    throw new Refused(
      `the resume holds a value and a step. A value answers the gate where the run waits, and "--from" goes back with none. Give one of the two.`,
    );
  }

  if (value !== undefined) {
    if (state.status !== "waiting" || !state.waitingFor) {
      throw new Refused(`the run ${runId} is ${state.status}, so it takes no value`);
    }

    const step = state.flow.steps.find((candidate) => candidate.id === state.waitingFor);
    if (!step) throw new Refused(`the run ${runId} waits for "${state.waitingFor}", which the flow does not hold`);
    const problem = contractProblem(step, value);
    if (problem) throw new Refused(problem);

    const now = new Date().toISOString();
    state.steps[step.id] = { status: "done", startedAt: now, endedAt: now, value, answeredByPerson: true };
    state.waitingFor = undefined;
    state.question = undefined;
    state.status = "running";
    // A gate settles outside a wave, so its own cycle takes its turn in `execute`.
    return execute(state, cwd, options, step);
  }

  // A run that says it runs, and whose process has gone, is a run that died.
  // ADR 0005 makes a crash and a gate the same case, so `--from` opens it.
  if (state.status === "running") {
    if (alive(state.pid)) throw new Refused(`the run ${runId} is running, so there is nothing to continue`);
    if (!options.from) {
      throw new Refused(
        `the run ${runId} says it runs, and the process that drove it has gone. Name the step to run again, with --from.`,
      );
    }
    state.status = "stopped";
  }

  const sorted = order(state.flow.steps);
  if (options.from) {
    if (!state.flow.steps.some((step) => step.id === options.from)) {
      throw new Refused(`the run ${runId} holds no step "${options.from}", so it cannot go back to it`);
    }
    // The named step and every step after it run again. The rest keep their work.
    goBackTo(options.from, state, sorted);
  } else if (state.status === "waiting") {
    throw new Refused(`the run ${runId} waits for a value. Answer it, or name a step to go back to.`);
  } else if (state.status === "done") {
    throw new Refused(`the run ${runId} is done. Name the step to run again, with --from.`);
  }

  // A failed record runs again, so its attempt goes to history and its cost
  // still counts. A stopped run has no failed record, and simply continues.
  for (const [id, record] of Object.entries(state.steps)) {
    if (record.status !== "failed") continue;
    state.history = [...(state.history ?? []), { step: id, record }];
    delete state.steps[id];
  }

  state.status = "running";
  delete state.error;
  state.waitingFor = undefined;
  state.question = undefined;
  return execute(state, cwd, options);
}

/**
 * A refusal at the door: the command, its values, or the flow it was given is
 * wrong, and nothing ran or changed. The command line reads it apart from a
 * run that failed, because a script that hears "failed" goes looking for a
 * failed run that does not exist.
 */
export class Refused extends Error {}

function refuse(problems: string[]): void {
  if (problems.length > 0) throw new Refused(`the flow is not valid:\n- ${problems.join("\n- ")}`);
}

/** Whether a process still holds a run. A run with no pid is from an older Orchy. */
/**
 * The state as it stands, and not as it was last written. A run whose process
 * has gone still says "running" in its own file, and every reader repeated it:
 * the page, `orchy runs`, and the API each answered "running" for a run that
 * had died, while the index beside them said "stopped". One answer, one status.
 */
export function standing(state: RunState): RunState {
  if (state.status !== "running" || alive(state.pid)) return state;
  return { ...state, status: "stopped" };
}

export function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    // Signal 0 asks after a process and sends it nothing.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every run this directory holds, newest first. `orchy runs` reads it. */
export function list(cwd: string): RunState[] {
  const at = join(resolve(cwd), ".orchy", "runs");
  let ids: string[];
  try {
    ids = readdirSync(at);
  } catch {
    return [];
  }
  const runs: RunState[] = [];
  for (const id of ids) {
    try {
      runs.push(standing(read(cwd, id)));
    } catch {
      // A run that is half written is not a run to list.
    }
  }
  return runs.sort((one, other) => startOf(other).localeCompare(startOf(one)));
}

/**
 * When a run started. A run from before the state held it dates by the
 * earliest step it holds, and one with no step of its own sorts last.
 */
export function startOf(state: RunState): string {
  return (
    state.startedAt ??
    Object.values(state.steps)
      .map((record) => record.startedAt)
      .sort()[0] ??
    ""
  );
}

export function read(cwd: string, runId: string): RunState {
  const file = join(directoryOf(resolve(cwd), runId), "state.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState;
  } catch {
    throw new Refused(`this directory holds no run "${runId}". Run "orchy runs" to see the runs it holds.`);
  }
}

/**
 * ADR 0005: the state on disk is the run, so no reader may see half of it. A
 * plain write truncates the file first, and a door that read that moment took
 * a broken answer for a healthy run. The write lands whole, by a rename.
 */
export function keep(directory: string, state: RunState): void {
  const file = join(directory, "state.json");
  const temp = `${file}.writing`;
  writeFileSync(temp, JSON.stringify(state, null, 2));
  renameSync(temp, file);
}

function directoryOf(cwd: string, runId: string): string {
  return join(cwd, ".orchy", "runs", runId);
}

async function execute(state: RunState, cwd: string, options: RunOptions, answered?: Step): Promise<RunState> {
  const harness = options.harness ?? pi;
  const emit = options.onEvent ?? (() => {});
  // ADR 0005: the state on disk is the run. A gate and a crash recover the same way.
  const directory = directoryOf(cwd, state.runId);
  // The pid rides with the state, so a reader knows a live run from a dead one.
  state.pid = process.pid;
  const save = () => keep(directory, state);
  // Each step may use a different harness, so each trajectory is read by its own.
  const convert = (id: string, handle: string, trajectoryId: string, at: string) => {
    const step = state.flow.steps.find((candidate) => candidate.id === id);
    if (!step) return undefined;
    return harnessFor(state.flow, step, harness, options.harnesses).toTrajectory(handle, trajectoryId, at);
  };
  const close = () => {
    state.pid = undefined;
    save();
    const file = join(directoryOf(cwd, state.runId), "trajectory.json");
    writeFileSync(file, JSON.stringify(toAtif(state, version, convert), null, 2));
  };
  save();
  emit({ type: "run_start", runId: state.runId });

  let sorted = order(state.flow.steps);
  const done = (id: string) => state.steps[id]?.status === "done";
  // A skipped step never passes, so a step that needs it never starts either.
  const settled = (id: string) => done(id) || state.steps[id]?.status === "skipped";

  // The wave loop settles a cycle over the steps it ran, and a gate is in no
  // wave. So the value of the person takes its turn here, before the steps that
  // follow the gate run. `validate()` refuses "escalate" on a gate, so this
  // cycle asks no person for a value that a person just gave.
  if (answered && personCycles(answered, state)) {
    goBack(answered, state, sorted, emit);
    save();
  }

  for (;;) {
    // The steps of a run change while it runs: a computed fanout becomes its
    // members, and a cycle back past the step that gave the list turns them
    // into that step again. So the order is read from the flow each turn, and
    // never held from an earlier one — a stale order kept running the members
    // of a list that no longer stood.
    sorted = order(state.flow.steps);

    // Every step whose needs have settled runs together. Invariant 3 still holds,
    // because a step with an unfinished need is not in the wave.
    const ready = sorted.filter((step) => !settled(step.id) && step.needs.every(settled));
    if (ready.length === 0) break;

    // The run settles here, so a run that reached its budget stops before it
    // starts more work. A run whose last wave ended inside the budget is done.
    const budget = budgetProblem(state, ready);
    if (budget) return fail(state, budget, close, emit);

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

    // A computed fanout has no list until the step it reads gives one, so the
    // run expands it here, and no earlier. It is the one expansion the runner
    // performs. See ADR 0017.
    const computed = ready.filter((step) => computedOf(step));
    if (computed.length > 0) {
      for (const step of computed) {
        const problem = spread(state, step);
        if (!problem) continue;
        const now = new Date().toISOString();
        emit({ type: "step_start", step: step.id });
        state.steps[step.id] = { status: "failed", startedAt: now, endedAt: now, error: problem };
        emit({ type: "step_end", step: step.id, status: "failed", error: problem });
        return fail(state, undefined, close, emit);
      }
      // The expansion made new steps; the top of the loop reads them.
      save();
      continue;
    }

    const work = ready.filter((step) => step.kind !== "gate");
    if (work.length === 0) {
      const waiting = ready[0] as GateStep;
      // A question is a prompt for a person, so a name in it takes its value the
      // same way. It did not: a flow that takes a ticket asked about
      // "{{ ticket }}" itself, in every run, and two waiting runs read alike.
      return stop(state, waiting.id, ask(waiting, state), close, emit);
    }

    const feedback = state.feedback;
    state.feedback = undefined;

    // Invariant 5: a promise needs a workspace that no other step disturbs, so a
    // wave that holds a promise and a step that can write runs one step at a
    // time. A wave where every step promises `nothing` holds no writer, so it
    // runs at the width of the flow: a change there breaks every promise in the
    // wave, which names too many steps and never too few. A step with no
    // promise writes what it likes, and counts as a writer.
    // ponytail: two runs in one working directory still disturb each other, so a
    // promise holds inside one run only. A workspace for each run lifts that.
    const promises = work.some((step) => changesOf(state.flow, step) !== undefined);
    const writes = work.some((step) => changesOf(state.flow, step) !== "nothing");
    const parallel = promises && writes ? 1 : (state.flow.parallel ?? WAVE);

    await pool(work, parallel, async (step) => {
      emit({ type: "step_start", step: step.id });
      const watch = (note: Note) => emit({ type: "output", step: step.id, ...note });
      const chosen = harnessFor(state.flow, step, harness, options.harnesses);
      const record = await runStep(step, state, cwd, chosen, watch, feedback);
      // ADR 0005: the state on disk is the run, so a wave that dies keeps what settled.
      state.steps[step.id] = record;
      save();
      emit({
        type: "step_end",
        step: step.id,
        status: record.status === "failed" ? "failed" : "done",
        ...(record.error ? { error: record.error } : {}),
      });
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
        if (!asking) return fail(state, undefined, close, emit);
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
        // A step that goes back to a step it does not need keeps its own record.
        // Every attempt is a cost, so this one goes to history as well.
        goBackTo(step.id, state, sorted);
        emit({ type: "cycle", step: step.id, to: retry.cycle.to, count: retry.count, limit: retry.cycle.limit });
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
    const waiting = [...voters].sort((one, other) => place(one) - place(other));

    // The earliest target wins the wave. A step that has spent its own limit
    // wins nothing, so the next voter takes its turn: otherwise the first voter
    // starves every other one, and a run of reviewers who all disagree ends
    // `done`.
    for (const turning of waiting) {
      // A vote the run does not act on is still information, so the record holds it.
      for (const other of waiting) {
        if (other !== turning) (state.steps[other.id] as StepRecord).votedToCycle = (cycleOf(other) as Cycle).to;
      }
      const cycle = cycleOf(turning) as Cycle;
      const record = state.steps[turning.id] as StepRecord;
      if (goBack(turning, state, sorted, emit)) {
        return stop(state, turning.id, questionFor(turning, cycle, record), close, emit);
      }
      // This step has spent its own limit, and the policy took its disagreement.
      // The next voter still has a turn, so the first one starves no other.
      if (record.disagreement !== "accepted") break;
    }

    save();
  }

  const problem = returnProblem(state);
  state.status = problem ? "failed" : "done";
  if (problem) state.error = problem;
  else state.value = valueOf(state);
  close();
  emit({ type: "run_end", status: state.status, ...(state.error ? { error: state.error } : {}) });
  return state;
}

/**
 * The run ends here. `error` names a fault of the run. A run that fails on a
 * step takes the reason of that step, because a reader of the end of a run must
 * never have to go and look for the why of it.
 */
function fail(
  state: RunState,
  error: string | undefined,
  close: () => void,
  emit: (event: RunEvent) => void,
): RunState {
  state.status = "failed";
  if (error) state.error = error;
  else state.error ??= reasons(state);
  close();
  emit({ type: "run_end", status: state.status, ...(state.error ? { error: state.error } : {}) });
  return state;
}

/**
 * What the run produced: the value of the step it ends with. A flow that
 * declares `returns` is checked against this, and a flow that declares none
 * still ends in a value that a person and a `kind: flow` step both read.
 */
function valueOf(state: RunState): unknown {
  const [exit] = exitsOf(state.flow.steps);
  return exit ? state.steps[exit.id]?.value : undefined;
}

/** Why the steps of this run failed, as one line for each. */
function reasons(state: RunState): string | undefined {
  const failed = Object.entries(state.steps).filter(([, record]) => record.status === "failed");
  if (failed.length === 0) return undefined;
  return failed.map(([id, record]) => `step "${id}" failed: ${record.error ?? "with no reason"}`).join("\n");
}

/**
 * What a gate asks, with every name in it filled in. A name that nothing
 * supplies is the fault of the flow, and a person reading the question is the
 * last one who could fix it, so the run says so where the question would be.
 */
function ask(step: GateStep, state: RunState): string {
  try {
    const asked = fill(step.question, step.id, valuesOf(step, state));
    // The person answers with the work in front of them, the way an agent step
    // reads the steps before it in its prompt. A brace name reads no step
    // value, so this block is the one way a question shows one.
    const inputs = Object.fromEntries(
      step.needs
        .filter((need) => state.steps[need]?.value !== undefined)
        .map((need) => [need, state.steps[need]?.value]),
    );
    if (Object.keys(inputs).length === 0) return asked;
    return `${asked}\n\n${block("The values of the steps before this one", inputs)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

  // A step that fans out over an empty list runs for nothing, so it does not
  // run at all. Every step that needs it is skipped by the rule above.
  const from = computedOf(step);
  const list = from && listOf(state, from);
  if (Array.isArray(list) && list.length === 0) return `"${from?.step}" returned no "${from?.key}" to fan out over`;

  if (step.kind === "flow" || !step.when) return undefined;
  for (const [id, wanted] of Object.entries(step.when)) {
    if (!matches(wanted, state.steps[id]?.value)) {
      return `"${id}" does not say ${JSON.stringify(wanted)}`;
    }
  }
  return undefined;
}

/** The list a computed fanout reads, which is a list only when the step gave one. */
function listOf(state: RunState, from: Computed): unknown {
  const value = state.steps[from.step]?.value as Record<string, unknown> | undefined;
  return value?.[from.key];
}

/**
 * Turns a computed fanout into one step for each item of the list, in the run
 * state. The list arrives with the value of a step, so this expansion happens
 * during the run. It calls the expansion that a file already uses, because two
 * expansions drift apart. Answers why it cannot expand, or nothing. See ADR 0017.
 */
function spread(state: RunState, step: Step): string | undefined {
  const from = computedOf(step) as Computed;
  const at = `step "${step.id}" fans out over "${from.key}" of "${from.step}"`;
  const list = listOf(state, from);
  if (!Array.isArray(list)) {
    return `${at}, and "${from.step}" gave ${JSON.stringify(list)}. A fanout reads a list.`;
  }

  const members: Member[] = [];
  for (const item of list) {
    const name = (item as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name === "") {
      return `${at}, and the item ${JSON.stringify(item)} holds no "name". An item names the member it becomes.`;
    }
    if (members.some((one) => one.name === name)) {
      return `${at}, and two items use the name "${name}". Each item needs a name of its own.`;
    }
    // The item is what the member adds, not what it replaces: a `with` on the
    // step reached the members of a file-written fanout and not these, so a
    // value the step held vanished, and the advice for the failure that
    // followed was to add it where it already was.
    members.push({ name, with: { ...((step as CallStep).with ?? {}), ...(item as Record<string, unknown>) } });
  }

  const steps = state.flow.steps.map((one) => (one.id === step.id ? ({ ...one, fanout: members } as Step) : one));
  // ADR 0005: the state on disk is the run, so the expanded steps live there and
  // a crash recovers them. Expansion takes the step away, so the run keeps the
  // step it started from: a cycle back past the step that computed the list has
  // to expand it again, over the list as it is now. Without this the members
  // froze — the list grew, the run judged the old names, and said nothing.
  state.spread = { ...state.spread, [step.id]: step };
  state.flow = expandFanout({ ...state.flow, steps });
  return undefined;
}

/**
 * Whether the value of a person sends the run back. `answeredByPerson` keeps an
 * escalation from firing the cycle of the step it stands in for. A gate that
 * declares its own cycle is a different case, and that cycle fires.
 */
function personCycles(step: Step, state: RunState): boolean {
  const cycle = cycleOf(step);
  if (step.kind !== "gate" || !cycle || cycle.when === "failed") return false;
  return matches(cycle.when as Match, state.steps[step.id]?.value);
}

/**
 * The step votes to cycle, so the run goes back to the target it names. Answers
 * whether the cycle reached its limit and the policy asks a person for the value.
 */
function goBack(step: Step, state: RunState, sorted: Step[], emit: (event: RunEvent) => void): boolean {
  const cycle = cycleOf(step) as Cycle;
  const record = state.steps[step.id] as StepRecord;
  const key = `${step.id}->${cycle.to}`;
  const count = (state.cycles[key] ?? 0) + 1;

  if (count > cycle.limit) {
    // Invariant 4: the cycle stops here whatever the steps still think.
    if (cycle.policy === "escalate") {
      state.history = [...(state.history ?? []), { step: step.id, record }];
      delete state.steps[step.id];
      return true;
    }
    record.disagreement = "accepted";
    // The run goes on as if the step agreed, so this is the one place a
    // reader of the console hears that it did not.
    emit({ type: "accept", step: step.id, to: cycle.to, limit: cycle.limit });
    return false;
  }

  state.cycles[key] = count;
  // A cycle that drops the reason for it sends the step back blind.
  state.feedback = [{ step: step.id, to: cycle.to, value: record.value }];
  goBackTo(cycle.to, state, sorted);
  emit({ type: "cycle", step: step.id, to: cycle.to, count, limit: cycle.limit });
  return false;
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
    return `Step "${step.id}" failed ${cycle.limit + 1} times over: ${record.error}. Supply the value for "${step.id}".`;
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
  unspread(state, again);
}

/**
 * Puts back every fanout that the run must compute again. A computed fanout
 * reads the value of a step; when the run goes back past that step, the value
 * it read is gone, so the members it made are of a list that no longer stands.
 * They kept running all the same, on the names of the first round.
 */
function unspread(state: RunState, cleared: Set<string>): void {
  const held = state.spread;
  if (!held) return;
  for (const [id, step] of Object.entries(held)) {
    const from = computedOf(step);
    // The list is still the list, so the members it made still stand.
    if (!from || !cleared.has(from.step)) continue;
    const names = new Set(state.flow.steps.filter((one) => one.id.startsWith(`${id}/`)).map((one) => one.id));
    for (const name of names) {
      const record = state.steps[name];
      if (record) (state.history ??= []).push({ step: name, record });
      delete state.steps[name];
    }
    // The members go, and the step that makes them takes their place again.
    const steps = state.flow.steps.filter((one) => !names.has(one.id));
    const at = state.flow.steps.findIndex((one) => names.has(one.id));
    steps.splice(at === -1 ? steps.length : at, 0, step);
    // A step that needed a member needs the step it came from again.
    state.flow = {
      ...state.flow,
      steps: steps.map((one) =>
        one.needs.some((need) => names.has(need))
          ? ({ ...one, needs: [...new Set(one.needs.map((need) => (names.has(need) ? id : need)))] } as Step)
          : one,
      ),
    };
    delete held[id];
  }
}

function matches(when: Match, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(when).every(([key, wanted]) => holds(record[key], wanted));
}

/**
 * A match against one value: the value itself, or one operator. `validate()`
 * refuses every other shape, so an object that names no operator never reaches
 * here. See ADR 0016.
 */
function holds(value: unknown, wanted: unknown): boolean {
  const operator = operatorOf(wanted);
  if (!operator) return isDeepStrictEqual(value, wanted);

  const [name, argument] = operator;
  if (name === "is") return isDeepStrictEqual(value, argument);
  if (name === "not") return !isDeepStrictEqual(value, argument);
  if (name === "empty") return empty(value) === argument;
  if (name === "lt") return typeof value === "number" && value < (argument as number);
  return typeof value === "number" && value > (argument as number);
}

/**
 * A list, a string, or an object that holds nothing. A value that is not there
 * is empty as well, so a cycle on `empty: false` never fires on a missing key.
 */
function empty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string" || Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
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

  const values = valuesOf(step, state);
  const taken = takenProblem(step, values);
  if (taken) return { ...at(), status: "failed", error: taken };

  let result: { value: unknown; trajectory?: string; cost?: number };
  let prompt: string | undefined;
  let before: Snapshot | undefined;
  try {
    // Reading the workspace is part of the step. Outside this block it threw
    // past `fail()` and `close()`, and the run stayed at "running" for ever.
    before = take(state.flow.workspace, cwd);
    if (step.kind === "agent") {
      prompt = buildPrompt(step, inputs, cwd, values, state.with);
      // The prompt is the whole of what the step was asked, and it lives in a
      // file that a value fills in. So the run says it once, before the work.
      watch({ kind: "prompt", text: prompt });
    }
    result =
      step.kind === "agent"
        ? await harness.run(
            {
              step: step.id,
              prompt: prompt as string,
              tools: step.tools,
              returns: step.returns,
              cwd,
              model: modelOf(state.flow, step),
              run: state.runId,
            },
            watch,
          )
        : (step as CallStep).command !== undefined
          ? { value: await callCommand(step as CallStep, inputs, cwd, watch, values) }
          : { value: await callModule(step as CallStep, inputs, cwd, watch, values) };
  } catch (error) {
    // The message, and not the word "Error" in front of it. A reader of a
    // console reads the reason, not the class of the object that carried it.
    const why = error instanceof Error ? error.message : String(error);
    // A harness that wrote a record before it failed hands it over here, so the
    // step a reader most wants to read is not the one with nothing in it.
    const held = (error as { trajectory?: string }).trajectory;
    // A step that failed still spent what it spent. ADR 0019 counts it, so the
    // harness hands the cost over on the error and the record keeps it.
    const paid = (error as { cost?: number }).cost;
    return {
      ...at(),
      status: "failed",
      error: why,
      ...(held ? { trajectory: held } : {}),
      ...(paid === undefined ? {} : { cost: paid }),
      ...(prompt ? { prompt } : {}),
    };
  }

  // Invariant 5: what the step really did, not what it says it did.
  const touched = changed(before, take(state.flow.workspace, cwd));
  const record: StepRecord = { ...at(), status: "done", value: result.value, trajectory: result.trajectory };
  if (prompt !== undefined) record.prompt = prompt;
  // A step that broke a rule spent its tokens all the same, so the record keeps
  // the cost and the budget counts it. See ADR 0019.
  if (result.cost !== undefined) record.cost = result.cost;
  if (touched.length > 0) record.changed = touched;

  const broken = brokenPromise(changesOf(state.flow, step), touched);
  if (broken) return { ...record, status: "failed", error: `step "${step.id}" ${broken}` };

  // Invariant 2: the value must match the contract of the step.
  const problem = contractProblem(step, result.value);
  if (problem) return { ...record, status: "failed", error: problem };

  return record;
}

/**
 * Invariant 5: what a step promises about the workspace. A promise of `nothing`
 * refuses every path. A promise of paths refuses a path that is not one of them,
 * and not inside one of them. A promise with an exception refuses the paths it
 * names and allows the rest. A commit moves HEAD, which no path holds.
 */
function brokenPromise(changes: Changes | undefined, touched: Change[]): string | undefined {
  if (changes === undefined || touched.length === 0) return undefined;
  if (changes === "nothing") return `promises to change nothing, but it ${say(touched)}`;

  if ("except" in changes) {
    const inside = touched.filter((one) => changes.except.some((refused) => touches(one, refused)));
    if (inside.length === 0) return undefined;
    return `promises to change nothing in ${changes.except.join(", ")}, but it ${say(inside)}`;
  }

  const outside = touched.filter((one) => !allows(changes.paths, one));
  if (outside.length === 0) return undefined;
  return `promises to change only ${changes.paths.join(", ")}, but it ${say(outside)}`;
}

/** A rename moves a file, so a promise that names only its source allows neither half. */
function allows(paths: string[], change: Change): boolean {
  const halves = [change.path, ...(change.to ? [change.to] : [])];
  return halves.every((half) => paths.some((allowed) => under(half, allowed)));
}

/** A change reaches a path when either half of it does. */
function touches(change: Change, refused: string): boolean {
  return under(change.path, refused) || (change.to !== undefined && under(change.to, refused));
}

/** `deleted docs/x, added docs/y`. The kind of each change, and not only the path. */
function say(touched: Change[]): string {
  return touched.map((one) => `${one.how} ${one.path}${one.to ? ` to ${one.to}` : ""}`).join(", ");
}

/** A path is the file itself, or anything under it as a directory. */
function under(path: string, allowed: string): boolean {
  const root = plain(allowed);
  // A promise of "." names the workspace itself, and so holds every path in it.
  if (root === "" || root === ".") return true;
  return plain(path) === root || plain(path).startsWith(`${root}/`);
}

/**
 * The name git would write: no "./" in front, no slash behind, no doubles. A
 * promise is written by a person and a change is reported by git, so the two
 * spellings of one path have to meet somewhere. They met nowhere, and
 * `except: ["./src"]` allowed every write to `src`.
 */
function plain(path: string): string {
  return path.replace(/\/{2,}/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

function buildPrompt(
  step: AgentStep,
  inputs: Record<string, unknown>,
  cwd: string,
  values: Record<string, unknown>,
  takes?: Record<string, unknown>,
): string {
  const at = resolve(cwd, step.prompt);
  let text: string;
  try {
    text = readFileSync(at, "utf8");
  } catch {
    throw new Error(`step "${step.id}" has no prompt at "${at}". A prompt path is relative to the flow file.`);
  }
  const parts = [fill(text, step.id, values)];
  // A step that guesses this writes its file outside the workspace, where
  // invariant 5 cannot see it and the step after it cannot read it.
  parts.push(`The working directory is \`${cwd}\`. Read and write by a path inside it.`);
  if (takes) parts.push(block("The values this run takes", takes));
  // A member of a fanout differs by this value, so the step must read it.
  if (step.with) parts.push(block("The values this step holds", step.with));
  if (Object.keys(inputs).length > 0) parts.push(block("The values of the steps before this one", inputs));
  return parts.join("\n\n");
}

/** Every pair of braces, so a name that resolves to nothing is never missed. */
const NAMED = /\{\{([^{}]*)\}\}/g;

/**
 * A name in a prompt takes its value. A name that nothing supplies fails the
 * step: a model that reads the braces, or the word `undefined`, does the wrong
 * work and says nothing about it.
 */
function fill(text: string, step: string, values: Record<string, unknown>): string {
  return text.replace(NAMED, (_all, inside: string) => {
    const name = inside.trim();
    if (!Object.hasOwn(values, name)) {
      throw new Error(
        `step "${step}" reads "{{ ${name} }}" in its prompt, and nothing supplies "${name}". Add it to "takes" on the flow, or to "with" on the step.`,
      );
    }
    const value = values[name];
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function block(title: string, value: unknown): string {
  return `## ${title}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

/**
 * A component takes the values of the steps before it, a way to say what it
 * does, and the values it works on. A component that wants neither of the last
 * two ignores them, and one that needs them declares "takes" on the step.
 *
 * The values of the run and the values of the step arrive as one value, and a
 * prompt resolves a name the same way. So a component reads one place whether
 * its flow is the run or a step of another flow, because expansion turns the
 * values of a sub-flow into values of a step.
 */
async function callModule(
  step: CallStep,
  inputs: Record<string, unknown>,
  cwd: string,
  watch: (note: Note) => void,
  values: Record<string, unknown>,
): Promise<unknown> {
  // A shipped component lives with Orchy, so its name is not a path. ADR 0026.
  const named = String(step.module);
  const path = named.startsWith("orchy:")
    ? join(import.meta.dirname, "components", `${named.slice("orchy:".length)}${EXT}`)
    : resolve(cwd, named);
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(path).href);
  } catch (error) {
    const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`step "${step.id}" cannot load its module at "${path}": ${why}`);
  }
  if (typeof module.default !== "function") {
    throw new Error(`step "${step.id}" names the module "${path}", which exports no default function.`);
  }
  const say = (text: string) => watch({ kind: "text", text: String(text) });
  // `cwd` rides fourth, so a shipped component acts where the steps act. A
  // component that wants none of the last three ignores them, as before.
  return (module.default as (...args: unknown[]) => unknown)(inputs, say, values, cwd);
}

/**
 * A component in any language: a program. It takes `{ values, steps }` as
 * JSON on stdin — the values of the run, and the values of the steps it
 * needs, by step id. It answers with its value as JSON on stdout, and the
 * contract checks it the same as any step. Each line of stderr is a live
 * note, and a code that is not 0 fails the step with what stderr said.
 * ADR 0026.
 */
function callCommand(
  step: CallStep,
  inputs: Record<string, unknown>,
  cwd: string,
  watch: (note: Note) => void,
  values: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((keep, refuse) => {
    const child = spawn(String(step.command), { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let said = "";
    let rest = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      said = `${said}${chunk.toString()}`.slice(-4000);
      const parts = `${rest}${chunk.toString()}`.split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) watch({ kind: "text", text: line });
    });
    child.on("error", (error) => {
      refuse(new Error(`step "${step.id}" could not run its command: ${error.message}`));
    });
    child.on("close", (code) => {
      if (rest.trim()) watch({ kind: "text", text: rest });
      if (code !== 0) {
        const why = said.trim() || out.trim().slice(-1000) || "and said nothing";
        return refuse(new Error(`step "${step.id}" ended with the code ${code}: ${why}`));
      }
      try {
        keep(JSON.parse(out));
      } catch {
        refuse(
          new Error(
            `step "${step.id}" answered something that is not JSON: ${out.trim().slice(0, 300) || "nothing"}. The command writes its value to stdout and its notes to stderr.`,
          ),
        );
      }
    });
    // A command that reads no input ends before the write, and the pipe says
    // EPIPE. That says nothing about the step, so it is not a failure.
    child.stdin.on("error", () => undefined);
    child.stdin.write(JSON.stringify({ values, steps: inputs }));
    child.stdin.end();
  });
}
