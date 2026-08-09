import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as ask } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemon } from "../src/daemon.ts";
import { serve } from "../src/server.ts";
import { KEPT, open, rowOf } from "../src/store.ts";
import { formatFlow, parseFlow } from "../src/yaml.ts";

const COUNT = `export default (inputs: Record<string, unknown>) => ({ count: Object.keys(inputs).length });\n`;

/** A component that says what it does, so a test proves the whole chain without a model. */
const TELLS = `export default (inputs: Record<string, unknown>, say: (text: string) => void) => {
  say("reading the ticket");
  say("writing the answer");
  return { count: Object.keys(inputs).length };
};
`;

/** A component that reads the values of the run, which the daemon passes to the child. */
const ISSUE = `export default (
  inputs: Record<string, unknown>,
  say: (text: string) => void,
  values: Record<string, unknown>,
) => ({ count: Number(values.issue) });
`;

const NUMBER = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

/** A flow that takes one value, so a test proves the whole chain of a run. */
const TAKING = {
  name: "taking",
  takes: { type: "object", required: ["issue"], properties: { issue: { type: "number" } } },
  steps: [{ id: "work", kind: "call", module: "issue.ts", returns: NUMBER }],
};

/** A flow of two deterministic steps and a gate, so a test needs no model. */
const FLOW = {
  name: "gated",
  steps: [
    { id: "first", kind: "call", module: "count.ts", returns: NUMBER },
    {
      id: "ask",
      kind: "gate",
      needs: ["first"],
      question: "Is the count correct?",
      returns: { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } },
    },
    { id: "last", kind: "call", needs: ["ask"], module: "count.ts", returns: NUMBER },
  ],
};

function project(flow: unknown = FLOW): string {
  const root = mkdtempSync(join(tmpdir(), "orchy-daemon-"));
  writeFileSync(join(root, "count.ts"), COUNT);
  writeFileSync(join(root, "tells.ts"), TELLS);
  writeFileSync(join(root, "issue.ts"), ISSUE);
  writeFileSync(join(root, "flow.yaml"), formatFlow(flow as never));
  return root;
}

/** Starts a daemon and a server on a free port, and gives back a client for it. */
async function running(root: string) {
  const engine = daemon(root);
  const server = await serve(engine, 0);
  const port = (server.address() as AddressInfo).port;

  const call = async (path: string, options?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: options?.body ? { "content-type": "application/json" } : undefined,
    });
    return { code: response.status, body: (await response.json()) as never };
  };

  /** Sends the headers of a browser, such as `Origin` and `Host`, which `fetch` holds back. */
  const raw = (path: string, headers: Record<string, string>, method = "GET", body = "") =>
    new Promise<{ code: number; error?: string }>((done, fail) => {
      const sent = ask({ host: "127.0.0.1", port, path, method, headers }, (answer) => {
        let text = "";
        answer.on("data", (chunk: Buffer) => (text += chunk.toString()));
        answer.on("end", () =>
          done({ code: answer.statusCode ?? 0, error: (JSON.parse(text) as { error?: string }).error }),
        );
      });
      sent.on("error", fail);
      sent.end(body);
    });

  /** Opens the stream of a run, keeps what it gives back, and lets go. */
  const read = async (path: string): Promise<Array<{ kind: string; event: { type: string; text?: string } }>> => {
    const control = new AbortController();
    let text = "";
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: control.signal });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const giveUp = setTimeout(() => control.abort(), 2000);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString();
        // The replay ends with the run, so there is no need to wait for more.
        if (text.includes('"run_end"')) break;
      }
      clearTimeout(giveUp);
    } catch {
      // The stream never ends by itself, so letting go is the normal way out.
    }
    control.abort();
    return text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { kind: string; event: { type: string } });
  };

  return {
    engine,
    port,
    call,
    raw,
    read,
    close: () =>
      new Promise<void>((done) => {
        engine.close();
        server.close(() => done());
      }),
  };
}

