import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Daemon, Ticket } from "./daemon.ts";
import { type Flow, validate } from "./flow.ts";
import { ADAPTERS, MODELS, SUPPLIES, TOOLS } from "./harness.ts";
import { readFlow } from "./load.ts";
import { descriptionOf, harnessInFile, harnessOfRun, missing, start, under } from "./server.ts";
import { parseFlow } from "./yaml.ts";

const VERSION = String(createRequire(import.meta.url)("../package.json").version);

/**
 * ADR 0024: the door speaks the part of the protocol that tools need —
 * `initialize`, `tools/list`, `tools/call` — as JSON-RPC 2.0, one message for
 * one line. That is small enough to write here, so the door adds no dependency.
 */
const PROTOCOL = "2025-06-18";

/**
 * What an agent reads before it writes a flow. The tool names, the harness
 * names, and the model grammar come from the tables in `harness.ts`, the same
 * way `GET /api/health` serves the editor, so no copy here falls behind. The
 * guide holds no rule: `validate()` still refuses.
 */
const GUIDE = `Orchy runs agent flows. A flow declares steps and rules as YAML. Orchy runs
the steps, enforces the rules, and records what each step did.

The loop: write the flow as YAML, hear every problem from check_flow, correct
it, write it with write_flow, start it with run_flow, and follow it with
read_run. A run that waits at a gate holds a question; answer it with
resume_run. A run of agent steps spends money, and the "budget" of the flow
(in dollars) bounds one run.

A flow file looks like this:

  name: code-and-review
  harness: claude
  budget: 5
  takes:
    type: object
    required: [issue]
    properties: { issue: { type: number } }
  steps:
    - id: code
      kind: agent
      prompt: prompts/code.md
      tools: [read, edit, grep]
      returns:
        type: object
        required: [summary]
        properties: { summary: { type: string } }

A step is one of four kinds. "agent" runs a model with a prompt file and a
tool list. "call" runs a TypeScript module. "gate" stops the run and asks a
person. "flow" holds another flow file. A step names the steps before it in
"needs". "returns" is JSON Schema, and the value of the step must match it.
Two more steps, after the agent step above:

    - id: check
      kind: call
      needs: [code]
      module: check.ts
      returns:
        type: object
        required: [ok]
        properties: { ok: { type: boolean } }
    - id: approve
      kind: gate
      needs: [check]
      question: Ship the change?
      returns: { type: string, enum: [yes, no] }

A "call" module is TypeScript with one default export:

  export default (inputs, say, values) => ({ ok: true })

"inputs" holds the values of the steps it needs, by step id. "say" reports a
line while the module works. "values" holds what the run takes. A name in
braces, as {{ issue }}, reads the values of the run: in a prompt file and in
the question of a gate. The values of earlier steps reach an agent prompt as
an appended block and a call module as "inputs" — a brace name does not read
them. A name that nothing supplies fails the step when it runs.

A flow path is relative to the root. A prompt path and a module path are
relative to the flow file. "budget" bounds what the agent steps of a run
spend; a flow with no agent step needs none. The tools an agent step can
declare: ${TOOLS.join(", ")}. The harnesses:
${ADAPTERS.map((name) => `- "${name}" supplies ${SUPPLIES[name].join(", ")}. ${MODELS[name].write}`).join("\n")}`;

