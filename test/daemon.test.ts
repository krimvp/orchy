import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request as ask } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { daemon, type Ticket } from "../src/daemon.ts";
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

const NOISY = `export default () => {
  console.log("an ordinary component line");
  console.log('{"type":"run_end","status":"failed","error":"forged"}');
  process.stdout.write('{"partial":');
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
  writeFileSync(join(root, "noisy.ts"), NOISY);
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

async function revisionOf(site: Awaited<ReturnType<typeof running>>, runId: string): Promise<number> {
  const held = (await site.call(`/api/runs/${runId}`)).body as { state: { revision: number } };
  return held.state.revision;
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
      body: JSON.stringify({ value: { approved: true }, revision: await revisionOf(site, row?.runId as string) }),
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

test("a new Droid flow declares no budget that its adapter cannot measure", async () => {
  const root = project();
  const site = await running(root);
  try {
    const droid = await site.call("/api/flows/new", {
      method: "POST",
      body: JSON.stringify({ name: "Droid work", path: "flows/droid/flow.yaml", harness: "droid" }),
    });
    assert.equal(droid.code, 200);
    const droidFlow = parseFlow(readFileSync(join(root, "flows", "droid", "flow.yaml"), "utf8"));
    assert.equal(droidFlow.harness, "droid");
    assert.equal(droidFlow.budget, undefined);

    const claude = await site.call("/api/flows/new", {
      method: "POST",
      body: JSON.stringify({ name: "Claude work", path: "flows/claude/flow.yaml", harness: "claude" }),
    });
    assert.equal(claude.code, 200);
    const claudeFlow = parseFlow(readFileSync(join(root, "flows", "claude", "flow.yaml"), "utf8"));
    assert.equal(claudeFlow.budget, 5);
  } finally {
    await site.close();
  }
});

test("a new flow refuses non-string fields before it writes", async () => {
  const root = project();
  const site = await running(root);
  const cases = [
    { body: { name: {}, path: "flows/name/flow.yaml", harness: "claude" }, path: "flows/name/flow.yaml", field: "name" },
    { body: { name: "Bad path", path: ["flows/path/flow.yaml"], harness: "claude" }, path: "flows/path/flow.yaml", field: "path" },
    { body: { name: "Bad harness", path: "flows/harness/flow.yaml", harness: {} }, path: "flows/harness/flow.yaml", field: "harness" },
  ];
  try {
    for (const item of cases) {
      const answer = await site.call("/api/flows/new", { method: "POST", body: JSON.stringify(item.body) });
      assert.equal(answer.code, 400);
      assert.match((answer.body as { error: string }).error, new RegExp(`"${item.field}" must be a string`));
      assert.equal(existsSync(join(root, item.path)), false);
    }
  } finally {
    await site.close();
  }
});

test("flow validation returns problems for null shapes and no JavaScript error", async () => {
  const site = await running(project());
  const shapes = [
    null,
    { name: "null-step", steps: [null] },
    {
      name: "null-member",
      steps: [
        {
          id: "work",
          kind: "agent",
          needs: [],
          prompt: "work.md",
          tools: ["read"],
          returns: NUMBER,
          fanout: [null],
        },
      ],
    },
  ];
  try {
    for (const flow of shapes) {
      const answer = await site.call("/api/validate", { method: "POST", body: JSON.stringify({ flow }) });
      assert.equal(answer.code, 200);
      const body = answer.body as { problems: string[]; warnings: string[] };
      assert.ok(body.problems.length > 0);
      assert.deepEqual(body.warnings, []);
      assert.doesNotMatch(body.problems.join("\n"), /TypeError|Cannot read|is not iterable/);
    }
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
      components: string[];
    };

    // The editor hints the shipped components from here, so it holds no copy.
    assert.deepEqual(health.components, ["orchy:check", "orchy:remember"]);

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

test("a live start reservation blocks every store over the root", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-reservation-"));
  const file = join(root, "index.db");
  const first = open(file);
  const second = open(file);
  try {
    assert.equal(first.reserveStart("parent", "dispatch", 1, "first").accepted, true);
    assert.deepEqual(second.reserveStart("parent", "dispatch", 1, "second"), { accepted: false, count: 1 });
    first.releaseStart("first");
    assert.equal(second.reserveStart("parent", "dispatch", 1, "second").accepted, true);
  } finally {
    first.close();
    second.close();
  }
});

test("a reservation from a dead process gives its slot back", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-stale-reservation-"));
  const file = join(root, "index.db");
  const storeModule = new URL("../src/store.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { open } from ${JSON.stringify(storeModule)}; open(process.argv[1]).reserveStart('parent', 'dispatch', 1, 'dead');`,
      file,
    ],
    { stdio: "ignore" },
  );

  const store = open(file);
  try {
    assert.equal(store.reserveStart("parent", "dispatch", 1, "next").accepted, true);
  } finally {
    store.close();
  }
});