/** Waits for a state that a child process reaches, and gives up after 30 seconds. */
async function until(ready: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (await ready()) return;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error("the run never reached the state the test waits for");
}

test("the daemon runs a flow, stops at a gate, and ends when a person answers", async () => {
  const site = await running(project());
  try {
    const added = await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    assert.equal(added.code, 200);
    assert.equal((added.body as { name: string }).name, "gated");

    const started = await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    assert.equal(started.code, 200);

    const status = async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status;
    await until(async () => (await status()) === "waiting");

    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string; question: string }>;
    assert.equal(row?.question, "Is the count correct?");

    const answered = await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: true } }),
    });
    assert.equal(answered.code, 200);
    await until(async () => (await status()) === "done");

    const run = (await site.call(`/api/runs/${row?.runId}`)).body as {
      state: { steps: Record<string, { value: unknown; answeredByPerson?: boolean }> };
    };
    assert.deepEqual(run.state.steps.first?.value, { count: 0 });
    assert.equal(run.state.steps.ask?.answeredByPerson, true);
    assert.deepEqual(run.state.steps.last?.value, { count: 1 });
  } finally {
    await site.close();
  }
});

test("the daemon keeps every event of a run, and gives them again after the run", async () => {
  const site = await running(project());
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "waiting");

    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const events = site.engine.store.events(row?.runId as string);
    assert.deepEqual(
      events.map((event) => event.type),
      ["run_start", "step_start", "step_end", "waiting"],
    );
  } finally {
    await site.close();
  }
});

test("a step reports what it does, and the daemon holds it apart from the index", async () => {
  const talking = {
    name: "talking",
    steps: [{ id: "work", kind: "call", module: "tells.ts", returns: NUMBER }],
  };
  const site = await running(project(talking));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "done");

    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const runId = row?.runId as string;

    const said = site.engine.notes(runId);
    assert.deepEqual(
      said.map((note) => (note as unknown as { text: string }).text),
      ["reading the ticket", "writing the answer"],
    );
    assert.equal((said[0] as unknown as { step: string }).step, "work");

    // The index keeps what the run did. What a step said is a view, not a record.
    const kinds = site.engine.store.events(runId).map((event) => event.type);
    assert.deepEqual(kinds, ["run_start", "step_start", "step_end", "run_end"]);
  } finally {
    await site.close();
  }
});

test("the stream of a run gives back what it did and what it said, in order", async () => {
  const talking = {
    name: "talking",
    steps: [{ id: "work", kind: "call", module: "tells.ts", returns: NUMBER }],
  };
  const site = await running(project(talking));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "done");
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;

    const replay = await site.read(`/api/runs/${row?.runId}/events`);
    const types = replay.filter((one) => one.kind === "event").map((one) => one.event.type);

    assert.deepEqual(types, ["run_start", "step_start", "output", "output", "step_end", "run_end"]);
  } finally {
    await site.close();
  }
});

test("the server refuses to start a flow that is not valid, and says why", async () => {
  const broken = { name: "broken", steps: [{ id: "one", kind: "call", needs: ["ghost"], module: "count.ts", returns: NUMBER }] };
  const site = await running(project(broken));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const started = await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });

    assert.equal(started.code, 400);
    assert.match((started.body as { error: string }).error, /needs "ghost"/);
    assert.deepEqual((await site.call("/api/runs")).body, []);
  } finally {
    await site.close();
  }
});

test("the editor writes no file when the flow it sends is not valid", async () => {
  const root = project();
  const site = await running(root);
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const before = readFileSync(join(root, "flow.yaml"), "utf8");

    const saved = await site.call("/api/flows/1", {
      method: "PUT",
      body: JSON.stringify({ flow: { name: "gated", steps: [{ id: "one", kind: "call", needs: ["ghost"], module: "count.ts", returns: NUMBER }] } }),
    });

    assert.equal((saved.body as { saved: boolean }).saved, false);
    assert.match((saved.body as { problems: string[] }).problems[0] as string, /needs "ghost"/);
    assert.equal(readFileSync(join(root, "flow.yaml"), "utf8"), before);
  } finally {
    await site.close();
  }
});