interface Message {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** A fault of the protocol, not of a tool. It answers as a JSON-RPC error. */
class Refusal extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handle(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/**
 * Serves the Model Context Protocol over `input` and `output`, against the
 * daemon. The door is like the HTTP one: it translates a call to the daemon
 * and to the flow helpers, and it adds no rule about a flow. `harness` is
 * what a flow that names none runs on, as at the command line.
 */
export function mcp(
  daemon: Daemon,
  harness = "pi",
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const root = resolve(daemon.root);

  /** The one rule of the daemon, at this door too: a path stays under the root. */
  const within = (given: string): string => {
    const path = resolve(root, given);
    if (!under(root, path)) {
      throw new Error(`the file at "${path}" is outside the root "${root}". Use a path under the root.`);
    }
    return path;
  };

  const tools: Tool[] = [
    {
      name: "check_flow",
      description:
        "Says what is wrong with a flow, given as YAML text. An empty list means the flow is valid. It runs nothing and spends nothing.",
      inputSchema: {
        type: "object",
        required: ["yaml"],
        properties: { yaml: { type: "string", description: "The flow, as YAML text." } },
      },
      handle(args) {
        try {
          return { problems: validate(parseFlow(String(args.yaml ?? "")), harness) };
        } catch (error) {
          return { problems: [error instanceof Error ? error.message : String(error)] };
        }
      },
    },

    {
      name: "write_flow",
      description:
        "Writes a flow file and its prompt files under the root, and registers the flow. It refuses a flow that does not validate, and its answer names every problem. A warning names a file the flow needs and does not have yet.",
      inputSchema: {
        type: "object",
        required: ["path", "yaml"],
        properties: {
          path: { type: "string", description: "Where the flow file goes, relative to the root. Ends with .yaml." },
          yaml: { type: "string", description: "The flow, as YAML text. A leading comment becomes its description." },
          prompts: {
            type: "object",
            description: "Prompt files to write beside the flow, each path relative to the flow file.",
            additionalProperties: { type: "string" },
          },
        },
      },
      handle(args) {
        const path = within(String(args.path ?? ""));
        if (!/\.ya?ml$/.test(path)) throw new Error("a flow is a YAML file, so its path ends with .yaml");
        const flow = parseFlow(String(args.yaml ?? ""), path);
        const problems = validate(flow, harness);
        if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);
        for (const [name, text] of Object.entries((args.prompts ?? {}) as Record<string, unknown>)) {
          const at = within(resolve(dirname(path), name));
          mkdirSync(dirname(at), { recursive: true });
          writeFileSync(at, String(text));
        }
        mkdirSync(dirname(path), { recursive: true });
        // The text as given, not a reprint: the leading comment of the file is
        // the description of the flow, and a reprint drops every comment.
        writeFileSync(path, String(args.yaml));
        const own = typeof flow.harness === "string" && flow.harness !== "" ? flow.harness : harness;
        return { flow: daemon.store.addFlow(path, flow.name, own), warnings: missing(flow, path) };
      },
    },

    {
      name: "read_flow",
      description: "Reads a flow file, and every file its steps name that is there: a prompt, a module, an inner flow.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string", description: "The flow file, relative to the root." } },
      },
      handle(args) {
        const path = within(String(args.path ?? ""));
        if (!existsSync(path)) throw new Error(`there is no flow file at "${path}"`);
        const yaml = readFileSync(path, "utf8");
        return { path, yaml, files: /\.ya?ml$/.test(path) ? filesOf(parseFlow(yaml, path), path) : {} };
      },
    },

    {
      name: "list_flows",
      description: "Lists every registered flow: its path, its harness, its description, and its last run.",
      inputSchema: { type: "object", properties: {} },
      handle() {
        daemon.catchUp();
        const runs = daemon.store.runs();
        return daemon.store.flows().map((row) => ({
          ...row,
          harness: harnessInFile(row.path) ?? row.harness,
          description: descriptionOf(row.path),
          lastRun: runs.find((run) => run.path === row.path) ?? null,
        }));
      },
    },

    {
      name: "run_flow",
      description:
        "Queues a run of a flow and answers with its ticket, and with its run id once the run starts. The values in `with` are what the flow takes. A run of agent steps spends money.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "The flow file, relative to the root." },
          with: { type: "object", description: "The values the flow takes, as one object." },
        },
      },
      async handle(args) {
        const path = within(String(args.path ?? ""));
        if (!existsSync(path)) {
          throw new Error(`there is no flow file at "${path}". Write it with write_flow, or pick one from list_flows.`);
        }
        const row =
          daemon.store.flowAt(path) ??
          daemon.store.addFlow(path, (await readFlow(path)).name || path, harnessInFile(path) ?? harness);
        const ticket = await start(daemon, row, args.with as Record<string, unknown> | undefined);
        return started(daemon, ticket);
      },
    },

    {
      name: "read_run",
      description:
        "Reads a run: its status, the record of every step, its value, and — when it waits at a gate — the question to answer with resume_run.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
      },
      handle(args) {
        const runId = String(args.runId ?? "");
        const state = daemon.state(runId);
        if (!state) throw new Error(`there is no run ${runId}`);
        return { row: daemon.store.run(runId) ?? null, state };
      },
    },

    {
      name: "read_trajectory",
      description: "Reads the trajectory of a run: the whole record of what every step did and said.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
      },
      handle(args) {
        const trajectory = daemon.trajectory(String(args.runId ?? ""));
        if (!trajectory) throw new Error(`the run ${String(args.runId)} has written no trajectory yet`);
        return trajectory;
      },
    },

    {
      name: "list_runs",
      description: "Lists the queue and every run the index holds, newest first.",
      inputSchema: { type: "object", properties: {} },
      handle() {
        daemon.catchUp();
        return { queue: daemon.pending(), runs: daemon.store.runs() };
      },
    },

    {
      name: "resume_run",
      description:
        "Continues a run. `value` answers the gate of a waiting run, and the contract of the gate checks it here, at the door. `from` names a step of an ended run to go back to.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          value: {
            type: "string",
            description:
              'The value that answers the gate, as JSON text: true, 42, "yes", or {"approved":true}. It must match the contract of the gate.',
          },
          from: { type: "string", description: "The step to go back to. Every step after it runs again." },
          step: {
            type: "string",
            description:
              "The gate this answer was written for. A run that has moved on to another gate then refuses it, instead of taking it for a question the answerer never read.",
          },
        },
      },
      handle(args) {
        const runId = String(args.runId ?? "");
        // The answer crosses the protocol as JSON text, as it does at the
        // command line, so a boolean stays a boolean. A client that sends the
        // value itself is read as it is.
        let value: unknown = args.value;
        if (typeof value === "string") {
          try {
            value = JSON.parse(value);
          } catch {
            throw new Error(
              `the answer holds ${String(args.value)}, which is not JSON. Write the value as JSON text, such as '"yes"' or 'true'.`,
            );
          }
        }
        const from = typeof args.from === "string" && args.from !== "" ? args.from : undefined;
        const step = typeof args.step === "string" && args.step !== "" ? args.step : undefined;
        return daemon.resume(runId, value, harnessOfRun(daemon, runId), from, step);
      },
    },

    {
      name: "stop_run",
      description: "Stops a run where it stands. The state on disk keeps what it reached.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
      },
      handle(args) {
        const runId = String(args.runId ?? "");
        if (daemon.stop(runId)) return { stopped: true };
        if (daemon.abandon(runId)) return { stopped: true, abandoned: true };
        const row = daemon.store.run(runId);
        throw new Error(
          row ? `the run is already ${row.status}, so there is nothing to stop` : `this daemon holds no run ${runId}`,
        );
      },
    },
  ];

  const write = (message: Record<string, unknown>) => void output.write(`${JSON.stringify(message)}\n`);

  const handle = async (message: Message): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "orchy", version: VERSION },
          instructions: GUIDE,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call": {
        const tool = tools.find((one) => one.name === String(params.name ?? ""));
        if (!tool) throw new Refusal(-32602, `there is no tool "${String(params.name)}"`);
        // A tool that refuses answers as a result, not as a protocol error, so
        // the agent reads the reason and writes again.
        try {
          const value = await tool.handle((params.arguments ?? {}) as Record<string, unknown>);
          return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      }
      default:
        throw new Refusal(-32601, `this server has no method "${String(message.method)}"`);
    }
  };

  const take = async (line: string) => {
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "the line is not JSON" } });
    }
    // A notification asks for no answer, and this server acts on none of them.
    if (message.method?.startsWith("notifications/")) return;
    try {
      const result = await handle(message);
      if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      if (message.id === undefined) return;
      const code = error instanceof Refusal ? error.code : -32603;
      const said = error instanceof Error ? error.message : String(error);
      write({ jsonrpc: "2.0", id: message.id, error: { code, message: said } });
    }
  };

  // One message for one line, so a partial line waits here, as in the daemon.
  let rest = "";
  input.on("data", (chunk: Buffer) => {
    const parts = `${rest}${chunk.toString()}`.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) if (line.trim()) void take(line);
  });
}

