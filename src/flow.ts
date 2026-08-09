import { isAbsolute, resolve } from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Workspace } from "./workspace.ts";

export const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web"] as const;

export type ToolName = (typeof TOOLS)[number];

/**
 * `when` is a partial match against the value of the step, not an expression.
 * A small expression language grows, and a graphical editor cannot draw one.
 */
export interface Cycle<S extends TSchema = TSchema> {
  to: string;
  when: Partial<Static<S>>;
  limit: number;
  policy: "escalate" | "accept";
}

interface Common {
  id: string;
  needs: string[];
}

/** Invariant 5 is opt-in. A step that promises to change nothing declares it. */
interface Acts {
  changes?: false;
}

/** One member of a fanout. It overrides only what differs from the step. */
export interface Member {
  name: string;
  harness?: string;
  model?: string;
  prompt?: string;
  tools?: ToolName[];
  module?: string;
}

export interface AgentStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "agent";
  /** Runs this step once for each member. Orchy expands it before the run. */
  fanout?: Member[];
  prompt: string;
  tools: ToolName[];
  /** Names an adapter. The run supplies the default when a step names none. */
  harness?: string;
  /** A string that only the harness reads. Pi wants `provider/model`. */
  model?: string;
  returns: S;
  cycle?: Cycle<S>;
}

export interface CallStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "call";
  /** Runs this step once for each member. Orchy expands it before the run. */
  fanout?: Member[];
  module: string;
  returns: S;
  cycle?: Cycle<S>;
}

/** A step that takes its value from a person. The run stops until one answers. */
export interface GateStep<S extends TSchema = TSchema> extends Common {
  kind: "gate";
  question: string;
  returns: S;
}

/** A whole flow as one step. Orchy expands it when it loads the file. */
export interface FlowStep extends Common {
  kind: "flow";
  flow: string;
  /** Expansion hangs this on the step the inner flow ends with. */
  cycle?: Cycle;
}

export type Step = AgentStep | CallStep | GateStep | FlowStep;

export interface Flow {
  name: string;
  workspace?: Workspace;
  /** How many steps run at once. Eight when the flow does not say. */
  parallel?: number;
  steps: Step[];
}

type Declared<T> = Omit<T, "kind" | "needs"> & { needs?: string[] };

export function agent<S extends TSchema>(step: Declared<AgentStep<S>>): AgentStep<S> {
  return { kind: "agent", needs: [], ...step };
}

export function call<S extends TSchema>(step: Declared<CallStep<S>>): CallStep<S> {
  return { kind: "call", needs: [], ...step };
}

export function gate<S extends TSchema>(step: Declared<GateStep<S>>): GateStep<S> {
  return { kind: "gate", needs: [], ...step };
}

export const WAVE = 8;

export function flow(
  name: string,
  definition: { workspace?: Workspace; parallel?: number; steps: Step[] },
): Flow {
  const built: Flow = { name, steps: definition.steps };
  if (definition.workspace) built.workspace = definition.workspace;
  if (definition.parallel !== undefined) built.parallel = definition.parallel;
  return built;
}

/**
 * A prompt and a module belong to the flow, so their paths are relative to the
 * flow file. The working directory is where a step acts, which is a different
 * thing. Call this after loading a flow from a file.
 */
export function resolvePaths(flow: Flow, directory: string): Flow {
  const at = (path: string) => (isAbsolute(path) ? path : resolve(directory, path));
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step.kind === "agent") return { ...step, prompt: at(step.prompt) };
      if (step.kind === "call") return { ...step, module: at(step.module) };
      return step;
    }),
  };
}

export function cycleOf(step: Step): Cycle | undefined {
  return step.kind === "agent" || step.kind === "call" ? step.cycle : undefined;
}

/** Rewrites every reference to a step that expansion replaced with several. */
function rename(steps: Step[], map: Map<string, string[]>): Step[] {
  const spread = (names: string[]) => names.flatMap((name) => map.get(name) ?? [name]);
  return steps.map((step) => {
    const next = { ...step, needs: spread(step.needs) };
    const cycle = cycleOf(next);
    if (cycle) {
      const to = map.get(cycle.to);
      if (to) (next as AgentStep).cycle = { ...cycle, to: to[to.length - 1] as string };
    }
    return next;
  });
}

