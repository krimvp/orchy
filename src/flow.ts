import { isAbsolute, resolve } from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ADAPTERS, type AdapterName, SUPPLIES, TOOLS, type ToolName } from "./harness.ts";
import type { Workspace } from "./workspace.ts";

/**
 * A schema is checked as plain JSON Schema, not as a TypeBox object. A schema
 * that has been through a file, a resume, or a graphical editor is data, and it
 * no longer carries the symbols that TypeBox needs.
 */
const ajv = new Ajv2020({ strict: false });

/**
 * Where a value breaks a schema, or nothing when it holds. Invariant 2 checks a
 * contract with this, and a flow checks what it takes and what it returns.
 */
export function schemaProblem(schema: TSchema, value: unknown): string | undefined {
  if (ajv.validate(schema, value)) return undefined;
  const [first] = ajv.errors ?? [];
  return `at "${first?.instancePath || "/"}": ${first?.message ?? "unknown"}`;
}

/**
 * A partial match against a value, not an expression. A small expression
 * language grows, and a graphical editor cannot draw one.
 *
 * A match against one key is a plain value, which tests that the two are equal,
 * or one operator from the closed set below. See ADR 0016.
 */
export type Match = Record<string, unknown>;

/** A match against one value: the value itself, or one operator. See ADR 0016. */
export type Matched<T> = T | { is: T } | { not: T } | { empty: boolean } | { lt: number } | { gt: number };

/**
 * What a match says about one value, beside the value itself. The set is
 * closed, so a dropdown draws it whole. `reads` names what the operator holds,
 * and `over` names what the value it tests holds.
 */
const OPERATORS: Record<string, { reads?: "boolean" | "number"; over?: { types: string[]; words: string } }> = {
  is: {},
  not: {},
  empty: { reads: "boolean", over: { types: ["array", "string", "object"], words: "a list, a string, or an object" } },
  lt: { reads: "number", over: { types: ["number", "integer"], words: "a number" } },
  gt: { reads: "number", over: { types: ["number", "integer"], words: "a number" } },
};

/** The one operator that a match names, or nothing when the match is a plain value. */
export function operatorOf(wanted: unknown): [string, unknown] | undefined {
  if (!isSchema(wanted)) return undefined;
  const entries = Object.entries(wanted as Record<string, unknown>);
  const [first] = entries;
  if (entries.length !== 1 || !first || !(first[0] in OPERATORS)) return undefined;
  return first;
}

/**
 * The condition that decides whether a step runs. It names a step that this
 * step needs, and the part of the value of that step that must match.
 */
export type When = Record<string, Match>;

export interface Cycle<S extends TSchema = TSchema> {
  to: string;
  /** A match against the value of the step, or the word `failed`. */
  when: { [K in keyof Static<S>]?: Matched<Static<S>[K]> } | "failed";
  limit: number;
  policy: "escalate" | "accept";
}

interface Common {
  id: string;
  needs: string[];
  /** Runs the step only when the value of each step named here matches. */
  when?: When;
}

/**
 * What a step promises to change in the workspace. Invariant 5 checks the
 * promise against the record. A step that promises nothing declares nothing.
 * A path names a file, or a directory and everything under it.
 */
export type Changes = "nothing" | { paths: string[] };

/** Invariant 5 is opt-in. A step that promises what it changes declares it. */
interface Acts {
  changes?: Changes;
}

/** One member of a fanout. It overrides only what differs from the step. */
export interface Member {
  name: string;
  harness?: string;
  model?: string;
  prompt?: string;
  tools?: ToolName[];
  module?: string;
  /** The value that only this member holds. The step reads it. */
  with?: Record<string, unknown>;
}

/**
 * Where a fanout finds its list when a step computes it: the value of a step
 * this step needs, and the key in that value that holds the list. Each item is
 * one member: the item is the value of the member, and the `name` field of the
 * item names it. The run expands this one, because the list arrives with the
 * value. See ADR 0017.
 */
export interface Computed {
  step: string;
  key: string;
}

/** The members a file names, or where the run finds them. */
export type Fanout = Member[] | Computed;

