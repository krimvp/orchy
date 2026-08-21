import type { Step, Trajectory } from "./atif.ts";
import type { TSchema } from "@sinclair/typebox";

/**
 * The name of every adapter. The names live apart from the adapters, so the
 * server checks a name without loading the SDK of a harness.
 */
export const ADAPTERS = ["pi", "claude", "droid"] as const;

export type AdapterName = (typeof ADAPTERS)[number];

/**
 * Invariant 1 speaks these names. Each adapter maps them to its own. `orchy`
 * is the door of the run's own root: a step that declares it authors flows,
 * starts runs, and answers gates, and ADR 0025 states what bounds that.
 */
export const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web", "orchy"] as const;

export type ToolName = (typeof TOOLS)[number];

/**
 * The tools each adapter supplies. This table lives beside the names and not
 * inside an adapter, so `validate()` refuses a tool the harness lacks without
 * loading the SDK of that harness. Each adapter checks a request against its
 * own row, so one table answers both.
 */
export const SUPPLIES: Record<AdapterName, readonly ToolName[]> = {
  pi: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  claude: TOOLS,
  droid: ["read", "bash", "edit", "write", "grep", "find", "ls", "web"],
};

/**
 * What each adapter reads as a model name. The grammar of a name belongs to the
 * harness, so this table lives beside the names, for the same reason as
 * `SUPPLIES`: `validate()` reads it without loading the SDK of a harness. It
 * checks the grammar and not the catalogue, because only the harness knows
 * which models it has. See ADR 0019.
 */
export const MODELS: Record<AdapterName, { reads: RegExp; write: string }> = {
  pi: { reads: /^[^/\s]+\/[^\s]+$/, write: 'Write the provider and the model, as "openai/gpt-5".' },
  claude: { reads: /^[^/\s]+$/, write: 'Write a plain model name, as "opus".' },
  droid: { reads: /^[^/\s]+$/, write: 'Write the model id as droid reads it, as "qwen3.5:397b".' },
};

/**
 * The autonomy level of the `droid` command, and the variable that names it.
 * Droid alone reads a level, so this is one row and not a table. It lives here
 * beside `SUPPLIES` and `MODELS`, and not in the adapter, so the runner refuses
 * a value that names no level without loading the adapter.
 *
 * A step needs `high`, because no one sits at the keyboard of a step. An
 * organisation can cap the level below `high`, and only the machine knows the
 * cap, so the environment lowers it. See ADR 0028.
 */
export const AUTONOMY = {
  variable: "ORCHY_DROID_AUTO",
  levels: ["low", "medium", "high"],
  fallback: "high",
};

/**
 * Why the level that the environment names is wrong, or nothing when it is
 * right or absent. The runner reads this before the first step, so a value that
 * names no level costs no token, and the adapter reads the same rule when it
 * starts the command.
 */
export function autonomyProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env[AUTONOMY.variable];
  if (named === undefined) return undefined;
  const level = named.trim().toLowerCase();
  if (level === "") {
    return `${AUTONOMY.variable} is set to nothing, which names no autonomy level. Leave it out to take "${AUTONOMY.fallback}".`;
  }
  if (!AUTONOMY.levels.includes(level)) {
    return `${AUTONOMY.variable} is "${named}", which names no autonomy level. Use one of: ${AUTONOMY.levels.join(", ")}.`;
  }
  return undefined;
}

/** The level a droid step runs under: the one the environment names, or `high`. */
export function autonomyOf(env: NodeJS.ProcessEnv = process.env): string {
  const problem = autonomyProblem(env);
  if (problem) throw new Error(problem);
  return (env[AUTONOMY.variable] ?? AUTONOMY.fallback).trim().toLowerCase();
}

export interface AgentRequest {
  step: string;
  prompt: string;
  tools: string[];
  returns: TSchema;
  cwd: string;
  /** A string that only this harness reads. Absent means the harness decides. */
  model?: string;
  /** The run this step belongs to, so a run the step starts records it. ADR 0025. */
  run?: string;
}

export interface AgentResult {
  value: unknown;
  /** A handle that only this harness understands: a file path, a session id. */
  trajectory?: string;
  /** Set when the cost is not in the trajectory, so the record keeps it anyway. */
  cost?: number;
}

/**
 * One thing a step did, while it did it. A note is a view and not a record:
 * the trajectory holds the whole of it, and a note is short enough to read.
 */
export interface Note {
  /** `prompt` is what the step asked, after Orchy read its file and filled it. */
  kind: "prompt" | "text" | "reasoning" | "tool" | "result";
  text: string;
}

export type Watch = (note: Note) => void;

/** A note carries a line, not a file. The trajectory holds the whole of it. */
const MOST = 400;

/**
 * The notes of one step of a trajectory. Both adapters read their own record
 * as it grows, and both turn it into an ATIF step already, so both report what
 * they do through this one function.
 */
export function notesOf(step: Step): Note[] {
  const notes: Note[] = [];
  if (step.reasoning_content) notes.push({ kind: "reasoning", text: cut(step.reasoning_content) });
  if (step.source === "agent" && step.message.trim()) notes.push({ kind: "text", text: cut(step.message) });
  for (const call of step.tool_calls ?? []) {
    notes.push({ kind: "tool", text: cut(`${call.function_name} ${JSON.stringify(call.arguments)}`) });
  }
  for (const result of step.observation?.results ?? []) {
    if (result.content.trim()) notes.push({ kind: "result", text: cut(result.content) });
  }
  return notes;
}

function cut(text: string): string {
  const flat = text.trim();
  return flat.length > MOST ? `${flat.slice(0, MOST)}…` : flat;
}

/**
 * ADR 0002 budgets a few members. A second harness cost the second one: a
 * trajectory has a different shape in every harness, so only the adapter can
 * read it.
 *
 * `watch` is the second argument that the plan reserved for the live output of
 * a step. An adapter that reports nothing still answers the same.
 */
export interface Harness {
  run(request: AgentRequest, watch?: Watch): Promise<AgentResult>;
  toTrajectory(handle: string, trajectoryId: string, version: string): Trajectory | undefined;
}
