import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Daemon, Ticket } from "./daemon.ts";
import { type AgentStep, COMPONENTS, type Flow, validate } from "./flow.ts";
import { ADAPTERS, MODELS, SUPPLIES, TOOLS } from "./harness.ts";
import { readFlow } from "./load.ts";
import { lines } from "./memory.ts";
import { read } from "./run.ts";
import { descriptionOf, harnessInFile, harnessOfRun, missing, start, under, unfilled } from "./server.ts";
import { parseFlow } from "./yaml.ts";

const VERSION = String(createRequire(import.meta.url)("../package.json").version);

/**
 * ADR 0024: the door speaks the part of the protocol that tools need —
 * `initialize`, `tools/list`, `tools/call` — as JSON-RPC 2.0, one message for
 * one line. That is small enough to write here, so the door adds no dependency.
 */
const PROTOCOL = "2025-06-18";

/**
 * How deep a chain of runs goes: a run, a run its step starts, and one more.
 * ADR 0025: the budget bounds one run and not its children, so the depth is
 * what bounds the chain, the way a limit bounds a cycle. This is a constant,
 * not a setting: a flow that wants more depth holds a `flow` step instead,
 * which expands into its parent and spends the parent's budget.
 */
const DEEP = 3;

/** How long `read_run` may hold its answer while the run works, in seconds. */
const PATIENCE = 55;

/**
 * What an agent reads before it writes a flow. The tool names, the harness
 * names, and the model grammar come from the tables in `harness.ts`, the same
 * way `GET /api/health` serves the editor, so no copy here falls behind. The
 * guide holds no rule: `validate()` still refuses.
 *
 * A client shows the first 2048 characters and cuts the rest — a tryout read
 * a guide that ended mid-word — so the guide stays under that, with room for
 * a long root path, and a root too long to fit is pointed at instead of
 * named. A test holds both.
 */
const guideFor = (root: string): string => {
  const whole = guideAt(root);
  if (whole.length < 2040) return whole;
  return guideAt("the directory this server started in — every path of list_flows names it in full");
};