test("the editor writes a flow that the loader reads back the same", async () => {
  const root = project();
  const site = await running(root);
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const read = (await site.call("/api/flows/1")).body as { flow: unknown };

    const saved = await site.call("/api/flows/1", { method: "PUT", body: JSON.stringify({ flow: read.flow }) });
    assert.equal((saved.body as { saved: boolean }).saved, true);

    const again = (await site.call("/api/flows/1")).body as { flow: unknown };
    assert.deepEqual(again.flow, read.flow);
  } finally {
    await site.close();
  }
});

test("the index reads every run from disk, so a lost database costs no run", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-index-"));
  const runs = join(root, "runs");
  mkdirSync(join(runs, "abc"), { recursive: true });
  writeFileSync(
    join(runs, "abc", "state.json"),
    JSON.stringify({
      runId: "abc",
      flow: { name: "counted", steps: [] },
      status: "done",
      steps: { one: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:09.000Z" } },
      cycles: {},
    }),
  );
  writeFileSync(
    join(runs, "abc", "trajectory.json"),
    JSON.stringify({ final_metrics: { prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.25 } }),
  );

  const store = open(join(root, "index.db"));
  assert.equal(store.index(runs), 1);

  const row = store.run("abc");
  assert.equal(row?.flowName, "counted");
  assert.equal(row?.status, "done");
  assert.equal(row?.cost, 0.25);
  assert.equal(row?.tokens, 15);
  assert.equal(row?.endedAt, "2026-01-01T00:00:09.000Z");
  store.close();
});

test("a run that says running when the daemon starts is stopped, because no child drives it", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-stopped-"));
  const runs = join(root, "runs");
  mkdirSync(join(runs, "gone"), { recursive: true });
  writeFileSync(
    join(runs, "gone", "state.json"),
    JSON.stringify({
      runId: "gone",
      flow: { name: "cut", steps: [] },
      status: "running",
      steps: { one: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" } },
      cycles: {},
    }),
  );

  const store = open(join(root, "index.db"));
  store.index(runs);

  assert.equal(store.run("gone")?.status, "stopped");
  store.close();
});

test("a run that waits has no end, so it reports no length", () => {
  const row = rowOf(
    {
      runId: "one",
      flow: { name: "gated", steps: [] },
      status: "waiting",
      waitingFor: "ask",
      question: "Which one?",
      steps: { first: { status: "done", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" } },
      cycles: {},
    },
    "flow.yaml",
  );

  assert.equal(row.endedAt, null);
  assert.equal(row.waitingFor, "ask");
});

test("a page on another site cannot start a run, because the daemon refuses its Origin", async () => {
  const site = await running(project());
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });

    const named = await site.raw("/api/flows/1/runs", { origin: "https://elsewhere.example" }, "POST", "{}");
    assert.equal(named.code, 403);
    assert.match(named.error as string, /https:\/\/elsewhere\.example/);

    // A page on `https` sends the word `null` for a request that it does not read.
    const hidden = await site.raw("/api/flows/1/runs", { origin: "null" }, "POST", "{}");
    assert.equal(hidden.code, 403);

    assert.deepEqual((await site.call("/api/runs")).body, []);
  } finally {
    await site.close();
  }
});

test("a name that resolves to this machine reaches nothing, because the daemon refuses its Host", async () => {
  const site = await running(project());
  try {
    const listed = await site.raw("/api/flows", { host: `rebound.example:${site.port}` });
    assert.equal(listed.code, 403);
    assert.match(listed.error as string, /rebound\.example/);

    // The port is a part of the name, so a second daemon is a different one.
    const other = await site.raw("/api/flows", { host: "127.0.0.1:1" });
    assert.equal(other.code, 403);
  } finally {
    await site.close();
  }
});