export interface AgentStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "agent";
  /** Runs this step once for each member. Orchy expands it before the run. */
  fanout?: Fanout;
  prompt: string;
  tools: ToolName[];
  /** Names an adapter. The flow, and then the run, supply the default. */
  harness?: string;
  /** A string that only the harness reads. Pi wants `provider/model`. */
  model?: string;
  /** A value the step holds. A fanout gives one to each member. */
  with?: Record<string, unknown>;
  returns: S;
  cycle?: Cycle<S>;
}

export interface CallStep<S extends TSchema = TSchema> extends Common, Acts {
  kind: "call";
  /** Runs this step once for each member. Orchy expands it before the run. */
  fanout?: Fanout;
  module: string;
  /** A value the step holds. The component takes it as its third argument. */
  with?: Record<string, unknown>;
  returns: S;
  cycle?: Cycle<S>;
}

/** A step that takes its value from a person. The run stops until one answers. */
export interface GateStep<S extends TSchema = TSchema> extends Common {
  kind: "gate";
  question: string;
  returns: S;
  /** Sends the run back on the value of the person. A person rejects the work. */
  cycle?: Cycle<S>;
}

/** A whole flow as one step. Orchy expands it when it loads the file. */
export interface FlowStep extends Omit<Common, "when"> {
  kind: "flow";
  flow: string;
  /** The values the inner flow takes. Expansion gives them to every step of it. */
  with?: Record<string, unknown>;
  /** Expansion hangs this on the step the inner flow ends with. */
  cycle?: Cycle;
}

export type Step = AgentStep | CallStep | GateStep | FlowStep;

export interface Flow {
  name: string;
  workspace?: Workspace;
  /** The harness for a step that names none. The run supplies the last word. */
  harness?: string;
  /** The model for a step that names none. */
  model?: string;
  /** The values a run supplies. Every step of the run reads them. */
  takes?: TSchema;
  /** The value the flow produces, which is the value of the step it ends with. */
  returns?: TSchema;
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

type Definition = Omit<Flow, "name" | "steps"> & { steps: Step[] };

export function flow(name: string, definition: Definition): Flow {
  const built: Flow = { name, steps: definition.steps };
  if (definition.workspace) built.workspace = definition.workspace;
  if (definition.harness) built.harness = definition.harness;
  if (definition.model) built.model = definition.model;
  if (definition.takes) built.takes = definition.takes;
  if (definition.returns) built.returns = definition.returns;
  if (definition.parallel !== undefined) built.parallel = definition.parallel;
  return built;
}

/**
 * Whether the values that reach a flow match what it takes. A value that no
 * flow takes reaches no step, and a flow that takes values and gets none leaves
 * a hole in every prompt. Both fail before a step spends a token. `who` names
 * the run, or the step that holds the flow.
 */
export function takesProblem(flow: Flow, values: Record<string, unknown> | undefined, who: string): string | undefined {
  if (!flow.takes) {
    // An empty object drops no value, so only a name that no step reads fails.
    const names = Object.keys(values ?? {});
    if (names.length === 0) return undefined;
    return `the flow "${flow.name}" takes no values, and ${who} supplies ${names.join(", ")}. Declare "takes" on the flow, or supply no values.`;
  }
  if (values === undefined) {
    return `the flow "${flow.name}" takes values, and ${who} supplies none. Supply the values that "takes" names.`;
  }
  const problem = schemaProblem(flow.takes, values);
  return problem && `the values ${who} supplies break what the flow "${flow.name}" takes ${problem}`;
}

/** The steps that no step needs. A flow that returns a value ends in one of them. */
export function exitsOf(steps: Step[]): Step[] {
  const wanted = new Set(steps.flatMap((step) => step.needs));
  return steps.filter((step) => !wanted.has(step.id));
}

/** The harness that runs a step: the step names one, or the flow does. */
export function harnessOf(flow: Flow, step: Step): string | undefined {
  return (step.kind === "agent" ? step.harness : undefined) ?? flow.harness;
}

/** The model of a step, by the same rule as the harness. */
export function modelOf(flow: Flow, step: Step): string | undefined {
  return (step.kind === "agent" ? step.model : undefined) ?? flow.model;
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

/** A flow step holds one as well, and only expansion reads that one. */
export function cycleOf(step: Step): Cycle | undefined {
  return step.kind === "flow" ? undefined : step.cycle;
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
    const from = computedOf(next);
    if (from) {
      const source = map.get(from.step);
      if (source) (next as AgentStep).fanout = { ...from, step: source[source.length - 1] as string };
    }
    return next;
  });
}

