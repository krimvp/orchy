import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Daemon } from "./daemon.ts";
import { type Flow, validate } from "./flow.ts";
import { ADAPTERS, TOOLS } from "./harness.ts";
import { loadFlow, readFlow } from "./load.ts";
import { formatFlow } from "./yaml.ts";

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
    // The editor draws the tool list and the harness list from here, so it never
    // holds a copy that falls behind the runner.
    ["GET", "/api/health", () => ({ root: daemon.root, adapters: ADAPTERS, tools: TOOLS })],

    ["GET", "/api/flows", () => daemon.store.flows()],

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
        return { row, flow, problems: validate(flow), editable: /\.ya?ml$/.test(row.path) };
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

    [
      "POST",
      "/api/flows/:id/runs",
      async (parameters, body) => {
        const row = flowRow(daemon, parameters.id as string);
        // A flow that cannot run must say so here, not in the log of a child.
        const flow = await loadFlow(row.path, daemon.root);
        const problems = validate(flow);
        if (problems.length > 0) throw new Error(`the flow is not valid:\n- ${problems.join("\n- ")}`);
        // The daemon adds no rule: it passes the values on, and the child checks them.
        return daemon.start({
          path: row.path,
          flowName: flow.name,
          harness: body.harness ? adapterOf(body.harness) : row.harness,
          with: body.with as Record<string, unknown> | undefined,
        });
      },
    ],

    ["POST", "/api/validate", (_p, body) => ({ problems: validate(body.flow as Flow) })],

    ["GET", "/api/runs", () => daemon.store.runs()],

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
        return daemon.resume(runId, body.value, harness);
      },
    ],

    ["POST", "/api/runs/:id/stop", (parameters) => ({ stopped: daemon.stop(parameters.id as string) })],

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

  return new Promise((keep) =>
    server.listen(port, host, () => {
      // The caller can ask for the port 0, so this daemon learns its name here.
      origins = originsOf(host, (server.address() as AddressInfo).port);
      keep(server);
    }),
  );
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
function under(root: string, path: string): boolean {
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
    // What the run did and what it said, back in the order it happened.
    const past = [...daemon.store.events(runId), ...daemon.notes(runId)].sort((a, b) => a.at.localeCompare(b.at));
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

function flowRow(daemon: Daemon, id: string) {
  const row = daemon.store.flow(Number(id));
  if (!row) throw new Error(`there is no flow ${id}`);
  return row;
}

/** A run keeps the file it came from, so a resume uses the harness of that flow. */
function harnessOfRun(daemon: Daemon, runId: string): string {
  const run = daemon.store.run(runId);
  const flow = run?.path ? daemon.store.flowAt(run.path) : undefined;
  return flow?.harness ?? "pi";
}
