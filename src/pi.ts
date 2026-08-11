import { readFileSync } from "node:fs";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { type Metrics, SCHEMA_VERSION, type Step, type Trajectory, totalMetrics } from "./atif.ts";
import { type AgentRequest, type Harness, MODELS, SUPPLIES, type ToolName, type Watch, notesOf } from "./harness.ts";
import { tail } from "./tail.ts";

const SUBMIT = "submit_result";

const REMIND = `You ended without calling ${SUBMIT}, so the work you just did was not recorded. Call it once now, with that result.`;

/**
 * How many times a step may offer a value that its contract refuses. Pi checks
 * the value itself and asks again, so a contract that no value satisfies makes
 * a model call and call and call. Invariant 4 says a flow cannot run forever,
 * and a cycle limit does not reach inside one step. This is that limit.
 */
const REFUSALS = 8;

/**
 * What Pi says when it refuses a value. A session line is JSON, so the quotes
 * around the name of the tool are escaped in it. This matches either form.
 */
const REFUSED = "Validation failed for tool";

export const pi: Harness = {
  async run(request, watch) {
    let value: unknown;

    const submit = defineTool({
      name: SUBMIT,
      label: "Submit result",
      description: "Report the result of this step. Call this once, when the work is complete.",
      parameters: request.returns,
      execute: async (_id: string, params: unknown) => {
        value = params;
        return { content: [{ type: "text" as const, text: "Recorded." }], details: undefined };
      },
    });

    for (const name of request.tools) {
      // Dropping a tool a step asked for would weaken invariant 1 in silence.
      if (!SUPPLIES.pi.includes(name as ToolName)) throw new Error(`pi has no tool for "${name}"`);
    }

    // Orchy must load the resources itself. Without this, the extensions and the
    // skills of the user never load, so a custom provider is unknown and Pi falls
    // back to another model without a word.
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(request.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd: request.cwd, agentDir, settingsManager });
    await resourceLoader.reload();

    // Pi needs both halves of the name, because two providers can serve one model.
    const modelRuntime = await ModelRuntime.create();
    let model: ReturnType<ModelRuntime["getModel"]>;
    if (request.model) {
      // `validate()` reads the same row, so a flow that names its harness hears
      // this before the run starts.
      if (!MODELS.pi.reads.test(request.model)) {
        throw new Error(`pi wants a model named "provider/model", not "${request.model}"`);
      }
      const cut = request.model.indexOf("/");
      const provider = request.model.slice(0, cut);
      const id = request.model.slice(cut + 1);
      model = modelRuntime.getModel(provider, id);
      if (!model) throw new Error(`pi does not know the model "${request.model}"`);
    }

    // Invariant 1: the step reaches the declared tools and nothing else.
    const sessionManager = SessionManager.create(request.cwd);
    const { session } = await createAgentSession({
      cwd: request.cwd,
      tools: [...request.tools, SUBMIT],
      customTools: [submit],
      sessionManager,
      settingsManager,
      resourceLoader,
      modelRuntime,
      model,
    });

    // Pi writes its session one line at a time, so the record of the step is
    // also the report of it. The tail runs whether or not a caller watches,
    // because the count of refused values comes from the same lines.
    let refusals = 0;
    const stop = tail(
      () => fileOf(sessionManager),
      (line) => {
        if (line.includes(REFUSED)) refusals += 1;
        // The step has offered value after value, and the contract refuses each
        // one. Nothing here will change, so stop instead of running for ever.
        if (refusals >= REFUSALS) void session.abort();
        if (watch) report(line, watch);
      },
    );

    try {
      await session.prompt(request.prompt);
      // A model that answers in prose has done the work and skipped the last
      // step of it, which is the common way a step fails here. One reminder
      // recovers the value. A second never has, so the step fails after it.
      if (value === undefined && refusals < REFUSALS) await session.prompt(REMIND);
    } finally {
      stop();
      session.dispose();
    }

    const file = sessionManager.getSessionFile();
    if (value === undefined) {
      // The session is on disk either way, and a step that failed is the one a
      // reader most wants to read. So the trajectory rides on the error.
      throw Object.assign(new Error(refused(request, file, refusals)), { trajectory: file });
    }
    return { value, trajectory: file, cost: costOf(file) };
  },

  /** A session file is data from another program, so read it defensively. */
  toTrajectory(path, trajectoryId, version) {
    const found = messages(path);
    if (!found) return undefined;

    const steps: Step[] = [];
    const metrics: Metrics[] = [];
    let model = "unknown";

    for (const entry of found) {
      const message = entry.message as PiMessage | undefined;
      const step = toStep(message, steps.length + 1, String(entry.timestamp ?? ""));
      if (!step) continue;
      if (message?.role === "assistant" && message.model) model = message.model;
      if (step.metrics) metrics.push(step.metrics);
      steps.push(step);
    }

    return {
      schema_version: SCHEMA_VERSION,
      trajectory_id: trajectoryId,
      session_id: trajectoryId,
      agent: { name: "pi", version, model_name: model },
      steps,
      final_metrics: { ...totalMetrics(metrics), total_steps: steps.length },
    };
  },
};

/** The message lines of a session file, or nothing when there is no file to read. */
function messages(path: string): Array<Record<string, unknown>> | undefined {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return undefined;
  }

  const found: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "message") found.push(entry);
    } catch {
      // A half-written line is not a message. The next read gets the whole one.
    }
  }
  return found;
}

