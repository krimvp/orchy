import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as ask } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { daemon } from "../src/daemon.ts";
import { OPERATORS } from "../src/flow.ts";
import { serve } from "../src/server.ts";
import { KEPT, due, open, rowOf } from "../src/store.ts";
import { formatFlow, parseFlow } from "../src/yaml.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

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

/** A component that takes long enough for a person to stop the run it is in. */
const SLEEPS = `export default async () => {
  await new Promise((rest) => setTimeout(rest, 5000));
  return { count: 1 };
};
`;

const NUMBER = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

const APPROVED = { type: "object", required: ["approved"], properties: { approved: { type: "boolean" } } };

/** Two gates, so a test can answer one of them while the other waits. */
const TWO_GATES = {
  name: "two-gates",
  steps: [
    { id: "first", kind: "gate", question: "The first question?", returns: APPROVED },
    { id: "second", kind: "gate", needs: ["first"], question: "The second question?", returns: APPROVED },
  ],
};

/** A flow with one slow step, so a test can stop a run that is really running. */
const SLOW = { name: "slow", steps: [{ id: "wait", kind: "call", module: "sleeps.ts", returns: NUMBER }] };

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
  writeFileSync(join(root, "sleeps.ts"), SLEEPS);
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
    // The question carries the values of the steps the gate needs, so the
    // person answers with the work in front of them.
    assert.equal(row?.question.startsWith("Is the count correct?"), true);
    assert.match(row?.question as string, /"count": 0/);

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

test("the health answer names every operator that a match holds, and what each one reads", async () => {
  const site = await running(project());
  try {
    const health = (await site.call("/api/health")).body as {
      operators: Array<{ name: string; reads: string }>;
    };

    // The editor draws the list from here, so a copy in the page cannot fall behind.
    assert.deepEqual(
      health.operators.map((one) => one.name),
      OPERATORS.map((one) => one.name),
    );
    // The page draws a control from `reads`, so every operator names one.
    assert.deepEqual(
      health.operators.map((one) => one.reads),
      OPERATORS.map((one) => one.reads),
    );
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
      withJson: null,
      startedByJson: null,
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

test("a schedule is due at once, and again only when its interval has passed", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  assert.equal(due({ everyMinutes: 60, lastAt: null }, now), true);
  assert.equal(due({ everyMinutes: 60, lastAt: "2026-08-11T11:30:00Z" }, now), false);
  assert.equal(due({ everyMinutes: 60, lastAt: "2026-08-11T11:00:00Z" }, now), true);
  assert.equal(due({ everyMinutes: 15, lastAt: "2026-08-11T11:46:00Z" }, now), false);
});

test("a scheduled flow runs by itself, and does not run again before its time", async () => {
  const solo = {
    name: "solo",
    steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }],
  };
  const site = await running(project(solo));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });

    // A pace tighter than 15 minutes is a runaway spend, so the server refuses it.
    const tight = await site.call("/api/flows/1/schedule", {
      method: "PUT",
      body: JSON.stringify({ everyMinutes: 1 }),
    });
    assert.equal(tight.code, 400);

    const set = await site.call("/api/flows/1/schedule", {
      method: "PUT",
      body: JSON.stringify({ everyMinutes: 60 }),
    });
    assert.equal(set.code, 200);

    // The beat fires the schedule with no person in the loop.
    site.engine.fire();
    await until(async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string }>).some((run) => run.status === "done"),
    );

    // The next beat comes before the hour has, so nothing else starts.
    site.engine.fire();
    const runs = (await site.call("/api/runs")).body as unknown[];
    assert.equal(runs.length, 1);

    // The row says how the flow runs, so the list can too.
    const [row] = (await site.call("/api/flows")).body as Array<{ schedule: { everyMinutes: number } | null }>;
    assert.equal(row?.schedule?.everyMinutes, 60);

    await site.call("/api/flows/1/schedule", { method: "DELETE" });
    const [bare] = (await site.call("/api/flows")).body as Array<{ schedule: unknown }>;
    assert.equal(bare?.schedule, null);
  } finally {
    await site.close();
  }
});

