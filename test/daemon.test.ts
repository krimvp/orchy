import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { daemon } from "../src/daemon.ts";
import { serve } from "../src/server.ts";
import { open, rowOf } from "../src/store.ts";
import { formatFlow, parseFlow } from "../src/yaml.ts";

const COUNT = `export default (inputs: Record<string, unknown>) => ({ count: Object.keys(inputs).length });\n`;

const NUMBER = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

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

  return {
    engine,
    call,
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
