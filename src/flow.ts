import type { TSchema } from "@sinclair/typebox";

export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface AgentStep {
  kind: "agent";
  id: string;
  needs: string[];
  prompt: string;
  tools: ToolName[];
  returns: TSchema;
}

export interface CallStep {
  kind: "call";
  id: string;
  needs: string[];
  module: string;
  returns: TSchema;
}

export type Step = AgentStep | CallStep;

export interface Flow {
  name: string;
  steps: Step[];
}

type Declared<T extends Step> = Omit<T, "kind" | "needs"> & { needs?: string[] };

export function agent(step: Declared<AgentStep>): AgentStep {
  return { kind: "agent", needs: [], ...step };
}

export function call(step: Declared<CallStep>): CallStep {
  return { kind: "call", needs: [], ...step };
}

export function flow(name: string, definition: { steps: Step[] }): Flow {
  return { name, steps: definition.steps };
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
  return problems;
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
