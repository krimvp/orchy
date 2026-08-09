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
import type { Harness } from "./harness.ts";

const SUBMIT = "submit_result";

export const pi: Harness = {
  async run(request) {
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
      const cut = request.model.indexOf("/");
      if (cut < 1) throw new Error(`pi wants a model named "provider/model", not "${request.model}"`);
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

    try {
      await session.prompt(request.prompt);
    } finally {
      session.dispose();
    }

    if (value === undefined) throw new Error(`the step ended without a call to ${SUBMIT}`);
    return { value, trajectory: sessionManager.getSessionFile() };
  },

  /** A session file is data from another program, so read it defensively. */
  toTrajectory(path, trajectoryId, version) {
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      return undefined;
    }

    const steps: Step[] = [];
    const metrics: Metrics[] = [];
    let model = "unknown";

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (entry.type !== "message") continue;

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
  content?: string | PiContent[];
  model?: string;
  toolCallId?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
}

function toStep(message: PiMessage | undefined, id: number, timestamp: string): Step | undefined {
  if (!message?.role) return undefined;
  const content = Array.isArray(message.content) ? message.content : [];
  const text =
    typeof message.content === "string"
      ? message.content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");

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