/**
 * What the session spent, or nothing when no message carried a price. A cost of
 * zero and a cost that no provider reported are different things, and a budget
 * that reads the second as zero is a budget that is not enforced. See ADR 0019.
 *
 * A provider with no price table reports a total of zero on every message, and
 * that is the second thing wearing the face of the first: a step that answered
 * spent something. So a session that reports zero throughout reports no cost.
 */
export function costOf(path: string | undefined): number | undefined {
  if (!path) return undefined;
  let total: number | undefined;
  for (const entry of messages(path) ?? []) {
    const cost = (entry.message as PiMessage | undefined)?.usage?.cost?.total;
    if (typeof cost === "number") total = (total ?? 0) + cost;
  }
  return total === 0 ? undefined : total;
}

/**
 * Why the step failed, in the words a person needs: which step, what the model
 * did instead, and what to do about it. The step id and the model come from the
 * request, because the session file names neither.
 */
function refused(request: AgentRequest, path: string | undefined, refusals = 0): string {
  const named = request.model ? `The model "${request.model}"` : "The model";
  // A provider that refuses the request is not a model that will not call a
  // tool. The two used to wear one face, and the advice was wrong for one.
  const broke = path ? errorOf(path) : undefined;
  if (broke) {
    return `step "${request.step}" reached no answer. ${named} answered: ${broke}. Read the message of the provider: this is not the step, and not the contract.`;
  }
  if (refusals >= REFUSALS) {
    const why = path ? lastRefusal(path) : "";
    return `step "${request.step}" offered ${refusals} values, and the contract refused every one${why ? `: ${why}` : ""}. Check that "returns" describes a value that exists.`;
  }
  const said = path ? lastText(path) : "";
  const instead = said ? ` ${named} answered in prose instead: "${said}".` : "";
  return `step "${request.step}" ended without a call to ${SUBMIT}, and again when reminded.${instead} Give the step a cycle on "failed", or name a model that calls a tool.`;
}

/** What a provider said when it refused the request, or nothing when it did not. */
function errorOf(path: string): string | undefined {
  for (const entry of (messages(path) ?? []).slice().reverse()) {
    const message = entry.message as PiMessage | undefined;
    if (message?.stopReason === "error" && message.errorMessage) return cut(message.errorMessage);
  }
  return undefined;
}

/** Why the contract refused the last value the step offered. */
function lastRefusal(path: string): string {
  for (const entry of (messages(path) ?? []).slice().reverse()) {
    const message = entry.message as PiMessage | undefined;
    if (message?.role !== "toolResult") continue;
    const text = textOf(message);
    // The reason, and not the value that carried it: the value is in the record.
    if (text.includes(REFUSED)) {
      const why = text.replace(/^Validation failed for tool[^\n]*\n?/, "").split("Received arguments")[0] ?? "";
      return cut(why.replace(/^\s*-\s*/gm, ""));
    }
  }
  return "";
}

function cut(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** The last thing the model said, short enough to sit inside an error. */
function lastText(path: string): string {
  const found = messages(path) ?? [];
  for (let at = found.length - 1; at >= 0; at--) {
    const message = found[at]?.message as PiMessage | undefined;
    if (message?.role !== "assistant") continue;
    const text = textOf(message).trim().replace(/\s+/g, " ");
    if (text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  return "";
}

/** The session file appears after the session starts, so this may find nothing yet. */
function fileOf(sessionManager: ReturnType<typeof SessionManager.create>): string | undefined {
  try {
    return sessionManager.getSessionFile() || undefined;
  } catch {
    return undefined;
  }
}

/** One line of the session, as notes. A line that says nothing reports nothing. */
function report(line: string, watch: Watch) {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (entry.type !== "message") return;
  const step = toStep(entry.message as PiMessage | undefined, 0, String(entry.timestamp ?? ""));
  if (step) for (const note of notesOf(step)) watch(note);
}

interface PiContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: string | PiContent[];
  model?: string;
  toolCallId?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
}

/** What a message says in words. A message is a string, or the parts of one. */
function textOf(message: PiMessage): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function toStep(message: PiMessage | undefined, id: number, timestamp: string): Step | undefined {
  if (!message?.role) return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = textOf(message);

  if (message.role === "user") {
    return { step_id: id, timestamp, source: "user", message: text };
  }

  if (message.role === "toolResult") {
    return {
      step_id: id,
      timestamp,
      source: "system",
      message: "",
      observation: { results: [{ source_call_id: message.toolCallId ?? "", content: text }] },
    };
  }

  if (message.role !== "assistant") return undefined;

  const calls = content
    .filter((part) => part.type === "toolCall")
    .map((part) => ({
      tool_call_id: part.id ?? "",
      function_name: part.name ?? "",
      arguments: part.arguments ?? {},
    }));
  const thinking = content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking ?? "")
    .join("\n");

  return {
    step_id: id,
    timestamp,
    source: "agent",
    message: text,
    reasoning_content: thinking || undefined,
    tool_calls: calls.length > 0 ? calls : undefined,
    metrics: {
      prompt_tokens: message.usage?.input ?? 0,
      completion_tokens: message.usage?.output ?? 0,
      cached_tokens: message.usage?.cacheRead ?? 0,
      cost_usd: message.usage?.cost?.total ?? 0,
    },
  };
}