/**
 * Turns one step into one step for each member. This happens before the run, so
 * the runner sees plain steps and a graphical editor draws the expanded graph.
 */
export function expandFanout(flow: Flow): Flow {
  if (!flow.steps.some((step) => fanoutOf(step))) return flow;

  const map = new Map<string, string[]>();
  const steps: Step[] = [];

  for (const step of flow.steps) {
    const fanout = fanoutOf(step);
    if (!fanout) {
      steps.push(step);
      continue;
    }
    const base = { ...step } as Record<string, unknown>;
    delete base.fanout;
    const names: string[] = [];
    for (const member of fanout) {
      const id = `${step.id}/${member.name}`;
      names.push(id);
      // A member overrides only what its kind of step can hold.
      const overrides =
        step.kind === "agent" ? pick(member, ["harness", "model", "prompt", "tools"]) : pick(member, ["module"]);
      steps.push({ ...base, ...overrides, id } as unknown as Step);
    }
    map.set(step.id, names);
  }

  return { ...flow, steps: rename(steps, map) };
}

export function fanoutOf(step: Step): Member[] | undefined {
  return step.kind === "agent" || step.kind === "call" ? step.fanout : undefined;
}

function pick(member: Member, keys: Array<keyof Member>): Partial<Member> {
  const taken: Partial<Member> = {};
  for (const key of keys) if (member[key] !== undefined) Object.assign(taken, { [key]: member[key] });
  return taken;
}

/**
 * Puts the steps of another flow in place of one step. The ids of the inner
 * flow take the id of the step as a prefix, so two uses never collide.
 */
export async function expandFlows(flow: Flow, load: (path: string) => Promise<Flow>): Promise<Flow> {
  if (!flow.steps.some((step) => step.kind === "flow")) return flow;

  const map = new Map<string, string[]>();
  const steps: Step[] = [];

  for (const step of flow.steps) {
    if (step.kind !== "flow") {
      steps.push(step);
      continue;
    }

    const inner = expandFanout(await expandFlows(await load(step.flow), load));
    const wanted = new Set(inner.steps.flatMap((one) => one.needs));
    const exits = inner.steps.filter((one) => !wanted.has(one.id));
    if (exits.length !== 1) {
      throw new Error(
        `the flow at "${step.flow}" ends in ${exits.length} steps, and step "${step.id}" needs exactly one`,
      );
    }

    const id = (name: string) => `${step.id}/${name}`;
    const own = new Set(inner.steps.map((one) => one.id));
    for (const one of inner.steps) {
      const moved = {
        ...one,
        id: id(one.id),
        // A step that starts the inner flow waits for whatever the outer step waits for.
        needs: one.needs.length === 0 ? step.needs : one.needs.map(id),
      } as Step;
      // A cycle inside a flow stays inside it.
      const cycle = cycleOf(moved);
      if (cycle && own.has(cycle.to)) (moved as AgentStep).cycle = { ...cycle, to: id(cycle.to) };
      steps.push(moved);
    }
    // A cycle on the outer step belongs to the step the inner flow ends with.
    if (step.cycle) {
      const last = steps.find((one) => one.id === id((exits[0] as Step).id)) as Step;
      if (cycleOf(last)) {
        throw new Error(`step "${step.id}" cycles, and so does the step "${last.id}" it ends with`);
      }
      if (last.kind === "gate") {
        throw new Error(`step "${step.id}" cycles, but the step it ends with takes its value from a person`);
      }
      (last as AgentStep).cycle = step.cycle;
    }

    map.set(step.id, [id((exits[0] as Step).id)]);
  }

  return { ...flow, steps: rename(steps, map) };
}

/**
 * A flow from a file or a graphical editor carries no types, so every flow
 * passes through here before it runs.
 */
