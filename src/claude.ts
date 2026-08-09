import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { type ZodTypeAny, z } from "zod";
import { type Metrics, SCHEMA_VERSION, type Step, type Trajectory, totalMetrics } from "./atif.ts";
import type { Harness } from "./harness.ts";

const SUBMIT = "submit_result";
const SERVER = "orchy";

/** Invariant 1 crosses the two vocabularies here. Claude has no separate list tool. */
const TOOLS: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

export const claude: Harness = {
  async run(request) {
    let value: unknown;

    const server = createSdkMcpServer({
      name: SERVER,
      tools: [
        tool(
          SUBMIT,
          "Report the result of this step. Call this once, when the work is complete.",
          shapeOf(request.returns as JsonSchema),
          async (args: unknown) => {
            value = args;
            return { content: [{ type: "text" as const, text: "Recorded." }] };
          },
        ),
      ],
    });

    const submitTool = `mcp__${SERVER}__${SUBMIT}`;
    const builtin = [...new Set(request.tools.map((name) => TOOLS[name]).filter(Boolean) as string[])];
    // A fresh id keeps a step out of the transcript of whatever session started it.
    const sessionId = randomUUID();

    const answer = query({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        sessionId,
        mcpServers: { [SERVER]: server },
        // Invariant 1: `tools` limits what exists, `allowedTools` runs it without a prompt.
        tools: builtin,
        allowedTools: [...builtin, submitTool],
      },
    });

    // Claude writes no cost into its transcript, so take it from the result.
    let cost: number | undefined;
    for await (const message of answer) {
      if (message.type !== "result") continue;
      if (message.subtype !== "success") throw new Error(`the step ended as ${message.subtype}`);
      cost = message.total_cost_usd;
    }

    if (value === undefined) throw new Error(`the step ended without a call to ${SUBMIT}`);
    return { value, trajectory: sessionId, cost };
  },

  /** The handle is a session id. Claude writes the transcript under its own directory. */
  toTrajectory(sessionId, trajectoryId, version) {
    const path = findTranscript(sessionId);
    if (!path) return undefined;

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
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      const message = entry.message;
      if (!message?.role) continue;

      const step = toStep(entry, steps.length + 1);
      if (!step) continue;
      if (message.model) model = message.model;
      if (step.metrics) metrics.push(step.metrics);
      steps.push(step);
    }

    return {
      schema_version: SCHEMA_VERSION,
      trajectory_id: trajectoryId,
      session_id: trajectoryId,
      agent: { name: "claude-code", version, model_name: model },
      steps,
      final_metrics: { ...totalMetrics(metrics), total_steps: steps.length },
    };
  },
};

function findTranscript(sessionId: string): string | undefined {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  let directories: string[];
  try {
    directories = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const path = join(projects, directory, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface Entry {
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | Block[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: Block) => block.type === "text")
    .map((block: Block) => block.text ?? "")
    .join("\n");
}

function toStep(entry: Entry, id: number): Step | undefined {
  const message = entry.message;
  if (!message) return undefined;
  const timestamp = entry.timestamp ?? "";
  const blocks = Array.isArray(message.content) ? message.content : [];

  if (message.role === "user") {
    // A tool result comes back as a user message, so look before calling it one.
    const results = blocks
      .filter((block) => block.type === "tool_result")
      .map((block) => ({ source_call_id: block.tool_use_id ?? "", content: textOf(block.content) }));
    if (results.length > 0) {
      return { step_id: id, timestamp, source: "system", message: "", observation: { results } };
    }
    return { step_id: id, timestamp, source: "user", message: textOf(message.content) };
  }

  if (message.role !== "assistant") return undefined;

  const calls = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      tool_call_id: block.id ?? "",
      function_name: block.name ?? "",
      arguments: block.input ?? {},
    }));
  const thinking = blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking ?? "")
    .join("\n");

  return {
    step_id: id,
    timestamp,
    source: "agent",
    message: textOf(message.content),
    reasoning_content: thinking || undefined,
    tool_calls: calls.length > 0 ? calls : undefined,
    metrics: {
      prompt_tokens: message.usage?.input_tokens ?? 0,
      completion_tokens: message.usage?.output_tokens ?? 0,
      cached_tokens: message.usage?.cache_read_input_tokens ?? 0,
      cost_usd: 0,
    },
  };
}

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
}

/**
 * The Claude SDK describes a tool with Zod, but a contract is JSON Schema.
 * This covers the shapes a contract uses. It only tells the model what to
 * produce: Ajv still checks the value, so a gap here fails the step, it does
 * not pass a wrong one.
 */
function shapeOf(schema: JsonSchema): Record<string, ZodTypeAny> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const type = typeOf(property);
    shape[key] = required.has(key) ? type : type.optional();
  }
  return shape;
}

function typeOf(schema: JsonSchema): ZodTypeAny {
  const base = (() => {
    switch (schema.type) {
      case "string":
        return z.string();
      case "number":
      case "integer":
        return z.number();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(schema.items ? typeOf(schema.items) : z.unknown());
      case "object":
        return z.object(shapeOf(schema));
      default:
        return z.unknown();
    }
  })();
  return schema.description ? base.describe(schema.description) : base;
}