test("a reservation lost before durable acceptance gives its slot back", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-unknown-start-"));
  const file = join(root, "index.db");
  const storeModule = new URL("../src/store.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { open } from ${JSON.stringify(storeModule)}; open(process.argv[1]).reserveStart('parent', 'dispatch', 1, 'dead', 'planned-run');`,
      file,
    ],
    { stdio: "ignore" },
  );

  const store = open(file);
  try {
    assert.equal(store.reserveStart("parent", "dispatch", 1, "next").accepted, true);
  } finally {
    store.close();
  }
});

test("an upgrade reservation with unknown delivery keeps its slot", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-legacy-reservation-"));
  const file = join(root, "index.db");
  const storeModule = new URL("../src/store.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { open } from ${JSON.stringify(storeModule)}; open(process.argv[1]).reserveStart('parent', 'dispatch', 1, 'old', 'planned-run');`,
      file,
    ],
    { stdio: "ignore" },
  );
  const raw = new DatabaseSync(file);
  raw.prepare("update start_reservation set phase = 'unknown', childRunId = null where token = 'old'").run();
  raw.close();

  const store = open(file);
  try {
    assert.deepEqual(store.reserveStart("parent", "dispatch", 1, "next"), { accepted: false, count: 1 });
  } finally {
    store.close();
  }
});

