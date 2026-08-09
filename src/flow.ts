import { isAbsolute, resolve } from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import type { Workspace } from "./workspace.ts";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

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

export interface AgentStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "agent";
  prompt: string;
  tools: ToolName[];
  returns: S;
  cycle?: Cycle<S>;
}

export interface CallStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "call";
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

export type Step = AgentStep | CallStep | GateStep;

export interface Flow {
  name: string;
  workspace?: Workspace;
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

export function flow(name: string, definition: { workspace?: Workspace; steps: Step[] }): Flow {
  return { name, workspace: definition.workspace, steps: definition.steps };
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
  return step.kind === "gate" ? undefined : step.cycle;
}

/**
 * A flow from a file or a graphical editor carries no types, so every flow
 * passes through here before it runs.
 */
export function validate(flow: Flow): string[] {
  const problems: string[] = [];
  if (!flow.name) problems.push("the flow has no name");
  if (flow.steps.length === 0) problems.push("the flow has no steps");

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

  const records = flow.workspace !== undefined && flow.workspace.kind !== "none";
  for (const step of flow.steps) {
    if (step.kind !== "gate" && step.changes === false && !records) {
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

  const properties = (step as { returns: { properties?: Record<string, unknown> } }).returns.properties;
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
