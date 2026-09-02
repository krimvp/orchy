import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { daemon } from "../src/daemon.ts";
import { mcp } from "../src/mcp.ts";
import { formatFlow } from "../src/yaml.ts";

const COUNT = `export default (inputs: Record<string, unknown>) => ({ count: Object.keys(inputs).length });\n`;

const NUMBER = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

/** A flow of two deterministic steps and a gate, so a test needs no model. */
const GATED = {
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

/** A flow whose step needs a prompt file, so a test can write one after it. */
const PROMPTED = {
  name: "prompted",
  harness: "pi",
  steps: [{ id: "work", kind: "agent", prompt: "prompts/work.md", tools: ["read"], returns: NUMBER }],
};

const BROKEN = {
  name: "broken",
  steps: [{ id: "one", kind: "call", needs: ["ghost"], module: "count.ts", returns: NUMBER }],
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orchy-mcp-"));
  writeFileSync(join(root, "count.ts"), COUNT);
  return root;
}

/** Opens the door over two streams, and gives back a client that speaks its lines. */
function talking(root: string, startedBy?: { runId: string; step: string }) {
  const engine = daemon(root, false);
  const input = new PassThrough();
  const output = new PassThrough();
  mcp(engine, "pi", input, output, startedBy);

  let count = 0;
  const waits = new Map<number, (message: Record<string, unknown>) => void>();
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    const parts = `${rest}${chunk.toString()}`.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) waits.get(message.id)?.(message as Record<string, unknown>);
    }
  });

  const send = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((done) => {
      count += 1;
      waits.set(count, done);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: count, method, params })}\n`);
    });

  /** Calls one tool, and reads its one text block back as data or as a reason. */
  const call = async (name: string, args?: unknown) => {
    const answer = (await send("tools/call", { name, arguments: args })) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    const text = answer.result.content[0]?.text ?? "";
    return answer.result.isError === true
      ? { refused: text, body: undefined as never }
      : { refused: undefined, body: JSON.parse(text) as never };
  };

  return { engine, send, call, close: () => engine.close() };
}

/** Waits for a state that a child process reaches, and gives up after 30 seconds. */
async function until(ready: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    if (await ready()) return;
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error("the run never reached the state the test waits for");
}

test("the door answers initialize with its guide, and lists every tool", async () => {
  const site = talking(project());
  try {
    const opened = (await site.send("initialize", { protocolVersion: "2025-06-18" })) as {
      result: { serverInfo: { name: string }; instructions: string; capabilities: { tools: unknown } };
    };
    assert.equal(opened.result.serverInfo.name, "orchy");
    assert.ok(opened.result.capabilities.tools);
    // The guide names the tools and the harnesses from the tables, so no copy falls behind.
    assert.match(opened.result.instructions, /check_flow/);
    assert.match(opened.result.instructions, /"pi" supplies/);
    // The guide names the root, so an agent never has to find it.
    assert.ok(opened.result.instructions.includes(site.engine.root));
    // A client shows the first 2048 characters of a guide and cuts the rest,
    // so a guide that grows past this ends mid-word for the agent that reads it.
    assert.ok(
      opened.result.instructions.length < 1980,
      `the guide holds ${opened.result.instructions.length} characters, and a client cuts it at 2048`,
    );

    const listed = (await site.send("tools/list")) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "check_flow",
        "write_flow",
        "read_flow",
        "list_flows",
        "run_flow",
        "read_run",
        "read_trajectory",
        "list_runs",
        "resume_run",
        "stop_run",
        "recall_memory",
        "remember",
      ],
    );

    const unknown = (await site.send("nothing/here")) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
  } finally {
    site.close();
  }
});

test("check_flow says what is wrong with a flow, and an empty answer means valid", async () => {
  const site = talking(project());
  try {
    const wrong = await site.call("check_flow", { yaml: formatFlow(BROKEN as never) });
    assert.match((wrong.body as { problems: string[] }).problems[0] as string, /needs "ghost"/);

    const bad = await site.call("check_flow", { yaml: ": not yaml : [" });
    assert.match((bad.body as { problems: string[] }).problems[0] as string, /not valid/);

    const good = await site.call("check_flow", { yaml: formatFlow(GATED as never) });
    assert.deepEqual((good.body as { problems: string[] }).problems, []);
  } finally {
    site.close();
  }
});

test("write_flow refuses a flow that does not validate, and writes nothing", async () => {
  const root = project();
  const site = talking(root);
  try {
    const refused = await site.call("write_flow", { path: "flows/broken/flow.yaml", yaml: formatFlow(BROKEN as never) });
    assert.match(refused.refused as string, /needs "ghost"/);
    assert.equal(existsSync(join(root, "flows", "broken", "flow.yaml")), false);
    assert.deepEqual(site.engine.store.flows(), []);
  } finally {
    site.close();
  }
});

test("the door refuses a flow file outside the root, and names the root", async () => {
  const root = project();
  const site = talking(root);
  try {
    const refused = await site.call("write_flow", { path: "../escape.yaml", yaml: formatFlow(GATED as never) });
    assert.match(refused.refused as string, /outside the root/);
    assert.ok((refused.refused as string).includes(root), `the message names no root: ${refused.refused}`);

    // A refusal writes nothing: every prompt path is checked before any lands.
    const leak = await site.call("write_flow", {
      path: "flows/leak/flow.yaml",
      yaml: formatFlow(GATED as never),
      prompts: { "good.md": "fine", "../../../evil.md": "evil" },
    });
    assert.match(leak.refused as string, /outside the root/);
    assert.equal(existsSync(join(root, "flows", "leak", "good.md")), false);
  } finally {
    site.close();
  }
});

test("a root too long to name in the guide is pointed at instead, so the guide is never cut", async () => {
  const root = join(project(), "a-very-long-directory-name".repeat(6));
  mkdirSync(root, { recursive: true });
  const site = talking(root);
  try {
    const opened = (await site.send("initialize", { protocolVersion: "2025-06-18" })) as {
      result: { instructions: string };
    };
    assert.ok(
      opened.result.instructions.length < 2048,
      `the guide holds ${opened.result.instructions.length} characters, and a client cuts it at 2048`,
    );
    assert.match(opened.result.instructions, /list_flows names it in full/);
  } finally {
    site.close();
  }
});

test("the door leaves the runs it started to finish", async () => {
  const root = project();
  writeFileSync(
    join(root, "naps.ts"),
    "export default async () => { await new Promise((rest) => setTimeout(rest, 1500)); return { count: 1 }; };\n",
  );
  const site = talking(root);
  const slow = { name: "slow", steps: [{ id: "wait", kind: "call", module: "naps.ts", returns: NUMBER }] };
  await site.call("write_flow", { path: "slow.yaml", yaml: formatFlow(slow as never) });
  const started = (await site.call("run_flow", { path: "slow.yaml" })).body as { runId: string };

  // The door goes. The run is its own process and its state is on disk, so a
  // dispatcher's runs outlive the step that started them. ADR 0025.
  site.engine.close(false);
  await until(async () => {
    try {
      const state = JSON.parse(
        readFileSync(join(root, ".orchy", "runs", started.runId, "state.json"), "utf8"),
      ) as { status: string };
      return state.status === "done";
    } catch {
      return false;
    }
  });
});

test("a missing prompt is a warning the write answers, and run_flow refuses the flow until it is there", async () => {
  const root = project();
  const site = talking(root);
  try {
    const bare = await site.call("write_flow", { path: "flows/prompted/flow.yaml", yaml: formatFlow(PROMPTED as never) });
    assert.match((bare.body as { warnings: string[] }).warnings[0] as string, /prompt that is not there/);

    const early = await site.call("run_flow", { path: "flows/prompted/flow.yaml" });
    assert.match(early.refused as string, /names files that are not there/);

    const whole = await site.call("write_flow", {
      path: "flows/prompted/flow.yaml",
      yaml: formatFlow(PROMPTED as never),
      prompts: { "prompts/work.md": "Count the inputs.\n" },
    });
    assert.deepEqual((whole.body as { warnings: string[] }).warnings, []);
    assert.equal(existsSync(join(root, "flows", "prompted", "prompts", "work.md")), true);
  } finally {
    site.close();
  }
});

test("a name that nothing supplies is named at the write, and refused before a run spends", async () => {
  const site = talking(project());
  try {
    // The question reads a name outside "takes", so check_flow warns with no file at all.
    const asking = {
      name: "asking",
      takes: { type: "object", properties: { issue: { type: "number" } } },
      steps: [{ id: "ask", kind: "gate", question: "Ship {{ ticket }}?", returns: NUMBER }],
    };
    const checked = (await site.call("check_flow", { yaml: formatFlow(asking as never) })).body as {
      problems: string[];
      warnings: string[];
    };
    assert.deepEqual(checked.problems, []);
    assert.match(checked.warnings[0] as string, /nothing supplies "ticket"/);

    // The prompt reads the same hole, and the write names it once the file is there.
    const prompted = {
      name: "prompted",
      harness: "pi",
      steps: [{ id: "work", kind: "agent", prompt: "prompts/work.md", tools: ["read"], returns: NUMBER }],
    };
    const written = await site.call("write_flow", {
      path: "flows/holey/flow.yaml",
      yaml: formatFlow(prompted as never),
      prompts: { "prompts/work.md": "Fix issue {{ issue }}.\n" },
    });
    assert.match((written.body as { warnings: string[] }).warnings[0] as string, /nothing supplies "issue"/);

    // The run is refused at the door, before the steps before the hole spend money.
    const started = await site.call("run_flow", { path: "flows/holey/flow.yaml" });
    assert.match(started.refused as string, /nothing supplies "issue"/);
  } finally {
    site.close();
  }
});

test("a run a step starts records the run that started it, and the parent lists it", async () => {
  const root = project();
  const solo = { name: "solo", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] };
  const parent = talking(root);
  let child: ReturnType<typeof talking> | undefined;
  try {
    await parent.call("write_flow", { path: "flows/solo/flow.yaml", yaml: formatFlow(solo as never) });
    writeFileSync(join(root, "flows", "solo", "count.ts"), COUNT);
    const first = (await parent.call("run_flow", { path: "flows/solo/flow.yaml" })).body as { runId: string };
    const settled = async (site: ReturnType<typeof talking>, runId: string) => {
      const held = await site.call("read_run", { runId, wait: 30 });
      return held.refused ? undefined : (held.body as { row: { status: string } | null }).row?.status;
    };
    await until(async () => (await settled(parent, first.runId)) === "done");

    // A second door speaks for a step of that run, the way an adapter opens one.
    child = talking(root, { runId: first.runId, step: "spawn" });
    const second = (await child.call("run_flow", { path: "flows/solo/flow.yaml" })).body as { runId: string };
    await until(async () => (await settled(child as ReturnType<typeof talking>, second.runId)) === "done");

    assert.deepEqual(child.engine.state(second.runId)?.startedBy, { runId: first.runId, step: "spawn" });
    const held = (await parent.call("read_run", { runId: first.runId })).body as {
      children: Array<{ runId: string; step: string; status: string }>;
    };
    assert.equal(held.children[0]?.runId, second.runId);
    assert.equal(held.children[0]?.step, "spawn");
  } finally {
    child?.close();
    parent.close();
  }
});

test("a chain of runs stops at three, and the door names the way that still runs", async () => {
  const root = project();
  const runs = join(root, ".orchy", "runs");
  // Three runs stand on disk, each started by the one before it.
  const chain = [
    { runId: "r1", flow: { name: "a", steps: [] }, status: "done", steps: {}, cycles: {} },
    { runId: "r2", flow: { name: "b", steps: [] }, status: "done", steps: {}, cycles: {}, startedBy: { runId: "r1", step: "s" } },
    { runId: "r3", flow: { name: "c", steps: [] }, status: "done", steps: {}, cycles: {}, startedBy: { runId: "r2", step: "s" } },
  ];
  for (const state of chain) {
    mkdirSync(join(runs, state.runId), { recursive: true });
    writeFileSync(join(runs, state.runId, "state.json"), JSON.stringify(state));
  }
  const site = talking(root, { runId: "r3", step: "spawn" });
  try {
    await site.call("write_flow", {
      path: "flows/solo/flow.yaml",
      yaml: formatFlow({ name: "solo", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] } as never),
    });
    const refused = await site.call("run_flow", { path: "flows/solo/flow.yaml" });
    assert.match(refused.refused as string, /stops at 3/);
    assert.match(refused.refused as string, /"flow" step/);
  } finally {
    site.close();
  }
});

test("a step starts only the flows its bound names, and only so many", async () => {
  const root = project();
  const solo = { name: "solo", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] };
  const other = { name: "other", steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }] };
  // The run that asks holds a bound: one flow, one start. ADR 0027.
  const allowed = join(root, "flows", "solo", "flow.yaml");
  const boss = {
    runId: "boss",
    flow: {
      name: "bossy",
      steps: [
        {
          id: "dispatch",
          kind: "agent",
          needs: [],
          prompt: "p.md",
          tools: ["orchy"],
          starts: { flows: [allowed], most: 1 },
          returns: {},
        },
      ],
    },
    status: "waiting",
    steps: {},
    cycles: {},
  };
  mkdirSync(join(root, ".orchy", "runs", "boss"), { recursive: true });
  writeFileSync(join(root, ".orchy", "runs", "boss", "state.json"), JSON.stringify(boss));

  const site = talking(root, { runId: "boss", step: "dispatch" });
  try {
    await site.call("write_flow", { path: "flows/solo/flow.yaml", yaml: formatFlow(solo as never) });
    await site.call("write_flow", { path: "flows/other/flow.yaml", yaml: formatFlow(other as never) });
    writeFileSync(join(root, "flows", "solo", "count.ts"), COUNT);
    writeFileSync(join(root, "flows", "other", "count.ts"), COUNT);

    const outside = await site.call("run_flow", { path: "flows/other/flow.yaml" });
    assert.match(outside.refused as string, /starts only/);
    assert.ok((outside.refused as string).includes(allowed));

    const first = (await site.call("run_flow", { path: "flows/solo/flow.yaml" })).body as { runId: string };
    assert.ok(first.runId, "the allowed flow did not start");
    await until(async () => {
      const held = await site.call("read_run", { runId: first.runId, wait: 30 });
      return !held.refused && (held.body as { row: { status: string } | null }).row?.status === "done";
    });

    const again = await site.call("run_flow", { path: "flows/solo/flow.yaml" });
    assert.match(again.refused as string, /at most 1 run/);
    assert.match(again.refused as string, /Every run counts/);
  } finally {
    site.close();
  }
});

test("check_flow reads a prompt before it is written, and names the hole in it", async () => {
  const site = talking(project());
  try {
    const prompted = {
      name: "prompted",
      harness: "pi",
      steps: [{ id: "work", kind: "agent", prompt: "prompts/work.md", tools: ["read"], returns: NUMBER }],
    };
    const checked = (
      await site.call("check_flow", {
        yaml: formatFlow(prompted as never),
        prompts: { "prompts/work.md": "Fix issue {{ ghost }}.\n" },
      })
    ).body as { problems: string[]; warnings: string[] };
    assert.deepEqual(checked.problems, []);
    assert.match(checked.warnings[0] as string, /nothing supplies "ghost"/);

    // A dotted spelling of the same path finds the same prompt.
    const dotted = (
      await site.call("check_flow", {
        yaml: formatFlow(prompted as never),
        prompts: { "./prompts/work.md": "Fix issue {{ ghost }}.\n" },
      })
    ).body as { warnings: string[] };
    assert.match(dotted.warnings[0] as string, /nothing supplies "ghost"/);
  } finally {
    site.close();
  }
});

test("an agent writes a flow, runs it, answers the gate, and reads the value of the run", async () => {
  const site = talking(project());
  try {
    // The leading comment of the file is the description of the flow.
    const written = await site.call("write_flow", {
      path: "flows/gated/flow.yaml",
      yaml: `# Counts, asks, and counts again.\n${formatFlow(GATED as never)}`,
    });
    assert.equal((written.body as { flow: { name: string } }).flow.name, "gated");

    // The flow names a module beside itself, so the agent writes that too.
    writeFileSync(join(site.engine.root, "flows", "gated", "count.ts"), COUNT);

    const [flow] = (await site.call("list_flows")).body as Array<{ description: string }>;
    assert.equal(flow?.description, "Counts, asks, and counts again.");

    const started = (await site.call("run_flow", { path: "flows/gated/flow.yaml" })).body as { runId?: string };
    assert.ok(started.runId, "the answer holds no run id");
    const runId = started.runId as string;

    // The door refuses a resume by the row, so the row is what the agent waits on.
    const row = async () => {
      const held = await site.call("read_run", { runId });
      return held.refused ? undefined : (held.body as { row: { status: string; question?: string } | null }).row;
    };
    await until(async () => (await row())?.status === "waiting");
    assert.equal((await row())?.question?.startsWith("Is the count correct?"), true);

    // The contract of the gate refuses a wrong answer at the door.
    const crossed = await site.call("resume_run", { runId, value: { approved: "yes please" } });
    assert.match(crossed.refused as string, /breaks the contract/);

    // The answer crosses the protocol as JSON text, and text that is not JSON says so.
    const loose = await site.call("resume_run", { runId, value: "yes please" });
    assert.match(loose.refused as string, /not JSON/);

    const answered = await site.call("resume_run", { runId, value: '{"approved":true}', step: "ask" });
    assert.equal(answered.refused, undefined);
    await until(async () => (await row())?.status === "done");

    const run = (await site.call("read_run", { runId })).body as {
      state: { steps: Record<string, { value?: unknown; answeredByPerson?: boolean }> };
    };
    assert.deepEqual(run.state.steps.first?.value, { count: 0 });
    assert.equal(run.state.steps.ask?.answeredByPerson, true);
    assert.deepEqual(run.state.steps.last?.value, { count: 1 });

    const listed = (await site.call("list_runs")).body as { runs: Array<{ runId: string; status: string }> };
    assert.equal(listed.runs[0]?.runId, runId);
    assert.equal(listed.runs[0]?.status, "done");

    // A refusal the child writes answers the resume itself, not only the queue.
    const wrong = await site.call("resume_run", { runId, from: "nope" });
    assert.match(wrong.refused as string, /no step "nope"/);
  } finally {
    site.close();
  }
});