test("durably accepted work keeps its reserved slot after its door dies", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-accepted-reservation-"));
  const file = join(root, "index.db");
  const storeModule = new URL("../src/store.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { open } from ${JSON.stringify(storeModule)};
       const store = open(process.argv[1]);
       store.reserveStart('parent', 'dispatch', 1, 'accepted', 'planned-run');
       store.acceptWork({kind:'start', flowName:'held', path:'flow.yaml', harness:'pi', plannedRunId:'planned-run', reservation:'accepted', payload:{kind:'start'}});`,
      file,
    ],
    { stdio: "ignore" },
  );

  const store = open(file);
  try {
    assert.deepEqual(store.reserveStart("parent", "dispatch", 1, "next"), { accepted: false, count: 1 });
  } finally {
    store.close();
  }
});

test("a failed child start releases its reservation", async () => {
  const root = project();
  const engine = daemon(root, false);
  try {
    assert.equal(engine.store.reserveStart("parent", "dispatch", 1, "failed").accepted, true);
    engine.start({
      path: join(root, "missing.yaml"),
      flowName: "missing",
      harness: "pi",
      reservation: "failed",
    });
    await until(async () => engine.pending().some((ticket) => ticket.error !== undefined));
    assert.equal(engine.store.reserveStart("parent", "dispatch", 1, "next").accepted, true);
  } finally {
    engine.close();
  }
});

test("a child keeps its reservation when its MCP daemon closes", () => {
  const root = project(TWO_GATES);
  const engine = daemon(root, false);
  assert.equal(engine.store.reserveStart("parent", "dispatch", 1, "held").accepted, true);
  engine.start({ path: join(root, "flow.yaml"), flowName: "two-gates", harness: "pi", reservation: "held" });
  engine.close(false);

  const next = open(join(root, ".orchy", "index.db"));
  try {
    assert.deepEqual(next.reserveStart("parent", "dispatch", 1, "next"), { accepted: false, count: 1 });
  } finally {
    next.close();
  }
});

test("ticket numbers are durable and global across stores", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-work-tickets-"));
  const file = join(root, "index.db");
  const first = open(file);
  const second = open(file);
  try {
    const one = first.acceptWork({
      kind: "start",
      flowName: "one",
      path: "one.yaml",
      harness: "pi",
      plannedRunId: "one",
      payload: { kind: "start" },
    });
    const two = second.acceptWork({
      kind: "start",
      flowName: "two",
      path: "two.yaml",
      harness: "pi",
      plannedRunId: "two",
      payload: { kind: "start" },
    });
    assert.equal(two?.ticket, (one?.ticket as number) + 1);
  } finally {
    first.close();
    second.close();
  }
});

test("work that cannot be stored as bounded JSON is not accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-work-json-"));
  const store = open(join(root, "index.db"));
  try {
    assert.throws(
      () =>
        store.acceptWork({
          kind: "start",
          flowName: "large",
          path: "flow.yaml",
          harness: "pi",
          plannedRunId: "large",
          payload: { kind: "start", with: { value: "x".repeat(1_000_001) } },
        }),
      /larger than 1000000 bytes/,
    );
    assert.throws(
      () =>
        store.acceptWork({
          kind: "start",
          flowName: "not-json",
          path: "flow.yaml",
          harness: "pi",
          plannedRunId: "not-json",
          payload: { kind: "start", with: { value: 1n } },
        }),
      /not JSON/,
    );
    assert.deepEqual(store.works(), []);
  } finally {
    store.close();
  }
});

test("a stale readiness failure cannot overwrite another daemon's claim", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-work-owner-"));
  const file = join(root, "index.db");
  const first = open(file);
  const second = open(file);
  try {
    const row = first.acceptWork({
      kind: "start",
      flowName: "one",
      path: "one.yaml",
      harness: "pi",
      plannedRunId: "one",
      payload: { kind: "start" },
    });
    assert.ok(row);
    assert.ok(first.claimWork(row.ticket));
    assert.equal(second.failQueuedWork(row.ticket, "a stale check failed"), false);
    assert.equal(second.work(row.ticket)?.status, "claimed");
  } finally {
    first.close();
    second.close();
  }
});

test("an error after delivery cannot turn the receipt into a failed start", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-delivered-work-"));
  const store = open(join(root, "index.db"));
  try {
    const row = store.acceptWork({
      kind: "start",
      flowName: "one",
      path: "one.yaml",
      harness: "pi",
      plannedRunId: "one",
      payload: { kind: "start" },
    });
    assert.ok(row);
    store.claimWork(row.ticket);
    store.deliveredWork(row.ticket, "one");
    store.failOwnedWork(row.ticket, "a later control error");
    assert.equal(store.work(row.ticket)?.status, "delivered");
  } finally {
    store.close();
  }
});

test("two daemon pumps dispatch one durable receipt once", async () => {
  const root = project({ name: "quick", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] });
  const plannedRunId = "one-durable-run";
  mkdirSync(join(root, ".orchy"), { recursive: true });
  const store = open(join(root, ".orchy", "index.db"));
  store.acceptWork({
    kind: "start",
    flowName: "quick",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId,
    payload: { kind: "start" },
  });
  store.close();

  const first = daemon(root, false);
  const second = daemon(root, false);
  try {
    await until(async () => first.state(plannedRunId)?.status === "done");
    assert.equal(first.store.events(plannedRunId).filter((event) => event.type === "run_start").length, 1);
    assert.equal(first.pending().some((ticket) => ticket.status === "failed"), false);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a daemon claims durable work before it loads user flow code", async () => {
  const root = project();
  const marker = join(root, "loaded-by-daemon");
  const flowPath = join(root, "flow.ts");
  writeFileSync(
    flowPath,
    `import { appendFileSync } from "node:fs";
if (process.env.ORCHY_RUN_GROUP !== "1") {
  appendFileSync(${JSON.stringify(marker)}, "loaded\\n");
  const until = Date.now() + 400;
  while (Date.now() < until) {}
}
export default { name: "claimed-first", steps: [{ id: "work", kind: "call", module: "count.ts", returns: ${JSON.stringify(NUMBER)} }] };
`,
  );
  mkdirSync(join(root, ".orchy"), { recursive: true });
  const store = open(join(root, ".orchy", "index.db"));
  store.acceptWork({
    kind: "start",
    flowName: "claimed-first",
    path: flowPath,
    harness: "pi",
    plannedRunId: "claimed-before-load",
    payload: { kind: "start" },
  });
  store.close();

  const daemonModule = new URL("../src/daemon.ts", import.meta.url).href;
  const script = `import { daemon } from ${JSON.stringify(daemonModule)};
const engine = daemon(process.argv[1], false);
await new Promise((wait) => setTimeout(wait, 1500));
await engine.close();`;
  const runDoor = () =>
    new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", script, root], { stdio: "ignore" });
      child.on("error", fail);
      child.on("close", (code) => (code === 0 ? done() : fail(new Error(`the test daemon ended with ${code}`))));
    });
  await Promise.all([runDoor(), runDoor()]);

  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 1);
});

test("a dispatch store fault leaves its receipt and does not stall the pump", async () => {
  const root = project({ name: "quick", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] });
  const engine = daemon(root, false);
  const claim = engine.store.claimWork.bind(engine.store);
  let calls = 0;
  mock.method(engine.store, "claimWork", (ticket: number) => {
    calls += 1;
    if (calls === 1) throw new Error("the database refused the claim");
    return claim(ticket);
  });
  const held = engine.start({ path: join(root, "flow.yaml"), flowName: "quick", harness: "pi" });
  const next = engine.start({ path: join(root, "flow.yaml"), flowName: "quick", harness: "pi" });
  const heldRunId = engine.store.work(held.ticket)?.plannedRunId as string;
  const nextRunId = engine.store.work(next.ticket)?.plannedRunId as string;
  try {
    await until(async () => engine.state(nextRunId)?.status === "done");
    const receipt = engine.pending().find((ticket) => ticket.ticket === held.ticket);
    assert.equal(receipt?.status, "queued");
    assert.match(receipt?.error ?? "", /database refused the claim/);
    assert.match(receipt?.recovery ?? "", /Restart the daemon/);
  } finally {
    mock.restoreAll();
    await engine.close();
  }

  const restarted = daemon(root, false);
  try {
    await until(async () => restarted.state(heldRunId)?.status === "done");
  } finally {
    await restarted.close();
  }
});

test("a live claimed receipt is not loaded by another daemon", async () => {
  const root = project();
  mkdirSync(join(root, ".orchy"), { recursive: true });
  const store = open(join(root, ".orchy", "index.db"));
  const row = store.acceptWork({
    kind: "start",
    flowName: "gated",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId: "live-claim",
    payload: { kind: "start" },
  });
  assert.ok(row);
  assert.ok(store.claimWork(row.ticket));
  const other = daemon(root, false);
  try {
    await new Promise((wait) => setTimeout(wait, 100));
    assert.equal(existsSync(join(root, ".orchy", "runs", "live-claim", "state.json")), false);
    assert.equal(other.pending()[0]?.status, "dispatching");
    assert.throws(() => other.forget(row.ticket), /claimed, so it cannot be dismissed/);
  } finally {
    await other.close();
    store.close();
  }
});

test("a dead claimed receipt is uncertain and never retried", () => {
  const root = project();
  mkdirSync(join(root, ".orchy"), { recursive: true });
  const file = join(root, ".orchy", "index.db");
  const storeModule = new URL("../src/store.ts", import.meta.url).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { open } from ${JSON.stringify(storeModule)};
       const store = open(process.argv[1]);
       const row = store.acceptWork({kind:'start', flowName:'gated', path:process.argv[2], harness:'pi', plannedRunId:'dead-claim', payload:{kind:'start'}});
       store.claimWork(row.ticket);`,
      file,
      join(root, "flow.yaml"),
    ],
    { stdio: "ignore" },
  );

  const engine = daemon(root, false);
  try {
    const [ticket] = engine.pending();
    assert.equal(ticket?.status, "uncertain");
    assert.match(ticket?.error ?? "", /uncertain start delivery.*dead-claim/);
    assert.match(ticket?.recovery ?? "", /GET \/api\/runs\/dead-claim/);
    assert.equal(existsSync(join(root, ".orchy", "runs", "dead-claim", "state.json")), false);
    engine.forget(ticket?.ticket as number);
    assert.deepEqual(engine.pending(), []);
  } finally {
    engine.close();
  }
});

