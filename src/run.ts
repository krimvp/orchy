import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "@sinclair/typebox/value";
import { type AgentStep, type CallStep, type Flow, type Step, validate } from "./flow.ts";
import { type Harness, pi } from "./pi.ts";

export interface StepRecord {
  status: "done" | "failed";
  value?: unknown;
  error?: string;
  trajectory?: string;
}

export interface RunState {
  runId: string;
  flow: string;
  status: "running" | "done" | "failed";
  steps: Record<string, StepRecord>;
}

export interface RunOptions {
  cwd?: string;
  harness?: Harness;
}

export async function run(flow: Flow, options: RunOptions = {}): Promise<RunState> {
  const problems = validate(flow);
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);

  const cwd = resolve(options.cwd ?? process.cwd());
  const harness = options.harness ?? pi;
  const state: RunState = { runId: randomUUID(), flow: flow.name, status: "running", steps: {} };

  const directory = join(cwd, ".orchy", "runs", state.runId);
  mkdirSync(directory, { recursive: true });
  // ADR 0005: the state on disk is the run. A gate and a crash recover the same way.
  const save = () => writeFileSync(join(directory, "state.json"), JSON.stringify(state, null, 2));
  save();

  for (const step of order(flow.steps)) {
    const record = await runStep(step, state, cwd, harness);
    state.steps[step.id] = record;
    if (record.status === "failed") {
      state.status = "failed";
      save();
      return state;
    }
    save();
  }

  state.status = "done";
  save();
  return state;
}

async function runStep(step: Step, state: RunState, cwd: string, harness: Harness): Promise<StepRecord> {
  const inputs = Object.fromEntries(step.needs.map((need) => [need, state.steps[need]?.value]));

  let result: { value: unknown; trajectory?: string };
  try {
    result =
      step.kind === "agent"
        ? await harness.run({
            prompt: buildPrompt(step, inputs, cwd),
            tools: step.tools,
            returns: step.returns,
            cwd,
          })
        : { value: await callModule(step, inputs, cwd) };
  } catch (error) {
    return { status: "failed", error: String(error) };
  }

  // Invariant 2: the value must match the contract of the step.
  if (!Value.Check(step.returns, result.value)) {
    const [first] = [...Value.Errors(step.returns, result.value)];
    return {
      status: "failed",
      error: `the value breaks the contract at "${first?.path ?? "/"}": ${first?.message ?? "unknown"}`,
      value: result.value,
    };
  }

  return { status: "done", value: result.value, trajectory: result.trajectory };
}

function buildPrompt(step: AgentStep, inputs: Record<string, unknown>, cwd: string): string {
  const text = readFileSync(resolve(cwd, step.prompt), "utf8");
  if (step.needs.length === 0) return text;
  return `${text}\n\n## The values of the steps before this one\n\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\`\n`;
}

async function callModule(step: CallStep, inputs: Record<string, unknown>, cwd: string): Promise<unknown> {
  const module = await import(pathToFileURL(resolve(cwd, step.module)).href);
  return module.default(inputs);
}

/** Invariant 3: a step starts only after every step that it needs passes. */
function order(steps: Step[]): Step[] {
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