/** A run on disk that a step's door belongs to, so the door reads its store. */
function standing(root: string, state: Record<string, unknown>): void {
  const at = join(root, ".orchy", "runs", String(state.runId));
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "state.json"), JSON.stringify(state));
}

const REMEMBERING = {
  runId: "r1",
  flow: {
    name: "bugfix",
    memory: { scope: "ticket/{{ issue }}" },
    steps: [
      { id: "code", kind: "agent", needs: [], prompt: "p.md", tools: ["read", "orchy"], returns: NUMBER },
      { id: "review", kind: "agent", needs: ["code"], memory: "none", prompt: "p.md", tools: ["read", "orchy"], returns: NUMBER },
    ],
  },
  status: "running",
  steps: {},
  cycles: {},
  memory: { key: "ticket-proj-14", most: 20 },
};

test("a step records through the door, and reads back only the store of its own run", async () => {
  const root = project();
  standing(root, REMEMBERING);
  // A second run, of another ticket, whose store the first must not reach.
  standing(root, { ...REMEMBERING, runId: "r2", memory: { key: "ticket-proj-99", most: 20 } });

  const site = talking(root, { runId: "r1", step: "code" });
  const other = talking(root, { runId: "r2", step: "code" });
  try {
    const written = await site.call("remember", { text: "the parser lives in src/yaml.ts", tags: ["where"] });
    assert.equal((written.body as { scope: string }).scope, "ticket-proj-14");
    // The entry names the run and the step, so a wrong one is found and dropped.
    const entry = (written.body as { entry: { run: string; step: string; id: string } }).entry;
    assert.equal(entry.run, "r1");
    assert.equal(entry.step, "code");

    await site.call("remember", { text: "the review wanted a line, not a comma" });
    const read = await site.call("recall_memory", {});
    assert.equal((read.body as { of: number }).of, 2);

    // A query keeps the entries that hold it, in the text or in a tag.
    const found = await site.call("recall_memory", { query: "parser" });
    assert.deepEqual((found.body as { entries: Array<{ text: string }> }).entries.map((one) => one.text), [
      "the parser lives in src/yaml.ts",
    ]);
    const tagged = (await site.call("recall_memory", { query: "where" })).body as { entries: unknown[] };
    assert.equal(tagged.entries.length, 1);

    // The key comes from the state of the run, and never from the call, so a
    // step cannot name the store of another ticket. There is nothing to ask for.
    const elsewhere = (await other.call("recall_memory", {})).body as { of: number; scope: string };
    assert.equal(elsewhere.of, 0);
    assert.equal(elsewhere.scope, "ticket-proj-99");
  } finally {
    other.close();
    site.close();
  }
});

test("the door refuses a memory to a step that declares none, and to a flow that declares none", async () => {
  const root = project();
  standing(root, REMEMBERING);
  standing(root, { ...REMEMBERING, runId: "quiet", flow: { name: "quiet", steps: [] }, memory: undefined });

  // A step that says it saw nothing but the work cannot reach past that word.
  const declined = talking(root, { runId: "r1", step: "review" });
  const forgetful = talking(root, { runId: "quiet", step: "code" });
  // A door an outside agent opened belongs to no run, so it has no store at all.
  const outside = talking(root);
  try {
    assert.match((await declined.call("recall_memory", {})).refused as string, /declares memory: none/);
    assert.match((await declined.call("remember", { text: "x" })).refused as string, /declares memory: none/);
    assert.match((await forgetful.call("recall_memory", {})).refused as string, /declares no memory/);
    assert.match((await outside.call("remember", { text: "x" })).refused as string, /belongs to a run/);
  } finally {
    outside.close();
    forgetful.close();
    declined.close();
  }
});