test("corrupt queued work becomes visible failures and does not stop the pump", async () => {
  const root = project({ name: "quick", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] });
  mkdirSync(join(root, ".orchy"), { recursive: true });
  const file = join(root, ".orchy", "index.db");
  const store = open(file);
  const broken = store.acceptWork({
    kind: "start",
    flowName: "broken",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId: "broken",
    payload: { kind: "start" },
  });
  const extra = store.acceptWork({
    kind: "start",
    flowName: "extra",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId: "extra",
    payload: { kind: "start" },
  });
  const combination = store.acceptWork({
    kind: "resume",
    flowName: "combination",
    path: join(root, "flow.yaml"),
    harness: "pi",
    runId: "combination",
    acceptedRevision: 2,
    payload: { kind: "resume", hasValue: false },
  });
  const columns = store.acceptWork({
    kind: "start",
    flowName: "columns",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId: "columns",
    payload: { kind: "start" },
  });
  store.acceptWork({
    kind: "start",
    flowName: "quick",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId: "healthy",
    payload: { kind: "start" },
  });
  store.close();
  const raw = new DatabaseSync(file);
  raw.prepare("update accepted_work set version = 99 where ticket = ?").run(broken?.ticket as number);
  raw.prepare(`update accepted_work set payloadJson = '{"kind":"start","extra":true}' where ticket = ?`).run(
    extra?.ticket as number,
  );
  raw.prepare(
    `update accepted_work set payloadJson = '{"kind":"resume","hasValue":false,"value":true,"gate":"ask"}' where ticket = ?`,
  ).run(combination?.ticket as number);
  raw.prepare("update accepted_work set acceptedRevision = 4 where ticket = ?").run(columns?.ticket as number);
  raw.close();

  const engine = daemon(root, false);
  try {
    await until(async () => engine.state("healthy")?.status === "done");
    const pending = engine.pending();
    assert.match(pending.find((ticket) => ticket.ticket === broken?.ticket)?.error ?? "", /unsupported version 99/);
    assert.match(pending.find((ticket) => ticket.ticket === extra?.ticket)?.error ?? "", /unknown field "extra"/);
    assert.match(
      pending.find((ticket) => ticket.ticket === combination?.ticket)?.error ?? "",
      /value or gate while it says it has no value/,
    );
    assert.match(pending.find((ticket) => ticket.ticket === columns?.ticket)?.error ?? "", /inconsistent run fields/);
    assert.equal(pending.filter((ticket) => ticket.status === "failed").length, 4);
  } finally {
    await engine.close();
  }
});