/**
 * Turns one step into one step for each member. This happens before the run, so
 * the runner sees plain steps and a graphical editor draws the expanded graph.
 * A computed fanout stays whole here, because its list arrives with the value of
 * a step. The run calls this again for that one. See ADR 0017.
 */
export function expandFanout(flow: Flow): Flow {
  if (!flow.steps.some((step) => membersOf(step))) return flow;

  const map = new Map<string, string[]>();
  const steps: Step[] = [];

  for (const step of flow.steps) {
    const fanout = membersOf(step);
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
      // A member overrides only what its kind of step can hold. `validate()`
      // refuses anything else, so nothing is dropped here in silence.
      const holds = MEMBER_HOLDS[step.kind as "agent" | "call"].slice(1);
      const overrides = pick(member, holds as Array<keyof Member>);
      steps.push({ ...base, ...overrides, id } as unknown as Step);
    }
    map.set(step.id, names);
  }

  return { ...flow, steps: rename(steps, map) };
}

export function fanoutOf(step: Step): Fanout | undefined {
  return step.kind === "agent" || step.kind === "call" ? step.fanout : undefined;
}

/** The members a file names, or nothing when a step computes the list. */
export function membersOf(step: Step): Member[] | undefined {
  const fanout = fanoutOf(step);
  return Array.isArray(fanout) ? fanout : undefined;
}

/** Where the run finds the list, or nothing when the file names the members. */
export function computedOf(step: Step): Computed | undefined {
  const fanout = fanoutOf(step);
  return fanout && !Array.isArray(fanout) ? fanout : undefined;
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
    const takes = takesProblem(inner, step.with, `step "${step.id}"`);
    if (takes) throw new Error(takes);

    const exits = exitsOf(inner.steps);
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
      // Expansion drops the inner flow, so the values it takes ride on each step
      // that reads one. The step keeps what only it holds, which is the narrower.
      if (step.with && (moved.kind === "agent" || moved.kind === "call")) {
        moved.with = { ...step.with, ...moved.with };
      }
      // A cycle inside a flow stays inside it, and so does a computed fanout.
      const cycle = cycleOf(moved);
      if (cycle && own.has(cycle.to)) (moved as AgentStep).cycle = { ...cycle, to: id(cycle.to) };
      const from = computedOf(moved);
      if (from && own.has(from.step)) (moved as AgentStep).fanout = { ...from, step: id(from.step) };
      steps.push(moved);
    }
    // A cycle on the outer step belongs to the step the inner flow ends with.
    if (step.cycle) {
      const last = steps.find((one) => one.id === id((exits[0] as Step).id)) as Step;
      if (cycleOf(last)) {
        throw new Error(`step "${step.id}" cycles, and so does the step "${last.id}" it ends with`);
      }
      (last as AgentStep).cycle = step.cycle;
    }

    map.set(step.id, [id((exits[0] as Step).id)]);
  }

  return { ...flow, steps: rename(steps, map) };
}

const FLOW_HOLDS = ["name", "workspace", "harness", "model", "takes", "returns", "parallel", "steps"];

/**
 * What each kind of step holds. A field that this table does not name is a
 * field that no one reads, so `validate()` refuses it. A `fanout` on a gate
 * step did nothing at all for a while, and nothing said so.
 */
