import { isAbsolute, resolve } from "node:path";
import type { Static, TSchema } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ADAPTERS, type AdapterName, MODELS, SUPPLIES, TOOLS, type ToolName } from "./harness.ts";
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

/** One operator, and what it reads. `GET /api/health` gives this to the page. */
export interface Operator {
  name: string;
  /** What the operator holds: the value itself, a boolean, or a number. */
  reads: "value" | "boolean" | "number";
  /** What the value it tests holds, when the operator tests only some values. */
  over?: { types: string[]; words: string };
}

/**
 * What a match says about one value, beside the value itself. The set is
 * closed, so a dropdown draws it whole. The set belongs to the flow data, so it
 * lives here, and the daemon serves it. A copy in the page falls behind.
 */
export const OPERATORS: Operator[] = [
  { name: "is", reads: "value" },
  { name: "not", reads: "value" },
  {
    name: "empty",
    reads: "boolean",
    over: { types: ["array", "string", "object"], words: "a list, a string, or an object" },
  },
  { name: "lt", reads: "number", over: { types: ["number", "integer"], words: "a number" } },
  { name: "gt", reads: "number", over: { types: ["number", "integer"], words: "a number" } },
];

/** The one operator that a match names, or nothing when the match is a plain value. */
export function operatorOf(wanted: unknown): [string, unknown] | undefined {
  if (!isSchema(wanted)) return undefined;
  const entries = Object.entries(wanted as Record<string, unknown>);
  const [first] = entries;
  if (entries.length !== 1 || !first || !OPERATORS.some((one) => one.name === first[0])) return undefined;
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
 *
 * `paths` names the only paths the step changes. `except` names the paths it
 * must not change, and lets it change everything else, which is the natural way
 * to write a rule about a whole repository.
 */
export type Changes = "nothing" | { paths: string[] } | { except: string[] };

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
  /** The values that must reach the step. Invariant 2 guards what goes in. */
  takes?: TSchema;
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
  /** The values that must reach the component. Invariant 2 guards what goes in. */
  takes?: TSchema;
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
  /** The promise for an agent step and a call step that declares none. */
  changes?: Changes;
  /** The values a run supplies. Every step of the run reads them. */
  takes?: TSchema;
  /** The value the flow produces, which is the value of the step it ends with. */
  returns?: TSchema;
  /** What the run may spend, in dollars. A run that reaches it stops. ADR 0019. */
  budget?: number;
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
  if (definition.changes) built.changes = definition.changes;
  if (definition.takes) built.takes = definition.takes;
  if (definition.returns) built.returns = definition.returns;
  if (definition.budget !== undefined) built.budget = definition.budget;
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
  if (problem) return `the values ${who} supplies break what the flow "${flow.name}" takes ${problem}`;
  // A value that the flow does not take reaches no step and no prompt, so it is
  // a mistake that runs to the end in silence. JSON Schema allows it, and this
  // does not: `docs/running.md` states the rule and the shape check keeps it.
  const named = Object.keys((flow.takes as { properties?: Record<string, unknown> }).properties ?? {});
  const spare = Object.keys(values).filter((key) => !named.includes(key));
  if (spare.length === 0) return undefined;
  return `the flow "${flow.name}" does not take ${spare.join(", ")}, and ${who} supplies ${spare.length === 1 ? "it" : "them"}. Add ${spare.length === 1 ? "the name" : "the names"} to "takes", or leave ${spare.length === 1 ? "it" : "them"} out.`;
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
 * The promise of a step, by the same rule as the harness. Only these two kinds
 * act in the workspace, so the promise of the flow reaches no other kind.
 */
export function changesOf(flow: Flow, step: Step): Changes | undefined {
  if (step.kind !== "agent" && step.kind !== "call") return undefined;
  return step.changes ?? flow.changes;
}

/**
 * A prompt and a module belong to the flow, so their paths are relative to the
 * flow file. The working directory is where a step acts, which is a different
 * thing. Call this after loading a flow from a file.
 */
export function resolvePaths(flow: Flow, directory: string): Flow {
  const at = (path: string) => (isAbsolute(path) ? path : resolve(directory, path));
  // A member overrides the prompt of its step, and that path came out of the
  // same file. One that stayed relative was read from the working directory
  // instead, so the flow only ran from its own directory.
  const members = (step: Step) => {
    const found = membersOf(step);
    if (!found) return undefined;
    return {
      fanout: found.map((one) => ({
        ...one,
        ...(one.prompt === undefined ? {} : { prompt: at(one.prompt) }),
        ...(one.module === undefined ? {} : { module: at(one.module) }),
      })),
    };
  };
  return {
    ...flow,
    steps: flow.steps.map((step) => {
      if (step.kind === "agent") return { ...step, prompt: at(step.prompt), ...members(step) };
      if (step.kind === "call") return { ...step, module: at(step.module), ...members(step) };
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
      const one = { ...base, ...overrides, id } as unknown as Step;
      // A retry belongs to the member that failed. `validate()` refuses every
      // other cycle on a fanout, so this is the only one that reaches here.
      const cycle = cycleOf(one);
      if (cycle?.to === step.id) (one as AgentStep).cycle = { ...cycle, to: id };
      steps.push(one);
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
    // A budget and a width belong to the run, so no step can carry one.
    // Expansion would drop it, and a rule that looks enforced and is not costs
    // more than a missing rule. `harness` and `model` ride on each step below,
    // because a step holds both.
    if (inner.budget !== undefined) {
      throw new Error(
        `the flow at "${step.flow}" has a budget, and step "${step.id}" holds it. A budget belongs to the run, so only the flow that the run starts sets one.`,
      );
    }
    if (inner.parallel !== undefined) {
      throw new Error(
        `the flow at "${step.flow}" runs ${inner.parallel} steps at a time, and step "${step.id}" holds it. A width belongs to the run, so only the flow that the run starts sets one.`,
      );
    }
    // One run acts in one workspace, so a flow that names the same one reads as
    // a flow that stands alone as well. A flow that names another one does not.
    if (inner.workspace && JSON.stringify(inner.workspace) !== JSON.stringify(flow.workspace)) {
      throw new Error(
        `the flow at "${step.flow}" works in ${JSON.stringify(inner.workspace)}, and step "${step.id}" holds it. One run works in one workspace, so an inner flow names the same one or none.`,
      );
    }
    // A contract that expansion drops is a rule that looks enforced and is not:
    // the same flow refused its own value standing alone and passed as a step.
    if (inner.returns !== undefined) {
      throw new Error(
        `the flow at "${step.flow}" returns a value under a contract of its own, and step "${step.id}" would drop it. Put that contract on the step the inner flow ends with.`,
      );
    }
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
      if (moved.kind === "agent" || moved.kind === "call") {
        if (step.with) moved.with = { ...step.with, ...moved.with };
        // A promise that expansion drops is a rule that looks enforced and is not.
        if (inner.changes) moved.changes ??= inner.changes;
      }
      // The harness and the model of the inner flow ride on each step it holds.
      // Expansion drops the inner flow, so a step that kept neither would run on
      // the harness of the outer flow, and spend the wrong money on the wrong
      // provider. The step keeps what only it names, which is the narrower.
      if (moved.kind === "agent") {
        if (inner.harness) moved.harness ??= inner.harness;
        if (inner.model) moved.model ??= inner.model;
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

const FLOW_HOLDS = [
  "name",
  "workspace",
  "harness",
  "model",
  "changes",
  "takes",
  "returns",
  "budget",
  "parallel",
  "steps",
];

/**
 * What each kind of step holds. A field that this table does not name is a
 * field that no one reads, so `validate()` refuses it. A `fanout` on a gate
 * step did nothing at all for a while, and nothing said so.
 */
const HOLDS: Record<Step["kind"], { must: string[]; may: string[] }> = {
  agent: {
    must: ["prompt", "tools", "returns"],
    may: ["needs", "when", "harness", "model", "with", "takes", "changes", "cycle", "fanout"],
  },
  call: { must: ["module", "returns"], may: ["needs", "when", "with", "takes", "changes", "cycle", "fanout"] },
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
  problems.push(...changesProblems("the flow", flow.changes));
  const takesFault = flow.takes === undefined ? undefined : schemaFault(flow.takes);
  if (takesFault) problems.push(`the flow takes ${JSON.stringify(flow.takes)}, ${takesFault}`);
  const returnsFault = flow.returns === undefined ? undefined : schemaFault(flow.returns);
  if (returnsFault) problems.push(`the flow returns ${JSON.stringify(flow.returns)}, ${returnsFault}`);
  if (flow.budget !== undefined && !(typeof flow.budget === "number" && flow.budget >= 0)) {
    problems.push(
      `the flow has a budget of ${JSON.stringify(flow.budget)}. A budget is a number of dollars, and zero means that no step of it may spend.`,
    );
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
    const returnsWrong = step.kind === "flow" || returns === undefined ? undefined : schemaFault(returns);
    if (returnsWrong) {
      problems.push(`step "${step.id}" returns "${JSON.stringify(returns)}", ${returnsWrong}`);
    }
    const takes = (step as CallStep).takes;
    const takesWrong = takes === undefined ? undefined : schemaFault(takes);
    if (takesWrong) problems.push(`step "${step.id}" takes ${JSON.stringify(takes)}, ${takesWrong}`);
    problems.push(...changesProblems(`step "${step.id}"`, (step as AgentStep).changes));
    problems.push(...cycleProblems(step));
    problems.push(...memberProblems(step));
  }
  return problems;
}

/** What a cycle holds. Everything here is read; nothing else is. */
const CYCLE_HOLDS = ["to", "when", "limit", "policy"];

const POLICIES = ["escalate", "accept"];

/**
 * The shape of a loop. A cycle had no shape check of its own, so a limit that
 * was missing or was not a number read as "no limit at all" — `count > undefined`
 * is never true — and the run went round for ever, against invariant 4. A policy
 * of "banana" quietly meant "accept" the same way.
 */
function cycleProblems(step: Step): string[] {
  const cycle = (step as { cycle?: unknown }).cycle;
  if (cycle === undefined) return [];
  const who = `step "${step.id}"`;
  if (!isSchema(cycle)) return [`${who} cycles to "${JSON.stringify(cycle)}", which names no step to go back to`];

  const held = cycle as unknown as Record<string, unknown>;
  const problems = Object.keys(held)
    .filter((key) => !CYCLE_HOLDS.includes(key))
    .map((key) => `${who} cycles with "${key}", which is not a field of a cycle`);

  if (typeof held.to !== "string" || held.to === "") {
    problems.push(`${who} cycles to ${JSON.stringify(held.to)}. Write the id of the step to go back to.`);
  }
  if (held.when === undefined) {
    problems.push(`${who} cycles, and says nothing about when. Write a match against its value, or "failed".`);
  } else if (held.when !== "failed" && !isSchema(held.when)) {
    problems.push(`${who} cycles when ${JSON.stringify(held.when)}. Write a match against its value, or "failed".`);
  }
  // The limit is the whole of invariant 4 for a loop: without it a run has no end.
  if (!(typeof held.limit === "number" && Number.isInteger(held.limit) && held.limit >= 1)) {
    problems.push(
      `${who} cycles with the limit ${JSON.stringify(held.limit)}. A limit is a whole number of turns, one or more, and a cycle needs one.`,
    );
  }
  if (held.policy !== undefined && !POLICIES.includes(String(held.policy))) {
    problems.push(`${who} cycles with the policy "${String(held.policy)}". Use one of: ${POLICIES.join(", ")}`);
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

/**
 * Why Ajv refuses a schema, or nothing when it reads it. An object is not yet a
 * schema: `{ type: "objekt" }` is an object, and Ajv throws over it in the
 * middle of a run, after the step it belongs to has spent its tokens.
 */
function schemaFault(value: unknown): string | undefined {
  if (!isSchema(value)) return "which is not JSON Schema";
  try {
    ajv.compile(value as TSchema);
    return undefined;
  } catch (error) {
    return `which Ajv refuses: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`;
  }
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

/** The two tags of a promise. A promise names one of them, and never both. */
const CHANGES_HOLDS = ["paths", "except"];

const WRITE = 'Write "nothing", { paths } for the only paths it changes, or { except } for the paths it must not change.';

/**
 * The promise of invariant 5. A boolean cannot hold it, so a word does. `who`
 * names the flow, or the step, because both hold a promise.
 */
function changesProblems(who: string, changes: Changes | undefined): string[] {
  if (changes === undefined || changes === "nothing") return [];
  if (typeof changes === "boolean") {
    const write = changes ? "leave it out" : 'write "changes: nothing"';
    return [`${who} promises "changes: ${changes}", which Orchy cannot check. Instead, ${write}.`];
  }
  if (!isSchema(changes)) return [`${who} promises "${JSON.stringify(changes)}". ${WRITE}`];

  const held = changes as unknown as Record<string, unknown>;
  const problems = Object.keys(held)
    .filter((key) => !CHANGES_HOLDS.includes(key))
    .map((key) => `${who} promises a change that holds "${key}", which is not a field of a promise`);
  const tags = CHANGES_HOLDS.filter((key) => held[key] !== undefined);
  if (tags.length === 0) return [...problems, `${who} promises "${JSON.stringify(changes)}". ${WRITE}`];
  if (tags.length > 1) {
    // Each one rules the other out: "paths" already refuses every other path.
    return [...problems, `${who} promises "paths" and "except" at once. ${WRITE}`];
  }

  const tag = tags[0] as string;
  const paths = held[tag];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || path === "")) {
    return [...problems, `${who} promises "${tag}" that is not a list of names. ${WRITE}`];
  }
  if (paths.length === 0) {
    const write = tag === "paths" ? 'Write "changes: nothing" instead.' : 'Leave "changes" out instead.';
    return [...problems, `${who} promises "${tag}" with no path. ${write}`];
  }
  // A promise holds names, not patterns. ADR 0013 chose it that way, and a
  // pattern that reads as a name refuses every path it looks like it allows.
  const patterns = (paths as string[]).filter((path) => /[*?[\]]/.test(path));
  for (const path of patterns) {
    problems.push(`${who} promises the path "${path}". A promise holds a name, not a pattern. Write "${path.replace(/\/?[*?[\]].*$/, "")}".`);
  }
  return problems;
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

  if (flow.parallel !== undefined && !(Number.isInteger(flow.parallel) && flow.parallel >= 1)) {
    problems.push(
      `the flow runs ${JSON.stringify(flow.parallel)} steps at a time. Write a whole number of one or more.`,
    );
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
    // A cycle to the step itself is a retry, and each member retries its own
    // work, so the member it means is never in doubt. A cycle that leaves the
    // step is, because a fanout has no one value to send back.
    const cycle = cycleOf(step);
    if (cycle && cycle.to !== step.id) {
      problems.push(
        `step "${step.id}" fans out and cycles to "${cycle.to}", so which member cycles is unclear. A cycle to "${step.id}" itself is a retry, and each member takes its own.`,
      );
    }
  }
  if (problems.length > 0) return problems;

  for (const step of flow.steps) {
    problems.push(...toolProblems(flow, step));
    problems.push(...modelProblems(flow, step));
    problems.push(...takenProblems(flow, step));
    problems.push(...conditionProblems(flow, step));
  }

  // A budget counts what a step spends, and only an agent step reports a cost.
  // A budget over no such step is a rule that looks enforced and is not.
  if (flow.budget !== undefined && !flow.steps.some((step) => step.kind === "agent" || step.kind === "flow")) {
    problems.push("the flow has a budget, and no step of it spends. Only an agent step reports a cost.");
  }

  const records = flow.workspace !== undefined && flow.workspace.kind !== "none";
  if (!records) {
    // One promise on the flow speaks for every step, so it answers once.
    if (flow.changes !== undefined) {
      problems.push("the flow promises what it changes, but it has no workspace to check it");
    }
    for (const step of flow.steps) {
      if ((step.kind === "agent" || step.kind === "call") && step.changes !== undefined) {
        problems.push(`step "${step.id}" promises what it changes, but the flow has no workspace to check it`);
      }
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
 * The grammar of a model name belongs to the harness: Pi reads
 * `provider/model`, and the `claude` command reads a plain name. A step that
 * writes the wrong one used to learn it in the middle of a run, after an
 * earlier step spent its tokens. `MODELS` in `harness.ts` names what each
 * adapter reads, so the answer comes before the run. See ADR 0019.
 */
function modelProblems(flow: Flow, step: Step): string[] {
  const model = modelOf(flow, step);
  const wanted =
    step.kind === "agent" ? [{ who: `step "${step.id}"`, harness: harnessOf(flow, step), model }] : [];
  for (const member of membersOf(step) ?? []) {
    // A member that overrides neither reads the same as its step, which the
    // line above already answers.
    if (!member.model && !member.harness) continue;
    const harness = member.harness ?? harnessOf(flow, step);
    wanted.push({ who: `member "${member.name}" of "${step.id}"`, harness, model: member.model ?? model });
  }

  return wanted.flatMap(({ who, harness, model: named }) => {
    const reads = ADAPTERS.includes(harness as AdapterName) ? MODELS[harness as AdapterName] : undefined;
    if (!named || !reads || reads.reads.test(named)) return [];
    return [`${who} names the model "${named}", which the harness "${harness}" cannot read. ${reads.write}`];
  });
}

/**
 * Invariant 2 the other way round: what a step takes, against the names that
 * can reach it. A run supplies what the flow takes, and the step holds the
 * rest, so a name in neither never arrives. The run checks the values
 * themselves, because only a run holds them.
 */
function takenProblems(flow: Flow, step: Step): string[] {
  const schema = (step as CallStep).takes as { required?: unknown } | undefined;
  const required = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  // A computed fanout makes the values of each member during the run, so the
  // run checks that one.
  if (required.length === 0 || computedOf(step)) return [];

  const supplied = Object.keys((flow.takes?.properties as Record<string, unknown>) ?? {});
  const own = (step as AgentStep).with;
  const members = membersOf(step);
  // Each member becomes a step of its own, and it holds its own values.
  const wanted = members
    ? members.map((one) => ({ who: `member "${one.name}" of "${step.id}"`, held: one.with ?? own, on: "the member" }))
    : [{ who: `step "${step.id}"`, held: own, on: "the step" }];

  return wanted.flatMap(({ who, held, on }) =>
    required
      .filter((name) => !supplied.includes(name) && !(held && Object.hasOwn(held, name)))
      .map(
        (name) =>
          `${who} takes "${name}", and nothing supplies it. Add "${name}" to "takes" on the flow, or to "with" on ${on}.`,
      ),
  );
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
    const names = OPERATORS.map((one) => one.name).join(", ");
    return [
      `${at} with ${JSON.stringify(wanted)}, which is not one operator. Use one of: ${names}. Write { is: ... } to test the value itself.`,
    ];
  }

  const [name, argument] = operator;
  const { reads, over } = OPERATORS.find((one) => one.name === name) as Operator;
  const nested = operatorOf(argument);
  if (reads === "value" && nested) {
    return [`${at} with "${name}" over the operator "${nested[0]}". An operator reads a plain value, and none nests.`];
  }
  if (reads !== "value" && typeof argument !== reads) {
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