test("a graceful close leaves queued work for the next daemon", async () => {
  const root = project(SLOW);
  writeFileSync(
    join(root, "quick.yaml"),
    formatFlow({ name: "quick", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] } as never),
  );
  const first = daemon(root, false);
  for (let count = 0; count < 4; count += 1) {
    first.start({ path: join(root, "flow.yaml"), flowName: "slow", harness: "pi" });
  }
  const queued = first.start({ path: join(root, "quick.yaml"), flowName: "quick", harness: "pi" });
  await until(async () => first.pending().find((ticket) => ticket.ticket === queued.ticket)?.status === "queued");
  assert.throws(() => first.forget(queued.ticket), /queued, so it cannot be dismissed/);
  const plannedRunId = first.store.work(queued.ticket)?.plannedRunId as string;
  await first.close();

  const second = daemon(root, false);
  try {
    await until(async () => second.state(plannedRunId)?.status === "done");
  } finally {
    await second.close();
  }
});

test("two stores make one scheduled receipt and one timestamp", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-schedule-work-"));
  const file = join(root, "index.db");
  const first = open(file);
  const flow = first.addFlow(join(root, "flow.yaml"), "scheduled", "pi");
  first.setSchedule(flow.id, 15);
  const second = open(file);
  const at = new Date().toISOString();
  const work = (plannedRunId: string) => ({
    kind: "start" as const,
    flowName: "scheduled",
    path: join(root, "flow.yaml"),
    harness: "pi",
    plannedRunId,
    payload: { kind: "start" as const },
  });
  try {
    const one = first.acceptWork(work("one"), { flowId: flow.id, at });
    const two = second.acceptWork(work("two"), { flowId: flow.id, at });
    assert.ok(one);
    assert.equal(two, undefined);
    assert.equal(first.works().length, 1);
    assert.equal(first.schedule(flow.id)?.lastAt, at);
  } finally {
    first.close();
    second.close();
  }
});