/**
 * The ticket, once it holds a run id or a reason. The daemon deletes the job
 * of a run that ends well, so the watch starts before any event can pass, and
 * a queue that holds the run back — every slot taken — answers with the bare
 * ticket instead of holding the answer with it. The agent then reads the
 * queue with list_runs.
 */
function started(daemon: Daemon, ticket: Ticket): Promise<Ticket> {
  return new Promise((done) => {
    const answer = (held: Ticket) => {
      stop();
      clearTimeout(patience);
      done(held);
    };
    const look = () => {
      const held = daemon.pending().find((one) => one.ticket === ticket.ticket);
      if (held && (held.runId || held.error)) answer(held);
    };
    const stop = daemon.watch((notice) => {
      if (notice.kind === "queue") look();
    });
    const patience = setTimeout(() => {
      stop();
      done(daemon.pending().find((one) => one.ticket === ticket.ticket) ?? ticket);
    }, 15_000);
    look();
  });
}

/** The files a flow names that are there, each under the path the flow uses for it. */
function filesOf(flow: Flow, flowPath: string): Record<string, string> {
  const base = dirname(flowPath);
  const files: Record<string, string> = {};
  const keep = (path?: string) => {
    if (!path || files[path] !== undefined) return;
    const at = resolve(base, path);
    if (existsSync(at)) files[path] = readFileSync(at, "utf8");
  };
  // The union of step kinds narrows each field away; this read takes them loosely.
  type Named = { prompt?: string; module?: string; flow?: string; fanout?: unknown };
  for (const step of (flow.steps ?? []) as unknown as Named[]) {
    keep(step.prompt);
    keep(step.module);
    keep(step.flow);
    if (Array.isArray(step.fanout)) {
      for (const member of step.fanout as Array<{ prompt?: string; module?: string }>) {
        keep(member.prompt);
        keep(member.module);
      }
    }
  }
  return files;
}