const guideAt = (root: string): string => `Orchy runs agent flows declared as YAML: it runs the steps, enforces the
rules, and records what each step did.

The loop: draft the flow, hear every problem from check_flow, write it with
write_flow, start it with run_flow, and poll read_run until the status is
done, failed, or waiting. A waiting run holds a question; answer it with
resume_run. Agent steps spend money; "budget" (dollars) bounds one run.

The root is ${root}. A flow path is relative to it; a prompt path and a
module path, to the flow file.

A flow:

name: triage
harness: claude
takes: { type: object, properties: { issue: { type: number } } }
steps:
  - id: code
    kind: agent
    prompt: prompts/code.md
    tools: [read, edit, grep]
    returns: { type: object, properties: { summary: { type: string } } }
  - id: check
    kind: call
    needs: [code]
    module: check.ts
    returns: { type: object, properties: { ok: { type: boolean } } }
  - id: approve
    kind: gate
    needs: [check]
    question: Ship the change?
    returns: { type: string, enum: [yes, no] }

"flow", a fourth kind, holds another flow file. The value of a step must
match its "returns" schema.

A call step holds "module" — a TypeScript default export (inputs, say,
values) => value — or "command": any program. It takes { values, steps } as
JSON on stdin, answers JSON on stdout, and fails with a code that is not 0.

{{ issue }} in a prompt or a gate question reads what the run takes, never a
step value. A name nothing supplies fails the step when it runs.

Agent tools: ${TOOLS.join(", ")}. Harnesses:
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
  startedBy?: { runId: string; step: string },
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

  /**
   * The store this door may reach: the one of the run whose step opened it. The
   * key comes from the state of that run on disk, and never from the call, so a
   * step cannot name the store of another ticket, another flow, or another
   * user. That is the whole of the isolation, and it costs no check. ADR 0028.
   */
  const mine = (): { key: string; step: string; runId: string } => {
    if (!startedBy) {
      throw new Error(
        "this door was not opened by a step of a run, so it has no memory of its own. A memory belongs to a run.",
      );
    }
    const state = daemon.state(startedBy.runId);
    if (!state) throw new Error(`this daemon holds no run ${startedBy.runId}`);
    const step = state.flow.steps.find((one) => one.id === startedBy.step);
    if ((step as AgentStep | undefined)?.memory === "none") {
      throw new Error(`the step "${startedBy.step}" declares memory: none, so it reads and writes no memory.`);
    }
    if (!state.memory) {
      throw new Error(
        `the flow "${state.flow.name}" declares no memory, so there is nothing to read and nowhere to write. Give the flow a scope, as memory: { scope: "flow" }.`,
      );
    }
    return { key: state.memory.key, step: startedBy.step, runId: startedBy.runId };
  };

  const tools: Tool[] = [
    {
      name: "check_flow",
      description: `Says what is wrong with a flow, given as YAML text. Empty lists mean the flow is valid. It runs nothing and spends nothing. The call components Orchy ships: ${COMPONENTS.map((name) => `orchy:${name}`).join(", ")}.`,
      inputSchema: {
        type: "object",
        required: ["yaml"],
        properties: {
          yaml: { type: "string", description: "The flow, as YAML text." },
          prompts: {
            type: "object",
            description: "Prompt texts to check before they are written, each key a path relative to the flow file.",
            additionalProperties: { type: "string" },
          },
        },
      },
      handle(args) {
        try {
          const flow = parseFlow(String(args.yaml ?? ""));
          // A prompt given here stands in for its file, so a hole in one is
          // heard before anything is written. The write reads the files too.
          return {
            problems: validate(flow, harness),
            warnings: unfilled(flow, undefined, args.prompts as Record<string, string> | undefined),
          };
        } catch (error) {
          return { problems: [error instanceof Error ? error.message : String(error)], warnings: [] };
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
        // Every path is checked before anything is written, so a refusal
        // leaves no file behind it.
        const prompts = Object.entries((args.prompts ?? {}) as Record<string, unknown>).map(
          ([name, text]) => [within(resolve(dirname(path), name)), text] as const,
        );
        for (const [at, text] of prompts) {
          mkdirSync(dirname(at), { recursive: true });
          writeFileSync(at, String(text));
        }
        mkdirSync(dirname(path), { recursive: true });
        // The text as given, not a reprint: the leading comment of the file is
        // the description of the flow, and a reprint drops every comment.
        writeFileSync(path, String(args.yaml));
        const own = typeof flow.harness === "string" && flow.harness !== "" ? flow.harness : harness;
        return {
          flow: daemon.store.addFlow(path, flow.name, own),
          warnings: [...missing(flow, path), ...unfilled(flow, path)],
        };
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
        // ADR 0025: the budget bounds one run and not its children, so the
        // depth bounds the chain, and it stops here, where the chain grows.
        if (startedBy && deepOf(root, startedBy) >= DEEP) {
          throw new Error(
            `the run ${startedBy.runId} stands ${DEEP} runs deep, and a chain of runs stops at ${DEEP}. Use a "flow" step for work that runs inside this run.`,
          );
        }
        // ADR 0027: the flow declares what its step may start, and the door
        // reads the bound from the state on disk, not from the model.
        const bound = startedBy && boundOf(root, startedBy);
        if (bound?.flows && !bound.flows.includes(path)) {
          throw new Error(
            `the step "${startedBy?.step}" starts only: ${bound.flows.join(", ")}. This flow is not one of them.`,
          );
        }
        if (bound?.most !== undefined && startedBy) {
          const already = childrenOf(daemon, startedBy.runId).filter((one) => one.step === startedBy.step).length;
          if (already >= bound.most) {
            throw new Error(
              `the step "${startedBy.step}" starts at most ${bound.most} run${bound.most === 1 ? "" : "s"}, and it has started ${already}. Every run counts, including one that failed.`,
            );
          }
        }
        const row =
          daemon.store.flowAt(path) ??
          daemon.store.addFlow(path, (await readFlow(path)).name || path, harnessInFile(path) ?? harness);
        const ticket = await start(daemon, row, args.with as Record<string, unknown> | undefined, undefined, startedBy);
        return started(daemon, ticket);
      },
    },

    {
      name: "read_run",
      description:
        "Reads a run: its status, the record of every step, its value, the runs its steps started, and — when it waits at a gate — the question to answer with resume_run. `row` is the one-line summary the index holds; `state` is the run itself, from disk. `wait` holds the answer up to that many seconds while the run works, so a poll costs fewer turns.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          wait: { type: "number", description: `Seconds to hold the answer while the run works. At most ${PATIENCE}.` },
        },
      },
      async handle(args) {
        const runId = String(args.runId ?? "");
        let state = daemon.state(runId);
        if (!state) throw new Error(`there is no run ${runId}`);
        // A bounded hold, not a wait for the end: the answer says where the
        // run stands when the time is up, and the agent reads again.
        const until = Date.now() + Math.min(Math.max(Number(args.wait) || 0, 0), PATIENCE) * 1000;
        while (state.status === "running" && Date.now() < until) {
          await new Promise((rest) => setTimeout(rest, 500));
          state = daemon.state(runId) ?? state;
        }
        // No catchUp here: it writes the row from disk before the job of the
        // run settles, and an answer given at that moment used to be refused
        // with "already on its way". The row waits for the daemon to say so.
        return { row: daemon.store.run(runId) ?? null, state, children: childrenOf(daemon, runId) };
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
        const ticket = daemon.resume(runId, value, harnessOfRun(daemon, runId), from, step);
        return resumed(daemon, ticket, runId);
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

    {
      name: "recall_memory",
      description:
        "Reads what earlier runs recorded in the memory of this run. The scope belongs to the flow, so this reads that store and no other: there is no way to name another one. `query` keeps the entries whose text or tags hold it. The seed at the top of the prompt holds the most recent entries already; call this to look past it, or when the turn has grown long enough to have lost it.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keeps the entries whose text or tags hold this, in any case." },
          limit: { type: "number", description: "How many of the most recent entries to answer with. Twenty when absent." },
        },
      },
      handle(args) {
        const { key } = mine();
        const query = String(args.query ?? "").trim().toLowerCase();
        const all = lines(root).recall(key);
        const found = query
          ? all.filter((entry) => `${entry.text} ${(entry.tags ?? []).join(" ")}`.toLowerCase().includes(query))
          : all;
        const limit = Number.isInteger(args.limit) && Number(args.limit) > 0 ? Number(args.limit) : 20;
        return { scope: key, entries: found.slice(-limit), of: all.length };
      },
    },

    {
      name: "remember",
      description:
        "Records one thing in the memory of this run, for the runs that come after it. Write what a later run could not work out for itself: a decision and why, a dead end, where something lives. The entry names this run and this step, so a wrong one is found and dropped. A flow that declares no memory records nothing, and says so.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "What to record, in a sentence or two." },
          tags: { type: "array", items: { type: "string" }, description: "Words that recall_memory reads back." },
        },
      },
      handle(args) {
        const { key, step, runId } = mine();
        const text = String(args.text ?? "").trim();
        if (!text) throw new Error("a memory holds no text. Write what a later run should know.");
        const tags = Array.isArray(args.tags) ? args.tags.map((one) => String(one)) : undefined;
        const entry = lines(root).remember(key, { run: runId, step, text, ...(tags ? { tags } : {}) });
        return { scope: key, entry };
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
          instructions: guideFor(root),
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

/**
 * How many runs stand above this one, counting it. The chain is read from the
 * states on disk, because the state is the run (ADR 0005). A chain that comes
 * back to itself, or breaks, counts what it reached.
 */
function deepOf(root: string, startedBy: { runId: string; step: string }): number {
  const seen = new Set<string>();
  let at: string | undefined = startedBy.runId;
  while (at && !seen.has(at)) {
    seen.add(at);
    try {
      at = read(root, at).startedBy?.runId;
    } catch {
      at = undefined;
    }
  }
  return seen.size;
}

/**
 * The ticket of a resume, once the child took the work or refused it. A
 * refusal the child wrote — a step "--from" does not name, a contract the
 * details broke — left its reason in the queue alone, and an agent that
 * follows a resume with read_run never reads the queue. So the reason
 * answers the resume itself. A resume that was taken keeps working, and the
 * wait ends when the run moves or the patience does.
 */
function resumed(daemon: Daemon, ticket: Ticket, runId: string): Promise<Ticket> {
  const was = daemon.store.run(runId)?.status;
  return new Promise((done, refuse) => {
    const finish = () => {
      stop();
      clearTimeout(patience);
    };
    const look = () => {
      const held = daemon.pending().find((one) => one.ticket === ticket.ticket);
      if (held?.error) {
        finish();
        return refuse(new Error(held.error));
      }
      // The run moved, or the job finished without a reason: the resume took.
      if (daemon.store.run(runId)?.status !== was || (!held && ticket.runId)) {
        finish();
        done(held ?? ticket);
      }
    };
    const stop = daemon.watch(() => look());
    const patience = setTimeout(() => {
      stop();
      done(daemon.pending().find((one) => one.ticket === ticket.ticket) ?? ticket);
    }, 15_000);
    look();
  });
}

/**
 * The bound of the step that asked, read from the state of its run. The flow
 * in that state already went through `validate()` and `resolvePaths`, so the
 * bound is well formed and its flow paths are absolute. ADR 0027.
 */
function boundOf(root: string, startedBy: { runId: string; step: string }): { flows?: string[]; most?: number } | undefined {
  try {
    const step = read(root, startedBy.runId).flow.steps.find((one) => one.id === startedBy.step);
    return step?.kind === "agent" ? step.starts : undefined;
  } catch {
    return undefined;
  }
}

/** The runs the steps of this run started, every one, read from the index. */
function childrenOf(daemon: Daemon, runId: string): Array<{ runId: string; step: string; status: string; cost: number | null }> {
  return daemon.store.children(runId).map((one) => ({
    runId: one.runId,
    step: (JSON.parse(one.startedByJson as string) as { step: string }).step,
    status: one.status,
    cost: one.cost,
  }));
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
