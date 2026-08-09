import type { Step, Trajectory } from "./atif.ts";
import type { TSchema } from "@sinclair/typebox";

/**
 * The name of every adapter. The names live apart from the adapters, so the
 * server checks a name without loading the SDK of a harness.
 */
export const ADAPTERS = ["pi", "claude"] as const;

export type AdapterName = (typeof ADAPTERS)[number];

/** Invariant 1 speaks these names. Each adapter maps them to its own. */
export const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web"] as const;

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
};

export interface AgentRequest {
  step: string;
  prompt: string;
  tools: string[];
  returns: TSchema;
  cwd: string;
  /** A string that only this harness reads. Absent means the harness decides. */
  model?: string;
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
  kind: "text" | "reasoning" | "tool" | "result";
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