const HOLDS: Record<Step["kind"], { must: string[]; may: string[] }> = {
  agent: {
    must: ["prompt", "tools", "returns"],
    may: ["needs", "when", "harness", "model", "with", "changes", "cycle", "fanout"],
  },
  call: { must: ["module", "returns"], may: ["needs", "when", "with", "changes", "cycle", "fanout"] },
  gate: { must: ["question", "returns"], may: ["needs", "when", "cycle"] },
  flow: { must: ["flow"], may: ["needs", "with", "cycle"] },
};

/** The first name is the member itself. The rest are what it overrides. */
const MEMBER_HOLDS: Record<"agent" | "call", string[]> = {
  agent: ["name", "harness", "model", "prompt", "tools", "with"],
  call: ["name", "module", "with"],
};

/** What a fanout holds when a step computes the list. See ADR 0017. */
const FANOUT_HOLDS = ["step", "key"];

const KINDS = Object.keys(HOLDS);

/** `an agent`, but `a call`. A message that reads badly gets read twice. */
function a(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
}

/** `an agent`, `an agent or a call`, `an agent, a call, or a flow`. */
function anyOf(kinds: string[]): string {
  const names = kinds.map(a);
  if (names.length < 2) return names.join("");
  const last = names.pop() as string;
  return `${names.join(", ")}${names.length > 1 ? "," : ""} or ${last}`;
}

/**
 * The shape of a flow, before its meaning. A file and a graphical editor carry
 * no types, so this is the only thing between a user and a field that nothing
 * reads. Every other check below assumes that this one passed.
 */
function shapeProblems(flow: Flow): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(flow)) {
    if (!FLOW_HOLDS.includes(key)) problems.push(`the flow holds "${key}", which is not a field of a flow`);
  }
  problems.push(...workspaceProblems(flow.workspace));
  if (flow.takes !== undefined && !isSchema(flow.takes)) {
    problems.push(`the flow takes ${JSON.stringify(flow.takes)}, which is not JSON Schema`);
  }
  if (flow.returns !== undefined && !isSchema(flow.returns)) {
    problems.push(`the flow returns ${JSON.stringify(flow.returns)}, which is not JSON Schema`);
  }
  if (!Array.isArray(flow.steps)) return [...problems, "the flow has no steps"];

  for (const step of flow.steps) {
    const holds = HOLDS[step.kind];
    if (!holds) {
      problems.push(`step "${step.id ?? "with no id"}" is of the kind "${step.kind}". Use one of: ${KINDS.join(", ")}`);
      continue;
    }
    if (!step.id) problems.push(`${a(step.kind)} step has no id`);

    for (const key of Object.keys(step)) {
      if (allowed(step.kind).includes(key)) continue;
      const elsewhere = KINDS.filter((kind) => kind !== step.kind && allowed(kind).includes(key));
      const hint = elsewhere.length > 0 ? ` Only ${anyOf(elsewhere)} step holds it.` : "";
      problems.push(`step "${step.id}" holds "${key}", which ${a(step.kind)} step cannot act on.${hint}`);
    }
    for (const key of holds.must) {
      if ((step as unknown as Record<string, unknown>)[key] === undefined) {
        problems.push(`step "${step.id}" has no "${key}", and ${a(step.kind)} step needs one`);
      }
    }
    const returns = (step as GateStep).returns;
    // A missing one already has its own problem, so this one speaks for a wrong one.
    if (step.kind !== "flow" && returns !== undefined && !isSchema(returns)) {
      problems.push(`step "${step.id}" returns "${JSON.stringify(returns)}", which is not JSON Schema`);
    }
    problems.push(...changesProblems(step));
    problems.push(...memberProblems(step));
  }
  return problems;
}

function allowed(kind: string): string[] {
  const holds = HOLDS[kind as Step["kind"]];
  return ["id", "kind", ...holds.must, ...holds.may];
}

function isSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WORKSPACES = ["none", "git"];

function workspaceProblems(workspace: Workspace | undefined): string[] {
  if (workspace === undefined) return [];
  if (!isSchema(workspace)) return [`the workspace is "${JSON.stringify(workspace)}", which names no kind`];
  const { kind, path } = workspace as { kind: string; path?: string };
  if (!WORKSPACES.includes(kind)) {
    return [`the workspace is of the kind "${kind}". Use one of: ${WORKSPACES.join(", ")}`];
  }
  if (kind === "git" && !path) return ['the git workspace has no path. Write { kind: git, path: "." }'];
  return [];
}