test("a second daemon cannot abandon a run the first daemon drives", async () => {
  const root = project(SLOW);
  const first = daemon(root, false);
  let second: ReturnType<typeof daemon> | undefined;
  try {
    const ticket = first.start({ path: join(root, "flow.yaml"), flowName: "slow", harness: "pi" });
    await until(async () => first.pending().some((one) => one.ticket === ticket.ticket && one.runId !== undefined));
    const runId = first.pending().find((one) => one.ticket === ticket.ticket)?.runId as string;
    second = daemon(root, false);

    await assert.rejects(() => second?.abandon(runId) as Promise<boolean>, /already on its way/);
    assert.equal(first.state(runId)?.status, "running");
    first.stop(runId);
  } finally {
    second?.close(false);
    first.close();
  }
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

test("a failed run's row says why, so a list answers without opening the run", () => {
  const record = {
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
  };
  // The fault of one step reads under the name of the step that holds it.
  const step = rowOf(
    {
      runId: "one",
      flow: { name: "broken", steps: [] },
      status: "failed",
      steps: { review: { ...record, status: "failed", error: "the value does not match returns" } },
      cycles: {},
    },
    "flow.yaml",
  );
  assert.equal(step.error, "review: the value does not match returns");

  // A fault of the run itself outranks the steps: it is the nearer answer.
  const run = rowOf(
    {
      runId: "two",
      flow: { name: "broken", steps: [] },
      status: "failed",
      error: "the run reached its budget",
      steps: { review: { ...record, status: "failed", error: "the value does not match returns" } },
      cycles: {},
    },
    "flow.yaml",
  );
  assert.equal(run.error, "the run reached its budget");

  // A run that did not fail carries no reason, whatever its steps went through.
  const done = rowOf(
    {
      runId: "three",
      flow: { name: "recovered", steps: [] },
      status: "done",
      steps: { review: { ...record, status: "done", value: { approved: true } } },
      cycles: {},
    },
    "flow.yaml",
  );
  assert.equal(done.error, null);
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

test("symbolic links cannot carry HTTP file reads or writes outside the root", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "orchy-outside-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  writeFileSync(join(outside, "flow.yaml"), formatFlow(FLOW as never));
  symlinkSync(outside, join(root, "link"));
  const site = await running(root);
  try {
    const read = await site.call("/api/file?path=link/secret.txt");
    assert.equal(read.code, 400);
    assert.match((read.body as { error: string }).error, /outside the root/);

    const write = await site.call("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: "link/new.txt", content: "escaped" }),
    });
    assert.equal(write.code, 400);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "secret");

    const registered = await site.call("/api/flows", {
      method: "POST",
      body: JSON.stringify({ path: "link/flow.yaml" }),
    });
    assert.equal(registered.code, 400);
    assert.deepEqual((await site.call("/api/flows")).body, []);
  } finally {
    await site.close();
  }
});

test("the HTTP door refuses named files that resolve outside the root", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "orchy-named-outside-"));
  writeFileSync(join(outside, "named.md"), "outside");
  symlinkSync(outside, join(root, "link"));
  const site = await running(root);
  const flows = [
    { name: "prompt", steps: [{ id: "one", kind: "agent", prompt: "link/named.md", tools: ["read"], returns: NUMBER }] },
    { name: "module", steps: [{ id: "one", kind: "call", module: "link/named.md", returns: NUMBER }] },
    { name: "inner", steps: [{ id: "one", kind: "flow", flow: "link/named.md" }] },
  ];
  try {
    for (const flow of flows) {
      writeFileSync(join(root, "named.yaml"), formatFlow(flow as never));
      const answer = await site.call("/api/flows", {
        method: "POST",
        body: JSON.stringify({ path: "named.yaml" }),
      });
      assert.equal(answer.code, 400);
      assert.match((answer.body as { error: string }).error, /outside the root/);
    }
  } finally {
    await site.close();
  }
});

test("the HTTP flow list refuses a registered file replaced by an outside link", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "orchy-row-outside-"));
  writeFileSync(join(outside, "flow.yaml"), formatFlow(FLOW as never));
  const site = await running(root);
  try {
    assert.equal(
      (await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) })).code,
      200,
    );
    unlinkSync(join(root, "flow.yaml"));
    symlinkSync(join(outside, "flow.yaml"), join(root, "flow.yaml"));

    const listed = await site.call("/api/flows");
    assert.equal(listed.code, 400);
    assert.match((listed.body as { error: string }).error, /outside the root/);
  } finally {
    await site.close();
  }
});

test("a malformed route does not stop the HTTP daemon", async () => {
  const site = await running(project());
  try {
    const malformed = await site.raw("/api/runs/%ZZ", { host: `127.0.0.1:${site.port}` });
    assert.equal(malformed.code, 400);
    assert.match(malformed.error as string, /malformed|encoding/i);
    assert.equal((await site.call("/api/health")).code, 200);
  } finally {
    await site.close();
  }
});

