import { parse } from "yaml";
import type { Flow, Step } from "./flow.ts";

/**
 * A file is a serialization of the flow data, not a friendlier language. Every
 * field maps one to one, and a contract is plain JSON Schema. So a graphical
 * editor writes the same file with no translation.
 */
export function parseFlow(text: string): Flow {
  const raw = parse(text) as { name?: string; workspace?: Flow["workspace"]; steps?: Array<Partial<Step>> } | null;
  if (!raw || typeof raw !== "object") throw new Error("the file holds no flow");

  const flow: Flow = {
    name: String(raw.name ?? ""),
    steps: (raw.steps ?? []).map((step) => ({ needs: [], ...step }) as Step),
  };
  if (raw.workspace) flow.workspace = raw.workspace;

  // No check here. A file can be a fragment of a larger flow, and a fragment
  // holds no workspace and reaches steps it cannot see. The run checks the whole.
  return flow;
}