/** The promise of invariant 5. A boolean cannot hold it, so a word does. */
function changesProblems(step: Step): string[] {
  const changes = (step as AgentStep).changes;
  if (changes === undefined || changes === "nothing") return [];
  if (typeof changes === "boolean") {
    const write = changes ? "leave it out" : 'write "changes: nothing"';
    return [`step "${step.id}" promises "changes: ${changes}", which Orchy cannot check. Instead, ${write}.`];
  }
  if (isSchema(changes) && Array.isArray((changes as { paths?: unknown }).paths)) {
    const { paths } = changes as { paths: unknown[] };
    if (paths.length === 0) return [`step "${step.id}" promises no path. Write "changes: nothing" instead.`];
    if (paths.some((path) => typeof path !== "string" || path === "")) {
      return [`step "${step.id}" promises a path that is not a name`];
    }
    return [];
  }
  return [`step "${step.id}" promises "${JSON.stringify(changes)}". Write "nothing" or a list of paths.`];
}

function memberProblems(step: Step): string[] {
  const fanout = fanoutOf(step);
  if (!fanout) {
    // A fanout that no one can expand must say so, not quietly do nothing.
    return (step as { fanout?: unknown }).fanout
      ? [`step "${step.id}" fans out, but only an agent step and a call step can`]
      : [];
  }
  if (!Array.isArray(fanout)) return computedShape(step, fanout);
  const holds = MEMBER_HOLDS[step.kind as "agent" | "call"];
  const problems: string[] = [];
  for (const member of fanout) {
    if (!member?.name) {
      problems.push(`a member of "${step.id}" has no name`);
      continue;
    }
    for (const key of Object.keys(member)) {
      if (!holds.includes(key)) {
        problems.push(`member "${member.name}" of "${step.id}" holds "${key}", which ${a(step.kind)} step cannot act on`);
      }
    }
  }
  return problems;
}

/** The shape of a fanout whose list a step computes. See ADR 0017. */
function computedShape(step: Step, fanout: Computed): string[] {
  const write = 'Write a list of members, or { step: <a step it needs>, key: <a list that step returns> }.';
  if (!isSchema(fanout)) return [`step "${step.id}" fans out over ${JSON.stringify(fanout)}. ${write}`];

  const held = fanout as unknown as Record<string, unknown>;
  const problems = Object.keys(held)
    .filter((key) => !FANOUT_HOLDS.includes(key))
    .map((key) => `step "${step.id}" fans out over a value that holds "${key}", which is not a field of a fanout`);
  for (const key of FANOUT_HOLDS) {
    if (typeof held[key] !== "string" || held[key] === "") {
      problems.push(`step "${step.id}" fans out over a value, and it names no "${key}". ${write}`);
    }
  }
  return problems;
}

/**
 * A flow from a file or a graphical editor carries no types, so every flow
 * passes through here before it runs.
 */
