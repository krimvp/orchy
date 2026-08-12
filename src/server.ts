import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Daemon } from "./daemon.ts";
import { type Flow, OPERATORS, type Step, validate } from "./flow.ts";
import { ADAPTERS, MODELS, TOOLS } from "./harness.ts";
import { loadFlow, readFlow } from "./load.ts";
import { formatFlow, parseFlow } from "./yaml.ts";

const UI = resolve(import.meta.dirname, "..", "ui", "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

type Params = Record<string, string>;
type Handler = (
  parameters: Params,
  body: Record<string, unknown>,
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<unknown> | unknown;

/** Marks a handler that answered by itself, such as one that streams events. */
const HELD = Symbol("held");

export function serve(daemon: Daemon, port: number, host = "127.0.0.1"): Promise<Server> {
  const routes: Array<[string, string, Handler]> = [
    // The editor draws the tool list, the harness list, and the operators from
    // here, so it never holds a copy that falls behind the runner. An operator
    // gives its name and what it reads, which is what a control needs. What it
    // refuses stays in `validate()`, which is the one gate.
    [
      "GET",
      "/api/health",
      () => ({
        root: daemon.root,
        adapters: ADAPTERS,
        tools: TOOLS,
        operators: OPERATORS.map(({ name, reads }) => ({ name, reads })),
        // What a model name looks like for each harness, so the editor hints
        // instead of leaving a free field to guesswork.
        models: Object.fromEntries(ADAPTERS.map((name) => [name, MODELS[name].write])),
      }),
    ],

    // Each row carries what a person needs to choose a flow: the one-line
    // description its file starts with, what its last run cost, and whether
    // it runs by itself.
    [
      "GET",
      "/api/flows",
      () => {
        daemon.catchUp();
        const runs = daemon.store.runs();
        return daemon.store.flows().map((row) => {
          const schedule = daemon.store.schedule(row.id);
          return {
            ...row,
            // The file has the last word on the harness, and the row is only
            // what a step that names none falls back to. The list showed the
            // row, so every flow that wrote `harness: claude` read as `pi`.
            harness: harnessInFile(row.path) ?? row.harness,
            description: descriptionOf(row.path),
            lastRun: runs.find((run) => run.path === row.path) ?? null,
            schedule: schedule ? { everyMinutes: schedule.everyMinutes, lastAt: schedule.lastAt } : null,
            hook: daemon.store.hook(row.id) ?? null,
          };
        });
      },
    ],

    // A webhook starts the flow from a POST. The token is the whole door: a
    // person makes it here, and the URL that holds it starts the run.
    [
      "PUT",
      "/api/flows/:id/hook",
      (parameters) => {
        const row = flowRow(daemon, parameters.id as string);
        const token = daemon.store.hook(row.id) ?? randomUUID();
        daemon.store.setHook(row.id, token);
        return { token };
      },
    ],

    [
      "DELETE",
      "/api/flows/:id/hook",
      (parameters) => {
        daemon.store.clearHook(Number(parameters.id));
        return { removed: true };
      },
    ],

    // The body of the POST is the values the flow takes. A body a flow does
    // not take fails the start, and the queue keeps the reason.
    [
      "POST",
      "/api/hooks/:token",
      async (parameters, body) => {
        const flowId = daemon.store.hooked(parameters.token as string);
        if (flowId === undefined) throw new Error("no hook holds this token");
        const row = flowRow(daemon, String(flowId));
        return start(daemon, row, Object.keys(body).length > 0 ? body : undefined);
      },
    ],

    // A flow that runs by itself. The first run starts at the next beat, and
    // each one after when the interval has passed. The values ride along the
    // way they would from the run form.
    [
      "PUT",
      "/api/flows/:id/schedule",
      async (parameters, body) => {
        const row = flowRow(daemon, parameters.id as string);
        const everyMinutes = Number(body.everyMinutes);
        // A tighter loop than this is a runaway spend, not a schedule.
        if (!Number.isFinite(everyMinutes) || everyMinutes < 15) {
          throw new Error("a schedule fires at most every 15 minutes");
        }
        const flow = await readFlow(row.path);
        const values = body.with as Record<string, unknown> | undefined;
        const needed = ((flow.takes?.required as string[] | undefined) ?? []).filter(
          (key) => values?.[key] === undefined || values[key] === "",
        );
        if (needed.length > 0) {
          throw new Error(`the flow takes values, so the schedule needs: ${needed.join(", ")}`);
        }
        daemon.store.setSchedule(row.id, Math.round(everyMinutes), values);
        return { scheduled: true, everyMinutes: Math.round(everyMinutes) };
      },
    ],

    [
      "DELETE",
      "/api/flows/:id/schedule",
      (parameters) => {
        daemon.store.clearSchedule(Number(parameters.id));
        return { removed: true };
      },
    ],

    // A new flow starts here: one file, one prompt, and a row in the store.
    // The editor is the surface that shapes it from there.
    [
      "POST",
      "/api/flows/new",
      async (_p, body) => {
        const root = resolve(daemon.root);
        const name = String(body.name ?? "").trim();
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const given = String(body.path ?? "").trim();
        if (!slug && !given) throw new Error("give the new flow a name");
        const path = resolve(root, given || join("flows", slug, "flow.yaml"));
        if (!under(root, path)) {
          throw new Error(`the flow at "${path}" is outside the root "${root}". Put the flow file under the root.`);
        }
        if (!/\.ya?ml$/.test(path)) throw new Error(`a new flow is a YAML file, so its path ends with .yaml`);
        if (existsSync(path)) throw new Error(`there is already a file at "${path}". Register it instead.`);
        const harness = adapterOf(body.harness);
        const flow: Flow = {
          name: name || slug || "new-flow",
          // The harness a person picked belongs in the file. It went to the
          // index alone, so the same new flow finished through the daemon and
          // died at the command line, which passes no harness of its own.
          harness,
          // A workspace is a promise about a repository, so it is written only
          // where there is one. The scaffold declared git wherever it landed,
          // and the first run of a flow in a plain directory died at the check.
          ...(isRepository(dirname(path)) ? { workspace: { kind: "git" as const, path: "." } } : {}),
          budget: 5,
          steps: [
            {
              id: "work",
              kind: "agent",
              needs: [],
              prompt: "prompts/work.md",
              tools: ["read", "grep", "find", "ls"],
              // A promise needs a workspace to check it against.
              ...(isRepository(dirname(path)) ? { changes: "nothing" as const } : {}),
              returns: {
                type: "object",
                required: ["summary"],
                properties: { summary: { type: "string" } },
              },
            } as unknown as Step,
          ],
        };
        mkdirSync(join(dirname(path), "prompts"), { recursive: true });
        writeFileSync(path, formatFlow(flow));
        const prompt = join(dirname(path), "prompts", "work.md");
        if (!existsSync(prompt)) {
          writeFileSync(
            prompt,
            "Say what this step should do, in plain words.\n\nAnswer with a short summary of what you did.\n",
          );
        }
        return daemon.store.addFlow(path, flow.name, harness);
      },
    ],

    [
      "POST",
      "/api/flows",
      async (_p, body) => {
        const root = resolve(daemon.root);
        const path = resolve(root, String(body.path ?? ""));
        // Every step acts in the root, so a flow file above it is another project.
        if (!under(root, path)) {
          throw new Error(`the flow at "${path}" is outside the root "${root}". Put the flow file under the root.`);
        }
        if (!existsSync(path)) throw new Error(`there is no file at "${path}"`);
        const harness = adapterOf(body.harness);
        const flow = await readFlow(path);
        return daemon.store.addFlow(path, flow.name || path, harness);
      },
    ],

    [
      "GET",
      "/api/flows/:id",
      async (parameters) => {
        const row = flowRow(daemon, parameters.id as string);
        const flow = await readFlow(row.path);
        return {
          row,
          flow,
          problems: validate(flow),
          warnings: [...missing(flow, row.path), ...unfilled(flow, row.path)],
          editable: /\.ya?ml$/.test(row.path),
        };
      },
    ],

    [
      "PUT",
      "/api/flows/:id",
      async (parameters, body) => {
        const row = flowRow(daemon, parameters.id as string);
        // Never hide a failure: only YAML holds the flow data one field to one field.
        if (!/\.ya?ml$/.test(row.path)) {
          throw new Error(`the flow at "${row.path}" is TypeScript, and the editor writes YAML only`);
        }
        const flow = body.flow as Flow;
        const problems = validate(flow);
        if (problems.length > 0) return { problems, saved: false };
        writeFileSync(row.path, formatFlow(flow));
        daemon.store.addFlow(row.path, flow.name, row.harness);
        return { problems, saved: true };
      },
    ],

    [
      "DELETE",
      "/api/flows/:id",
      (parameters) => {
        daemon.store.removeFlow(Number(parameters.id));
        return { removed: true };
      },
    ],

    // The editor opens the files a flow names: a prompt, a module, an inner
    // flow. Every step acts in the root, so a file above it is another
    // project, and the same line that guards a flow file guards these.
    [
      "GET",
      "/api/file",
      (_p, _b, request) => {
        const root = resolve(daemon.root);
        const wanted = new URL(request.url ?? "/", "http://orchy").searchParams.get("path") ?? "";
        const path = resolve(root, wanted);
        if (!under(root, path)) {
          throw new Error(`the file at "${path}" is outside the root "${root}"`);
        }
        if (!existsSync(path)) return { path, exists: false, content: "" };
        // A file this big is not a prompt, and the editor is not the tool for it.
        if (statSync(path).size > 1_000_000) throw new Error(`the file at "${path}" is too large for this editor`);
        return { path, exists: true, content: readFileSync(path, "utf8") };
      },
    ],

    [
      "PUT",
      "/api/file",
      (_p, body) => {
        const root = resolve(daemon.root);
        const path = resolve(root, String(body.path ?? ""));
        if (!under(root, path)) {
          throw new Error(`the file at "${path}" is outside the root "${root}"`);
        }
        // A prompt for a new step names a directory that is not there yet.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(body.content ?? ""));
        return { written: true, path };
      },
    ],

    [
      "POST",
      "/api/flows/:id/runs",
      async (parameters, body) => {
        const row = flowRow(daemon, parameters.id as string);
        const harness = body.harness ? adapterOf(body.harness) : undefined;
        return start(daemon, row, body.with as Record<string, unknown> | undefined, harness);
      },
    ],

    // `path` rides along when the editor knows the file, so the answer also
    // says which named files are not there. Those are warnings, not problems:
    // the editor writes a missing prompt in one click, so they block no save.
    [
      "POST",
      "/api/validate",
      (_p, body) => {
        const flow = body.flow as Flow;
        const path = typeof body.path === "string" ? body.path : undefined;
        // A flow that names no harness runs on the one the daemon holds for its
        // file, so that is the harness the page is answered for.
        const held = path ? daemon.store.flowAt(resolve(daemon.root, path))?.harness : undefined;
        return {
          problems: validate(flow, held),
          warnings: path ? [...missing(flow, path), ...unfilled(flow, path)] : unfilled(flow),
        };
      },
    ],

    [
      "GET",
      "/api/runs",
      () => {
        // A run the command line started is on disk and in no job of this
        // daemon, so the list reads the disk before it answers.
        daemon.catchUp();
        return daemon.store.runs();
      },
    ],

    // The runs of one flow, newest first. Several runs of one flow go at once,
    // each on its own values, and this is where a person reads them together.
    [
      "GET",
      "/api/flows/:id/runs",
      (parameters) => {
        daemon.catchUp();
        return daemon.store.runs(flowRow(daemon, parameters.id as string).path);
      },
    ],

    [
      "GET",
      "/api/runs/:id",
      (parameters) => {
        const runId = parameters.id as string;
        const state = daemon.state(runId);
        if (!state) throw new Error(`there is no run ${runId}`);
        return { row: daemon.store.run(runId), state };
      },
    ],

    [
      "GET",
      "/api/runs/:id/trajectory",
      (parameters) => {
        const trajectory = daemon.trajectory(parameters.id as string);
        if (!trajectory) throw new Error(`the run ${parameters.id} has written no trajectory yet`);
        return trajectory;
      },
    ],

    [
      "POST",
      "/api/runs/:id/resume",
      (parameters, body) => {
        const runId = parameters.id as string;
        const harness = body.harness ? adapterOf(body.harness) : harnessOfRun(daemon, runId);
        const from = typeof body.from === "string" && body.from !== "" ? body.from : undefined;
        // The gate the answer was written for, when the caller says. A run that
        // moved on since takes no answer meant for the question it has left.
        const step = typeof body.step === "string" && body.step !== "" ? body.step : undefined;
        return daemon.resume(runId, body.value, harness, from, step);
      },
    ],

    // A live child hears a signal. A run with no child — one that waits at a
    // gate, or one a dead daemon left — is marked stopped where it stands.
    // Never hide a failure: a run this daemon cannot stop says why.
    [
      "POST",
      "/api/runs/:id/stop",
      (parameters) => {
        const runId = parameters.id as string;
        if (daemon.stop(runId)) return { stopped: true };
        if (daemon.abandon(runId)) return { stopped: true, abandoned: true };
        const row = daemon.store.run(runId);
        throw new Error(
          row
            ? `the run is already ${row.status}, so there is nothing to stop`
            : `this daemon holds no run ${runId}`,
        );
      },
    ],

    ["GET", "/api/queue", () => daemon.pending()],

    [
      "DELETE",
      "/api/queue/:ticket",
      (parameters) => {
        daemon.forget(Number(parameters.ticket));
        return { removed: true };
      },
    ],

    [
      "GET",
      "/api/events",
      (_p, _b, request, response) => {
        stream(daemon, response, request, undefined);
        return HELD;
      },
    ],

    [
      "GET",
      "/api/runs/:id/events",
      (parameters, _b, request, response) => {
        stream(daemon, response, request, parameters.id as string);
        return HELD;
      },
    ],
  ];

  let origins = new Set<string>();
  const server = createServer((request, response) => {
    void answer(routes, origins, request, response);
  });

  return new Promise((keep, refuse) => {
    // A port that another program holds is a fault a person can act on. Without
    // this the error reaches the top as an unhandled event, in a stack trace.
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        refuse(new Error(`another program listens on ${host}:${port}. Name a free port with --port.`));
        return;
      }
      refuse(error);
    });
    server.listen(port, host, () => {
      // The caller can ask for the port 0, so this daemon learns its name here.
      origins = originsOf(host, (server.address() as AddressInfo).port);
      keep(server);
    });
  });
}

