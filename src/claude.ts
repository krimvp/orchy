import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Metrics, SCHEMA_VERSION, type Step, type Trajectory, totalMetrics } from "./atif.ts";
import { type Harness, MODELS, type ToolName, type Watch, environmentOf, notesOf } from "./harness.ts";
import { tail } from "./tail.ts";

const run = promisify(execFile);

/**
 * Invariant 1 crosses the two vocabularies here. Claude has no separate list
 * tool. The type covers every name, so `SUPPLIES.claude` cannot claim a tool
 * that this table does not map.
 */
const TOOLS: Record<ToolName, string[]> = {
  read: ["Read"],
  write: ["Write"],
  edit: ["Edit"],
  bash: ["Bash"],
  grep: ["Grep"],
  find: ["Glob"],
  ls: ["Glob"],
  web: ["WebSearch", "WebFetch"],
  // The door of the run's own root, served over MCP. ADR 0025.
  orchy: ["mcp__orchy"],
};

// Orchy runs from source as TypeScript and from a published copy as JavaScript,
// so a file it starts or loads takes the extension it is running under itself.
const EXT = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";
const CLI = join(import.meta.dirname, `cli${EXT}`);

interface Answer {
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  structured_output?: unknown;
  total_cost_usd?: number;
}

/**
 * Orchy drives the `claude` command, not the Claude Agent SDK. The SDK spawns
 * this same command, and it costs two packages to do so. The command takes the
 * contract as JSON Schema directly, so no schema conversion happens at all.
 */
