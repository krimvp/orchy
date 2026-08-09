import { parse } from "yaml";
import { type Flow, type Step, validate } from "./flow.ts";

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

  const problems = validate(flow);
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);
  return flow;
}