test("component stdout cannot crash or control the daemon", async () => {
  const flow = { name: "noisy", steps: [{ id: "noise", kind: "call", module: "noisy.ts", returns: NUMBER }] };
  const site = await running(project(flow));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "done");
    assert.equal((await site.call("/api/health")).code, 200);
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
      error: null,
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
    const stopping = site.call(`/api/runs/${row?.runId}/stop`, { method: "POST" });
    await new Promise((wait) => setTimeout(wait, 200));
    assert.equal(site.engine.state(row?.runId as string)?.status, "running");

    const stopped = await stopping;
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

test("a stop cancels a queued gate answer before the closing child can start it", async () => {
  const root = project({ name: "one-gate", steps: [TWO_GATES.steps[0]] });
  const engine = daemon(root);
  let stopping: Promise<boolean> | undefined;
  let fault: unknown;
  const unwatch = engine.watch((notice) => {
    if (notice.kind !== "event" || notice.event.type !== "waiting" || stopping) return;
    try {
      const state = engine.state(notice.runId);
      engine.resume(notice.runId, { approved: true }, "pi", undefined, "first", state?.revision);
      stopping = engine.stop(notice.runId);
    } catch (error) {
      fault = error;
    }
  });

  try {
    engine.start({ path: "flow.yaml", flowName: "one-gate", harness: "pi" });
    await until(async () => stopping !== undefined || fault !== undefined);
    if (fault) throw fault;
    assert.equal(await stopping, true);
    const [state] = engine.store.runs();
    assert.equal(state?.status, "stopped");
    assert.equal(engine.state(state?.runId as string)?.waitingFor, undefined);
    assert.equal(engine.state(state?.runId as string)?.steps.first, undefined);
    assert.equal(engine.store.works().some((work) => work.kind === "resume"), false);
  } finally {
    unwatch();
    await engine.close();
  }
});

test("stopping a run ends a command descendant before it can write", async () => {
  const root = project({
    name: "descendant",
    steps: [
      {
        id: "wait",
        kind: "call",
        command: `${process.execPath} -e 'const { spawn } = require("node:child_process"); const fs = require("node:fs"); fs.writeFileSync("started", "yes"); const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); require(\\"node:fs\\").writeFileSync(\\"descendant-ready\\", \\"yes\\"); setTimeout(() => require(\\"node:fs\\").writeFileSync(\\"late\\", \\"yes\\"), 5000); setTimeout(() => {}, 8000)"], { stdio: "ignore" }); child.unref(); setTimeout(() => {}, 8000)'`,
        returns: NUMBER,
      },
    ],
  });
  const site = await running(root);
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => existsSync(join(root, "descendant-ready")));
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const stateFile = join(root, ".orchy", "runs", row?.runId as string, "state.json");
    const pid = (JSON.parse(readFileSync(stateFile, "utf8")) as { pid: number }).pid;

    const realKill = process.kill.bind(process);
    let forced = false;
    mock.method(
      process,
      "kill",
      ((target: number, signal?: number | NodeJS.Signals) => {
        if (target === -pid && signal === "SIGKILL") {
          forced = true;
          return true;
        }
        return realKill(target, signal as NodeJS.Signals);
      }) as typeof process.kill,
    );

    const firstStop = site.call(`/api/runs/${row?.runId}/stop`, { method: "POST" });
    await until(async () => forced);
    assert.doesNotThrow(() => realKill(-pid, 0));
    const [during] = (await site.call("/api/runs")).body as Array<{ status: string }>;
    assert.equal(during?.status, "running");
    const failed = await firstStop;
    assert.equal(failed.code, 400);

    mock.restoreAll();
    const stopped = await site.call(`/api/runs/${row?.runId}/stop`, { method: "POST" });
    assert.equal(stopped.code, 200);
    await new Promise((wait) => setTimeout(wait, 2000));

    assert.equal(existsSync(join(root, "late")), false);
    assert.equal(site.engine.state(row?.runId as string)?.status, "stopped");
  } finally {
    mock.restoreAll();
    await site.close();
  }
});

