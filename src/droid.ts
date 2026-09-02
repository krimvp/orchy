import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type Metrics, SCHEMA_VERSION, type Step, type Trajectory } from "./atif.ts";
import { type AgentRequest, type Harness, MODELS, type ToolName, type Watch, environmentOf, notesOf } from "./harness.ts";
import { tail } from "./tail.ts";

const run = promisify(execFile);

/**
 * Invariant 1 crosses the two vocabularies here. Droid holds one MCP list for
 * every session, so no per-step list can bound the door of the run's own root,
 * and `SUPPLIES.droid` leaves `orchy` out. The type covers the rest, so
 * `SUPPLIES.droid` cannot claim a tool that this table does not map.
 */
const TOOLS: Record<Exclude<ToolName, "orchy">, string[]> = {
  read: ["Read"],
  write: ["Create"],
  edit: ["Edit"],
  bash: ["Execute"],
  grep: ["Grep"],
  find: ["Glob"],
  ls: ["LS"],
  web: ["FetchUrl", "WebSearch"],
};

/**
 * The `droid` command takes no schema, so the contract rides the system prompt,
 * and the runner checks the value against the real schema when it lands.
 */
function contract(returns: unknown): string {
  return `The last message of this session is the value of this step. Write one JSON value that matches this JSON Schema, and nothing else: no fence, no prose, no name in front of it.\n${JSON.stringify(returns)}`;
}

const SESSIONS = join(homedir(), ".factory", "sessions");

interface Answer {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
}

/**
 * Orchy drives the `droid` command of Factory. The command reads
 * `~/.factory/config.json` for a custom model, so a free provider such as
 * Ollama Cloud serves a step without a Factory account.
 */
export const droid: Harness = {
  async run(request, watch) {
    const tools = [
      ...new Set(
        request.tools.flatMap((name) => {
          const mapped = TOOLS[name as Exclude<ToolName, "orchy">];
          // Dropping a tool a step asked for would weaken invariant 1 in silence.
          if (!mapped) throw new Error(`droid has no tool for "${name}"`);
          return mapped;
        }),
      ),
    ];
    // An empty `--restrict-tools` list restricts a step to nothing, and droid
    // refuses it. That reads as invariant 1 broken, so the empty list is caught
    // here with a reason a person can act on.
    if (tools.length === 0) {
      throw new Error(`step "${request.step}" declares no tools, and droid cannot bound a step to none. Declare a tool, or name another harness.`);
    }
    // `validate()` reads the same row, so a flow that names its harness hears
    // this before the run starts.
    if (request.model && !MODELS.droid.reads.test(request.model)) {
      throw new Error(`droid wants a plain model id, not "${request.model}"`);
    }

    const args = [
      "exec",
      "--output-format",
      "json",
      // Invariant 1: the list bounds what exists. `--restrict-tools` holds the
      // step to these names and nothing else, so the `Skill` tool and the
      // `Task` tool, the subagent door, are both shut — `--enabled-tools` left
      // `Task` open above the list under `--auto high`. Droid refuses a name it
      // does not know, so nothing here is dropped in silence.
      "--restrict-tools",
      tools.join(","),
      // No one sits at the keyboard of a step, so nothing may stop to ask.
      // The tool list is the boundary; the level approves what the list holds.
      "--auto",
      "high",
      "--append-system-prompt",
      contract(request.returns),
      ...(request.model ? ["--model", request.model] : []),
    ];

    // Droid names its session only at the end, so while it runs the record is
    // found, not asked for: the first session of this directory that is new
    // since the step started, and whose first line opens with this prompt.
    const before = known(request.cwd);
    const stop = watch ? tail(() => appeared(request.cwd, before, request.prompt), (line) => report(line, watch)) : undefined;

    try {
      const answer = await exec([...args, request.prompt], request);
      // A session continues only under a Factory login, so no reminder can ride
      // the same session, the way pi sends one. The value is read out of the
      // answer instead, prose around it or not, and the runner still checks it.
      const value = valueOf(answer.result);
      if (value === undefined) {
        const said = (answer.result ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
        throw spent(
          new Error(
            `step "${request.step}" ended without a JSON value.${said ? ` The model answered in prose instead: "${said}".` : ""} Give the step a cycle on "failed", or name a model that answers in JSON.`,
          ),
          answer.session_id,
        );
      }
      // Ollama Cloud carries no price and droid writes no dollars, so the step
      // reports no cost, and a budget refuses the flow. See ADR 0019.
      return { value, trajectory: answer.session_id };
    } finally {
      stop?.();
    }
  },

  /** The handle is a session id. Droid writes the session under its own directory. */
  toTrajectory(sessionId, trajectoryId, version) {
    const path = findSession(sessionId);
    if (!path) return undefined;

    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      return undefined;
    }

    const steps: Step[] = [];
    for (const line of lines) {
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        continue;
      }
      const step = toStep(entry, steps.length + 1);
      if (step) steps.push(step);
    }

    // Droid writes no usage into the session, and no model. Both sit in the
    // settings file beside it, as one total for the whole step.
    const settings = settingsOf(path);
    return {
      schema_version: SCHEMA_VERSION,
      trajectory_id: trajectoryId,
      session_id: trajectoryId,
      agent: { name: "droid", version, model_name: settings.model },
      steps,
      final_metrics: { ...settings.metrics, total_steps: steps.length },
    };
  },
};