export function validate(flow: Flow): string[] {
  // Every check below reads a field, so the shape comes first and alone.
  const shape = shapeProblems(flow);
  if (shape.length > 0) return shape;

  const problems: string[] = [];
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

  // A flow returns the value of the step it ends with, so more than one end
  // leaves no one value to check. A fanout at the end makes several ends.
  if (flow.returns !== undefined) {
    const exits = exitsOf(flow.steps);
    // A computed fanout makes those ends during the run, so the check is here.
    const spreading = exits.find((step) => computedOf(step));
    if (exits.length !== 1) {
      const names = exits.map((step) => `"${step.id}"`).join(", ");
      problems.push(
        `the flow returns one value, but it ends in ${exits.length} steps: ${names}. A flow that returns a value ends in one step.`,
      );
    } else if (spreading) {
      problems.push(
        `the flow returns one value, but step "${spreading.id}" fans out over a list, so the run ends in one step for each item`,
      );
    }
  }

  for (const step of flow.steps) {
    if (!fanoutOf(step)) continue;
    const members = membersOf(step);
    if (members) {
      if (members.length === 0) problems.push(`step "${step.id}" fans out to nothing`);
      if (new Set(members.map((one) => one.name)).size !== members.length) {
        problems.push(`step "${step.id}" has two members with one name`);
      }
    }
    problems.push(...computedProblems(flow, step));
    if (cycleOf(step)) {
      problems.push(`step "${step.id}" both fans out and cycles, so which member cycles is unclear`);
    }
  }
  if (problems.length > 0) return problems;

  for (const step of flow.steps) {
    problems.push(...toolProblems(flow, step));
    problems.push(...conditionProblems(flow, step));
  }

  const records = flow.workspace !== undefined && flow.workspace.kind !== "none";
  for (const step of flow.steps) {
    if ((step.kind === "agent" || step.kind === "call") && step.changes !== undefined && !records) {
      problems.push(`step "${step.id}" promises what it changes, but the flow has no workspace to check it`);
    }
  }

  const sorted = order(flow.steps).map((step) => step.id);
  for (const step of flow.steps) {
    const cycle = cycleOf(step);
    if (!cycle) continue;
    if (!ids.has(cycle.to)) {
      problems.push(`step "${step.id}" cycles to "${cycle.to}", which does not exist`);
    } else if (sorted.indexOf(cycle.to) > sorted.indexOf(step.id)) {
      // A step cycles to itself, which is a retry. It never cycles forward.
      problems.push(`step "${step.id}" cycles to "${cycle.to}", which does not run before it`);
    }
    if (cycle.limit < 1) problems.push(`step "${step.id}" sets a cycle limit below one`);
    // An escalation asks a person for the value of the step. A gate has one
    // already, so the same person would answer the same question without end.
    if (step.kind === "gate" && cycle.policy === "escalate") {
      problems.push(
        `step "${step.id}" cycles with the policy "escalate", and a person already answers it. Write "accept".`,
      );
    }
    problems.push(...checkWhen(step, cycle));
  }

  return problems;
}

/**
 * Invariant 1 speaks one vocabulary, and each harness speaks its own. A flow
 * that names its harness gets the answer here, before the run spends a token.
 */
function toolProblems(flow: Flow, step: Step): string[] {
  const wanted =
    step.kind === "agent"
      ? [{ who: `step "${step.id}"`, harness: harnessOf(flow, step), tools: step.tools }]
      : [];
  for (const member of membersOf(step) ?? []) {
    if (!member.tools) continue;
    const harness = member.harness ?? harnessOf(flow, step);
    wanted.push({ who: `member "${member.name}" of "${step.id}"`, harness, tools: member.tools });
  }

  return wanted.flatMap(({ who, harness, tools }) => {
    const supplies = ADAPTERS.includes(harness as AdapterName) ? SUPPLIES[harness as AdapterName] : undefined;
    return tools.flatMap((name) => {
      if (!TOOLS.includes(name)) return [`${who} asks for the tool "${name}", which does not exist`];
      if (supplies && !supplies.includes(name)) {
        return [`${who} asks for the tool "${name}", and the harness "${harness}" has none`];
      }
      return [];
    });
  });
}

/**
 * The run expands a computed fanout, so this checks everything a file can say
 * about it: the step it reads, and the list that step declares. A source that
 * declares no such list fails the check, and not the run. See ADR 0017.
 */
function computedProblems(flow: Flow, step: Step): string[] {
  const from = computedOf(step);
  if (!from) return [];
  const at = `step "${step.id}" fans out over "${from.key}" of "${from.step}"`;
  if (!step.needs.includes(from.step)) {
    return [`${at}, but it does not need "${from.step}". Add "${from.step}" to "needs".`];
  }

  const other = flow.steps.find((one) => one.id === from.step) as GateStep | undefined;
  if (other && fanoutOf(other)) {
    return [`${at}, and "${from.step}" fans out as well, so it has no one value`];
  }
  const properties = other?.returns?.properties as Record<string, unknown> | undefined;
  if (!properties) return [];

  const declared = properties[from.key] as { type?: string; items?: { properties?: unknown } } | undefined;
  if (!declared) return [`${at}, which "${from.step}" does not return`];
  if (declared.type !== "array") return [`${at}, and "${from.key}" is not a list. A fanout runs once for each item.`];
  const item = declared.items?.properties as Record<string, unknown> | undefined;
  if (item && !("name" in item)) {
    return [`${at}, and an item of "${from.key}" holds no "name". An item names the member it becomes.`];
  }
  return [];
}