async function answer(
  routes: Array<[string, string, Handler]>,
  origins: Set<string>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const foreign = elsewhere(request, origins);
  if (foreign) return send(response, 403, { error: foreign });

  const url = new URL(request.url ?? "/", "http://orchy");
  const method = request.method ?? "GET";

  for (const [verb, pattern, handler] of routes) {
    const parameters = match(pattern, url.pathname);
    if (!parameters || verb !== method) continue;
    try {
      const value = await handler(parameters, await read(request), request, response);
      if (value !== HELD) send(response, 200, value);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/")) return send(response, 404, { error: `no route for ${url.pathname}` });
  file(url.pathname, response);
}

/**
 * Every name that reaches this daemon. The loopback address and `localhost` are
 * the same machine, so a person types either one.
 */
function originsOf(host: string, port: number): Set<string> {
  const loopback = host === "127.0.0.1" || host === "::1";
  const names = loopback ? ["127.0.0.1", "[::1]", "localhost"] : [host];
  return new Set(names.map((name) => originOf(`${name}:${port}`)));
}

/**
 * The daemon has no user and no password, and it starts an agent that can hold
 * `bash`. So a request from a page somewhere else must reach nothing.
 *
 * A browser sends `Origin` with every request that changes something, even one
 * that it cannot read, so a foreign `Origin` is a cross-site request. It sends
 * no `Origin` for a request of a page to its own daemon, which is what the
 * `fetch` of the page and its `EventSource` both send. A `Host` that this
 * daemon does not answer to is a name that resolves here from somewhere else,
 * which is how DNS rebinding starts.
 */
function elsewhere(request: IncomingMessage, origins: Set<string>): string | undefined {
  const own = [...origins][0] as string;
  const host = request.headers.host ?? "";
  if (!origins.has(originOf(host))) {
    return `this daemon does not answer to the host "${host}". Reach it at ${own}.`;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && !origins.has(origin)) {
    return `the page at "${origin}" is not this daemon, so it starts nothing here. Open the page at ${own}.`;
  }
  return undefined;
}

/** The origin of a host and a port, in the words a browser uses for it. */
function originOf(host: string): string {
  try {
    return new URL(`http://${host}`).origin;
  } catch {
    return "";
  }
}

/** A path is under the root when it reaches it with no step back. */
export function under(root: string, path: string): boolean {
  const step = relative(root, path);
  return step !== "" && !step.startsWith("..") && !isAbsolute(step);
}

function match(pattern: string, path: string): Params | undefined {
  const wanted = pattern.split("/");
  const parts = path.replace(/\/$/, "").split("/");
  if (wanted.length !== parts.length) return undefined;
  const parameters: Params = {};
  for (const [index, piece] of wanted.entries()) {
    if (piece.startsWith(":")) parameters[piece.slice(1)] = decodeURIComponent(parts[index] as string);
    else if (piece !== parts[index]) return undefined;
  }
  return parameters;
}

async function read(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(response: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value ?? null);
  response.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/** One event for one line, in the format that `EventSource` reads. */
function stream(daemon: Daemon, response: ServerResponse, request: IncomingMessage, runId?: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);

  if (runId) {
    // What the run did and what it said, back in the order it happened. The
    // clock sorts them, and the order of receipt breaks a same-millisecond tie.
    const past = [...daemon.store.events(runId), ...daemon.notes(runId)].sort(
      (a, b) => a.at.localeCompare(b.at) || (a.seq ?? 0) - (b.seq ?? 0),
    );
    for (const event of past) write({ kind: "event", runId, event });
  }
  write({ kind: "queue", pending: daemon.pending() });

  const stop = daemon.watch((notice) => {
    if (runId && notice.kind === "event" && notice.runId !== runId) return;
    write(notice);
  });
  // A client that goes away without a word leaves the write to fail silently.
  const beat = setInterval(() => response.write(": beat\n\n"), 20_000);
  request.on("close", () => {
    clearInterval(beat);
    stop();
  });
}

/** The UI is one page, so a path that names no file gets the page. */
function file(path: string, response: ServerResponse): void {
  if (!existsSync(join(UI, "index.html"))) {
    return send(response, 503, { error: `the UI is not built. Run "npm run ui:build".` });
  }
  const wanted = join(UI, path);
  const found = wanted.startsWith(UI) && existsSync(wanted) && statSync(wanted).isFile();
  const at = found ? wanted : join(UI, "index.html");
  response.writeHead(200, { "content-type": TYPES[extname(at)] ?? "application/octet-stream" });
  response.end(readFileSync(at));
}

function adapterOf(value: unknown): string {
  const name = String(value ?? "pi");
  if (!ADAPTERS.includes(name as (typeof ADAPTERS)[number])) {
    throw new Error(`there is no harness "${name}". Use one of: ${ADAPTERS.join(", ")}`);
  }
  return name;
}

/**
 * The harness a flow file names for itself, when it names one. Reading the file
 * costs a line, and the alternative is a list that says the wrong thing about
 * every flow that names its own.
 */
export function harnessInFile(path: string): string | undefined {
  try {
    const named = parseFlow(readFileSync(path, "utf8"), path).harness;
    return typeof named === "string" && named !== "" ? named : undefined;
  } catch {
    // A file that will not parse says so everywhere else. Here it says nothing.
    return undefined;
  }
}

/** Whether git reads this directory as a repository, which a workspace needs. */
function isRepository(at: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: at, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function flowRow(daemon: Daemon, id: string) {
  const row = daemon.store.flow(Number(id));
  if (!row) throw new Error(`there is no flow ${id}`);
  return row;
}

/**
 * Starts a run, checked. A flow that cannot run must say so here, not in the
 * log of a child, and a file the flow names must be there before a step spends
 * money on it. The button, the schedule route, the hook, and the MCP door all
 * come through this one function.
 */
export async function start(
  daemon: Daemon,
  row: { id: number; path: string; harness: string },
  values: Record<string, unknown> | undefined,
  harness?: string,
) {
  const flow = await loadFlow(row.path, daemon.root);
  const problems = validate(flow, harness ?? row.harness);
  if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);
  const raw = await readFlow(row.path);
  const gone = missing(raw, row.path);
  if (gone.length > 0) throw new Error(`the flow names files that are not there:\n- ${gone.join("\n- ")}`);
  // A hole in a prompt fails its step at run time, after the steps before it
  // spent money, so the run is refused where a person can still act on it.
  const holes = unfilled(raw, row.path);
  if (holes.length > 0) throw new Error(`the flow reads names that nothing supplies:\n- ${holes.join("\n- ")}`);
  // The daemon adds no rule: it passes the values on, and the child checks them.
  return daemon.start({ path: row.path, flowName: flow.name, harness: harness ?? row.harness, with: values });
}

/** A run keeps the file it came from, so a resume uses the harness of that flow. */
export function harnessOfRun(daemon: Daemon, runId: string): string {
  const run = daemon.store.run(runId);
  const flow = run?.path ? daemon.store.flowAt(run.path) : undefined;
  return flow?.harness ?? "pi";
}

/**
 * The one-line description a flow file starts with: its leading comment. The
 * file already says what the flow does there, so the list repeats no one.
 */
export function descriptionOf(path: string): string {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    const said: string[] = [];
    for (const line of lines) {
      const match = /^\s*(?:#|\/\/)\s?(.*)$/.exec(line);
      if (!match) break;
      said.push((match[1] as string).trim());
    }
    return said.join(" ").trim();
  } catch {
    return "";
  }
}

/**
 * The files a flow names that are not there: a prompt, a module, an inner
 * flow. Each path is relative to the flow file, the way the run resolves it.
 */
/**
 * The brace names a flow reads that nothing supplies: in the question of a
 * gate, and in the prompt file of an agent step, when the file is there to
 * read. Each one fails its step at run time, after the steps before it spent
 * money. `takesProblem` refuses a value outside `takes`, so what a run can
 * supply is exactly what `takes` names, and this check proves a hole. A
 * computed fanout supplies each member values no file names yet, so its
 * prompt is checked by the run and not here.
 */
export function unfilled(flow: Flow, flowPath?: string): string[] {
  const takes = ((flow.takes as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<
    string,
    unknown
  >;
  const problems: string[] = [];
  const check = (step: string, where: string, text: string, held?: Record<string, unknown>) => {
    for (const [, inside] of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const name = (inside as string).trim();
      if (Object.hasOwn(takes, name) || (held && Object.hasOwn(held, name))) continue;
      problems.push(
        `the step "${step}" reads "{{ ${name} }}" in its ${where}, and nothing supplies "${name}". Add it to "takes" on the flow${
          where === "prompt" ? ', or to "with" on the step' : ""
        }.`,
      );
    }
  };
  const base = flowPath ? dirname(resolve(flowPath)) : undefined;
  const readAt = (path?: string): string | undefined => {
    if (!base || !path || isAbsolute(path)) return undefined;
    try {
      return readFileSync(resolve(base, path), "utf8");
    } catch {
      return undefined;
    }
  };
  type Named = { id: string; question?: string; prompt?: string; with?: Record<string, unknown>; fanout?: unknown };
  for (const step of (flow.steps ?? []) as unknown as Named[]) {
    if (typeof step.question === "string") check(step.id, "question", step.question, step.with);
    if (step.fanout && !Array.isArray(step.fanout)) continue;
    if (Array.isArray(step.fanout)) {
      for (const member of step.fanout as Array<{ name: string; prompt?: string; with?: Record<string, unknown> }>) {
        const text = readAt(member.prompt ?? step.prompt);
        // A member's `with` replaces the step's, as `expandFanout` writes it.
        if (text !== undefined) check(`${step.id}/${member.name}`, "prompt", text, member.with ?? step.with);
      }
      continue;
    }
    const text = readAt(step.prompt);
    if (text !== undefined) check(step.id, "prompt", text, step.with);
  }
  return problems;
}

export function missing(flow: Flow, flowPath: string): string[] {
  const base = dirname(resolve(flowPath));
  const gone: string[] = [];
  const check = (step: string, kind: string, path?: string) => {
    if (!path || isAbsolute(path)) return;
    if (!existsSync(resolve(base, path))) {
      gone.push(`the step "${step}" names a ${kind} that is not there: ${path}`);
    }
  };
  // The union of step kinds narrows each field away; this check reads them loosely.
  type Named = { id: string; prompt?: string; module?: string; flow?: string; fanout?: unknown };
  for (const step of (flow.steps ?? []) as unknown as Named[]) {
    check(step.id, "prompt", step.prompt);
    check(step.id, "module", step.module);
    check(step.id, "flow file", step.flow);
    if (Array.isArray(step.fanout)) {
      for (const member of step.fanout as Array<{ name: string; prompt?: string; module?: string }>) {
        check(`${step.id}/${member.name}`, "prompt", member.prompt);
        check(`${step.id}/${member.name}`, "module", member.module);
      }
    }
  }
  return gone;
}