test("a schedule for a flow that takes values must carry them", async () => {
  const site = await running(project(TAKING));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });

    const bare = await site.call("/api/flows/1/schedule", {
      method: "PUT",
      body: JSON.stringify({ everyMinutes: 60 }),
    });
    assert.equal(bare.code, 400);
    assert.match((bare.body as { error: string }).error, /the schedule needs: issue/);

    const held = await site.call("/api/flows/1/schedule", {
      method: "PUT",
      body: JSON.stringify({ everyMinutes: 60, with: { issue: 412 } }),
    });
    assert.equal(held.code, 200);

    site.engine.fire();
    await until(async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string }>).some((run) => run.status === "done"),
    );
  } finally {
    await site.close();
  }
});

test("a failed run resumes from the step that failed, and keeps the work that passed", async () => {
  const flow = {
    name: "mending",
    steps: [
      { id: "first", kind: "call", module: "count.ts", returns: NUMBER },
      { id: "shaky", kind: "call", needs: ["first"], module: "flaky.ts", returns: NUMBER },
    ],
  };
  const site = await running(project(flow));
  const root = site.engine.root;
  writeFileSync(
    join(root, "flaky.ts"),
    `import { existsSync } from "node:fs";
export default () => {
  if (!existsSync("go.txt")) throw new Error("go.txt is not there yet");
  return { count: 7 };
};
`,
  );
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string }>).some((run) => run.status === "failed"),
    );
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const runId = row?.runId as string;
    const before = (await site.call(`/api/runs/${runId}`)).body as {
      state: { steps: Record<string, { startedAt: string }> };
    };
    const firstRan = before.state.steps.first?.startedAt;

    // The person mends the workspace, and the run continues from the failure.
    writeFileSync(join(root, "go.txt"), "go\n");
    const resumed = await site.call(`/api/runs/${runId}/resume`, { method: "POST", body: "{}" });
    assert.equal(resumed.code, 200);
    await until(async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string }>).some((run) => run.status === "done"),
    );

    const after = (await site.call(`/api/runs/${runId}`)).body as {
      state: {
        steps: Record<string, { startedAt: string; value?: { count: number } }>;
        history?: Array<{ step: string; record: { status: string } }>;
      };
    };
    // The step that passed kept its work, the failed attempt went to history.
    assert.equal(after.state.steps.first?.startedAt, firstRan);
    assert.equal(after.state.steps.shaky?.value?.count, 7);
    assert.equal(after.state.history?.some((one) => one.step === "shaky" && one.record.status === "failed"), true);

    // A done run goes back only to a step a person names.
    const bare = await site.call(`/api/runs/${runId}/resume`, { method: "POST", body: "{}" });
    assert.equal(bare.code, 400);
    assert.match((bare.body as { error: string }).error, /Name the step to run again/);

    // A named step runs again, with everything after it.
    const back = await site.call(`/api/runs/${runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ from: "first" }),
    });
    assert.equal(back.code, 200);
    await until(async () => {
      const held = (await site.call(`/api/runs/${runId}`)).body as {
        row: { status: string } | null;
        state: { steps: Record<string, { startedAt: string }> };
      };
      return held.row?.status === "done" && held.state.steps.first?.startedAt !== firstRan;
    });
  } finally {
    await site.close();
  }
});

test("a webhook starts the flow from a POST, and a wrong token starts nothing", async () => {
  const site = await running(project(TAKING));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    const made = await site.call("/api/flows/1/hook", { method: "PUT" });
    assert.equal(made.code, 200);
    const token = (made.body as { token: string }).token;

    // The list carries the token, so the page can show the URL.
    const [row] = (await site.call("/api/flows")).body as Array<{ hook: string | null }>;
    assert.equal(row?.hook, token);

    const wrong = await site.call("/api/hooks/not-a-token", { method: "POST", body: "{}" });
    assert.equal(wrong.code, 400);

    // The body is the values the flow takes.
    const started = await site.call(`/api/hooks/${token}`, { method: "POST", body: JSON.stringify({ issue: 5 }) });
    assert.equal(started.code, 200);
    await until(async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string }>).some((run) => run.status === "done"),
    );
    const [run] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const state = (await site.call(`/api/runs/${run?.runId}`)).body as {
      state: { steps: Record<string, { value?: { count: number } }> };
    };
    assert.equal(state.state.steps.work?.value?.count, 5);

    // The hook goes, and the token opens nothing.
    await site.call("/api/flows/1/hook", { method: "DELETE" });
    const gone = await site.call(`/api/hooks/${token}`, { method: "POST", body: "{}" });
    assert.equal(gone.code, 400);
  } finally {
    await site.close();
  }
});

test("two runs of one flow go at once, each on its own values", async () => {
  const site = await running(project(TAKING));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: JSON.stringify({ with: { issue: 7 } }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: JSON.stringify({ with: { issue: 9 } }) });

    const runs = async () => (await site.call("/api/runs")).body as Array<{ status: string; withJson: string }>;
    await until(async () => (await runs()).filter((run) => run.status === "done").length === 2);

    // The row of a run keeps what that run took, so a list tells the two apart.
    const took = (await runs()).map((run) => (JSON.parse(run.withJson) as { issue: number }).issue).sort();
    assert.deepEqual(took, [7, 9]);
  } finally {
    await site.close();
  }
});

test("the daemon gives back the runs of one flow, and not the runs of another", async () => {
  const root = project();
  writeFileSync(
    join(root, "other.yaml"),
    formatFlow({
      name: "other",
      steps: [{ id: "only", kind: "call", module: "count.ts", returns: NUMBER }],
    } as never),
  );
  const site = await running(root);
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "other.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await site.call("/api/flows/2/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as unknown[]).length === 2);

    const mine = (await site.call("/api/flows/2/runs")).body as Array<{ flowName: string }>;
    assert.deepEqual(
      mine.map((run) => run.flowName),
      ["other"],
    );
  } finally {
    await site.close();
  }
});

test("a run that a person stops leaves no ticket saying it did not start", async () => {
  const site = await running(project(SLOW));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "running");

    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const stopped = await site.call(`/api/runs/${row?.runId}/stop`, { method: "POST" });
    assert.equal(stopped.code, 200);

    // The queue is for work that has not begun. A run a person ended is not
    // that, and it left a ticket reading "did not start" for ever, quoting
    // whatever its child last wrote to stderr.
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status !== "running");
    const pending = (await site.call("/api/queue")).body as Array<{ error?: string }>;
    assert.deepEqual(
      pending.filter((one) => one.error),
      [],
    );
  } finally {
    await site.close();
  }
});

test("an answer the gate refuses is refused at the door, not in a child", async () => {
  const site = await running(project());
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "waiting");
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;

    // The contract wants a boolean. A queued answer used to be taken with a 200
    // and refused later, on another page, under the words "did not start".
    const refused = await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: "yes please" } }),
    });

    assert.equal(refused.code, 400);
    assert.match((refused.body as { error: string }).error, /breaks the contract/);
    // The run still waits for the person, and no ticket says it did not start.
    assert.equal(((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status, "waiting");
    const pending = (await site.call("/api/queue")).body as Array<{ error?: string }>;
    assert.deepEqual(
      pending.filter((one) => one.error),
      [],
    );
  } finally {
    await site.close();
  }
});

test("the page shows a run that the command line started while the daemon ran", async () => {
  const root = project();
  const site = await running(root);
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    assert.deepEqual((await site.call("/api/runs")).body, []);

    // The daemon read `.orchy/runs` once, when it started, so a run made beside
    // it was on disk, in `orchy runs`, and on no page at all.
    await new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, [CLI, "run", "flow.yaml"], { cwd: root, stdio: "ignore" });
      // A gated flow waits, which the CLI reports with the code 3.
      child.on("close", (code) => (code === 3 || code === 0 ? done() : fail(new Error(`the run ended with ${code}`))));
    });

    const runs = (await site.call("/api/runs")).body as Array<{ status: string; flowName: string }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.flowName, "gated");
  } finally {
    await site.close();
  }
});

test("an answer written for one gate is not given to another", async () => {
  const site = await running(project(TWO_GATES));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    const waiting = async () =>
      ((await site.call("/api/runs")).body as Array<{ status: string; waitingFor: string }>)[0];
    await until(async () => (await waiting())?.status === "waiting");
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;

    // One person answers the first question. Another was still reading it.
    await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: true }, step: "first" }),
    });
    await until(async () => (await waiting())?.waitingFor === "second");

    // Their answer was written for "first", and the run has moved on: it must
    // not be recorded as the answer to a question they never read.
    const crossed = await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: false }, step: "first" }),
    });

    assert.equal(crossed.code, 400);
    assert.match((crossed.body as { error: string }).error, /waits at "second", and this answer is for "first"/);
    assert.equal((await waiting())?.waitingFor, "second");
  } finally {
    await site.close();
  }
});