test("a failed forced stop never reports or records stopped", async () => {
  const root = project(SLOW);
  const site = await running(root);
  let pid = 0;
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "running");
    const [row] = (await site.call("/api/runs")).body as Array<{ runId: string }>;
    const stateFile = join(root, ".orchy", "runs", row?.runId as string, "state.json");
    pid = (JSON.parse(readFileSync(stateFile, "utf8")) as { pid: number }).pid;
    const realKill = process.kill.bind(process);
    mock.method(
      process,
      "kill",
      ((target: number, signal?: number | NodeJS.Signals) => {
        if (target !== -pid) return realKill(target, signal as NodeJS.Signals);
        if (signal === "SIGTERM") return realKill(pid, signal);
        if (signal === "SIGKILL") return realKill(pid, signal);
        return true;
      }) as typeof process.kill,
    );

    await assert.rejects(site.engine.stop(row?.runId as string), /did not end after SIGKILL/);
    mock.restoreAll();
    assert.equal(site.engine.state(row?.runId as string)?.status, "running");
    const [during] = (await site.call("/api/runs")).body as Array<{ status: string }>;
    assert.equal(during?.status, "running");
    assert.equal(await site.engine.abandon(row?.runId as string), false);
    assert.equal(await site.engine.stop(row?.runId as string), true);
    assert.equal(site.engine.state(row?.runId as string)?.status, "stopped");
  } finally {
    mock.restoreAll();
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The successful second stop already ended the group.
      }
    }
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
      body: JSON.stringify({ value: { approved: "yes please" }, revision: await revisionOf(site, row?.runId as string) }),
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
    const firstRevision = await revisionOf(site, row?.runId as string);

    // One person answers the first question. Another was still reading it.
    await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: true }, step: "first", revision: firstRevision }),
    });
    await until(async () => (await waiting())?.waitingFor === "second");

    // Their answer was written for "first", and the run has moved on: it must
    // not be recorded as the answer to a question they never read.
    const crossed = await site.call(`/api/runs/${row?.runId}/resume`, {
      method: "POST",
      body: JSON.stringify({ value: { approved: false }, step: "first", revision: firstRevision }),
    });

    assert.equal(crossed.code, 400);
    assert.match((crossed.body as { error: string }).error, /waits at "second", and this answer is for "first"/);
    assert.equal((await waiting())?.waitingFor, "second");
  } finally {
    await site.close();
  }
});

test("two answers for one revision produce one ticket", async () => {
  const site = await running(project(TWO_GATES));
  try {
    await site.call("/api/flows", { method: "POST", body: JSON.stringify({ path: "flow.yaml" }) });
    await site.call("/api/flows/1/runs", { method: "POST", body: "{}" });
    await until(async () => ((await site.call("/api/runs")).body as Array<{ status: string }>)[0]?.status === "waiting");
    const held = (await site.call(`/api/runs/${((await site.call("/api/runs")).body as Array<{ runId: string }>)[0]?.runId}`))
      .body as { state: { runId: string; revision: number } };
    const body = (approved: boolean) =>
      JSON.stringify({ value: { approved }, step: "first", revision: held.state.revision });

    const answers = await Promise.all([
      site.call(`/api/runs/${held.state.runId}/resume`, { method: "POST", body: body(true) }),
      site.call(`/api/runs/${held.state.runId}/resume`, { method: "POST", body: body(false) }),
    ]);

    assert.deepEqual(answers.map((one) => one.code).sort(), [200, 400]);
    const refused = answers.find((one) => one.code === 400) as { body: { error: string } };
    assert.match(refused.body.error, /already has an answer/);
  } finally {
    await site.close();
  }
});

test("two daemons accept one resume, and the next gate accepts another", async () => {
  const root = project(TWO_GATES);
  const first = daemon(root, false);
  const second = daemon(root, false);
  try {
    first.start({ path: join(root, "flow.yaml"), flowName: "two-gates", harness: "pi" });
    await until(async () => first.store.runs()[0]?.waitingFor === "first");
    await new Promise((wait) => setTimeout(wait, 100));
    const runId = first.store.runs()[0]?.runId as string;
    const revision = first.state(runId)?.revision as number;
    const accepted: Ticket[] = [];
    const refused: Error[] = [];
    for (const engine of [first, second]) {
      try {
        accepted.push(engine.resume(runId, { approved: true }, "pi", undefined, "first", revision));
      } catch (error) {
        refused.push(error as Error);
      }
    }
    assert.equal(accepted.length, 1);
    assert.equal(refused.length, 1);
    assert.match(refused[0]?.message ?? "", /accepted work|already has an answer/);

    await until(async () => first.store.run(runId)?.waitingFor === "second");
    await new Promise((wait) => setTimeout(wait, 100));
    const nextRevision = first.state(runId)?.revision as number;
    assert.doesNotThrow(() => second.resume(runId, { approved: false }, "pi", undefined, "second", nextRevision));
    await until(async () => first.state(runId)?.status === "done");
  } finally {
    await first.close();
    await second.close();
  }
});