export function validate(flow: Flow): string[] {
  const problems: string[] = [];
  const known = new Set<string>(TOOLS);
  if (!flow.name) problems.push("the flow has no name");
  if (flow.steps.length === 0) problems.push("the flow has no steps");

  if (flow.parallel !== undefined && flow.parallel < 1) {
    problems.push("the flow runs fewer than one step at a time");
  }

  const ids = new Set<string>();
  for (const step of flow.steps) {
    if (ids.has(step.id)) problems.push(`two steps use the id "${step.id}"`);
    ids.add(step.id);
  }

  for (const step of flow.steps) {
    for (const need of step.needs) {
      if (need === step.id) problems.push(`step "${step.id}" needs itself`);
      else if (!ids.has(need)) {
        problems.push(`step "${step.id}" needs "${need}", which does not exist`);
      }
    }
  }

  problems.push(...findLoops(flow.steps));
  if (problems.length > 0) return problems;

  for (const step of flow.steps) {
    const fanout = fanoutOf(step);
    // A fanout that no one can expand must say so, not quietly do nothing.
    if (!fanout) {
      if ((step as { fanout?: unknown }).fanout) {
        problems.push(`step "${step.id}" fans out, but only an agent step and a call step can`);
      }
      continue;
    }
    if (fanout.length === 0) problems.push(`step "${step.id}" fans out to nothing`);
    for (const member of fanout) {
      for (const name of member.tools ?? []) {
        if (!known.has(name)) problems.push(`member "${member.name}" of "${step.id}" asks for the tool "${name}"`);
      }
    }
    if (new Set(fanout.map((one) => one.name)).size !== fanout.length) {
      problems.push(`step "${step.id}" has two members with one name`);
    }
    if (cycleOf(step)) {
      problems.push(`step "${step.id}" both fans out and cycles, so which member cycles is unclear`);
    }
  }
  if (problems.length > 0) return problems;

  for (const step of flow.steps) {
    if (step.kind !== "agent") continue;
    for (const name of step.tools) {
      // A tool no harness knows must fail here, not vanish inside an adapter.
      if (!known.has(name)) problems.push(`step "${step.id}" asks for the tool "${name}", which does not exist`);
    }
  }

  const records = flow.workspace !== undefined && flow.workspace.kind !== "none";
  for (const step of flow.steps) {
    if ((step.kind === "agent" || step.kind === "call") && step.changes === false && !records) {
      problems.push(`step "${step.id}" promises to change nothing, but the flow has no workspace to check it`);
    }
  }

  const sorted = order(flow.steps).map((step) => step.id);
  for (const step of flow.steps) {
    const cycle = cycleOf(step);
    if (!cycle) continue;
    if (!ids.has(cycle.to)) {
      problems.push(`step "${step.id}" cycles to "${cycle.to}", which does not exist`);
    } else if (sorted.indexOf(cycle.to) >= sorted.indexOf(step.id)) {
      problems.push(`step "${step.id}" cycles to "${cycle.to}", which does not run before it`);
    }
    if (cycle.limit < 1) problems.push(`step "${step.id}" sets a cycle limit below one`);
    problems.push(...checkWhen(step, cycle));
  }

  return problems;
}

function checkWhen(step: Step, cycle: Cycle): string[] {
  const keys = Object.keys(cycle.when as Record<string, unknown>);
  if (keys.length === 0) return [`step "${step.id}" cycles on an empty condition, so it always cycles`];

  const properties = (step as { returns?: { properties?: Record<string, unknown> } }).returns?.properties;
  if (!properties) return [];
  return keys
    .filter((key) => !(key in properties))
    .map((key) => `step "${step.id}" cycles on "${key}", which it does not return`);
}

/** Invariant 3: a step starts only after every step that it needs passes. */
export function order(steps: Step[]): Step[] {
  const done = new Set<string>();
  const sorted: Step[] = [];
  while (sorted.length < steps.length) {
    const next = steps.find((step) => !done.has(step.id) && step.needs.every((need) => done.has(need)));
    if (!next) throw new Error("the steps cannot be put in order");
    done.add(next.id);
    sorted.push(next);
  }
  return sorted;
}

function findLoops(steps: Step[]): string[] {
  const needsOf = new Map(steps.map((step) => [step.id, step.needs]));
  const state = new Map<string, "open" | "closed">();
  const problems: string[] = [];

  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "closed") return;
    if (state.get(id) === "open") {
      problems.push(`the steps ${[...path.slice(path.indexOf(id)), id].join(" -> ")} make a loop`);
      return;
    }
    state.set(id, "open");
    for (const need of needsOf.get(id) ?? []) visit(need, [...path, id]);
    state.set(id, "closed");
  };

  for (const step of steps) visit(step.id, []);
  return problems;
}