test("the page keeps working, because the daemon answers its own Origin and the name localhost", async () => {
  const site = await running(project());
  try {
    const added = await site.raw(
      "/api/flows",
      { origin: `http://127.0.0.1:${site.port}`, "content-type": "application/json" },
      "POST",
      JSON.stringify({ path: "flow.yaml" }),
    );
    assert.equal(added.code, 200);

    // A person types either name, and both reach this machine only.
    const listed = await site.raw("/api/flows", { host: `localhost:${site.port}` });
    assert.equal(listed.code, 200);
  } finally {
    await site.close();
  }
});

test("the daemon refuses a flow file outside its root, and names the root", async () => {
  const root = project();
  const site = await running(root);
  try {
    const added = await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "../../etc/hosts" }) });

    assert.equal(added.code, 400);
    const error = (added.body as { error: string }).error;
    assert.match(error, /outside the root/);
    assert.ok(error.includes(root), `the message names no root: ${error}`);
    assert.deepEqual((await site.call("/api/flows")).body, []);
  } finally {
    await site.close();
  }
});

test("the index drops the events of a run that falls behind the list, and keeps the run", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-trim-"));
  const store = open(join(root, "index.db"));
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

  // One run more than the index keeps, so the oldest one falls behind the list.
  for (let count = 0; count <= KEPT; count += 1) {
    const runId = `run-${String(count).padStart(4, "0")}`;
    store.saveRun({
      runId,
      flowName: "counted",
      path: null,
      status: "done",
      startedAt: at(count),
      endedAt: at(count),
      waitingFor: null,
      question: null,
      cost: null,
      tokens: null,
    });
    store.addEvent(runId, { type: "run_start", runId });
  }

  store.trim();

  assert.equal(store.runs().length, KEPT);
  assert.equal(store.events(`run-${String(KEPT).padStart(4, "0")}`).length, 1);
  assert.deepEqual(store.events("run-0000"), []);
  // ADR 0009: the index is not the run, so the run stays.
  assert.equal(store.run("run-0000")?.flowName, "counted");
  store.close();
});

test("a flow written as YAML parses back to the same data", () => {
  const flow = parseFlow(formatFlow(parseFlow(formatFlow(FLOW as never))));
  assert.equal(flow.name, "gated");
  assert.deepEqual(
    flow.steps.map((step) => step.id),
    ["first", "ask", "last"],
  );
  assert.deepEqual(flow.steps[1]?.needs, ["first"]);
  assert.deepEqual(flow.steps[0]?.needs, []);
});

test("the daemon passes the values of a run to the child, and every step reads them", async () => {
  const site = await running(project(TAKING));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const started = await site.call("/api/flows/1/runs", {
      method: "POST",
      body: JSON.stringify({ with: { issue: 42 } }),
    });
    assert.equal(started.code, 200);
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "done");

    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const run = (await site.call(`/api/runs/${row?.runId}`)).body as {
      state: { with: unknown; steps: Record<string, { value: unknown }> };
    };
    assert.deepEqual(run.state.with, { issue: 42 });
    assert.deepEqual(run.state.steps.work?.value, { count: 42 });
  } finally {
    await site.close();
  }
});

test("the daemon adds no rule of its own, so the child refuses a run with no values", async () => {
  const site = await running(project(TAKING));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const started = await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    assert.equal(started.code, 200);

    await until(async () => ((await site.call("/api/queue")).body as Array<{ error?: string }>)[0]?.error !== undefined);
    const [ticket] = (await site.call("/api/queue")).body as Array<{ error: string }>;
    assert.match(ticket?.error as string, /takes values, and this run supplies none/);
    assert.deepEqual((await site.call("/api/runs")).body, []);
  } finally {
    await site.close();
  }
});