/** One start of the command. A command that ends badly says why on its own streams. */
async function exec(args: string[], request: AgentRequest): Promise<Answer> {
  let stdout: string;
  try {
    const command = run("droid", args, { cwd: request.cwd, maxBuffer: 64 * 1024 * 1024, env: environmentOf(request) });
    // The command reads its input stream, and Orchy writes nothing to it.
    command.child.stdin?.end();
    ({ stdout } = await command);
  } catch (error) {
    const held = error as { stderr?: string; stdout?: string; code?: number };
    const why = (held.stderr ?? "").trim() || (held.stdout ?? "").trim().slice(0, 300) || `it ended with the code ${held.code ?? "unknown"}`;
    throw spent(
      new Error(`step "${request.step}" could not run the droid command: ${why.split("\n").slice(0, 3).join(" ").slice(0, 300)}`),
      sessionOf(held.stdout),
    );
  }

  let answer: Answer;
  try {
    answer = JSON.parse(stdout) as Answer;
  } catch {
    throw new Error(`the droid command answered something that is not JSON: ${stdout.trim().slice(0, 300)}`);
  }
  if (answer.is_error || answer.subtype !== "success") {
    throw spent(
      new Error(`step "${request.step}" ended as ${answer.subtype ?? "an error"}: ${String(answer.result).slice(0, 300)}`),
      answer.session_id,
    );
  }
  return answer;
}

/** The record of a step that failed rides on the error, as with claude. */
function spent(error: Error, trajectory: string | undefined): Error {
  return Object.assign(error, trajectory ? { trajectory } : {});
}

/** The session id inside an answer, when the command wrote one before it failed. */
function sessionOf(stdout: string | undefined): string | undefined {
  try {
    return (JSON.parse(stdout ?? "") as Answer).session_id;
  } catch {
    return undefined;
  }
}

/**
 * The JSON value inside what the model said, or nothing when there is none. A
 * model that fences its answer, or that says a sentence and then the value, has
 * still answered, so the value comes out of either. A bare word or number must
 * stand alone: pulling one out of a sentence would guess. The runner checks
 * the value against the contract either way.
 */
function valueOf(result: string | undefined): unknown {
  const whole = (result ?? "").trim();
  if (!whole) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```\s*$/.exec(whole)?.[1]?.trim() ?? whole;
  try {
    return JSON.parse(fenced);
  } catch {
    return lastValue(fenced);
  }
}

/** The last whole JSON object or array in a text, read from the rightmost start. */
function lastValue(text: string): unknown {
  for (let at = text.length - 1; at >= 0; at--) {
    if (text[at] !== "{" && text[at] !== "[") continue;
    try {
      return JSON.parse(text.slice(at, text.length));
    } catch {
      // Not the start of the value. The next brace to the left may be.
    }
  }
  return undefined;
}

/** Droid folds a working directory into one name, and this is the fold. */
function directoryOf(cwd: string): string {
  return join(SESSIONS, cwd.replaceAll("/", "-"));
}

/** The sessions that already exist, so a new one is told apart from them. */
function known(cwd: string): Set<string> {
  try {
    return new Set(readdirSync(directoryOf(cwd)));
  } catch {
    return new Set();
  }
}

/**
 * The session file of this step, once it appears. The first line of a session
 * names the prompt as its title, so two steps that share one directory do not
 * read each other. The answer at the end names the session either way.
 */
function appeared(cwd: string, before: Set<string>, prompt: string): string | undefined {
  const directory = directoryOf(cwd);
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch {
    return undefined;
  }
  for (const file of files) {
    if (!file.endsWith(".jsonl") || before.has(file)) continue;
    const path = join(directory, file);
    const title = titleOf(path);
    if (title !== undefined && opens(prompt, title)) return path;
  }
  return undefined;
}

/** Droid titles a session with the head of its prompt, cut with an ellipsis. */
function opens(prompt: string, title: string): boolean {
  const head = title.replace(/\s*(\.\.\.|…)$/, "");
  return flat(prompt).startsWith(flat(head));
}

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The title of a session, or nothing when its first line is not whole yet. */
function titleOf(path: string): string | undefined {
  try {
    const first = readFileSync(path, "utf8").split("\n")[0] ?? "";
    const entry = JSON.parse(first) as { type?: string; title?: string };
    return entry.type === "session_start" ? (entry.title ?? "") : undefined;
  } catch {
    return undefined;
  }
}

function findSession(sessionId: string): string | undefined {
  let directories: string[];
  try {
    directories = readdirSync(SESSIONS);
  } catch {
    return undefined;
  }
  for (const directory of directories) {
    const path = join(SESSIONS, directory, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** What the settings file beside a session says the step was and spent. */
function settingsOf(path: string): { model: string; metrics: Metrics } {
  try {
    const settings = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".settings.json"), "utf8")) as {
      model?: string;
      tokenUsage?: { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number; cacheReadTokens?: number };
    };
    const usage = settings.tokenUsage;
    return {
      model: settings.model ?? "unknown",
      metrics: {
        // A cache write is an input token that a person paid for, as in claude.
        prompt_tokens: (usage?.inputTokens ?? 0) + (usage?.cacheCreationTokens ?? 0),
        completion_tokens: usage?.outputTokens ?? 0,
        cached_tokens: usage?.cacheReadTokens ?? 0,
      },
    };
  } catch {
    return { model: "unknown", metrics: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 } };
  }
}

/** One line of the session, as notes. A line that says nothing reports nothing. */
function report(line: string, watch: Watch): void {
  let entry: Entry;
  try {
    entry = JSON.parse(line) as Entry;
  } catch {
    return;
  }
  const step = toStep(entry, 0);
  if (step) for (const note of notesOf(step)) watch(note);
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
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Block[];
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
  if (entry.type !== "message") return undefined;
  const message = entry.message;
  if (!message?.role) return undefined;
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
    // Droid keeps no usage in its session, so a per-step zero would read as
    // free. The settings file carries the one total, on `final_metrics`.
  };
}
