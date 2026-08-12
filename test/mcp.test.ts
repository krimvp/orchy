import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
function talking(root: string) {
  const engine = daemon(root, false);
  const input = new PassThrough();
  const output = new PassThrough();
  mcp(engine, "pi", input, output);

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
  } finally {
    site.close();
  }
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
    assert.equal((await row())?.question, "Is the count correct?");

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
  } finally {
    site.close();
  }
});
