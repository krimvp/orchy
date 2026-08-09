import type { TSchema } from "@sinclair/typebox";
import type { Trajectory } from "./atif.ts";

/**
 * The name of every adapter. The names live apart from the adapters, so the
 * server checks a name without loading the SDK of a harness.
 */
export const ADAPTERS = ["pi", "claude"] as const;

export type AdapterName = (typeof ADAPTERS)[number];

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
 * ADR 0002 budgets a few members. A second harness cost the second one: a
 * trajectory has a different shape in every harness, so only the adapter can
 * read it.
 */
export interface Harness {
  run(request: AgentRequest): Promise<AgentResult>;
  toTrajectory(handle: string, trajectoryId: string, version: string): Trajectory | undefined;
}