export const claude: Harness = {
  async run(request, watch) {
    const tools = [
      ...new Set(
        request.tools.flatMap((name) => {
          const mapped = TOOLS[name as ToolName];
          // Dropping a tool a step asked for would weaken invariant 1 in silence.
          if (!mapped) throw new Error(`claude has no tool for "${name}"`);
          return mapped;
        }),
      ),
    ];
    // `validate()` reads the same row, so a flow that names its harness hears
    // this before the run starts.
    if (request.model && !MODELS.claude.reads.test(request.model)) {
      throw new Error(`claude wants a plain model name, not "${request.model}"`);
    }
    // A fresh id keeps a step out of the transcript of whatever session started it.
    const sessionId = randomUUID();

    // `--tools` bounds the built-in set only; a tool of an MCP server exists
    // through `--mcp-config` instead, so the two lists part here.
    const builtin = tools.filter((name) => !name.startsWith("mcp__"));
    // The step reaches the door of its own root, and the door records who
    // asked: the child run writes `startedBy` from this. ADR 0025.
    const door = {
      mcpServers: {
        orchy: {
          command: process.execPath,
          args: [CLI, "mcp"],
          ...(request.run ? { env: { ORCHY_STARTED_BY: JSON.stringify({ runId: request.run, step: request.step }) } } : {}),
        },
      },
    };

    const args = [
      "--print",
      request.prompt,
      "--output-format",
      "json",
      "--session-id",
      sessionId,
      "--json-schema",
      JSON.stringify(request.returns),
      // Invariant 1: `--tools` limits what exists, `--allowedTools` runs it without a prompt.
      "--tools",
      ...(builtin.length > 0 ? builtin : [""]),
      "--allowedTools",
      ...(tools.length > 0 ? tools : [""]),
      // Invariant 1 again: without this, every MCP server of the user's own
      // configuration exists for the step, and no tool list declared it.
      "--strict-mcp-config",
      ...(tools.includes("mcp__orchy") ? ["--mcp-config", JSON.stringify(door)] : []),
      ...(request.model ? ["--model", request.model] : []),
    ];

    // Claude writes its transcript one line at a time, so the record of the
    // step is also the report of it. The command itself does not change.
    const stop = watch ? tail(() => findTranscript(sessionId), (line) => report(line, watch)) : undefined;

    let stdout: string;
    try {
      const command = run("claude", args, { cwd: request.cwd, maxBuffer: 64 * 1024 * 1024, env: environmentOf(request) });
      // The command reads its input stream, and Orchy writes nothing to it. Left
      // open, the command waits out its own timeout on every step of every flow.
      command.child.stdin?.end();
      ({ stdout } = await command);
    } catch (error) {
      // A command that ends badly says why on its own streams. Node throws the
      // whole argument list instead, prompt and all, and names no reason.
      // The transcript and the money are already real, so both ride out on the
      // error: a step that failed is the step a reader most wants to read, and
      // ADR 0019 counts what a failed attempt spent.
      throw spent(
        new Error(`step "${request.step}" could not run the claude command: ${whyOf(error)}`),
        sessionId,
        costOf((error as { stdout?: string }).stdout),
      );
    } finally {
      stop?.();
    }

    let answer: Answer;
    try {
      answer = JSON.parse(stdout) as Answer;
    } catch {
      throw new Error("the claude command answered something that is not JSON");
    }

    if (answer.is_error || answer.subtype !== "success") {
      throw spent(
        new Error(
          `step "${request.step}" ended as ${answer.subtype ?? "an error"}: ${String(answer.result).slice(0, 300)}`,
        ),
        sessionId,
        answer.total_cost_usd,
      );
    }
    if (answer.structured_output === undefined) {
      throw spent(
        new Error(`step "${request.step}" ended with no value for its contract`),
        sessionId,
        answer.total_cost_usd,
      );
    }

    // Claude writes no cost into its transcript, so take it from the answer.
    return { value: answer.structured_output, trajectory: sessionId, cost: answer.total_cost_usd };
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
    // Claude writes one line for each block of a response, and every one of
    // those lines carries the usage of the whole response. Counting each line
    // multiplies the tokens of a step by the number of blocks it happened to
    // take, so a response is counted once, by its id.
    const counted = new Set<string>();
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
      const id = message.id;
      if (step.metrics && (id === undefined || !counted.has(id))) {
        if (id !== undefined) counted.add(id);
        metrics.push(step.metrics);
      } else {
        // The response has already been counted, so this line reports no usage
        // of its own. It is the same answer, written on.
        step.metrics = undefined;
      }
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

/**
 * The record and the money of a step that failed, carried on the error. The
 * runner reads both off it, so a failure costs a person the value of the step
 * and nothing else: not the transcript, and not the count of what it spent.
 */
function spent(error: Error, trajectory: string, cost: number | undefined): Error {
  return Object.assign(error, { trajectory, ...(cost === undefined ? {} : { cost }) });
}

/** What the command said it spent, when it wrote an answer before it failed. */
function costOf(stdout: string | undefined): number | undefined {
  try {
    const answer = JSON.parse(stdout ?? "") as Answer;
    return typeof answer.total_cost_usd === "number" ? answer.total_cost_usd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Why the command failed, in its own words. Node puts the whole argument list
 * in `message`, and the prompt is one of those arguments, so the reason drowns.
 * The command writes the reason to its streams.
 */
function whyOf(error: unknown): string {
  const held = error as { stderr?: string; stdout?: string; message?: string; code?: number };
  const said = (held.stderr ?? "").trim() || resultOf(held.stdout) || "";
  if (said) return said.split("\n").slice(0, 3).join(" ").slice(0, 300);
  return `it ended with the code ${held.code ?? "unknown"}`;
}

/** The reason inside a JSON answer, when the command wrote one before it failed. */
function resultOf(stdout: string | undefined): string {
  try {
    const answer = JSON.parse(stdout ?? "") as Answer;
    return String(answer.result ?? "");
  } catch {
    return "";
  }
}

/** One line of the transcript, as notes. A line that says nothing reports nothing. */
function report(line: string, watch: Watch): void {
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return;
  }
  if (!entry.message?.role) return;
  const step = toStep(entry, 0);
  if (step) for (const note of notesOf(step)) watch(note);
}

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
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
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
    // Claude keeps no cost in its transcript. The adapter puts the cost of the
    // whole step on `final_metrics`, so a per-step zero here would read as free.
    metrics: {
      // A cache write is an input token that a person paid for, so the count of
      // what went in holds it. A cache read is the cheap half, and it has its
      // own name.
      prompt_tokens: (message.usage?.input_tokens ?? 0) + (message.usage?.cache_creation_input_tokens ?? 0),
      completion_tokens: message.usage?.output_tokens ?? 0,
      cached_tokens: message.usage?.cache_read_input_tokens ?? 0,
    },
  };
}