/** A step runs when the value of every step it names matches. */
function conditionProblems(flow: Flow, step: Step): string[] {
  if (step.kind === "flow" || !step.when) return [];
  const problems: string[] = [];
  for (const [id, wanted] of Object.entries(step.when)) {
    if (!step.needs.includes(id)) {
      problems.push(`step "${step.id}" runs when "${id}" matches, but it does not need "${id}"`);
      continue;
    }
    if (!isSchema(wanted) || Object.keys(wanted).length === 0) {
      problems.push(`step "${step.id}" runs on an empty condition for "${id}", so it always runs`);
      continue;
    }
    const other = flow.steps.find((one) => one.id === id) as GateStep | undefined;
    const properties = other?.returns?.properties as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(wanted)) {
      const at = `step "${step.id}" runs when "${id}" says "${key}"`;
      if (properties && !(key in properties)) {
        problems.push(`${at}, which "${id}" does not return`);
        continue;
      }
      problems.push(...operatorProblems(key, value, at, properties?.[key]));
    }
  }
  return problems;
}

/**
 * A match against one value is a plain value, which tests that the two are
 * equal, or one operator. An object that names no operator reads exactly as an
 * operator does, so it is refused and never guessed. `at` names the step and
 * the key it reads. See ADR 0016.
 */
function operatorProblems(key: string, wanted: unknown, at: string, declared: unknown): string[] {
  if (!isSchema(wanted)) return [];
  const operator = operatorOf(wanted);
  if (!operator) {
    const names = Object.keys(OPERATORS).join(", ");
    return [
      `${at} with ${JSON.stringify(wanted)}, which is not one operator. Use one of: ${names}. Write { is: ... } to test the value itself.`,
    ];
  }

  const [name, argument] = operator;
  const { reads, over } = OPERATORS[name] as { reads?: "boolean" | "number"; over?: { types: string[]; words: string } };
  const nested = operatorOf(argument);
  if (!reads && nested) {
    return [`${at} with "${name}" over the operator "${nested[0]}". An operator reads a plain value, and none nests.`];
  }
  if (reads && typeof argument !== reads) {
    return [`${at} with "${name}": ${JSON.stringify(argument)}. The operator "${name}" reads ${a(reads)}.`];
  }
  const type = (declared as { type?: string } | undefined)?.type;
  if (over && type && !over.types.includes(type)) {
    return [`${at} with "${name}", and "${key}" holds ${a(type)}. The operator "${name}" tests ${over.words}.`];
  }
  return [];
}

function checkWhen(step: Step, cycle: Cycle): string[] {
  // A failure carries no value, so this condition reads the record and not it.
  if (cycle.when === "failed") {
    return step.kind === "gate" ? [`step "${step.id}" cannot fail, so it cannot cycle on a failure`] : [];
  }
  if (!isSchema(cycle.when)) {
    return [`step "${step.id}" cycles when "${JSON.stringify(cycle.when)}". Write a match, or the word "failed".`];
  }

  const when = cycle.when as Match;
  const keys = Object.keys(when);
  if (keys.length === 0) return [`step "${step.id}" cycles on an empty condition, so it always cycles`];

  const properties = (step as { returns?: { properties?: Record<string, unknown> } }).returns?.properties;
  return keys.flatMap((key) => {
    const at = `step "${step.id}" cycles on "${key}"`;
    if (properties && !(key in properties)) return [`${at}, which it does not return`];
    return operatorProblems(key, when[key], at, properties?.[key]);
  });
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
