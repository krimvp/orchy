import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { type AgentStep, type CallStep, type Flow, type GateStep, agent, call, expandFanout, expandFlows, flow, gate, resolvePaths, validate } from "../src/flow.ts";
import { LONGEST, keyOf, lines } from "../src/memory.ts";
import { loadFlow } from "../src/load.ts";
import type { AgentRequest, AgentResult, Harness } from "../src/harness.ts";
import { notesOf } from "../src/harness.ts";
import { type RunEvent, type RunState, list, resume, run } from "../src/run.ts";
import { tail } from "../src/tail.ts";
import { claude } from "../src/claude.ts";
import { costOf, pi } from "../src/pi.ts";
import { formatFlow, parseFlow } from "../src/yaml.ts";
import { changed, take } from "../src/workspace.ts";

const Summary = Type.Object({ summary: Type.String() });

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "orchy-"));
  writeFileSync(join(directory, "step.md"), "Do the work.");
  return directory;
}

/** Returns the given values in order, then starts the list again. A cycle re-runs
 * the steps in the same order, so the list repeats with them. */
function fakeHarness(...values: unknown[]): Harness & { seen: AgentRequest[] } {
  const seen: AgentRequest[] = [];
  return {
    seen,
    toTrajectory: () => undefined,
    async run(request: AgentRequest): Promise<AgentResult> {
      seen.push(request);
      return { value: values[(seen.length - 1) % values.length], trajectory: "/sessions/fake.jsonl" };
    },
  };
}

test("validate reports a duplicate id and a missing need", () => {
  const problems = validate({
    name: "broken",
    steps: [
      agent({ id: "a", prompt: "p.md", tools: ["read"], returns: Summary }),
      agent({ id: "a", needs: ["ghost"], prompt: "p.md", tools: ["read"], returns: Summary }),
    ],
  });

  assert.ok(problems.some((p) => p.includes('two steps use the id "a"')));
  assert.ok(problems.some((p) => p.includes('needs "ghost"')));
});

test("validate reports a loop", () => {
  const problems = validate({
    name: "circular",
    steps: [
      agent({ id: "a", needs: ["b"], prompt: "p.md", tools: ["read"], returns: Summary }),
      agent({ id: "b", needs: ["a"], prompt: "p.md", tools: ["read"], returns: Summary }),
    ],
  });

  assert.ok(problems.some((p) => p.includes("make a loop")));
});

test("validate reports a step that needs itself", () => {
  const problems = validate({
    name: "self",
    steps: [agent({ id: "a", needs: ["a"], prompt: "p.md", tools: ["read"], returns: Summary })],
  });

  assert.ok(problems.some((p) => p.includes("needs itself")));
});

test("validate accepts a flow that is in order", () => {
  const good = flow("fine", {
    steps: [
      agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary }),
      agent({ id: "two", needs: ["one"], prompt: "step.md", tools: ["read"], returns: Summary }),
    ],
  });

  assert.deepEqual(validate(good), []);
});

test("validate returns a problem for every malformed JSON value", () => {
  const values: unknown[] = [
    null,
    [],
    true,
    7,
    "flow",
    { name: "bad", steps: null },
    { name: "bad", steps: [null] },
    { name: "bad", steps: [{ id: "one", kind: "call", needs: null, command: "true", returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "agent", needs: [], prompt: "p.md", tools: null, returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "agent", needs: [], prompt: "p.md", tools: [], starts: null, returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "call", needs: [], command: "true", with: [], returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "call", needs: [], command: "true", fanout: false, returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "gate", needs: [], question: null, returns: {} }] },
    { name: "bad", steps: [{ id: "one", kind: "call", needs: [], command: "true", fanout: [null], returns: {} }] },
  ];

  for (const value of values) {
    assert.doesNotThrow(() => validate(value));
    assert.ok(validate(value).length > 0, `validate accepted ${JSON.stringify(value)}`);
  }
});

test("validate names the paths of a null step and a null fanout member", () => {
  assert.match(validate({ name: "bad", steps: [null] }).join("\n"), /"\/steps\/0"/);
  assert.match(
    validate({
      name: "bad",
      steps: [{ id: "one", kind: "call", needs: [], command: "true", fanout: [null], returns: {} }],
    }).join("\n"),
    /"\/steps\/0\/fanout\/0"/,
  );
});

test("run refuses a flow that is not valid", async () => {
  const bad = flow("bad", {
    steps: [agent({ id: "a", needs: ["ghost"], prompt: "step.md", tools: ["read"], returns: Summary })],
  });

  await assert.rejects(() => run(bad, { harness: fakeHarness({ summary: "x" }) }), /is not valid/);
});

test("a step runs after the steps it needs, and gets their values", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  // "second" is declared first, so passing proves the order comes from needs.
  const state = await run(
    flow("ordered", {
      steps: [
        agent({ id: "second", needs: ["first"], prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "first", prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(
    harness.seen.map((request) => request.prompt.includes("steps before this one")),
    [false, true],
  );
  assert.equal(state.steps.first?.trajectory, "/sessions/fake.jsonl");
});

test("the prompt names the working directory the step acts in", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  // A step that guesses this writes its file where invariant 5 cannot see it
  // and the step after it cannot read it.
  await run(flow("placed", { steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary })] }), {
    cwd,
    harness,
  });

  assert.match(harness.seen[0]?.prompt ?? "", /The working directory is `.+`\. Read and write by a path inside it\./);
  assert.ok(harness.seen[0]?.prompt.includes(cwd));
});

test("the declared tools reach the harness, and nothing else", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  await run(
    flow("tools", {
      steps: [agent({ id: "only", prompt: "step.md", tools: ["read", "grep"], returns: Summary })],
    }),
    { cwd, harness },
  );

  assert.deepEqual(harness.seen[0]?.tools, ["read", "grep"]);
});

test("a value that breaks the contract fails the run", async () => {
  const cwd = workspace();

  const state = await run(
    flow("contract", {
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ summary: 42 }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /breaks the contract/);
});

test("a later step does not run after an earlier step fails", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ wrong: true });

  const state = await run(
    flow("stop", {
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", needs: ["a"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  assert.equal(state.steps.b, undefined);
  assert.equal(harness.seen.length, 1);
});

test("the run state reaches the disk after each step", async () => {
  const cwd = workspace();

  const state = await run(
    flow("saved", {
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ summary: "done" }) },
  );

  const onDisk = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "state.json"), "utf8"));
  assert.equal(onDisk.runId, state.runId);
  assert.equal(onDisk.status, "done");
  assert.deepEqual(onDisk.steps, state.steps);
});

test("a call step runs a module and passes the values it needs", async () => {
  const cwd = workspace();
  writeFileSync(
    join(cwd, "double.ts"),
    "export default (inputs) => ({ summary: String(inputs.first.summary).toUpperCase() });",
  );

  const state = await run(
    flow("call", {
      steps: [
        agent({ id: "first", prompt: "step.md", tools: ["read"], returns: Summary }),
        call({ id: "second", needs: ["first"], module: "double.ts", returns: Summary }),
      ],
    }),
    { cwd, harness: fakeHarness({ summary: "quiet" }) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.second?.value, { summary: "QUIET" });
});

// -- The cycle, the gate, and resume --

const Verdict = Type.Object({ approved: Type.Boolean() });

function reviewFlow(limit: number, policy: "escalate" | "accept") {
  return flow("code-and-review", {
    steps: [
      agent({ id: "code", prompt: "step.md", tools: ["write"], returns: Summary }),
      agent({
        id: "review",
        needs: ["code"],
        prompt: "step.md",
        tools: ["read"],
        returns: Verdict,
        cycle: { to: "code", when: { approved: false }, limit, policy },
      }),
    ],
  });
}

test("validate rejects a cycle that points forward, an unknown key, and an empty condition", () => {
  const problems = validate(
    flow("wrong", {
      steps: [
        agent({
          id: "first",
          prompt: "p.md",
          tools: ["read"],
          returns: Verdict,
          cycle: { to: "second", when: { approved: false }, limit: 2, policy: "accept" },
        }),
        agent({
          id: "second",
          needs: ["first"],
          prompt: "p.md",
          tools: ["read"],
          returns: Verdict,
          cycle: { to: "first", when: {}, limit: 2, policy: "accept" },
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes("does not run before it")));
  assert.ok(problems.some((p) => p.includes("always cycles")));
});

test("validate rejects a cycle on a key the step does not return", () => {
  const problems = validate(
    flow("typo", {
      steps: [
        agent({ id: "a", prompt: "p.md", tools: ["read"], returns: Summary }),
        agent({
          id: "b",
          needs: ["a"],
          prompt: "p.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "a", when: { summary: "x", approved: false } as never, limit: 2, policy: "accept" },
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('cycles on "approved"')));
});

test("a step goes back when the condition matches, and stops when the value changes", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true });

  const state = await run(reviewFlow(3, "accept"), { cwd, harness });

  assert.equal(state.status, "done");
  assert.equal(state.cycles["review->code"], 1);
  assert.deepEqual(state.steps.code?.value, { summary: "v2" });
  assert.equal(harness.seen.length, 4);
});

test("the accept policy stops the cycle at its limit and records the disagreement", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v" }, { approved: false });

  const state = await run(reviewFlow(2, "accept"), { cwd, harness });

  assert.equal(state.status, "done");
  assert.equal(state.cycles["review->code"], 2);
  assert.equal(state.steps.review?.disagreement, "accepted");
});

test("the escalate policy stops the run for a person, and resume finishes it", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v" }, { approved: false });

  const stopped = await run(reviewFlow(1, "escalate"), { cwd, harness });

  assert.equal(stopped.status, "waiting");
  assert.equal(stopped.waitingFor, "review");
  assert.match(stopped.question ?? "", /reached its limit/);

  const finished = await resume(stopped.runId, { approved: true }, { cwd, harness });

  assert.equal(finished.status, "done");
  assert.equal(finished.steps.review?.answeredByPerson, true);
});

test("resume refuses a value that breaks the contract of the gate", async () => {
  const cwd = workspace();
  const stopped = await run(reviewFlow(1, "escalate"), {
    cwd,
    harness: fakeHarness({ summary: "v" }, { approved: false }),
  });

  await assert.rejects(() => resume(stopped.runId, { approved: "yes" }, { cwd }), /breaks the contract/);
});

test("a gate step stops the run before it runs anything after it", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v" });

  const gated = flow("gated", {
    steps: [
      gate({ id: "confirm", question: "Ship it?", returns: Verdict }),
      agent({ id: "after", needs: ["confirm"], prompt: "step.md", tools: ["read"], returns: Summary }),
    ],
  });

  const stopped = await run(gated, { cwd, harness });
  assert.equal(stopped.status, "waiting");
  assert.equal(stopped.question, "Ship it?");
  assert.equal(harness.seen.length, 0);

  const finished = await resume(stopped.runId, { approved: true }, { cwd, harness });
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.steps.confirm?.value, { approved: true });
  assert.equal(harness.seen.length, 1);
});

test("a run reports what it does through events", async () => {
  const cwd = workspace();
  const events: string[] = [];

  await run(reviewFlow(2, "accept"), {
    cwd,
    harness: fakeHarness({ summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true }),
    onEvent: (event) => events.push(event.type),
  });

  // A run names itself first, so a parent process knows the run it drives. Each
  // agent step says what it asked before it says what it did.
  assert.deepEqual(events, [
    "run_start",
    "step_start", "output", "step_end", "step_start", "output", "step_end", "cycle",
    "step_start", "output", "step_end", "step_start", "output", "step_end", "run_end",
  ]);
});

test("a run keeps the prompt it sent, and says it before the step works", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "ask.md"), "Count to {{ n }}.");
  const events: RunEvent[] = [];

  const state = await run(
    flow("asking", {
      takes: Type.Object({ n: Type.Number() }),
      steps: [agent({ id: "one", prompt: "ask.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, with: { n: 3 }, harness: fakeHarness({ summary: "v" }), onEvent: (event) => events.push(event) },
  );

  // A prompt lives in a file that a value fills in, so neither the file nor the
  // value alone says what the step was asked.
  assert.match(state.steps.one?.prompt ?? "", /^Count to 3\./);
  const said = events.find((event) => event.type === "output" && event.kind === "prompt");
  assert.match(said && said.type === "output" ? said.text : "", /^Count to 3\./);
});

test("a run keeps the value of the step it ends with", async () => {
  const cwd = workspace();

  const state = await run(
    flow("answering", {
      steps: [agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ summary: "the answer" }) },
  );

  assert.deepEqual(state.value, { summary: "the answer" });
});

test("a step that fails says why in its event, so a parent process reports it", async () => {
  const cwd = workspace();
  const events: RunEvent[] = [];

  const state = await run(
    flow("breaking", {
      steps: [agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ wrong: true }), onEvent: (event) => events.push(event) },
  );

  assert.equal(state.status, "failed");
  const [ended] = events.filter((event) => event.type === "step_end");
  assert.match(String(ended && "error" in ended ? ended.error : ""), /breaks the contract/);
  const [over] = events.filter((event) => event.type === "run_end");
  assert.match(String(over && "error" in over ? over.error : ""), /step "one" failed/);
});

test("a run refuses a value that the flow does not take", async () => {
  const cwd = workspace();

  await assert.rejects(
    () =>
      run(
        flow("narrow", {
          takes: Type.Object({ issue: Type.Number() }),
          steps: [agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary })],
        }),
        { cwd, with: { issue: 1, spare: "x" }, harness: fakeHarness({ summary: "v" }) },
      ),
    /does not take spare/,
  );
});

test("a second step that votes to cycle takes its turn when the first has spent its limit", async () => {
  const cwd = workspace();
  const votes = { approved: false };
  const reviewer = (id: string) =>
    agent({
      id,
      needs: ["code"],
      prompt: "step.md",
      tools: ["read"],
      returns: Verdict,
      cycle: { to: "code", when: { approved: false }, limit: 1, policy: "accept" },
    });

  const state = await run(
    flow("two-reviewers", {
      steps: [agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary }), reviewer("b"), reviewer("c")],
    }),
    { cwd, harness: fakeHarness({ summary: "v" }, votes, votes) },
  );

  // The first voter must not starve the second: each one spends its own limit.
  assert.deepEqual(state.cycles, { "b->code": 1, "c->code": 1 });
});

test("a resume names the run again, so a parent process follows it", async () => {
  const cwd = workspace();
  const events: string[] = [];
  const harness = fakeHarness({ summary: "v" });

  const gated = flow("gated", {
    steps: [
      gate({ id: "confirm", question: "Ship it?", returns: Verdict }),
      agent({ id: "after", needs: ["confirm"], prompt: "step.md", tools: ["read"], returns: Summary }),
    ],
  });

  const waiting = await run(gated, { cwd, harness });
  const finished = await resume(waiting.runId, { approved: true }, {
    cwd,
    harness,
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(finished.status, "done");
  assert.equal(events[0], "run_start");
});

// -- What a step reports while it works --

const wait = (millis: number) => new Promise((done) => setTimeout(done, millis));

test("tail reads a file as it grows, and holds a line that is half written", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orchy-tail-"));
  const file = join(directory, "session.jsonl");
  const seen: string[] = [];

  const stop = tail(
    () => (existsSync(file) ? file : undefined),
    (line) => seen.push(line),
  );
  writeFileSync(file, "one\ntwo\nthr");
  await wait(400);
  assert.deepEqual(seen, ["one", "two"]);

  appendFileSync(file, "ee\nfour\n");
  await wait(400);
  stop();

  assert.deepEqual(seen, ["one", "two", "three", "four"]);
});

test("a harness reports what a step does, and the run passes it on", async () => {
  const cwd = workspace();
  const talking: Harness = {
    toTrajectory: () => undefined,
    async run(_request, watch) {
      watch?.({ kind: "tool", text: "Read package.json" });
      watch?.({ kind: "text", text: "the file holds a name" });
      return { value: { summary: "v" } };
    },
  };

  const events: RunEvent[] = [];
  const one = flow("one", {
    steps: [agent({ id: "look", prompt: "step.md", tools: ["read"], returns: Summary })],
  });
  const state = await run(one, { cwd, harness: talking, onEvent: (event) => events.push(event) });

  assert.equal(state.status, "done");
  const output = events.filter((event) => event.type === "output");
  // The run says the prompt itself, and the harness says the rest.
  const said = output.filter((event) => event.kind !== "prompt");
  assert.deepEqual(
    said.map((event) => `${event.kind}: ${event.text}`),
    ["tool: Read package.json", "text: the file holds a name"],
  );
  assert.equal(
    output.every((event) => event.step === "look"),
    true,
  );
});

test("a deterministic step reports what it does through the same events", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "tells.ts"), `export default (_i, say) => { say("half way"); return { count: 1 }; };\n`);

  const events: RunEvent[] = [];
  const one = flow("one", {
    steps: [call({ id: "work", module: "tells.ts", returns: Type.Object({ count: Type.Number() }) })],
  });
  await run(one, { cwd, onEvent: (event) => events.push(event) });

  const output = events.filter((event) => event.type === "output");
  assert.deepEqual(output.map((event) => event.text), ["half way"]);
});

test("notesOf turns one step of a trajectory into what a person reads", () => {
  const notes = notesOf({
    step_id: 1,
    timestamp: "",
    source: "agent",
    message: "I will read the file.",
    reasoning_content: "the name is in the file",
    tool_calls: [{ tool_call_id: "1", function_name: "Read", arguments: { path: "a.ts" } }],
  });

  assert.deepEqual(notes, [
    { kind: "reasoning", text: "the name is in the file" },
    { kind: "text", text: "I will read the file." },
    { kind: "tool", text: 'Read {"path":"a.ts"}' },
  ]);
});

test("a note carries a line, not a file", () => {
  const [note] = notesOf({ step_id: 1, timestamp: "", source: "agent", message: "x".repeat(900) });
  assert.equal(note?.text.length, 401);
  assert.equal(note?.text.endsWith("…"), true);
});

// -- The workspace and invariant 5 --

function gitWorkspace(): string {
  const directory = workspace();
  const run = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  run("init", "-q");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("add", "step.md");
  run("commit", "-qm", "first");
  return directory;
}

/** A harness that acts in the workspace before it answers, like an agent with `bash`. */
function actingHarness(work: () => void, value: unknown): Harness {
  return {
    toTrajectory: () => undefined,
    async run() {
      work();
      return { value };
    },
  };
}

/** A harness that writes a file before it answers. */
function writingHarness(directory: string, name: string, value: unknown): Harness {
  return actingHarness(() => writeFileSync(join(directory, name), "written by the step"), value);
}

test("validate refuses a contract that Ajv cannot read", () => {
  const problems = validate({
    name: "bad-schema",
    steps: [
      {
        id: "a",
        kind: "agent",
        needs: [],
        prompt: "step.md",
        tools: ["read"],
        returns: { type: "objekt" } as unknown as TSchema,
      },
    ],
  } as unknown as Flow);

  assert.ok(problems.some((p) => p.includes('step "a" returns') && p.includes("Ajv refuses")));
});

test("validate refuses a width that is not a whole number", () => {
  const problems = validate({
    name: "bad-width",
    parallel: "abc" as unknown as number,
    steps: [{ id: "a", kind: "agent", needs: [], prompt: "step.md", tools: ["read"], returns: Summary }],
  } as unknown as Flow);

  assert.ok(problems.some((p) => p.includes('runs "abc" steps at a time')));
});

test("validate refuses a pattern where a promise wants a name", () => {
  const problems = validate(
    flow("pattern", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: { paths: ["docs/**"] } }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('promises the path "docs/**"') && p.includes('Write "docs"')));
});

test("validate refuses a promise that no workspace can check", () => {
  const problems = validate(
    flow("unchecked", {
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" })],
    }),
  );

  assert.ok(problems.some((p) => p.includes("no workspace to check it")));
});

test("a step that promises to change nothing fails when it changes a file", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("promise", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" })],
    }),
    { cwd, harness: writingHarness(cwd, "sneaky.txt", { summary: "I changed nothing" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing, but it added sneaky\.txt/);
});

test("a step without the promise records what it changed and passes", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("records", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary })],
    }),
    { cwd, harness: writingHarness(cwd, "new.txt", { summary: "wrote a file" }) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.a?.changed, [{ path: "new.txt", how: "added" }]);
});

test("a change to a tracked file keeps its whole path", async () => {
  const cwd = gitWorkspace();

  // A tracked file gives a porcelain line that starts with a space. An untracked
  // one does not, so only this case catches a trim that eats the first letter.
  const state = await run(
    flow("tracked", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["edit"], returns: Summary })],
    }),
    { cwd, harness: writingHarness(cwd, "step.md", { summary: "changed a tracked file" }) },
  );

  assert.deepEqual(state.steps.a?.changed, [{ path: "step.md", how: "changed" }]);
});

test("the run state of Orchy is not counted as a change", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("quiet", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" })],
    }),
    { cwd, harness: fakeHarness({ summary: "read only" }) },
  );

  assert.equal(state.status, "done");
  assert.equal(state.steps.a?.changed, undefined);
});

test("a workspace that is not a git repository says so", async () => {
  const cwd = workspace();

  await assert.rejects(
    () =>
      run(
        flow("nogit", {
          workspace: { kind: "git", path: "." },
          steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
        }),
        { cwd, harness: fakeHarness({ summary: "x" }) },
      ),
    /is not a git repository/,
  );
});

test("a cycle carries the value that sent the run back", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true });

  await run(reviewFlow(3, "accept"), { cwd, harness });

  // Call 3 is "code" running again. It needs nothing, so only the cycle can inform it.
  assert.ok(harness.seen[2]?.prompt.includes('"approved": false'));
  assert.ok(!harness.seen[0]?.prompt.includes("approved"));
});

test("every example and shipped flow is valid", async () => {
  // Reads the directories, so a new flow is covered without touching this test.
  for (const kind of ["examples", "flows"]) {
    const root = join(import.meta.dirname, "..", kind);
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    assert.ok(names.length >= 6);

    for (const name of names) {
      for (const file of readdirSync(join(root, name)).filter((one) => /^flow\.(ts|ya?ml)$/.test(one))) {
        const path = join(root, name, file);
        const loaded = file.endsWith(".ts")
          ? ((await import(path)).default as Flow)
          : parseFlow(readFileSync(path, "utf8"));
        const expanded = expandFanout(loaded);
        assert.deepEqual(validate(expanded), [], `${kind}/${name}/${file} is not valid`);
      }
    }
  }
});

test("every example and shipped flow loads, and every path one names exists, from any working directory", async () => {
  // `validate()` opens no file, so it cannot answer this. A member that kept a
  // relative path passed every check and then failed in the middle of a run,
  // anywhere but its own directory. Loading also expands every inner flow, so
  // a shipped flow that includes a fragment is checked the way a run reads it.
  for (const kind of ["examples", "flows"]) {
    const root = join(import.meta.dirname, "..", kind);
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const name of names) {
      for (const file of readdirSync(join(root, name)).filter((one) => /^flow\.(ts|ya?ml)$/.test(one))) {
        // Loaded from a directory that holds none of it, which is how a run works.
        const loaded = expandFanout(await loadFlow(join(root, name, file), tmpdir()));
        for (const step of loaded.steps) {
          const path = step.kind === "agent" ? step.prompt : step.kind === "call" ? step.module : undefined;
          if (path === undefined) continue;
          assert.ok(existsSync(path), `${kind}/${name}/${file}: step "${step.id}" names "${path}", which is not there`);
        }
      }
    }
  }
});

// -- The file format and ATIF --

test("the YAML file and the TypeScript file produce the same flow", async () => {
  const fromCode = (await import("../examples/code-review/flow.ts")).default;
  const fromFile = parseFlow(readFileSync("examples/code-review/flow.yaml", "utf8"));

  // JSON strips the symbols that TypeBox adds, which is the form that both
  // a file and a graphical editor produce.
  assert.deepEqual(fromFile, JSON.parse(JSON.stringify(fromCode)));
});

test("a flow from YAML meets the same check as one from code", () => {
  // The loader reads a fragment as well as a whole flow, so the run does the check.
  const text = [
    "name: broken",
    "steps:",
    "  - id: a",
    "    kind: agent",
    "    needs: [ghost]",
    "    prompt: step.md",
    "    tools: [read]",
    "    returns: { type: object }",
  ].join("\n");
  const parsed = parseFlow(text);
  assert.ok(validate(parsed).some((problem) => problem.includes('needs "ghost"')));
});

test("a run writes an ATIF trajectory that holds one child for each agent step", async () => {
  const cwd = workspace();

  const state = await run(reviewFlow(3, "accept"), {
    cwd,
    harness: fakeHarness({ summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true }),
  });

  const atif = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "trajectory.json"), "utf8"));

  assert.equal(atif.schema_version, "ATIF-v1.7");
  assert.equal(atif.trajectory_id, state.runId);
  // Two attempts of code plus two of review, and the cycle dropped none of them.
  assert.equal(atif.final_metrics.total_steps, 4);
  assert.deepEqual(
    atif.steps.map((step: { step_id: number }) => step.step_id),
    [1, 2, 3, 4],
  );
  assert.ok(atif.steps.every((step: { extra: { orchy: { step: string } } }) => step.extra.orchy.step));

  // The timestamps must be real, and they must not go backwards.
  const times = atif.steps.map((step: { timestamp: string }) => step.timestamp);
  assert.ok(times.every((time: string) => time > "2020-01-01"), `epoch timestamps: ${times[0]}`);
  assert.deepEqual(times, [...times].sort());
});

test("ATIF reads a pi session file into steps, tool calls, and metrics", async () => {
  const cwd = workspace();
  const session = join(cwd, "session.jsonl");
  writeFileSync(
    session,
    [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd }),
      JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "do it" } }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "reading a file" },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
          ],
          usage: { input: 100, output: 20, cacheRead: 5, cost: { total: 0.5 } },
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:03Z",
        message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file body" }] },
      }),
    ].join("\n"),
  );

  const state = await run(
    flow("traced", { steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })] }),
    {
      cwd,
      harness: {
        async run() {
          return { value: { summary: "done" }, trajectory: session };
        },
        toTrajectory: (handle, id, version) => pi.toTrajectory(handle, id, version),
      },
    },
  );

  const atif = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "trajectory.json"), "utf8"));
  const [child] = atif.subagent_trajectories;

  assert.equal(child.agent.model_name, "claude-opus-5");
  assert.deepEqual(
    child.steps.map((step: { source: string }) => step.source),
    ["user", "agent", "system"],
  );
  assert.equal(child.steps[1].tool_calls[0].function_name, "read");
  assert.equal(child.steps[1].reasoning_content, "considering");
  assert.equal(child.steps[2].observation.results[0].source_call_id, "t1");
  assert.deepEqual(child.final_metrics, {
    prompt_tokens: 100,
    completion_tokens: 20,
    cached_tokens: 5,
    cost_usd: 0.5,
    total_steps: 3,
  });
  assert.equal(atif.steps[0].subagent_trajectory_ref.trajectory_id, child.trajectory_id);
});

test("the trajectory marks the run of a step that a cycle threw away", async () => {
  const cwd = workspace();
  const state = await run(reviewFlow(2, "accept"), {
    cwd,
    harness: fakeHarness({ summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true }),
  });

  const atif = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "trajectory.json"), "utf8"));
  const marks = atif.steps.map((step: { extra: { orchy: { step: string; dropped?: boolean } } }) => [
    step.extra.orchy.step,
    step.extra.orchy.dropped ?? false,
  ]);

  // The first run of each step is the one the cycle threw away.
  assert.deepEqual(marks, [
    ["code", true],
    ["review", true],
    ["code", false],
    ["review", false],
  ]);
});

test("a prompt and a module resolve against the flow file, not the working directory", () => {
  const resolved = resolvePaths(
    flow("assets", {
      steps: [
        agent({ id: "a", prompt: "prompts/ask.md", tools: ["read"], returns: Summary }),
        call({ id: "b", needs: ["a"], module: "/already/absolute.ts", returns: Summary }),
      ],
    }),
    "/flows/grilling",
  );

  assert.equal((resolved.steps[0] as { prompt: string }).prompt, "/flows/grilling/prompts/ask.md");
  assert.equal((resolved.steps[1] as { module: string }).module, "/already/absolute.ts");
});

test("the prompt and the module a member overrides resolve against the flow file too", () => {
  const resolved = resolvePaths(
    flow("panel", {
      steps: [
        agent({
          id: "a",
          prompt: "prompts/audit.md",
          tools: ["read"],
          returns: Summary,
          fanout: [{ name: "readme", prompt: "prompts/audit-readme.md" }, { name: "docs" }],
        }),
        call({
          id: "b",
          needs: ["a"],
          module: "report.ts",
          returns: Summary,
          fanout: [{ name: "one", module: "other.ts" }],
        }),
      ],
    }),
    "/flows/docs-audit",
  );

  const members = (step: unknown) => (step as { fanout: Array<Record<string, string>> }).fanout;
  assert.equal(members(resolved.steps[0])[0]?.prompt, "/flows/docs-audit/prompts/audit-readme.md");
  // A member that overrides nothing takes the path of its step, which is resolved.
  assert.equal(members(resolved.steps[0])[1]?.prompt, undefined);
  assert.equal(members(resolved.steps[1])[0]?.module, "/flows/docs-audit/other.ts");
});

// -- The Claude adapter --

test("the Claude adapter reads a transcript into ATIF", () => {
  const home = mkdtempSync(join(tmpdir(), "orchy-claude-"));
  const project = join(home, "projects", "-some-where");
  mkdirSync(project, { recursive: true });

  const sessionId = "11111111-2222-3333-4444-555555555555";
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "do it" } }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "text", text: "reading" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
          ],
          usage: { input_tokens: 90, output_tokens: 12, cache_read_input_tokens: 4 },
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }] },
      }),
    ].join("\n"),
  );

  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const trajectory = claude.toTrajectory(sessionId, "run:1:a", "0.0.0");
    assert.ok(trajectory);
    assert.equal(trajectory.agent.name, "claude-code");
    assert.equal(trajectory.agent.model_name, "claude-sonnet-5");
    // A tool result arrives as a user message, so it must not become a user step.
    assert.deepEqual(
      trajectory.steps.map((step) => step.source),
      ["user", "agent", "system"],
    );
    assert.equal(trajectory.steps[1]?.tool_calls?.[0]?.function_name, "Read");
    assert.equal(trajectory.steps[1]?.reasoning_content, "considering");
    assert.equal(trajectory.steps[2]?.observation?.results[0]?.source_call_id, "toolu_1");
    assert.deepEqual(trajectory.final_metrics, {
      prompt_tokens: 90,
      completion_tokens: 12,
      cached_tokens: 4,
      cost_usd: 0,
      total_steps: 3,
    });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("the Claude adapter answers nothing for a session it cannot find", () => {
  assert.equal(claude.toTrajectory("no-such-session", "run:1:a", "0.0.0"), undefined);
});

// -- A harness and a model for each step --

test("each step reaches the harness it names, and the model goes with it", async () => {
  const cwd = workspace();
  const fast = fakeHarness({ summary: "from fast" });
  const slow = fakeHarness({ approved: true });

  const state = await run(
    flow("mixed", {
      steps: [
        agent({ id: "code", harness: "fast", model: "claude-opus-4-5", prompt: "step.md", tools: ["write"], returns: Summary }),
        agent({
          id: "review",
          needs: ["code"],
          harness: "slow",
          model: "ollama/glm-5.2",
          prompt: "step.md",
          tools: ["read"],
          returns: Verdict,
        }),
      ],
    }),
    { cwd, harnesses: { fast, slow } },
  );

  assert.equal(state.status, "done");
  assert.equal(fast.seen.length, 1);
  assert.equal(slow.seen.length, 1);
  assert.equal(fast.seen[0]?.model, "claude-opus-4-5");
  assert.equal(slow.seen[0]?.model, "ollama/glm-5.2");
});

test("a step that names no harness uses the one the run supplies", async () => {
  const cwd = workspace();
  const fallback = fakeHarness({ summary: "default" });

  await run(
    flow("fallback", { steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })] }),
    { cwd, harness: fallback, harnesses: { other: fakeHarness({ summary: "wrong" }) } },
  );

  assert.equal(fallback.seen.length, 1);
  assert.equal(fallback.seen[0]?.model, undefined);
});

test("each trajectory is read by the harness of its own step", async () => {
  const cwd = workspace();
  const seen: string[] = [];
  const spy = (name: string, value: unknown): Harness => ({
    async run() {
      return { value, trajectory: `${name}-handle`, cost: 1 };
    },
    toTrajectory(handle) {
      seen.push(handle);
      return undefined;
    },
  });

  const state = await run(
    flow("split", {
      steps: [
        agent({ id: "a", harness: "one", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", needs: ["a"], harness: "two", prompt: "step.md", tools: ["read"], returns: Verdict }),
      ],
    }),
    { cwd, harnesses: { one: spy("one", { summary: "x" }), two: spy("two", { approved: true }) } },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(seen.sort(), ["one-handle", "two-handle"]);

  // A step with no trajectory still spent money, so the total must hold it.
  const atif = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "trajectory.json"), "utf8"));
  assert.equal(atif.final_metrics.cost_usd, 2);
});

test("a run refuses an unknown harness before it runs anything", async () => {
  const cwd = workspace();
  const only = fakeHarness({ summary: "x" });

  await assert.rejects(
    () =>
      run(
        flow("ghost", {
          steps: [agent({ id: "a", harness: "nope", prompt: "step.md", tools: ["read"], returns: Summary })],
        }),
        { cwd, harness: only, harnesses: { real: only } },
      ),
    /names the harness "nope"/,
  );
  assert.equal(only.seen.length, 0);
});

// -- Steps that can run together do --

test("steps whose needs are met run at the same time", async () => {
  const cwd = workspace();
  let started = 0;
  let release = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Each call waits for the other. A runner that goes one at a time never frees it.
  const paired: Harness = {
    toTrajectory: () => undefined,
    async run() {
      started += 1;
      if (started === 2) release();
      await Promise.race([
        both,
        new Promise((_, reject) => setTimeout(() => reject(new Error("the steps did not run together")), 3000)),
      ]);
      return { value: { summary: "together" } };
    },
  };

  const state = await run(
    flow("wave", {
      steps: [
        agent({ id: "first", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "second", prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness: paired },
  );

  assert.equal(state.status, "done");
  assert.equal(started, 2);
});

test("a step still waits for the steps it needs", async () => {
  const cwd = workspace();
  const order: string[] = [];
  const recording: Harness = {
    toTrajectory: () => undefined,
    async run(request) {
      order.push(`start:${request.step}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${request.step}`);
      return { value: { summary: request.step } };
    },
  };

  await run(
    flow("chain", {
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", needs: ["a"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness: recording },
  );

  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
});

// -- Fanout and sub-flows --

test("a fanout becomes one step for each member, and references follow", () => {
  const expanded = expandFanout(
    flow("panel", {
      steps: [
        agent({ id: "code", prompt: "code.md", tools: ["write"], returns: Summary }),
        agent({
          id: "review",
          needs: ["code"],
          prompt: "review.md",
          tools: ["read"],
          returns: Verdict,
          fanout: [
            { name: "opus", harness: "claude", model: "claude-opus-4-5" },
            { name: "glm", harness: "pi", model: "ollama/glm-5.2", prompt: "strict.md" },
          ],
        }),
        call({ id: "verdict", needs: ["review"], module: "verdict.ts", returns: Verdict }),
      ],
    }),
  );

  assert.deepEqual(
    expanded.steps.map((step) => step.id),
    ["code", "review/opus", "review/glm", "verdict"],
  );

  const [, opus, glm, verdict] = expanded.steps as Array<AgentStep & { harness?: string; model?: string }>;
  assert.equal(opus?.harness, "claude");
  assert.equal(opus?.prompt, "review.md");
  // A member overrides only what it names.
  assert.equal(glm?.model, "ollama/glm-5.2");
  assert.equal(glm?.prompt, "strict.md");
  assert.deepEqual(verdict?.needs, ["review/opus", "review/glm"]);
  assert.deepEqual(validate(expanded), []);
});

test("validate refuses a fanout that also cycles", () => {
  const problems = validate(
    flow("both", {
      steps: [
        agent({ id: "a", prompt: "a.md", tools: ["read"], returns: Verdict }),
        agent({
          id: "b",
          needs: ["a"],
          prompt: "b.md",
          tools: ["read"],
          returns: Verdict,
          fanout: [{ name: "one" }],
          cycle: { to: "a", when: { approved: false }, limit: 2, policy: "accept" },
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('step "b" fans out and cycles to "a"')));
});

test("validate accepts a fanout that retries itself, because each member takes its own", () => {
  const panel = flow("retrying", {
    steps: [
      agent({
        id: "b",
        prompt: "b.md",
        tools: ["read"],
        returns: Verdict,
        fanout: [{ name: "one" }, { name: "two" }],
        cycle: { to: "b", when: "failed", limit: 1, policy: "accept" },
      }),
    ],
  });

  assert.deepEqual(validate(panel), []);
});

test("a retry on a fanout points each member at itself, and not at the last one", () => {
  const expanded = expandFanout(
    flow("retrying", {
      steps: [
        agent({
          id: "b",
          prompt: "b.md",
          tools: ["read"],
          returns: Verdict,
          fanout: [{ name: "one" }, { name: "two" }],
          cycle: { to: "b", when: "failed", limit: 1, policy: "accept" },
        }),
      ],
    }),
  );

  assert.deepEqual(
    expanded.steps.map((step) => [step.id, (step as AgentStep).cycle?.to]),
    [
      ["b/one", "b/one"],
      ["b/two", "b/two"],
    ],
  );
});

test("one member of a fanout retries its own failure, and the others keep their values", async () => {
  const cwd = workspace();
  // The second member fails once, which is how a model that answers in prose
  // instead of calling the tool ends. Ten good members used to die with it.
  const failed = new Set<string>();
  const flaky: Harness = {
    toTrajectory: () => undefined,
    async run(request: AgentRequest) {
      if (request.step === "read/two" && !failed.has(request.step)) {
        failed.add(request.step);
        throw new Error("the step ended without a call to submit_result");
      }
      return { value: { approved: true } };
    },
  };

  const state = await run(
    flow("panel", {
      steps: [
        agent({
          id: "read",
          prompt: "step.md",
          tools: ["read"],
          returns: Verdict,
          fanout: [{ name: "one" }, { name: "two" }, { name: "three" }],
          cycle: { to: "read", when: "failed", limit: 1, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness: flaky },
  );

  assert.equal(state.status, "done");
  assert.equal(state.steps["read/two"]?.status, "done");
  assert.equal(state.steps["read/one"]?.status, "done");
  assert.equal(state.cycles["read/two->read/two"], 1);
  // The failure of the member is still a cost, so the record of it is kept.
  assert.equal(state.history?.filter((one) => one.step === "read/two").length, 1);
});

test("a sub-flow takes the id of its step as a prefix and joins the graph", async () => {
  const inner = flow("panel", {
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict }),
      call({ id: "sum", needs: ["look"], module: "sum.ts", returns: Verdict }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      steps: [
        agent({ id: "code", prompt: "code.md", tools: ["write"], returns: Summary }),
        { kind: "flow", id: "review", needs: ["code"], flow: "./panel.yaml" },
        call({ id: "ship", needs: ["review"], module: "ship.ts", returns: Summary }),
      ],
    }),
    async () => inner,
  );

  assert.deepEqual(
    expanded.steps.map((step) => step.id),
    ["code", "review/look", "review/sum", "ship"],
  );
  // The first step of the inner flow waits for whatever the outer step waited for.
  assert.deepEqual(expanded.steps[1]?.needs, ["code"]);
  assert.deepEqual(expanded.steps[2]?.needs, ["review/look"]);
  // Whoever needed the sub-flow now needs the step it ends with.
  assert.deepEqual(expanded.steps[3]?.needs, ["review/sum"]);
  assert.deepEqual(validate(expanded), []);
});

test("a sub-flow that ends in more than one step is refused", async () => {
  const inner = flow("two-ends", {
    steps: [
      agent({ id: "a", prompt: "a.md", tools: ["read"], returns: Verdict }),
      agent({ id: "b", prompt: "b.md", tools: ["read"], returns: Verdict }),
    ],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", { steps: [{ kind: "flow", id: "sub", needs: [], flow: "./two.yaml" }] }),
        async () => inner,
      ),
    /ends in 2 steps/,
  );
});

test("a cycle inside a sub-flow points inside it after expansion", async () => {
  const inner = flow("panel", {
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict }),
      agent({
        id: "judge",
        needs: ["look"],
        prompt: "judge.md",
        tools: ["read"],
        returns: Verdict,
        cycle: { to: "look", when: { approved: false }, limit: 2, policy: "accept" },
      }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", { steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }] }),
    async () => inner,
  );

  const judge = expanded.steps.find((step) => step.id === "review/judge") as AgentStep;
  assert.equal(judge.cycle?.to, "review/look");
  assert.deepEqual(validate(expanded), []);
});

test("a cycle on a flow step lands on the step the inner flow ends with", async () => {
  const inner = flow("panel", {
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict }),
      call({ id: "sum", needs: ["look"], module: "sum.ts", returns: Verdict }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      steps: [
        agent({ id: "code", prompt: "code.md", tools: ["write"], returns: Summary }),
        {
          kind: "flow",
          id: "review",
          needs: ["code"],
          flow: "./panel.yaml",
          cycle: { to: "code", when: { approved: false }, limit: 2, policy: "escalate" },
        },
      ],
    }),
    async () => inner,
  );

  const last = expanded.steps.find((step) => step.id === "review/sum") as CallStep;
  assert.equal(last.cycle?.to, "code");
  assert.equal(last.cycle?.limit, 2);
  assert.deepEqual(validate(expanded), []);
});

test("a flow step refuses to cycle when the step it ends with already does", async () => {
  const inner = flow("panel", {
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict }),
      agent({
        id: "judge",
        needs: ["look"],
        prompt: "judge.md",
        tools: ["read"],
        returns: Verdict,
        cycle: { to: "look", when: { approved: false }, limit: 2, policy: "accept" },
      }),
    ],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", {
          steps: [
            {
              kind: "flow",
              id: "review",
              needs: [],
              flow: "./panel.yaml",
              cycle: { to: "review/look", when: { approved: false }, limit: 1, policy: "accept" },
            },
          ],
        }),
        async () => inner,
      ),
    /cycles, and so does the step/,
  );
});

test("a wave runs no more steps at once than the flow allows", async () => {
  const cwd = workspace();
  let running = 0;
  let peak = 0;
  const counting: Harness = {
    toTrajectory: () => undefined,
    async run() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { value: { summary: "done" } };
    },
  };

  const state = await run(
    flow("capped", {
      parallel: 2,
      steps: Array.from({ length: 6 }, (_, index) =>
        agent({ id: `s${index}`, prompt: "step.md", tools: ["read"], returns: Summary }),
      ),
    }),
    { cwd, harness: counting },
  );

  assert.equal(state.status, "done");
  assert.equal(Object.keys(state.steps).length, 6);
  assert.equal(peak, 2);
});

/** A harness that reports how many steps ran at the same time. */
function countingHarness(): Harness & { peak: () => number } {
  let running = 0;
  let peak = 0;
  return {
    peak: () => peak,
    toTrajectory: () => undefined,
    async run() {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { value: { summary: "done" } };
    },
  };
}

/** A panel of three, each one promising what the test gives it. */
function panelFlow(changes: Array<"nothing" | undefined>): Flow {
  return flow("panel", {
    workspace: { kind: "git", path: "." },
    parallel: 3,
    steps: changes.map((promise, index) =>
      agent({ id: `s${index}`, prompt: "step.md", tools: ["read"], returns: Summary, changes: promise }),
    ),
  });
}

test("a wave where every step promises nothing runs at the width of the flow", async () => {
  const cwd = gitWorkspace();
  const counting = countingHarness();

  // Nothing in the wave may write, so no step can disturb the record of another.
  const state = await run(panelFlow(["nothing", "nothing", "nothing"]), { cwd, harness: counting });

  assert.equal(state.status, "done");
  assert.equal(counting.peak(), 3);
});

test("a wave that holds a promise and a step that may write runs one step at a time", async () => {
  const cwd = gitWorkspace();
  const counting = countingHarness();

  // The last step promises nothing about what it changes, so it may change
  // anything, and one git status cannot tell its work from the others.
  const state = await run(panelFlow(["nothing", "nothing", undefined]), { cwd, harness: counting });

  assert.equal(state.status, "done");
  assert.equal(counting.peak(), 1);
});

test("validate refuses a flow that runs fewer than one step at a time", () => {
  const problems = validate(
    flow("zero", {
      parallel: 0,
      steps: [agent({ id: "a", prompt: "a.md", tools: ["read"], returns: Summary })],
    }),
  );

  assert.ok(problems.some((p) => p.includes("runs 0 steps at a time")));
});

test("a call step fans out too, and a member overrides its module", () => {
  const expanded = expandFanout(
    flow("split", {
      steps: [
        call({
          id: "check",
          module: "default.ts",
          returns: Verdict,
          fanout: [{ name: "one" }, { name: "two", module: "other.ts" }],
        }),
        call({ id: "sum", needs: ["check"], module: "sum.ts", returns: Verdict }),
      ],
    }),
  );

  const [one, two, sum] = expanded.steps as CallStep[];
  assert.equal(one?.id, "check/one");
  assert.equal(one?.module, "default.ts");
  assert.equal(two?.module, "other.ts");
  assert.deepEqual(sum?.needs, ["check/one", "check/two"]);
  // A member of a call step never picks up a field only an agent step holds.
  assert.equal((two as { harness?: string }).harness, undefined);
});

test("validate refuses a fanout on a step that cannot have one", () => {
  const problems = validate({
    name: "gated",
    steps: [{ kind: "gate", id: "g", needs: [], question: "ok?", returns: Verdict, fanout: [{ name: "a" }] } as never],
  });

  assert.ok(problems.some((p) => p.includes("only an agent step and a call step can")));
});

test("validate refuses two members with one name", () => {
  const problems = validate(
    flow("clash", {
      steps: [
        agent({
          id: "a",
          prompt: "a.md",
          tools: ["read"],
          returns: Verdict,
          fanout: [{ name: "x" }, { name: "x" }],
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes("two members with one name")));
});

test("validate refuses a tool that does not exist", () => {
  const problems = validate({
    name: "typo",
    steps: [{ kind: "agent", id: "a", needs: [], prompt: "a.md", tools: ["teleport"], returns: Summary } as never],
  });

  assert.ok(problems.some((p) => p.includes('asks for the tool "teleport"')));
});

test("a harness refuses a tool it cannot supply, rather than drop it", async () => {
  // pi has no web tool. Dropping it would weaken invariant 1 without a word.
  await assert.rejects(
    () => pi.run({ step: "a", prompt: "hi", tools: ["web"], returns: Summary, cwd: process.cwd() }),
    /pi has no tool for "web"/,
  );
  await assert.rejects(
    () => claude.run({ step: "a", prompt: "hi", tools: ["teleport"], returns: Summary, cwd: process.cwd() }),
    /claude has no tool for "teleport"/,
  );
});

test("the claude adapter turns one orchy tool into the tools claude has", () => {
  // `web` is two tools in Claude, so the map answers a list, not one name.
  assert.deepEqual(validate(
    flow("web", { steps: [agent({ id: "a", prompt: "a.md", tools: ["web"], returns: Summary })] }),
  ), []);
});

// ── The shape of a flow ──────────────────────────────────────────────────────

test("validate refuses a field that the kind of a step cannot hold", () => {
  const problems = validate(
    parseFlow(
      [
        "name: wrong",
        "steps:",
        "  - id: one",
        "    kind: call",
        "    module: m.ts",
        "    harness: claude",
        "    tools: [read]",
        "    returns: { type: object }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('holds "harness", which a call step cannot act on')));
  assert.ok(problems.some((p) => p.includes("Only an agent step holds it")));
});

test("validate refuses a member override that the kind of the step cannot hold", () => {
  const problems = validate(
    flow("panel", {
      steps: [
        call({
          id: "one",
          module: "m.ts",
          returns: Summary,
          // A call step has no model, so expansion used to drop this in silence.
          fanout: [{ name: "first", model: "claude-opus-4-5" }],
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('member "first" of "one" holds "model"')));
});

test("validate names the kind that does not exist, and the kinds that do", () => {
  const problems = validate(parseFlow("name: typo\nsteps:\n  - id: one\n    kind: agnt\n"));

  assert.ok(problems.some((p) => p.includes('is of the kind "agnt". Use one of: agent, call, gate, flow')));
});

test("validate refuses a workspace that no code can take a snapshot of", () => {
  assert.ok(
    validate(parseFlow("name: w\nworkspace: { kind: docker }\nsteps: []")).some((p) =>
      p.includes('the workspace is of the kind "docker"'),
    ),
  );
  assert.ok(
    validate(parseFlow("name: w\nworkspace: { kind: git }\nsteps: []")).some((p) =>
      p.includes("the git workspace has no path"),
    ),
  );
});

test("validate refuses a step with no contract, rather than let Ajv answer", () => {
  const problems = validate(parseFlow("name: n\nsteps:\n  - id: one\n    kind: call\n    module: m.ts\n"));

  assert.ok(problems.some((p) => p.includes('step "one" has no "returns", and a call step needs one')));
});

test("a file keeps every field it holds, so the flow paces the wave it declared", () => {
  // `parallel` never reached the runner, because the parser kept three fields.
  assert.equal(parseFlow("name: p\nparallel: 3\nsteps: []").parallel, 3);
  assert.ok(
    validate(parseFlow("name: p\nparallle: 3\nsteps: []")).some((p) =>
      p.includes('the flow holds "parallle"'),
    ),
  );
});

// ── The harness of a flow ────────────────────────────────────────────────────

test("a step with no harness takes the one the flow names", async () => {
  const cwd = workspace();
  const mine = fakeHarness({ summary: "ok" });
  const other = fakeHarness({ summary: "wrong" });

  await run(
    flow("named", {
      harness: "mine",
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: other, harnesses: { mine, other } },
  );

  assert.equal(mine.seen.length, 1);
  assert.equal(other.seen.length, 0);
});

test("a step with no model takes the one the flow names, and overrides it", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "one" }, { summary: "two" });

  await run(
    flow("models", {
      model: "ollama/glm-5.2",
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", needs: ["a"], model: "ollama/other", prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.deepEqual(
    harness.seen.map((request) => request.model),
    ["ollama/glm-5.2", "ollama/other"],
  );
});

test("validate refuses a tool that the harness of the flow does not supply", () => {
  // pi has no web tool, and it used to say so only after the run started.
  const problems = validate(
    flow("web", {
      harness: "pi",
      steps: [agent({ id: "a", prompt: "a.md", tools: ["web"], returns: Summary })],
    }),
  );

  assert.ok(problems.some((p) => p.includes('asks for the tool "web", and the harness "pi" has none')));
  assert.deepEqual(
    validate(
      flow("web", {
        harness: "claude",
        steps: [agent({ id: "a", prompt: "a.md", tools: ["web"], returns: Summary })],
      }),
    ),
    [],
  );
});

// ── The value a member holds ─────────────────────────────────────────────────

test("a member gives its step a value, so one prompt serves a list", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  const state = await run(
    flow("audit", {
      steps: [
        agent({
          id: "audit",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          fanout: [
            { name: "core", with: { package: "core" } },
            { name: "cli", with: { package: "cli" } },
          ],
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.deepEqual(Object.keys(state.steps), ["audit/core", "audit/cli"]);
  assert.match(harness.seen[0]?.prompt ?? "", /The values this step holds[\s\S]*"package": "core"/);
  assert.match(harness.seen[1]?.prompt ?? "", /"package": "cli"/);
});

test("a component takes the value of its step as a third argument", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "m.ts"), "export default (inputs, say, held) => ({ summary: held.package });");

  const state = await run(
    flow("audit", {
      steps: [
        call({
          id: "audit",
          module: "m.ts",
          returns: Summary,
          fanout: [
            { name: "core", with: { package: "core" } },
            { name: "cli", with: { package: "cli" } },
          ],
        }),
      ],
    }),
    { cwd },
  );

  assert.deepEqual(state.steps["audit/core"]?.value, { summary: "core" });
  assert.deepEqual(state.steps["audit/cli"]?.value, { summary: "cli" });
});

// ── The promise of a step ────────────────────────────────────────────────────

test("a step that promises a path fails when it changes a file outside it", async () => {
  const cwd = gitWorkspace();
  mkdirSync(join(cwd, "docs"));

  const state = await run(
    flow("scoped", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary, changes: { paths: ["docs"] } })],
    }),
    { cwd, harness: writingHarness(cwd, "src.txt", { summary: "I stayed in docs" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change only docs, but it added src\.txt/);
});

test("a step that promises a path passes when it stays under it", async () => {
  const cwd = gitWorkspace();
  mkdirSync(join(cwd, "docs"));

  const state = await run(
    flow("scoped", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary, changes: { paths: ["docs"] } })],
    }),
    { cwd, harness: writingHarness(cwd, "docs/new.md", { summary: "I stayed in docs" }) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.a?.changed, [{ path: "docs/new.md", how: "added" }]);
});

test("validate tells a user of changes: false what to write instead", () => {
  const problems = validate(
    parseFlow(
      [
        "name: old",
        "workspace: { kind: git, path: . }",
        "steps:",
        "  - id: one",
        "    kind: agent",
        "    prompt: p.md",
        "    tools: [read]",
        "    changes: false",
        "    returns: { type: object }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('Instead, write "changes: nothing"')));
});

// ── The condition on a step ──────────────────────────────────────────────────

const Sort = Type.Object({ severity: Type.String() });

function triageFlow(): Flow {
  return flow("triage", {
    steps: [
      agent({ id: "sort", prompt: "step.md", tools: ["read"], returns: Sort }),
      agent({
        id: "page",
        needs: ["sort"],
        when: { sort: { severity: "high" } },
        prompt: "step.md",
        tools: ["read"],
        returns: Summary,
      }),
      agent({ id: "tell", needs: ["page"], prompt: "step.md", tools: ["read"], returns: Summary }),
    ],
  });
}

test("a step that a condition rules out never runs", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ severity: "low" }, { summary: "paged" });

  const state = await run(triageFlow(), { cwd, harness });

  assert.equal(state.status, "done");
  assert.equal(state.steps.page?.status, "skipped");
  assert.match(state.steps.page?.skipped ?? "", /"sort" does not say/);
  // Only the sort step reached the harness, so the run spent one turn.
  assert.equal(harness.seen.length, 1);
});

test("a step that needs a skipped step is skipped as well", async () => {
  const cwd = workspace();
  const state = await run(triageFlow(), { cwd, harness: fakeHarness({ severity: "low" }) });

  assert.equal(state.steps.tell?.status, "skipped");
  assert.match(state.steps.tell?.skipped ?? "", /it needs "page", which the run skipped/);
});

test("a step that a condition allows runs as any other step does", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ severity: "high" }, { summary: "paged" }, { summary: "told" });

  const state = await run(triageFlow(), { cwd, harness });

  assert.equal(state.status, "done");
  assert.equal(state.steps.page?.status, "done");
  assert.equal(state.steps.tell?.status, "done");
});

test("a run says which steps it skipped, so a reader is never left guessing", async () => {
  const cwd = workspace();
  const events: RunEvent[] = [];

  await run(triageFlow(), {
    cwd,
    harness: fakeHarness({ severity: "low" }),
    onEvent: (event) => events.push(event),
  });

  const skipped = events.filter((event) => event.type === "skip").map((event) => event.step);
  assert.deepEqual(skipped, ["page", "tell"]);
});

test("validate refuses a condition on a step that the step does not need", () => {
  const problems = validate(
    flow("early", {
      steps: [
        agent({ id: "sort", prompt: "step.md", tools: ["read"], returns: Sort }),
        agent({ id: "page", when: { sort: { severity: "high" } }, prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('runs when "sort" matches, but it does not need "sort"')));
});

test("validate refuses a condition on a key that the step it reads never returns", () => {
  const problems = validate(
    flow("typo", {
      steps: [
        agent({ id: "sort", prompt: "step.md", tools: ["read"], returns: Sort }),
        agent({
          id: "page",
          needs: ["sort"],
          when: { sort: { serverity: "high" } },
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
        }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('says "serverity", which "sort" does not return')));
});

// ── The retry ────────────────────────────────────────────────────────────────

/** A harness that throws for the first `times` turns, as a flaky API does. */
function flakyHarness(times: number, value: unknown): Harness & { turns: number } {
  const state = { turns: 0 };
  return {
    get turns() {
      return state.turns;
    },
    toTrajectory: () => undefined,
    async run(): Promise<AgentResult> {
      state.turns += 1;
      if (state.turns <= times) throw new Error("the API answered 503");
      return { value };
    },
  };
}

function retryFlow(limit: number, policy: "escalate" | "accept"): Flow {
  return flow("retry", {
    steps: [
      agent({
        id: "flaky",
        prompt: "step.md",
        tools: ["read"],
        returns: Summary,
        cycle: { to: "flaky", when: "failed", limit, policy },
      }),
    ],
  });
}

test("a step that cycles to itself runs again after it fails", async () => {
  const cwd = workspace();
  const harness = flakyHarness(2, { summary: "at last" });

  const state = await run(retryFlow(3, "escalate"), { cwd, harness });

  assert.equal(state.status, "done");
  assert.equal(harness.turns, 3);
  assert.deepEqual(state.steps.flaky?.value, { summary: "at last" });
  // Every attempt is a cost, so the record keeps the two that failed.
  assert.equal(state.history?.length, 2);
});

test("a retry carries the error back, so the step knows what went wrong", async () => {
  const cwd = workspace();
  const seen: string[] = [];
  const harness: Harness = {
    toTrajectory: () => undefined,
    async run(request: AgentRequest): Promise<AgentResult> {
      seen.push(request.prompt);
      if (seen.length === 1) throw new Error("the API answered 503");
      return { value: { summary: "second time" } };
    },
  };

  await run(retryFlow(2, "accept"), { cwd, harness });

  assert.ok(!seen[0]?.includes("503"));
  assert.match(seen[1] ?? "", /the API answered 503/);
});

test("a retry that reaches its limit asks a person for the value", async () => {
  const cwd = workspace();

  const state = await run(retryFlow(2, "escalate"), { cwd, harness: flakyHarness(9, {}) });

  assert.equal(state.status, "waiting");
  assert.equal(state.waitingFor, "flaky");
  // The limit is 2 cycles, so the step failed three times: once, and twice more.
  assert.match(state.question ?? "", /failed 3 times over: .*503/);

  const answered = await resume(state.runId, { summary: "a person wrote this" }, { cwd });
  assert.equal(answered.status, "done");
});

test("a retry that reaches its limit fails the run when no person is asked", async () => {
  const cwd = workspace();

  // A failure carries no value, so `accept` has nothing to accept. It stops.
  const state = await run(retryFlow(2, "accept"), { cwd, harness: flakyHarness(9, {}) });

  assert.equal(state.status, "failed");
});

test("a step that breaks its contract is retried, as a step that throws is", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ wrong: "shape" }, { summary: "right shape" });

  const state = await run(retryFlow(2, "accept"), { cwd, harness });

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.flaky?.value, { summary: "right shape" });
});

test("a cycle still refuses to send the run forward", () => {
  const problems = validate(
    flow("forward", {
      steps: [
        agent({
          id: "one",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "two", when: { summary: "x" }, limit: 2, policy: "accept" },
        }),
        agent({ id: "two", needs: ["one"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('cycles to "two", which does not run before it')));
});

// ── The wave ─────────────────────────────────────────────────────────────────

/** Answers by the id of the step, one value for each turn. An Error value throws. */
function byStep(answers: Record<string, unknown[]>): Harness & { seen: AgentRequest[] } {
  const seen: AgentRequest[] = [];
  const turns: Record<string, number> = {};
  return {
    seen,
    toTrajectory: () => undefined,
    async run(request: AgentRequest): Promise<AgentResult> {
      seen.push(request);
      const list = answers[request.step] ?? [];
      const turn = turns[request.step] ?? 0;
      turns[request.step] = turn + 1;
      const value = list[Math.min(turn, list.length - 1)];
      if (value instanceof Error) throw value;
      return { value };
    },
  };
}

test("a wave that holds a promise runs one step at a time, so no step breaks the promise of another", async () => {
  const cwd = gitWorkspace();
  let running = 0;
  let peak = 0;
  const pair: Harness = {
    toTrajectory: () => undefined,
    async run(request) {
      running += 1;
      peak = Math.max(peak, running);
      // The writer writes while the quiet step waits, which is what a wave does.
      if (request.step === "writer") {
        await wait(20);
        writeFileSync(join(cwd, "writer-made-this.txt"), "the writer wrote this");
      } else await wait(60);
      running -= 1;
      return { value: { summary: request.step } };
    },
  };

  const state = await run(
    flow("wave-promise", {
      parallel: 2,
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "writer", prompt: "step.md", tools: ["write"], returns: Summary }),
        agent({ id: "innocent", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" }),
      ],
    }),
    { cwd, harness: pair },
  );

  assert.equal(state.steps.innocent?.error, undefined);
  assert.equal(state.status, "done");
  assert.equal(peak, 1);
});

test("a step record reaches the disk as the step settles, so a wave that dies keeps it", async () => {
  const cwd = workspace();
  let runId = "";
  const slower: Harness = {
    toTrajectory: () => undefined,
    async run(request) {
      if (request.step === "slow") await wait(40);
      return { value: { summary: request.step } };
    },
  };

  // The second step of the wave kills the run, as a crash does.
  await assert.rejects(
    () =>
      run(
        flow("dies", {
          steps: [
            agent({ id: "fast", prompt: "step.md", tools: ["read"], returns: Summary }),
            agent({ id: "slow", prompt: "step.md", tools: ["read"], returns: Summary }),
          ],
        }),
        {
          cwd,
          harness: slower,
          onEvent: (event) => {
            if (event.type === "run_start") runId = event.runId;
            if (event.type === "step_end" && event.step === "slow") throw new Error("the run died");
          },
        },
      ),
    /the run died/,
  );

  const onDisk = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", runId, "state.json"), "utf8"));
  assert.equal(onDisk.steps.fast?.status, "done");
});

function twoFlaky(): Flow {
  return flow("two-flaky", {
    steps: [
      agent({
        id: "one",
        prompt: "step.md",
        tools: ["read"],
        returns: Summary,
        cycle: { to: "one", when: "failed", limit: 2, policy: "accept" },
      }),
      agent({
        id: "two",
        prompt: "step.md",
        tools: ["read"],
        returns: Summary,
        cycle: { to: "two", when: "failed", limit: 2, policy: "accept" },
      }),
    ],
  });
}

test("two steps that fail in one wave both retry", async () => {
  const cwd = workspace();
  const harness = byStep({
    one: [new Error("the API answered 503"), { summary: "one" }],
    two: [new Error("the API answered 500"), { summary: "two" }],
  });

  const state = await run(twoFlaky(), { cwd, harness });

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.one?.value, { summary: "one" });
  assert.deepEqual(state.steps.two?.value, { summary: "two" });
});

test("each step that retries in a wave hears its own error", async () => {
  const cwd = workspace();
  const harness = byStep({
    one: [new Error("the API answered 503"), { summary: "one" }],
    two: [new Error("the API answered 500"), { summary: "two" }],
  });

  await run(twoFlaky(), { cwd, harness });

  const second = (id: string) => harness.seen.filter((request) => request.step === id)[1]?.prompt ?? "";
  assert.match(second("one"), /503/);
  assert.ok(!second("one").includes("500"));
  assert.match(second("two"), /500/);
});

test("a failure with no way back fails the run, even beside a failure that would ask a person", async () => {
  const cwd = workspace();
  const harness = byStep({
    start: [{ summary: "start" }],
    // It passes, the cycle sends it back, and it fails beside the spent step.
    hard: [{ summary: "ok" }, new Error("the disk is full")],
    soft: [new Error("the API answered 503")],
  });

  const state = await run(
    flow("mixed-failures", {
      steps: [
        agent({ id: "start", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "hard", needs: ["start"], prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({
          id: "soft",
          needs: ["start"],
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "start", when: "failed", limit: 1, policy: "escalate" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  // The run is over, so the failed step waits on no disk to run again.
  await assert.rejects(() => resume(state.runId, { summary: "a person wrote this" }, { cwd, harness }), /is failed/);
  assert.equal(harness.seen.filter((request) => request.step === "hard").length, 2);
});

test("two failures that reach the limit of their cycle run no step past that limit", async () => {
  const cwd = workspace();
  const harness = byStep({
    one: [new Error("the API answered 503")],
    two: [new Error("the API answered 500")],
  });

  const state = await run(
    flow("two-spent", {
      steps: [
        agent({
          id: "one",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "one", when: "failed", limit: 1, policy: "escalate" },
        }),
        agent({
          id: "two",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "two", when: "failed", limit: 1, policy: "escalate" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  await assert.rejects(() => resume(state.runId, { summary: "a person wrote this" }, { cwd, harness }), /is failed/);
  // One turn, and the one retry that the limit allows.
  assert.equal(harness.seen.filter((request) => request.step === "two").length, 2);
});

test("a failed attempt keeps its record when the step goes back to a step it does not need", async () => {
  const cwd = workspace();
  const harness = byStep({
    start: [{ summary: "s1" }, { summary: "s2" }],
    flaky: [new Error("the API answered 503"), { summary: "at last" }],
  });

  const state = await run(
    flow("aside", {
      steps: [
        agent({ id: "start", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({
          id: "flaky",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "start", when: "failed", limit: 2, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  // Every attempt is a cost, so the record of the one that failed stays.
  assert.deepEqual(state.history?.map((one) => one.step).sort(), ["flaky", "start"]);
});

test("a wave with two votes to cycle goes back to the earliest target and keeps the other vote", async () => {
  const cwd = workspace();
  const harness = byStep({
    first: [{ summary: "v1" }, { summary: "v2" }],
    second: [{ summary: "s1" }, { summary: "s2" }],
    near: [{ approved: false }, { approved: true }],
    far: [{ approved: false }, { approved: true }],
  });

  const state = await run(
    flow("panel", {
      steps: [
        agent({ id: "first", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "second", needs: ["first"], prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({
          id: "near",
          needs: ["second"],
          prompt: "step.md",
          tools: ["read"],
          returns: Verdict,
          cycle: { to: "second", when: { approved: false }, limit: 2, policy: "accept" },
        }),
        agent({
          id: "far",
          needs: ["second"],
          prompt: "step.md",
          tools: ["read"],
          returns: Verdict,
          cycle: { to: "first", when: { approved: false }, limit: 2, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  // "near" votes first, and "far" votes for the earlier step, so "far" wins.
  assert.equal(state.cycles["far->first"], 1);
  assert.equal(state.cycles["near->second"], undefined);
  const vote = state.history?.find((one) => one.step === "near");
  assert.equal(vote?.record.votedToCycle, "second");
});

test("a cycle keeps the work of a branch that does not need the step it goes back to", async () => {
  const cwd = workspace();
  const harness = byStep({
    code: [{ summary: "v1" }, { summary: "v2" }],
    aside: [{ summary: "aside" }],
    review: [{ approved: false }, { approved: true }],
  });

  const state = await run(
    flow("branch", {
      steps: [
        agent({ id: "code", prompt: "step.md", tools: ["write"], returns: Summary }),
        agent({ id: "aside", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({
          id: "review",
          needs: ["code"],
          prompt: "step.md",
          tools: ["read"],
          returns: Verdict,
          cycle: { to: "code", when: { approved: false }, limit: 2, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.aside?.value, { summary: "aside" });
  assert.equal(harness.seen.filter((request) => request.step === "aside").length, 1);
});

test("the narrower harness wins: the step, then the flow, then the run", async () => {
  const cwd = workspace();
  const one = fakeHarness({ summary: "one" });
  const two = fakeHarness({ summary: "two" });
  const three = fakeHarness({ summary: "three" });

  await run(
    flow("order", {
      harness: "two",
      steps: [
        agent({ id: "a", harness: "one", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", needs: ["a"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    // The run supplies `three`, as `--harness three` does.
    { cwd, harness: three, harnesses: { one, two, three } },
  );

  assert.equal(one.seen.length, 1, "the step names one, so it takes one");
  assert.equal(two.seen.length, 1, "the step names none, so it takes the flow");
  assert.equal(three.seen.length, 0, "the flow names one, so the run never answers");
});

// ── The values a flow takes, and the value it returns ────────────────────────

const Issue = Type.Object({ issue: Type.Number() });

function takingFlow(step: AgentStep): Flow {
  return flow("issued", { takes: Issue, steps: [step] });
}

test("a run that supplies values for a flow that takes none is refused", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  await assert.rejects(
    () =>
      run(flow("plain", { steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })] }), {
        cwd,
        harness,
        with: { issue: 123 },
      }),
    /takes no values, and this run supplies issue/,
  );
  assert.equal(harness.seen.length, 0);
});

test("a run that supplies no values for a flow that takes them is refused", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  await assert.rejects(
    () =>
      run(takingFlow(agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })), { cwd, harness }),
    /takes values, and this run supplies none/,
  );
  assert.equal(harness.seen.length, 0);
});

test("a value that breaks what the flow takes fails before any step spends a token", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  await assert.rejects(
    () =>
      run(takingFlow(agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })), {
        cwd,
        harness,
        with: { issue: "123" },
      }),
    /break what the flow "issued" takes at "\/issue": must be number/,
  );
  assert.equal(harness.seen.length, 0);
});

test("an agent step reads the values the run takes, and a component takes them as well", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });
  writeFileSync(join(cwd, "m.ts"), "export default (inputs, say, values) => ({ summary: String(values.issue) });");

  const state = await run(
    flow("issued", {
      takes: Issue,
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary }),
        call({ id: "b", needs: ["a"], module: "m.ts", returns: Summary }),
      ],
    }),
    { cwd, harness, with: { issue: 123 } },
  );

  assert.equal(state.status, "done");
  assert.match(harness.seen[0]?.prompt ?? "", /The values this run takes[\s\S]*"issue": 123/);
  assert.deepEqual(state.steps.b?.value, { summary: "123" });
});

test("a name in a prompt takes its value from the flow and from the step", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });
  writeFileSync(join(cwd, "named.md"), "Read issue {{ issue }} for {{who}}.");

  await run(
    flow("issued", {
      takes: Issue,
      steps: [
        agent({
          id: "a",
          prompt: "named.md",
          tools: ["read"],
          returns: Summary,
          with: { who: "the platform team" },
        }),
      ],
    }),
    { cwd, harness, with: { issue: 123 } },
  );

  assert.match(harness.seen[0]?.prompt ?? "", /Read issue 123 for the platform team\./);
});

test("a name that nothing supplies fails the step, and names the step and the name", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });
  writeFileSync(join(cwd, "named.md"), "Read issue {{ ticket }}.");

  const state = await run(
    takingFlow(agent({ id: "a", prompt: "named.md", tools: ["read"], returns: Summary })),
    { cwd, harness, with: { issue: 123 } },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /step "a" reads "\{\{ ticket \}\}" in its prompt/);
  assert.match(state.steps.a?.error ?? "", /nothing supplies "ticket"/);
  assert.equal(harness.seen.length, 0);
});

test("validate refuses a flow that returns a value and ends in more than one step", () => {
  const problems = validate(
    flow("two-ends", {
      returns: Summary,
      steps: [
        agent({ id: "a", prompt: "p.md", tools: ["read"], returns: Summary }),
        agent({ id: "b", prompt: "p.md", tools: ["read"], returns: Summary }),
      ],
    }),
  );

  assert.ok(problems.some((p) => p.includes('it ends in 2 steps: "a", "b"')));
});

test("the value of the step a flow ends with is checked against what the flow returns", async () => {
  const cwd = workspace();

  const state = await run(
    flow("checked", {
      returns: Verdict,
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ summary: "done" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.error ?? "", /the value of "a" breaks what the flow "checked" returns/);
});

test("a flow that returns the value it declares ends done", async () => {
  const cwd = workspace();

  const state = await run(
    flow("checked", {
      returns: Summary,
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: fakeHarness({ summary: "done" }) },
  );

  assert.equal(state.status, "done");
  assert.equal(state.error, undefined);
});

test("a flow step passes its values down to the steps of the flow it names", async () => {
  const inner = flow("panel", {
    takes: Issue,
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict, with: { angle: "risk" } }),
      call({ id: "sum", needs: ["look"], module: "sum.ts", returns: Verdict }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml", with: { issue: 123 } }],
    }),
    async () => inner,
  );

  // The step keeps what only it holds, and takes what the flow step supplies.
  assert.deepEqual((expanded.steps[0] as AgentStep).with, { issue: 123, angle: "risk" });
  assert.deepEqual((expanded.steps[1] as CallStep).with, { issue: 123 });
  assert.deepEqual(validate(expanded), []);
});

test("a flow step that supplies a value the flow it names does not take is refused", async () => {
  const inner = flow("panel", {
    steps: [agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict })],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", {
          steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml", with: { issue: 123 } }],
        }),
        async () => inner,
      ),
    /takes no values, and step "review" supplies issue/,
  );
});

test("a flow step that supplies none to a flow that takes values is refused", async () => {
  const inner = flow("panel", {
    takes: Issue,
    steps: [agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict })],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", { steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }] }),
        async () => inner,
      ),
    /takes values, and step "review" supplies none/,
  );
});

test("validate refuses what a flow takes when it is not JSON Schema", () => {
  const problems = validate(
    parseFlow(
      [
        "name: bad",
        "takes: issue",
        "steps:",
        "  - id: one",
        "    kind: agent",
        "    prompt: p.md",
        "    tools: [read]",
        "    returns: { type: object }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('the flow takes "issue", which is not JSON Schema')));
});

test("a component in a sub-flow reads the values of that flow, as it does in a run of its own", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "m.ts"), "export default (inputs, say, values) => ({ summary: String(values.issue) });");

  const inner = flow("panel", { takes: Issue, steps: [call({ id: "open", module: "m.ts", returns: Summary })] });
  const outer = await expandFlows(
    flow("outer", {
      steps: [{ kind: "flow", id: "sub", needs: [], flow: "./panel.yaml", with: { issue: 123 } }],
    }),
    async () => inner,
  );

  const state = await run(outer, { cwd });
  assert.deepEqual(state.steps["sub/open"]?.value, { summary: "123" });
});

// ── The cycle of a gate ──────────────────────────────────────────────────────

function humanReviewFlow(limit: number, policy: "escalate" | "accept"): Flow {
  return flow("human-review", {
    steps: [
      agent({ id: "code", prompt: "step.md", tools: ["write"], returns: Summary }),
      gate({
        id: "review",
        needs: ["code"],
        question: "Is the code right?",
        returns: Verdict,
        cycle: { to: "code", when: { approved: false }, limit, policy },
      }),
    ],
  });
}

test("a gate sends the run back when a person rejects the work", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v1" }, { summary: "v2" });

  const stopped = await run(humanReviewFlow(2, "accept"), { cwd, harness });
  assert.equal(stopped.waitingFor, "review");

  const again = await resume(stopped.runId, { approved: false }, { cwd, harness });
  assert.equal(again.status, "waiting");
  assert.equal(again.waitingFor, "review");
  assert.equal(again.cycles["review->code"], 1);
  assert.equal(harness.seen.length, 2);

  const finished = await resume(again.runId, { approved: true }, { cwd, harness });
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.steps.code?.value, { summary: "v2" });
});

test("a gate carries the answer of the person back to the step it goes back to", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v1" }, { summary: "v2" });

  const stopped = await run(humanReviewFlow(2, "accept"), { cwd, harness });
  await resume(stopped.runId, { approved: false, note: "name the file" }, { cwd, harness });

  assert.match(harness.seen[1]?.prompt ?? "", /name the file/);
});

test("a gate stops at its limit, and the accept policy records the disagreement", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v" });

  const stopped = await run(humanReviewFlow(1, "accept"), { cwd, harness });
  const again = await resume(stopped.runId, { approved: false }, { cwd, harness });
  assert.equal(again.status, "waiting");

  const finished = await resume(again.runId, { approved: false }, { cwd, harness });
  assert.equal(finished.status, "done");
  assert.equal(finished.cycles["review->code"], 1);
  assert.equal(finished.steps.review?.disagreement, "accepted");
});

test("a person who answers for a step that escalated fires no cycle of that step", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "v" }, { approved: false });

  const stopped = await run(reviewFlow(1, "escalate"), { cwd, harness });
  assert.equal(stopped.waitingFor, "review");
  const spent = harness.seen.length;

  // The person agrees with the review that reached its limit. The cycle of the
  // step it stands in for must not send the run back on that value.
  const finished = await resume(stopped.runId, { approved: false }, { cwd, harness });
  assert.equal(finished.status, "done");
  assert.equal(harness.seen.length, spent);
});

test("validate holds a gate to every rule that a cycle already has", () => {
  const gated = (cycle: string) =>
    parseFlow(
      [
        "name: gated",
        "steps:",
        "  - id: one",
        "    kind: agent",
        "    prompt: p.md",
        "    tools: [read]",
        "    returns: { type: object, properties: { ok: { type: boolean } } }",
        "  - id: ask",
        "    kind: gate",
        "    needs: [one]",
        "    question: is it right?",
        "    returns: { type: object, properties: { approved: { type: boolean } } }",
        `    cycle: ${cycle}`,
        "  - id: later",
        "    kind: agent",
        "    needs: [ask]",
        "    prompt: p.md",
        "    tools: [read]",
        "    returns: { type: object }",
      ].join("\n"),
    );

  const forward = validate(gated("{ to: later, when: { approved: false }, limit: 2, policy: accept }"));
  assert.ok(forward.some((p) => p.includes('step "ask" cycles to "later", which does not run before it')));

  const failed = validate(gated("{ to: one, when: failed, limit: 2, policy: accept }"));
  assert.ok(failed.some((p) => p.includes('step "ask" cannot fail, so it cannot cycle on a failure')));

  const asking = validate(gated("{ to: one, when: { approved: false }, limit: 2, policy: escalate }"));
  assert.ok(
    asking.some((p) => p.includes('step "ask" cycles with the policy "escalate", and a person already answers it')),
  );

  assert.deepEqual(validate(gated("{ to: one, when: { approved: false }, limit: 2, policy: accept }")), []);
});

test("a flow step cycles onto the gate that the flow it names ends with", async () => {
  const inner = flow("panel", {
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Summary }),
      gate({ id: "judge", needs: ["look"], question: "Is it right?", returns: Verdict }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      steps: [
        agent({ id: "code", prompt: "code.md", tools: ["write"], returns: Summary }),
        {
          kind: "flow",
          id: "review",
          needs: ["code"],
          flow: "./panel.yaml",
          cycle: { to: "code", when: { approved: false }, limit: 2, policy: "accept" },
        },
      ],
    }),
    async () => inner,
  );

  const last = expanded.steps.find((step) => step.id === "review/judge") as GateStep;
  assert.equal(last.cycle?.to, "code");
  assert.deepEqual(validate(expanded), []);
});

// ── A match holds one operator ───────────────────────────────────────────────

const Sorted = Type.Object({
  severity: Type.String(),
  score: Type.Number(),
  findings: Type.Array(Type.String()),
  result: Type.Object({ ok: Type.Boolean() }),
});

test("each operator of a match decides whether a step runs", async () => {
  const cwd = workspace();
  const done = { summary: "ran" };
  const harness = fakeHarness({ severity: "low", score: 3, findings: [], result: { ok: true } }, done, done, done, done);
  const one = (id: string, when: Record<string, unknown>) =>
    agent({ id, needs: ["sort"], when: { sort: when }, prompt: "step.md", tools: ["read"], returns: Summary });

  const state = await run(
    flow("operators", {
      steps: [
        agent({ id: "sort", prompt: "step.md", tools: ["read"], returns: Sorted }),
        one("other", { severity: { not: "high" } }),
        one("same", { result: { is: { ok: true } } }),
        one("none", { findings: { empty: true } }),
        one("under", { score: { lt: 7 } }),
        one("over", { score: { gt: 7 } }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(
    Object.fromEntries(["other", "same", "none", "under", "over"].map((id) => [id, state.steps[id]?.status])),
    { other: "done", same: "done", none: "done", under: "done", over: "skipped" },
  );
});

test("a cycle goes back while a list holds something, and stops when it is empty", async () => {
  const cwd = workspace();
  const Review = Type.Object({ findings: Type.Array(Type.String()) });
  const harness = fakeHarness({ summary: "v1" }, { findings: ["a"] }, { summary: "v2" }, { findings: [] });

  const state = await run(
    flow("findings", {
      steps: [
        agent({ id: "code", prompt: "step.md", tools: ["write"], returns: Summary }),
        agent({
          id: "review",
          needs: ["code"],
          prompt: "step.md",
          tools: ["read"],
          returns: Review,
          cycle: { to: "code", when: { findings: { empty: false } }, limit: 3, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  assert.equal(state.cycles["review->code"], 1);
  assert.equal(harness.seen.length, 4);
});

test("a step and a cycle refuse the same match, because both hold one idea", () => {
  const onStep = validate(
    flow("step", {
      steps: [
        agent({ id: "sort", prompt: "p.md", tools: ["read"], returns: Sorted }),
        agent({
          id: "page",
          needs: ["sort"],
          when: { sort: { severity: { equals: "high" } } },
          prompt: "p.md",
          tools: ["read"],
          returns: Summary,
        }),
      ],
    }),
  );

  assert.ok(
    onStep.some((p) =>
      p.includes('step "page" runs when "sort" says "severity" with {"equals":"high"}, which is not one operator'),
    ),
  );
  assert.ok(onStep.some((p) => p.includes("Use one of: is, not, empty, lt, gt")));

  const onCycle = validate(
    flow("cycle", {
      steps: [
        agent({ id: "sort", prompt: "p.md", tools: ["read"], returns: Sorted }),
        agent({
          id: "page",
          needs: ["sort"],
          prompt: "p.md",
          tools: ["read"],
          returns: Sorted,
          cycle: { to: "sort", when: { result: { ok: true } }, limit: 2, policy: "accept" },
        }),
      ],
    }),
  );

  assert.ok(onCycle.some((p) => p.includes('step "page" cycles on "result" with {"ok":true}, which is not one operator')));
  assert.ok(onCycle.some((p) => p.includes("Write { is: ... } to test the value itself")));
});

test("validate refuses an operator that nests, that reads the wrong value, or that tests one", () => {
  const sorted = (when: Record<string, unknown>) =>
    validate(
      flow("wrong", {
        steps: [
          agent({ id: "sort", prompt: "p.md", tools: ["read"], returns: Sorted }),
          agent({ id: "page", needs: ["sort"], when: { sort: when }, prompt: "p.md", tools: ["read"], returns: Summary }),
        ],
      }),
    );

  assert.ok(
    sorted({ findings: { not: { empty: true } } }).some((p) =>
      p.includes('step "page" runs when "sort" says "findings" with "not" over the operator "empty"'),
    ),
  );
  assert.ok(
    sorted({ score: { lt: "seven" } }).some((p) =>
      p.includes('step "page" runs when "sort" says "score" with "lt": "seven". The operator "lt" reads a number.'),
    ),
  );
  assert.ok(
    sorted({ severity: { lt: 7 } }).some((p) =>
      p.includes('step "page" runs when "sort" says "severity" with "lt", and "severity" holds a string'),
    ),
  );
});

test("a file keeps a gate that cycles, and a match that holds an operator", () => {
  const text = [
    "name: kept",
    "steps:",
    "  - id: code",
    "    kind: agent",
    "    prompt: p.md",
    "    tools: [write]",
    "    returns: { type: object, properties: { findings: { type: array } } }",
    "  - id: ask",
    "    kind: gate",
    "    needs: [code]",
    "    question: is it right?",
    "    returns: { type: object, properties: { approved: { type: boolean } } }",
    "    cycle: { to: code, when: { approved: { not: true } }, limit: 2, policy: accept }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
});

// ── A fanout over a value the run computes ───────────────────────────────────

const Found = Type.Object({
  packages: Type.Array(Type.Object({ name: Type.String(), version: Type.Optional(Type.String()) })),
});

/** A step that finds a list, and a step that runs once for each item of it. */
function auditFlow(): Flow {
  return flow("audit", {
    steps: [
      call({ id: "find", module: "find.ts", returns: Found }),
      call({
        id: "audit",
        needs: ["find"],
        module: "audit.ts",
        returns: Summary,
        fanout: { step: "find", key: "packages" },
      }),
      call({ id: "sum", needs: ["audit"], module: "sum.ts", returns: Summary }),
    ],
  });
}

function auditWorkspace(found: string): string {
  const cwd = workspace();
  writeFileSync(join(cwd, "find.ts"), `export default () => (${found});`);
  writeFileSync(join(cwd, "audit.ts"), "export default (inputs, say, held) => ({ summary: held.name });");
  writeFileSync(join(cwd, "sum.ts"), "export default (inputs) => ({ summary: Object.keys(inputs).join(',') });");
  return cwd;
}

test("a fanout over a list a step computes runs once for each item", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core" }, { name: "cli" }, { name: "api" }] }');

  const state = await run(auditFlow(), { cwd });

  assert.equal(state.status, "done");
  assert.deepEqual(Object.keys(state.steps), ["find", "audit/core", "audit/cli", "audit/api", "sum"]);
  assert.deepEqual(state.steps["audit/cli"]?.value, { summary: "cli" });
});

test("a step that needs a computed fanout waits for every item of it", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core" }, { name: "cli" }] }');

  const state = await run(auditFlow(), { cwd });

  assert.deepEqual(state.steps.sum?.value, { summary: "audit/core,audit/cli" });
});

test("the steps a computed fanout makes reach the state on disk", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core", version: "1.2" }] }');

  const state = await run(auditFlow(), { cwd });

  // ADR 0005: the state on disk is the run, so a crash recovers the same steps.
  const onDisk = JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "state.json"), "utf8")) as RunState;
  assert.deepEqual(
    onDisk.flow.steps.map((step) => step.id),
    ["find", "audit/core", "sum"],
  );
  const audit = onDisk.flow.steps[1] as CallStep;
  // The item is the value of the member, and no fanout is left to expand twice.
  assert.deepEqual(audit.with, { name: "core", version: "1.2" });
  assert.equal(audit.fanout, undefined);
});

test("a run fails when an item of a computed list carries no name", async () => {
  const cwd = auditWorkspace('{ packages: ["core", "cli"] }');
  const loose = auditFlow();
  loose.steps[0] = call({ id: "find", module: "find.ts", returns: Type.Object({ packages: Type.Array(Type.Any()) }) });

  const state = await run(loose, { cwd });

  assert.equal(state.status, "failed");
  assert.match(state.steps.audit?.error ?? "", /step "audit" fans out over "packages" of "find"/);
  assert.match(state.steps.audit?.error ?? "", /holds no "name"/);
});

test("a run fails when two items of a computed list use one name", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core" }, { name: "core" }] }');

  const state = await run(auditFlow(), { cwd });

  assert.equal(state.status, "failed");
  assert.match(state.steps.audit?.error ?? "", /two items use the name "core"/);
});

test("a computed fanout over an empty list skips the step, and the steps that need it", async () => {
  const cwd = auditWorkspace("{ packages: [] }");

  const state = await run(auditFlow(), { cwd });

  assert.equal(state.status, "done");
  assert.equal(state.steps.audit?.status, "skipped");
  assert.match(state.steps.audit?.skipped ?? "", /"find" returned no "packages"/);
  assert.equal(state.steps.sum?.status, "skipped");
});

test("validate refuses a computed fanout over a step it does not need", () => {
  const wrong = auditFlow();
  (wrong.steps[1] as CallStep).needs = [];
  (wrong.steps[2] as CallStep).needs = ["find"];

  const problems = validate(wrong);

  assert.ok(problems.some((p) => p.includes('but it does not need "find"')));
});

test("validate refuses a computed fanout over a key the step it reads does not return as a list", () => {
  const missing = auditFlow();
  (missing.steps[1] as CallStep).fanout = { step: "find", key: "modules" };
  const flat = auditFlow();
  (flat.steps[0] as CallStep).returns = Type.Object({ packages: Type.String() });

  assert.ok(validate(missing).some((p) => p.includes('which "find" does not return')));
  assert.ok(validate(flat).some((p) => p.includes('"packages" is not a list')));
});

test("validate refuses a computed fanout whose items name no member", () => {
  const nameless = auditFlow();
  (nameless.steps[0] as CallStep).returns = Type.Object({
    packages: Type.Array(Type.Object({ path: Type.String() })),
  });

  const problems = validate(nameless);

  assert.ok(problems.some((p) => p.includes('holds no "name"')));
});

test("validate refuses a computed fanout that also cycles", () => {
  const both = auditFlow();
  (both.steps[1] as CallStep).cycle = { to: "find", when: { summary: "again" }, limit: 2, policy: "accept" };

  assert.ok(validate(both).some((p) => p.includes('step "audit" fans out and cycles to "find"')));
});

test("a member of a computed fanout retries its own failure", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core" }, { name: "cli" }] }');
  // The run expands a computed fanout, so the retry has to survive that
  // expansion as well as the one that happens before the run.
  const failed = new Set<string>();
  const flaky: Harness = {
    toTrajectory: () => undefined,
    async run(request: AgentRequest) {
      if (request.step === "audit/core" && !failed.has(request.step)) {
        failed.add(request.step);
        throw new Error("the step ended without a call to submit_result");
      }
      return { value: { summary: request.step } };
    },
  };

  const audited = auditFlow();
  audited.steps[1] = agent({
    id: "audit",
    needs: ["find"],
    prompt: "step.md",
    tools: ["read"],
    returns: Summary,
    fanout: { step: "find", key: "packages" },
    cycle: { to: "audit", when: "failed", limit: 1, policy: "accept" },
  });

  const state = await run(audited, { cwd, harness: flaky });

  assert.equal(state.status, "done");
  assert.equal(state.steps["audit/core"]?.status, "done");
  assert.equal(state.steps["audit/cli"]?.status, "done");
  assert.equal(state.cycles["audit/core->audit/core"], 1);
});

test("validate refuses a field of a computed fanout that nothing reads", () => {
  const extra = auditFlow();
  (extra.steps[1] as CallStep).fanout = { step: "find", key: "packages", name: "package" } as never;

  const problems = validate(extra);

  assert.ok(problems.some((p) => p.includes('holds "name", which is not a field of a fanout')));
});

test("validate refuses a flow that returns a value and ends in a computed fanout", () => {
  const ending = flow("audit", {
    returns: Summary,
    steps: auditFlow().steps.slice(0, 2),
  });

  const problems = validate(ending);

  assert.ok(problems.some((p) => p.includes("fans out over a list, so the run ends in one step for each item")));
});

test("a file keeps a computed fanout, so the editor writes it back unharmed", () => {
  const text = [
    "name: audit",
    "steps:",
    "  - id: find",
    "    kind: call",
    "    module: find.ts",
    "    returns: { type: object }",
    "  - id: audit",
    "    kind: call",
    "    needs: [find]",
    "    module: audit.ts",
    "    returns: { type: object }",
    "    fanout: { step: find, key: packages }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
});

// ── The promise of a flow, and what a step did ───────────────────────────────

test("a flow sets the promise, and a step that declares none takes it", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("read-only", {
      workspace: { kind: "git", path: "." },
      changes: "nothing",
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: writingHarness(cwd, "sneaky.txt", { summary: "I changed nothing" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /step "a" promises to change nothing, but it added sneaky\.txt/);
});

test("a step that writes a file the workspace already changed breaks its promise", async () => {
  const cwd = gitWorkspace();
  // The tree is dirty before the step, which is the ordinary state of a repository.
  writeFileSync(join(cwd, "step.md"), "Do the work. Edited by a person.");

  const state = await run(
    flow("read-only", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" }),
      ],
    }),
    { cwd, harness: writingHarness(cwd, "step.md", { summary: "I changed nothing" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing, but it changed step\.md/);
});

test("a workspace records a repeated change to a quoted Unicode path", () => {
  const cwd = gitWorkspace();
  const name = 'notes/one "quoted" ü\nline.md';
  mkdirSync(join(cwd, "notes"));
  writeFileSync(join(cwd, name), "first");
  execFileSync("git", ["add", name], { cwd, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "odd path"], { cwd, stdio: "pipe" });
  writeFileSync(join(cwd, name), "changed before");

  const before = take({ kind: "git", path: "." }, cwd);
  writeFileSync(join(cwd, name), "changed by the step");

  assert.deepEqual(changed(before, take({ kind: "git", path: "." }, cwd)), [{ path: name, how: "changed" }]);
});

test("a workspace hashes a symbolic link itself on repeated changes", () => {
  const cwd = gitWorkspace();
  writeFileSync(join(cwd, "one.txt"), "same");
  writeFileSync(join(cwd, "two.txt"), "same");
  writeFileSync(join(cwd, "three.txt"), "same");
  symlinkSync("one.txt", join(cwd, "held"));
  execFileSync("git", ["add", "one.txt", "two.txt", "three.txt", "held"], { cwd, stdio: "pipe" });
  execFileSync("git", ["commit", "-qm", "link"], { cwd, stdio: "pipe" });
  unlinkSync(join(cwd, "held"));
  symlinkSync("two.txt", join(cwd, "held"));

  const before = take({ kind: "git", path: "." }, cwd);
  unlinkSync(join(cwd, "held"));
  symlinkSync("three.txt", join(cwd, "held"));

  assert.deepEqual(changed(before, take({ kind: "git", path: "." }, cwd)), [{ path: "held", how: "changed" }]);
});

test("a step that renames a file out of the paths it promises breaks its promise", async () => {
  const cwd = gitWorkspace();
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "docs", "one.md"), "one");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("add", "docs/one.md");
  git("commit", "-qm", "docs");

  const state = await run(
    flow("docs-only", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({
          id: "a",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          changes: { paths: ["docs"] },
        }),
      ],
    }),
    {
      cwd,
      harness: actingHarness(() => git("mv", "docs/one.md", "moved.md"), { summary: "moved it" }),
    },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change only docs, but it renamed docs\/one\.md to moved\.md/);
});

test("a step overrides the promise of the flow", async () => {
  const cwd = gitWorkspace();
  mkdirSync(join(cwd, "docs"));

  const state = await run(
    flow("mixed", {
      workspace: { kind: "git", path: "." },
      changes: "nothing",
      steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary, changes: { paths: ["docs"] } })],
    }),
    { cwd, harness: writingHarness(cwd, "docs/new.md", { summary: "I stayed in docs" }) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.a?.changed, [{ path: "docs/new.md", how: "added" }]);
});

test("validate refuses a promise on a flow that no workspace can check", () => {
  const problems = validate(
    flow("unchecked", {
      changes: "nothing",
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
  );

  assert.ok(problems.some((p) => p.includes("the flow promises what it changes, but it has no workspace to check it")));
});

test("a step that promises an exception fails when it changes the path it excepts", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("except", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary, changes: { except: ["step.md"] } }),
      ],
    }),
    { cwd, harness: writingHarness(cwd, "step.md", { summary: "I left step.md alone" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing in step\.md, but it changed step\.md/);
});

test("a step that promises an exception passes when it changes anything else", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("except", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary, changes: { except: ["step.md"] } }),
      ],
    }),
    { cwd, harness: writingHarness(cwd, "new.txt", { summary: "I left step.md alone" }) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.a?.changed, [{ path: "new.txt", how: "added" }]);
});

test("validate refuses a promise that names paths and an exception at once", () => {
  const problems = validate(
    parseFlow(
      [
        "name: both",
        "workspace: { kind: git, path: . }",
        "steps:",
        "  - id: one",
        "    kind: agent",
        "    prompt: p.md",
        "    tools: [write]",
        "    changes: { paths: [docs], except: [CONTEXT.md] }",
        "    returns: { type: object }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('step "one" promises "paths" and "except" at once')));
});

test("the record of a step names what it did to each path", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("kinds", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary })],
    }),
    {
      cwd,
      harness: actingHarness(() => {
        writeFileSync(join(cwd, "new.txt"), "new");
        rmSync(join(cwd, "step.md"));
      }, { summary: "one added, one deleted" }),
    },
  );

  assert.deepEqual(state.steps.a?.changed, [
    { path: "new.txt", how: "added" },
    { path: "step.md", how: "deleted" },
  ]);
});

test("a step that deletes a file hears the word deleted, and not the word changed", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("promise", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: "nothing" })],
    }),
    { cwd, harness: actingHarness(() => rmSync(join(cwd, "step.md")), { summary: "I changed nothing" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing, but it deleted step\.md/);
});

test("a step that commits hears that it moved HEAD", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("commit", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["bash"], returns: Summary, changes: "nothing" })],
    }),
    {
      cwd,
      harness: actingHarness(() => {
        writeFileSync(join(cwd, "step.md"), "changed by the step");
        execFileSync("git", ["commit", "-qam", "second"], { cwd, stdio: "pipe" });
      }, { summary: "I committed" }),
    },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing, but it moved HEAD/);
});

test("a file keeps the promise of a flow, and a promise with an exception", () => {
  const text = [
    "name: kept",
    "workspace: { kind: git, path: . }",
    "changes: nothing",
    "steps:",
    "  - id: code",
    "    kind: agent",
    "    prompt: p.md",
    "    tools: [write]",
    "    changes: { except: [CONTEXT.md] }",
    "    returns: { type: object }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
});

test("a step that undoes the work of an earlier step hears that it restored the path", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("undo", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({ id: "a", prompt: "step.md", tools: ["write"], returns: Summary }),
        agent({ id: "b", needs: ["a"], prompt: "step.md", tools: ["write"], returns: Summary }),
      ],
    }),
    {
      cwd,
      harness: {
        toTrajectory: () => undefined,
        async run(request) {
          if (request.step === "a") writeFileSync(join(cwd, "extra.txt"), "work");
          else rmSync(join(cwd, "extra.txt"));
          return { value: { summary: request.step } };
        },
      },
    },
  );

  assert.deepEqual(state.steps.a?.changed, [{ path: "extra.txt", how: "added" }]);
  assert.deepEqual(state.steps.b?.changed, [{ path: "extra.txt", how: "restored" }]);
});

test("a sub-flow carries the promise it sets into the flow that holds it", async () => {
  const inner = flow("inner", {
    workspace: { kind: "git", path: "." },
    changes: "nothing",
    steps: [
      agent({ id: "read", prompt: "p.md", tools: ["read"], returns: Summary }),
      agent({
        id: "write",
        needs: ["read"],
        prompt: "p.md",
        tools: ["write"],
        returns: Summary,
        changes: { paths: ["docs"] },
      }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      workspace: { kind: "git", path: "." },
      steps: [{ kind: "flow", id: "sub", needs: [], flow: "./inner.yaml" }],
    }),
    async () => inner,
  );

  assert.deepEqual(
    expanded.steps.map((step) => (step as AgentStep).changes),
    ["nothing", { paths: ["docs"] }],
  );
});

// ── A run has a budget, and a harness reads a model name ─────────────────────

/** A harness that reports what each turn spent. `undefined` reports nothing. */
function costlyHarness(cost: number | undefined, ...values: unknown[]): Harness & { seen: AgentRequest[] } {
  const seen: AgentRequest[] = [];
  return {
    seen,
    toTrajectory: () => undefined,
    async run(request: AgentRequest): Promise<AgentResult> {
      seen.push(request);
      return { value: values[(seen.length - 1) % values.length], trajectory: "/sessions/fake.jsonl", cost };
    },
  };
}

test("a run stops at the budget of the flow, and says what it spent", async () => {
  const cwd = workspace();
  const harness = costlyHarness(1, { summary: "done" });

  const state = await run(
    flow("spend", {
      budget: 2,
      steps: [
        agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "two", needs: ["one"], prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "three", needs: ["two"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  assert.equal(harness.seen.length, 2);
  assert.equal(state.steps.three, undefined);
  assert.match(state.error ?? "", /it spent \$2 of \$2/);
});

test("the cost of a run that a cycle threw away counts against the budget", async () => {
  const cwd = workspace();
  const harness = costlyHarness(1, { summary: "v1" }, { approved: false }, { summary: "v2" }, { approved: true });

  const state = await run({ ...reviewFlow(3, "accept"), budget: 3 }, { cwd, harness });

  // Two runs of "code" and one of "review" reach the budget, and two of those
  // three records are in the history that the cycle threw away.
  assert.equal(state.status, "failed");
  assert.equal(harness.seen.length, 3);
  assert.equal(state.history?.length, 2);
  assert.match(state.error ?? "", /it spent \$3 of \$3/);
});

test("a run with a budget stops when a step reports no cost", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  const state = await run(
    flow("blind", {
      budget: 5,
      steps: [
        agent({ id: "one", prompt: "step.md", tools: ["read"], returns: Summary }),
        agent({ id: "two", needs: ["one"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  assert.equal(harness.seen.length, 1);
  assert.match(state.error ?? "", /step "one" reported no cost/);
});

test("the cost of a step that breaks its contract counts against the budget", async () => {
  const cwd = workspace();
  const harness = costlyHarness(3, { summary: 42 });

  const state = await run(
    flow("retry", {
      budget: 2,
      steps: [
        agent({
          id: "a",
          prompt: "step.md",
          tools: ["read"],
          returns: Summary,
          cycle: { to: "a", when: "failed", limit: 3, policy: "accept" },
        }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "failed");
  assert.equal(harness.seen.length, 1);
  assert.match(state.error ?? "", /it spent \$3 of \$2/);
});

test("validate takes a budget of nothing, and refuses one that is not a number of dollars", () => {
  const budgeted = (budget: unknown) =>
    validate({
      name: "b",
      budget,
      steps: [agent({ id: "a", prompt: "p.md", tools: ["read"], returns: Summary })],
    } as unknown as Flow);

  assert.ok(budgeted(-1).some((p) => p.includes("A budget is a number of dollars")));
  assert.ok(budgeted("5").some((p) => p.includes("A budget is a number of dollars")));
  assert.deepEqual(budgeted(0.5), []);
  // Nothing is a budget a run can keep: no step of it may spend.
  assert.deepEqual(budgeted(0), []);
});

test("validate refuses a budget on a flow where no step spends", () => {
  const problems = validate(
    flow("free", { budget: 1, steps: [call({ id: "a", module: "m.ts", returns: Summary })] }),
  );

  assert.ok(problems.some((p) => p.includes("no step of it spends")));
});

test("a sub-flow carries the harness and the model it names onto each step it holds", async () => {
  const inner = flow("panel", {
    harness: "claude",
    model: "haiku",
    steps: [
      agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Summary }),
      agent({ id: "own", needs: ["look"], prompt: "look.md", tools: ["read"], returns: Summary, model: "opus" }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      harness: "pi",
      model: "ollama/glm-5.2",
      steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }],
    }),
    async () => inner,
  );

  const look = expanded.steps.find((step) => step.id === "review/look") as AgentStep;
  const own = expanded.steps.find((step) => step.id === "review/own") as AgentStep;
  assert.equal(look.harness, "claude");
  assert.equal(look.model, "haiku");
  // The step keeps what only it names, which is the narrower of the two.
  assert.equal(own.model, "opus");
});

test("a flow step that names a flow with a width of its own is refused", async () => {
  const inner = flow("panel", {
    parallel: 1,
    steps: [agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Summary })],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", { steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }] }),
        async () => inner,
      ),
    /runs 1 steps at a time, and step "review" holds it/,
  );
});

test("a flow step that names a flow with a budget of its own is refused", async () => {
  const inner = flow("panel", {
    budget: 1,
    steps: [agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Verdict })],
  });

  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", { steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }] }),
        async () => inner,
      ),
    /has a budget, and step "review" holds it/,
  );
});

test("a file keeps the budget of a flow", () => {
  const text = [
    "name: kept",
    "budget: 2.5",
    "steps:",
    "  - id: code",
    "    kind: agent",
    "    prompt: p.md",
    "    tools: [write]",
    "    returns: { type: object }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
});

test("validate refuses a model name that the harness of the step cannot read", () => {
  const named = (harness: string, model: string) =>
    validate(
      flow("m", {
        harness,
        model,
        steps: [agent({ id: "a", prompt: "p.md", tools: ["read"], returns: Summary })],
      }),
    );

  assert.ok(
    named("pi", "opus").some((p) =>
      p.includes('step "a" names the model "opus", which the harness "pi" cannot read. Write the provider and the model, as "openai/gpt-5".'),
    ),
  );
  assert.ok(
    named("claude", "openai/gpt-5").some((p) =>
      p.includes('step "a" names the model "openai/gpt-5", which the harness "claude" cannot read. Write a plain model name, as "opus".'),
    ),
  );
  assert.deepEqual(named("pi", "ollama/glm-5.2"), []);
  assert.deepEqual(named("claude", "claude-opus-4-5"), []);

  // A step that names its own harness and model is read by that harness.
  const step = validate(
    flow("m", {
      harness: "claude",
      steps: [agent({ id: "a", harness: "pi", model: "opus", prompt: "p.md", tools: ["read"], returns: Summary })],
    }),
  );
  assert.ok(step.some((p) => p.includes('step "a" names the model "opus", which the harness "pi" cannot read')));
});

test("a member that overrides the model is read by the harness of that member", () => {
  const panel = (member: { name: string; harness?: string; model?: string }) =>
    validate(
      flow("panel", {
        harness: "pi",
        model: "ollama/glm-5.2",
        steps: [
          agent({ id: "ask", prompt: "p.md", tools: ["read"], returns: Summary, fanout: [{ name: "one" }, member] }),
        ],
      }),
    );

  assert.ok(
    panel({ name: "two", model: "opus" }).some((p) =>
      p.includes('member "two" of "ask" names the model "opus", which the harness "pi" cannot read'),
    ),
  );
  // The member takes the model of the step, and its own harness reads it.
  assert.ok(
    panel({ name: "two", harness: "claude" }).some((p) =>
      p.includes('member "two" of "ask" names the model "ollama/glm-5.2", which the harness "claude" cannot read'),
    ),
  );
  assert.deepEqual(panel({ name: "two", harness: "claude", model: "opus" }), []);
});

test("the pi adapter reports what a session spent, and nothing when no message priced it", () => {
  const cwd = workspace();
  const write = (usage: unknown) => {
    const file = join(cwd, `${JSON.stringify(usage).length}.jsonl`);
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "session", id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [], usage } }),
      ].join("\n"),
    );
    return file;
  };

  assert.equal(costOf(write({ input: 10, output: 2, cost: { total: 0.25 } })), 0.5);
  // A provider that reports no price leaves the cost unknown, and not zero.
  assert.equal(costOf(write({ input: 10, output: 2 })), undefined);
  // A provider with no price table prices every message at zero, which is the
  // same thing wearing a number. A budget that read it as zero was not enforced.
  assert.equal(costOf(write({ input: 10, output: 2, cost: { total: 0 } })), undefined);
  assert.equal(costOf(join(cwd, "no-session.jsonl")), undefined);
});

// ── What a step takes ────────────────────────────────────────────────────────

/** A flow whose values arrive, or do not, so a step can declare what it needs. */
const Loose = Type.Object({ issue: Type.Optional(Type.Number()) });

test("validate refuses a step that takes a value nothing supplies", () => {
  const problems = validate(
    flow("wired", {
      takes: Issue,
      steps: [call({ id: "open", module: "m.ts", returns: Summary, takes: Type.Object({ ticket: Type.Number() }) })],
    }),
  );

  assert.ok(
    problems.some((p) =>
      p.includes(
        'step "open" takes "ticket", and nothing supplies it. Add "ticket" to "takes" on the flow, or to "with" on the step.',
      ),
    ),
  );
});

test("a step that takes a value the run does not supply fails before the module runs", async () => {
  const cwd = workspace();
  const ran = join(cwd, "ran.txt");
  writeFileSync(
    join(cwd, "m.ts"),
    `import { writeFileSync } from "node:fs";
     export default (inputs, say, values) => {
       writeFileSync(${JSON.stringify(ran)}, "yes");
       return { summary: String(values.issue) };
     };`,
  );

  const state = await run(
    flow("loose", { takes: Loose, steps: [call({ id: "open", module: "m.ts", returns: Summary, takes: Issue })] }),
    { cwd, with: {} },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.open?.error ?? "", /the values that reach "open" break what it takes/);
  assert.match(state.steps.open?.error ?? "", /must have required property 'issue'/);
  assert.equal(existsSync(ran), false);
});

test("an agent step that takes a value it does not get spends no token", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });

  const state = await run(
    flow("loose", {
      takes: Loose,
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, takes: Issue })],
    }),
    { cwd, harness, with: {} },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /the values that reach "a" break what it takes/);
  assert.equal(harness.seen.length, 0);
});

test("an item of a computed fanout is checked against what the step takes", async () => {
  const cwd = auditWorkspace('{ packages: [{ name: "core", version: "1.2" }, { name: "cli" }] }');
  const audited = auditFlow();
  (audited.steps[1] as CallStep).takes = Type.Object({ name: Type.String(), version: Type.String() });

  const state = await run(audited, { cwd });

  assert.equal(state.status, "failed");
  assert.equal(state.steps["audit/core"]?.status, "done");
  assert.match(state.steps["audit/cli"]?.error ?? "", /the values that reach "audit\/cli" break what it takes/);
  assert.match(state.steps["audit/cli"]?.error ?? "", /must have required property 'version'/);
});

test("a member of a fanout supplies what the step takes", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "m.ts"), "export default (inputs, say, values) => ({ summary: values.package });");
  const Package = Type.Object({ package: Type.String() });
  const audit = (second: { name: string; with?: Record<string, unknown> }): Flow =>
    flow("audit", {
      steps: [
        call({
          id: "audit",
          module: "m.ts",
          returns: Summary,
          takes: Package,
          fanout: [{ name: "core", with: { package: "core" } }, second],
        }),
      ],
    });

  const good = audit({ name: "cli", with: { package: "cli" } });
  assert.deepEqual(validate(good), []);
  const state = await run(good, { cwd });
  assert.equal(state.status, "done");
  assert.deepEqual(state.steps["audit/cli"]?.value, { summary: "cli" });

  assert.ok(
    validate(audit({ name: "cli" })).some((p) =>
      p.includes('member "cli" of "audit" takes "package", and nothing supplies it'),
    ),
  );
});

test("a step of a sub-flow takes the values the flow step supplies", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "m.ts"), "export default (inputs, say, values) => ({ summary: String(values.issue) });");

  const inner = flow("panel", {
    takes: Issue,
    steps: [call({ id: "open", module: "m.ts", returns: Summary, takes: Issue })],
  });
  const outer = await expandFlows(
    flow("outer", {
      steps: [{ kind: "flow", id: "sub", needs: [], flow: "./panel.yaml", with: { issue: 123 } }],
    }),
    async () => inner,
  );

  assert.deepEqual(validate(outer), []);
  const state = await run(outer, { cwd });
  assert.deepEqual(state.steps["sub/open"]?.value, { summary: "123" });
});

test("validate refuses what a step takes when it is not JSON Schema", () => {
  const problems = validate(
    parseFlow(
      [
        "name: bad",
        "steps:",
        "  - id: one",
        "    kind: call",
        "    module: m.ts",
        "    takes: issue",
        "    returns: { type: object }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('step "one" takes "issue", which is not JSON Schema')));
});

test("a gate takes its value from a person, so it says only what it returns", () => {
  const problems = validate(
    flow("asked", {
      steps: [{ kind: "gate", id: "ask", needs: [], question: "Is it right?", returns: Summary, takes: Issue } as never],
    }),
  );

  assert.ok(
    problems.some((p) =>
      p.includes('step "ask" holds "takes", which a gate step cannot act on. Only an agent or a call step holds it.'),
    ),
  );
});

test("a file keeps what a step takes", () => {
  const schema = "{ type: object, properties: { issue: { type: number } }, required: [issue] }";
  const text = [
    "name: kept",
    `takes: ${schema}`,
    "steps:",
    "  - id: open",
    "    kind: call",
    "    module: m.ts",
    `    takes: ${schema}`,
    "    returns: { type: object }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
});

// -- What the sweep of 2026-08-11 found. See docs/sweep.md --

test("validate refuses a cycle whose limit is missing, so no run goes round for ever", () => {
  const cycled = (cycle: unknown) =>
    validate({
      name: "loop",
      steps: [
        { id: "a", kind: "call", needs: [], module: "m.ts", returns: Summary },
        { id: "b", kind: "call", needs: ["a"], module: "m.ts", returns: Summary, cycle },
      ],
    } as unknown as Flow);

  // `count > undefined` is never true, so a cycle with no limit never ends.
  const missing = cycled({ to: "a", when: "failed" });
  assert.ok(missing.some((p) => p.includes("A limit is a whole number of turns")));
  assert.ok(cycled({ to: "a", when: "failed", limit: "3" }).some((p) => p.includes("A limit is a whole number")));
  assert.ok(cycled({ to: "a", when: "failed", limit: 2.5 }).some((p) => p.includes("A limit is a whole number")));
  assert.ok(cycled({ to: "a", when: "failed", limit: 0 }).some((p) => p.includes("A limit is a whole number")));
  assert.deepEqual(cycled({ to: "a", when: "failed", limit: 2 }), []);
});

test("validate refuses a cycle that holds a policy or a field no one reads", () => {
  const cycled = (cycle: unknown) =>
    validate({
      name: "loop",
      steps: [
        { id: "a", kind: "call", needs: [], module: "m.ts", returns: Summary },
        { id: "b", kind: "call", needs: ["a"], module: "m.ts", returns: Summary, cycle },
      ],
    } as unknown as Flow);

  assert.ok(
    cycled({ to: "a", when: "failed", limit: 2, policy: "banana" }).some((p) => p.includes('the policy "banana"')),
  );
  assert.ok(
    cycled({ to: "a", when: "failed", limit: 2, unless: "x" }).some((p) => p.includes('"unless", which is not a field')),
  );
  assert.ok(cycled({ to: "a", limit: 2 }).some((p) => p.includes("says nothing about when")));
});

test("a budget of nothing runs a step that cannot spend, and stops before one that can", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "count.ts"), "export default () => ({ summary: 'free' });\n");

  const state = await run(
    flow("free-then-paid", {
      budget: 0,
      steps: [
        call({ id: "free", module: "count.ts", returns: Summary }),
        agent({ id: "paid", needs: ["free"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness: fakeHarness({ summary: "spent something" }) },
  );

  assert.equal(state.steps.free?.status, "done");
  assert.equal(state.status, "failed");
  assert.equal(state.steps.paid, undefined);
  assert.match(state.error ?? "", /reached the budget/);
});

test("a step that failed keeps what it spent, and the budget counts it", async () => {
  const cwd = workspace();
  // A harness that spends and then fails hands the cost over on the error, the
  // way the claude adapter does. ADR 0019 counts a failed attempt.
  const burning: Harness = {
    toTrajectory: () => undefined,
    async run() {
      throw Object.assign(new Error("it could not answer"), { trajectory: "session-1", cost: 0.02 });
    },
  };

  const state = await run(
    flow("burns", {
      budget: 0.01,
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, harness: burning },
  );

  assert.equal(state.steps.a?.status, "failed");
  assert.equal(state.steps.a?.cost, 0.02);
  assert.equal(state.steps.a?.trajectory, "session-1");
});

test("a promise reads a path the way git writes it, however the flow spells it", async () => {
  const cwd = gitWorkspace();
  mkdirSync(join(cwd, "src"), { recursive: true });

  // `./src` and `src` are one path. They were two, and the promise allowed
  // every write to the first spelling.
  const state = await run(
    flow("spelling", {
      workspace: { kind: "git", path: "." },
      steps: [
        agent({
          id: "a",
          prompt: "step.md",
          tools: ["write"],
          returns: Summary,
          changes: { except: ["./src/"] },
        }),
      ],
    }),
    { cwd, harness: writingHarness(cwd, join("src", "sneaky.ts"), { summary: "wrote where I promised not to" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.a?.error ?? "", /promises to change nothing in \.\/src\/, but it added src\/sneaky\.ts/);
});

test("the Claude adapter counts one answer once, however many lines it takes", () => {
  const home = mkdtempSync(join(tmpdir(), "orchy-claude-"));
  const project = join(home, "projects", "-some-where");
  mkdirSync(project, { recursive: true });

  // Claude writes one line for each block of an answer, and every line repeats
  // the usage of the whole answer. Counting each line multiplied the tokens of
  // a step by the number of blocks it happened to take.
  const sessionId = "99999999-8888-7777-6666-555555555555";
  const usage = {
    input_tokens: 9,
    output_tokens: 143,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 5115,
  };
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "assistant", id: "msg_1", model: "claude-haiku-4-5", content: [{ type: "text", text: "one" }], usage },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02Z",
        message: {
          role: "assistant",
          id: "msg_1",
          model: "claude-haiku-4-5",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
          usage,
        },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03Z",
        message: { role: "assistant", id: "msg_2", model: "claude-haiku-4-5", content: [{ type: "text", text: "two" }], usage },
      }),
    ].join("\n"),
  );

  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    const trajectory = claude.toTrajectory(sessionId, "run:1:a", "0.0.0");
    assert.ok(trajectory);
    // Two answers, not three lines. A cache write is an input token a person
    // paid for, so it counts with the others instead of vanishing.
    assert.equal(trajectory.final_metrics.prompt_tokens, (9 + 5115) * 2);
    assert.equal(trajectory.final_metrics.completion_tokens, 143 * 2);
    assert.equal(trajectory.final_metrics.cached_tokens, 2 * 2);
    assert.equal(trajectory.steps.length, 3);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("loading a flow that holds itself is refused instead of never ending", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-self-"));
  writeFileSync(
    join(cwd, "self.yaml"),
    "name: self\nsteps:\n  - id: again\n    kind: flow\n    needs: []\n    flow: self.yaml\n",
  );

  await assert.rejects(() => loadFlow(join(cwd, "self.yaml")), /is open already/);
});

test("loading a flow that two files hold in turn is refused as well", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-pair-"));
  writeFileSync(join(cwd, "a.yaml"), "name: a\nsteps:\n  - id: b\n    kind: flow\n    needs: []\n    flow: b.yaml\n");
  writeFileSync(join(cwd, "b.yaml"), "name: b\nsteps:\n  - id: a\n    kind: flow\n    needs: []\n    flow: a.yaml\n");

  await assert.rejects(() => loadFlow(join(cwd, "a.yaml")), /is open already/);
});

test("a file is checked before it is expanded, so a field on a flow step cannot slip through", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-holds-"));
  writeFileSync(join(cwd, "inner.yaml"), "name: inner\nsteps:\n  - id: one\n    kind: call\n    needs: []\n    module: m.ts\n    returns:\n      type: object\n");
  // Expansion takes the flow step away, so `validate()` never saw one: a `when`
  // it says it refuses went through in silence, and the inner steps ran anyway.
  writeFileSync(
    join(cwd, "outer.yaml"),
    "name: outer\nsteps:\n  - id: sub\n    kind: flow\n    needs: []\n    flow: inner.yaml\n    when:\n      ghost:\n        is: 1\n",
  );

  await assert.rejects(() => loadFlow(join(cwd, "outer.yaml")), /holds "when", which a flow step cannot act on/);
});

test("an inner flow with a promise and no workspace is checked in the workspace of the flow that holds it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-inner-promise-"));
  // The fragment promises what it changes and names no workspace, because the
  // flow that includes it names one. Standing alone it is refused, since alone
  // there is no workspace to check the promise against.
  writeFileSync(
    join(cwd, "inner.yaml"),
    [
      "name: inner",
      "steps:",
      "  - id: one",
      "    kind: call",
      "    needs: []",
      "    module: m.ts",
      "    changes: nothing",
      "    returns:",
      "      type: object",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "outer.yaml"),
    [
      "name: outer",
      "workspace: { kind: git, path: . }",
      "steps:",
      "  - id: sub",
      "    kind: flow",
      "    needs: []",
      "    flow: inner.yaml",
      "",
    ].join("\n"),
  );

  const loaded = await loadFlow(join(cwd, "outer.yaml"));
  assert.deepEqual(validate(loaded), []);
  await assert.rejects(() => loadFlow(join(cwd, "inner.yaml")), /no workspace to check it/);
});

test("an inner flow that returns a value under its own contract is refused, not quietly dropped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-inner-returns-"));
  writeFileSync(
    join(cwd, "inner.yaml"),
    [
      "name: inner",
      "returns:",
      "  type: object",
      "  required: [count]",
      "  properties:",
      "    count: { type: number }",
      "steps:",
      "  - id: one",
      "    kind: call",
      "    needs: []",
      "    module: m.ts",
      "    returns:",
      "      type: object",
      "",
    ].join("\n"),
  );
  writeFileSync(join(cwd, "outer.yaml"), "name: outer\nsteps:\n  - id: sub\n    kind: flow\n    needs: []\n    flow: inner.yaml\n");

  await assert.rejects(() => loadFlow(join(cwd, "outer.yaml")), /would drop it/);
});

test("validate refuses a harness that does not exist, so a typo cannot turn the checks off", () => {
  const named = (harness: string) =>
    validate({
      name: "typo",
      harness: "claude",
      steps: [
        {
          id: "a",
          kind: "agent",
          needs: [],
          harness,
          model: "openai/gpt-5",
          prompt: "step.md",
          tools: ["web"],
          returns: Summary,
        },
      ],
    } as unknown as Flow);

  // `clade` placed no harness, so the tool check and the model check both read
  // nothing and said nothing: three faults, one clean flow. The name itself is
  // the fault to report, and the flow is refused for it.
  assert.deepEqual(named("clade"), [
    'step "a" names the harness "clade", which does not exist. Use one of: pi, claude, droid',
  ]);
  assert.ok(named("").some((p) => p.includes('names the harness ""')));
  // A harness that is real gets read: pi has no web tool, and says so.
  const onPi = named("pi");
  assert.ok(!onPi.some((p) => p.includes("does not exist")));
  assert.ok(onPi.some((p) => p.includes('asks for the tool "web", and the harness "pi" has none')));
});

test("validate reads the tools and the model against the harness the run will use", () => {
  const flowWithNoHarness = {
    name: "unnamed",
    steps: [
      { id: "a", kind: "agent", needs: [], prompt: "step.md", tools: ["web"], model: "haiku", returns: Summary },
    ],
  } as unknown as Flow;

  // A flow that names no harness is what the README tells a person to write,
  // and it was the flow that got no check at all: `--harness pi` has no web
  // tool and cannot read a plain model name.
  assert.deepEqual(validate(flowWithNoHarness, "claude"), []);
  const onPi = validate(flowWithNoHarness, "pi");
  assert.ok(onPi.some((p) => p.includes('asks for the tool "web", and the harness "pi" has none')));
  assert.ok(onPi.some((p) => p.includes('names the model "haiku"')));
});

test("validate refuses a model named as nothing, which quietly took the default", () => {
  const problems = validate({
    name: "empty-model",
    harness: "claude",
    steps: [{ id: "a", kind: "agent", needs: [], model: "", prompt: "step.md", tools: ["read"], returns: Summary }],
  } as unknown as Flow);

  assert.ok(problems.some((p) => p.includes("which names no model")));
});

test("validate refuses a contract whose keyword is a typo, which used to check nothing", () => {
  const problems = validate({
    name: "typo",
    steps: [
      {
        id: "a",
        kind: "call",
        needs: [],
        module: "m.ts",
        // `requires` is not `required`, and Ajv read the whole contract loosely:
        // every value passed, and nothing said a word.
        returns: { type: "object", requires: ["n"], properties: { n: { type: "number" } } },
      },
    ],
  } as unknown as Flow);

  assert.ok(problems.some((p) => p.includes("unknown keyword")));
});

test("a cycle back past the step that gave the list makes the members again", async () => {
  const cwd = workspace();
  // The list grows every round. The members froze on the first list: the new
  // names were never run, and the run ended `done` saying nothing about it.
  writeFileSync(
    join(cwd, "plan.ts"),
    [
      "let round = 0;",
      "export default () => {",
      "  round += 1;",
      "  const names = ['a', 'b', 'c'].slice(0, round + 1);",
      "  return { round, items: names.map((name) => ({ name })) };",
      "};",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(cwd, "judge.ts"),
    "export default (_i, _s, values) => ({ name: String(values.name) });\n",
  );
  writeFileSync(
    join(cwd, "check.ts"),
    [
      "export default (inputs) => {",
      "  const judged = Object.keys(inputs).filter((id) => id.startsWith('judge/'));",
      "  return { judged, enough: judged.length >= 3 };",
      "};",
      "",
    ].join("\n"),
  );

  const state = await run(
    flow("growing", {
      steps: [
        call({ id: "plan", module: "plan.ts", returns: Type.Object({ round: Type.Number(), items: Type.Array(Type.Object({ name: Type.String() })) }) }),
        call({
          id: "judge",
          needs: ["plan"],
          module: "judge.ts",
          fanout: { step: "plan", key: "items" },
          returns: Type.Object({ name: Type.String() }),
        }),
        call({
          id: "check",
          needs: ["judge"],
          module: "check.ts",
          returns: Type.Object({ judged: Type.Array(Type.String()), enough: Type.Boolean() }),
          cycle: { to: "plan", when: { enough: false }, limit: 3, policy: "accept" },
        }),
      ],
    }),
    { cwd },
  );

  assert.equal(state.status, "done");
  assert.deepEqual((state.steps.check?.value as { judged: string[] }).judged, ["judge/a", "judge/b", "judge/c"]);
});

test("a member of a computed fanout keeps the values its step already holds", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "plan.ts"), "export default () => ({ items: [{ name: 'one' }] });\n");
  writeFileSync(join(cwd, "member.ts"), "export default (_i, _s, values) => ({ summary: `${values.tag}:${values.name}` });\n");

  const state = await run(
    flow("keeps", {
      steps: [
        call({ id: "plan", module: "plan.ts", returns: Type.Object({ items: Type.Array(Type.Object({ name: Type.String() })) }) }),
        call({
          id: "work",
          needs: ["plan"],
          module: "member.ts",
          with: { tag: "outer" },
          fanout: { step: "plan", key: "items" },
          returns: Summary,
        }),
      ],
    }),
    { cwd },
  );

  assert.equal(state.status, "done");
  assert.equal((state.steps["work/one"]?.value as { summary: string }).summary, "outer:one");
});

test("a gate asks its question with the names in it filled in", async () => {
  const cwd = workspace();

  const state = await run(
    flow("asking", {
      takes: Type.Object({ ticket: Type.String() }),
      steps: [
        gate({
          id: "approve",
          question: "Does ticket {{ ticket }} look right?",
          returns: Type.Object({ approved: Type.Boolean() }),
        }),
      ],
    }),
    { cwd, with: { ticket: "ORC-41" } },
  );

  assert.equal(state.status, "waiting");
  // The braces reached the person. Two runs of one flow asked the same question.
  assert.equal(state.question, "Does ticket ORC-41 look right?");
});

test("a nested gate asks the same question once with the values of its flow step", async () => {
  const cwd = workspace();
  const Ticket = Type.Object({ ticket: Type.String() });
  const inner = flow("asked", {
    takes: Ticket,
    steps: [gate({ id: "approve", question: "Approve {{ ticket }}?", returns: Verdict })],
  });
  const ticket = "ORC-42 {{ literal }}";

  const standalone = await run(inner, { cwd, with: { ticket } });
  const expanded = await expandFlows(
    flow("outer", {
      steps: [{ id: "review", kind: "flow", needs: [], flow: "asked.yaml", with: { ticket } }],
    }),
    async () => inner,
  );
  const nested = await run(expanded, { cwd });

  assert.deepEqual((expanded.steps[0] as GateStep).with, { ticket });
  assert.equal(standalone.question, "Approve ORC-42 {{ literal }}?");
  assert.equal(nested.question, standalone.question);
});

test("the values of a nested gate override the values of its flow step", async () => {
  const Ticket = Type.Object({ ticket: Type.String() });
  const inner = flow("asked", {
    takes: Ticket,
    steps: [
      gate({
        id: "approve",
        question: "Approve {{ ticket }}?",
        with: { ticket: "the inner ticket" },
        returns: Verdict,
      }),
    ],
  });

  const expanded = await expandFlows(
    flow("outer", {
      steps: [
        { id: "review", kind: "flow", needs: [], flow: "asked.yaml", with: { ticket: "the outer ticket" } },
      ],
    }),
    async () => inner,
  );

  assert.deepEqual((expanded.steps[0] as GateStep).with, { ticket: "the inner ticket" });
});

test("a condition and a cycle of a nested gate keep their inner step ids", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "ready.ts"), "export default () => ({ ready: true });\n");
  const Ticket = Type.Object({ ticket: Type.String() });
  const Ready = Type.Object({ ready: Type.Boolean() });
  const inner = flow("asked", {
    takes: Ticket,
    steps: [
      call({ id: "prepare", module: "ready.ts", returns: Ready }),
      gate({
        id: "approve",
        needs: ["prepare"],
        when: { prepare: { ready: true } },
        question: "Approve {{ ticket }}?",
        returns: Verdict,
        cycle: { to: "approve", when: { approved: false }, limit: 1, policy: "accept" },
      }),
    ],
  });
  const expanded = await expandFlows(
    flow("outer", {
      steps: [
        { id: "review", kind: "flow", needs: [], flow: "asked.yaml", with: { ticket: "ORC-43" } },
      ],
    }),
    async () => inner,
  );
  const approve = expanded.steps[1] as GateStep;

  assert.deepEqual(approve.when, { "review/prepare": { ready: true } });
  assert.equal(approve.cycle?.to, "review/approve");
  assert.deepEqual(validate(expanded), []);

  const first = await run(expanded, { cwd });
  assert.equal(first.status, "waiting");
  const second = await resume(first.runId, { approved: false }, { cwd });
  assert.equal(second.status, "waiting");
  assert.equal(second.question?.startsWith("Approve ORC-43?"), true);
  const done = await resume(first.runId, { approved: true }, { cwd });
  assert.equal(done.status, "done");
});

test("a missing value in a gate question fails the run instead of becoming the question", async () => {
  const state = await run(
    flow("asked", {
      steps: [gate({ id: "approve", question: "Approve {{ ticket }}?", returns: Verdict })],
    }),
    { cwd: workspace() },
  );

  assert.equal(state.status, "failed");
  assert.equal(state.question, undefined);
  assert.match(state.error ?? "", /reads "\{\{ ticket \}\}" in its question/);
  assert.match(state.error ?? "", /Add it to "takes" on the flow/);
  assert.doesNotMatch(state.error ?? "", /"with" on the step/);
});

test("a call step runs a command in any language, and reads its value from stdout", async () => {
  const cwd = workspace();
  const notes: string[] = [];

  const state = await run(
    flow("commanded", {
      takes: Type.Object({ n: Type.Number() }),
      steps: [
        call({
          id: "double",
          command: `node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.error("doubling");console.log(JSON.stringify({count:d.values.n*2}))'`,
          returns: Type.Object({ count: Type.Number() }),
        }),
      ],
    }),
    { cwd, with: { n: 21 }, onEvent: (event) => event.type === "output" && notes.push(event.text) },
  );

  assert.equal(state.status, "done");
  assert.deepEqual(state.steps.double?.value, { count: 42 });
  // What the command wrote to stderr reached the notes; stdout stayed the value.
  assert.ok(notes.includes("doubling"));
});

test("a command that ends badly fails the step with what it said", async () => {
  const state = await run(
    flow("breaking", {
      steps: [
        call({
          id: "boom",
          command: `node -e 'console.error("the disk is full");process.exit(3)'`,
          returns: Type.Object({}),
        }),
      ],
    }),
    { cwd: workspace() },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.boom?.error ?? "", /the code 3/);
  assert.match(state.steps.boom?.error ?? "", /the disk is full/);
});

test("a command that answers no JSON is told where notes go", async () => {
  const state = await run(
    flow("chatting", {
      steps: [call({ id: "talk", command: "echo hello", returns: Type.Object({}) })],
    }),
    { cwd: workspace() },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.talk?.error ?? "", /notes to stderr/);
});

test("a command that writes too much output fails before it fills the run state", async () => {
  const state = await run(
    flow("loud", {
      steps: [
        call({
          id: "talk",
          command: `${process.execPath} -e 'process.stdout.write("x".repeat(4 * 1024 * 1024 + 1))'`,
          returns: Type.Object({}),
        }),
      ],
    }),
    { cwd: workspace() },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.talk?.error ?? "", /more than 4 MiB/);
});

test("a run passes cancellation to its harness and records stopped", async () => {
  const cwd = workspace();
  const control = new AbortController();
  const harness: Harness = {
    toTrajectory: () => undefined,
    async run(_request, _watch, signal) {
      signal?.throwIfAborted();
      throw new Error("the harness received no stop");
    },
  };

  const state = await run(
    flow("stopping", {
      steps: [agent({ id: "work", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    {
      cwd,
      harness,
      signal: control.signal,
      onEvent: (event) => event.type === "step_start" && control.abort(new Error("the run was stopped")),
    },
  );

  assert.equal(state.status, "stopped");
  assert.equal(JSON.parse(readFileSync(join(cwd, ".orchy", "runs", state.runId, "state.json"), "utf8")).status, "stopped");
});

test("direct adapter cancellation ends a command descendant", async () => {
  const cwd = workspace();
  const bin = join(cwd, "bin");
  mkdirSync(bin);
  const command = join(bin, "claude");
  writeFileSync(
    command,
    [
      `#!${process.execPath}`,
      `const { spawn } = require("node:child_process");`,
      `const fs = require("node:fs");`,
      `fs.writeFileSync("adapter-started", "yes");`,
      `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync('adapter-late', 'yes'), 1500); setTimeout(() => {}, 5000)"], { stdio: "ignore" });`,
      `child.unref();`,
      `setTimeout(() => {}, 5000);`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  const control = new AbortController();

  try {
    const running = claude.run(
      { step: "work", prompt: "Wait.", tools: [], returns: Type.Object({}), cwd },
      undefined,
      control.signal,
    );
    for (let count = 0; count < 100 && !existsSync(join(cwd, "adapter-started")); count += 1) {
      await new Promise((wait) => setTimeout(wait, 20));
    }
    assert.equal(existsSync(join(cwd, "adapter-started")), true);
    control.abort(new Error("the run was stopped"));
    await assert.rejects(running, /could not run the claude command/);
    await new Promise((wait) => setTimeout(wait, 2000));
    assert.equal(existsSync(join(cwd, "adapter-late")), false);
  } finally {
    process.env.PATH = path;
  }
});

test("the orchy check passes on a clean exit, and fails with what the command said", async () => {
  const Ok = Type.Object({ ok: Type.Boolean() });
  const checked = (command: string) =>
    flow("checked", {
      steps: [call({ id: "verify", module: "orchy:check", with: { run: command }, returns: Ok })],
    });

  const good = await run(checked("node -e 'process.exit(0)'"), { cwd: workspace() });
  assert.equal(good.status, "done");
  assert.deepEqual(good.steps.verify?.value, { ok: true });

  const bad = await run(checked(`node -e 'console.log("3 tests failed");process.exit(1)'`), { cwd: workspace() });
  assert.equal(bad.status, "failed");
  assert.match(bad.steps.verify?.error ?? "", /3 tests failed/);
});

test("a call step runs a module or a command, and exactly one", () => {
  const shaped = (fields: Record<string, unknown>) =>
    validate(flow("shaped", { steps: [{ kind: "call", id: "one", needs: [], returns: Type.Object({}), ...fields } as never] }));

  assert.match(shaped({ module: "a.ts", command: "true" }).join("\n"), /holds a module and a command/);
  assert.match(shaped({}).join("\n"), /no module and no command/);
  assert.match(shaped({ module: "orchy:nope" }).join("\n"), /Orchy supplies: orchy:check/);
  assert.deepEqual(shaped({ command: "true" }), []);
});

test("a bound on what a step starts must be readable, or it is refused", () => {
  const bounded = (tools: string[], starts: unknown) =>
    validate(
      flow("bounded", {
        steps: [agent({ id: "spawn", prompt: "step.md", tools: tools as never, starts: starts as never, returns: Summary })],
      }),
      "claude",
    );

  assert.match(bounded(["read"], { most: 2 }).join("\n"), /nothing reads the bound/);
  assert.match(bounded(["orchy"], {}).join("\n"), /no bound in it/);
  assert.match(bounded(["orchy"], { most: 0 }).join("\n"), /one or more/);
  assert.match(bounded(["orchy"], { rate: 2 }).join("\n"), /not a field of a bound/);
  assert.deepEqual(bounded(["orchy"], { most: 2 }), []);
});

test("the orchy tool is refused where the harness cannot supply it", () => {
  const doored = flow("doored", {
    steps: [agent({ id: "spawn", prompt: "step.md", tools: ["orchy"], returns: Summary })],
  });

  // Only the claude adapter opens the door of the run for a step. ADR 0025.
  assert.match(validate(doored, "pi").join("\n"), /the tool "orchy", and the harness "pi" has none/);
  assert.deepEqual(validate(doored, "claude"), []);
});

test("a resume takes a value or a step to go back to, not both", async () => {
  const cwd = workspace();
  const gated = flow("gated", {
    steps: [gate({ id: "confirm", question: "Ship it?", returns: Verdict })],
  });
  const stopped = await run(gated, { cwd });

  // The value would answer the gate, and "--from" would go back: one taken in
  // silence over the other sent a run forward when a person meant to go back.
  await assert.rejects(
    () => resume(stopped.runId, { approved: true }, { cwd, from: "confirm" }),
    /a value and a step/,
  );
});

test("one state revision takes one gate answer", async () => {
  const cwd = workspace();
  const stopped = await run(
    flow("gated-once", { steps: [gate({ id: "confirm", question: "Ship it?", returns: Type.Boolean() })] }),
    { cwd },
  );
  const revision = stopped.revision as number;

  const answers = await Promise.allSettled([
    resume(stopped.runId, true, { cwd, gate: "confirm", revision }),
    resume(stopped.runId, false, { cwd, gate: "confirm", revision }),
  ]);

  assert.equal(answers.filter((one) => one.status === "fulfilled").length, 1);
  assert.equal(answers.filter((one) => one.status === "rejected").length, 1);
  const saved = JSON.parse(
    readFileSync(join(cwd, ".orchy", "runs", stopped.runId, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(saved.status, "done");
});

test("a claim without a live owner fails closed until a person removes it", async () => {
  const cwd = workspace();
  const stopped = await run(
    flow("stale-claim", { steps: [gate({ id: "confirm", question: "Ship it?", returns: Type.Boolean() })] }),
    { cwd },
  );
  const claim = join(cwd, ".orchy", "runs", stopped.runId, "claim");
  mkdirSync(claim);
  await assert.rejects(
    () => resume(stopped.runId, true, { cwd, gate: "confirm", revision: stopped.revision }),
    /claim with no live owner/,
  );
  rmSync(claim, { recursive: true });
  writeFileSync(claim, JSON.stringify({ pid: 2_147_483_646, identity: "a dead process", token: "old" }));

  await assert.rejects(
    () => resume(stopped.runId, true, { cwd, gate: "confirm", revision: stopped.revision }),
    /remove it only when no Orchy process drives the run/,
  );
  rmSync(claim);

  const state = await resume(stopped.runId, true, {
    cwd,
    gate: "confirm",
    revision: stopped.revision,
  });

  assert.equal(state.status, "done");
});

test("a component that throws null leaves a failed run", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "null.ts"), "export default () => { throw null; };\n");

  const state = await run(
    flow("null-fault", { steps: [call({ id: "work", module: "null.ts", returns: Summary })] }),
    { cwd },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.work?.error ?? "", /null/);
  assert.equal(state.pid, undefined);
});

test("a post-step snapshot fault leaves a failed run", async () => {
  const cwd = gitWorkspace();
  writeFileSync(
    join(cwd, "remove-git.ts"),
    `import { rmSync } from 'node:fs'; export default () => { rmSync(${JSON.stringify(join(cwd, ".git"))}, { recursive: true }); return { summary: 'x' }; };\n`,
  );
  execFileSync("git", ["add", "remove-git.ts"], { cwd });
  execFileSync("git", ["commit", "-m", "add component"], { cwd, stdio: "ignore" });

  const state = await run(
    flow("snapshot-fault", {
      workspace: { kind: "git", path: "." },
      steps: [call({ id: "work", module: "remove-git.ts", returns: Summary })],
    }),
    { cwd },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.work?.error ?? "", /not a git repository/);
});

test("a step value that changes in JSON persistence fails", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "undefined.ts"), "export default () => ({ summary: undefined });\n");

  const state = await run(
    flow("json-only", { steps: [call({ id: "work", module: "undefined.ts", returns: Summary })] }),
    { cwd },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.work?.error ?? "", /undefined, which is not JSON/);
  const saved = JSON.parse(
    readFileSync(join(cwd, ".orchy", "runs", state.runId, "state.json"), "utf8"),
  ) as RunState;
  assert.equal(saved.steps.work?.status, "failed");
});

test("the question of a gate carries the values of the steps it needs", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "looks fine" });

  const state = await run(
    flow("showing", {
      steps: [
        agent({ id: "look", prompt: "step.md", tools: ["read"], returns: Summary }),
        gate({ id: "approve", needs: ["look"], question: "Ship it?", returns: Verdict }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "waiting");
  // The person answers with the work in front of them, the way an agent step
  // reads the steps before it in its prompt.
  assert.equal(state.question?.startsWith("Ship it?"), true);
  assert.match(state.question ?? "", /"summary": "looks fine"/);
});

test("a run whose process has gone says stopped, and not running", async () => {
  const cwd = workspace();
  writeFileSync(join(cwd, "m.ts"), "export default () => ({ summary: 'x' });\n");
  await run(
    flow("gone", { steps: [call({ id: "a", module: "m.ts", returns: Summary })] }),
    { cwd },
  );

  // A run that died leaves its own file saying "running", with the pid of a
  // process that has gone. Every reader repeated it: the page, `orchy runs`,
  // and the API, while the index beside them said "stopped".
  const [id] = readdirSync(join(cwd, ".orchy", "runs"));
  const file = join(cwd, ".orchy", "runs", id as string, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
  writeFileSync(file, JSON.stringify({ ...state, status: "running", pid: 2_147_483_646 }, null, 2));

  const [listed] = list(cwd);
  assert.equal(listed?.status, "stopped");
});

test("a flow that will not load ends the command as a wrong command, not a failed run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orchy-codes-"));
  writeFileSync(join(cwd, "m.ts"), "export default () => ({ summary: 'x' });\n");
  writeFileSync(
    join(cwd, "broken.yaml"),
    "name: broken\nsteps:\n  - id: a\n    kind: call\n    needs: []\n    module: m.ts\n    returns:\n      type: object\n    cycle: { to: a, when: failed }\n",
  );

  const code = (args: string[]) =>
    new Promise<number>((done) => {
      const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: "ignore" });
      child.on("close", (ended) => done(ended ?? -1));
    });

  // `--help` reserves 1 for a run that failed and 2 for a command that is
  // wrong. A flow that cannot even load is the second kind.
  assert.equal(await code(["run", "broken.yaml"]), 2);
  assert.equal(await code(["run", "nothing.yaml"]), 2);
  // `check` runs nothing and spends nothing, and says the same thing.
  assert.equal(await code(["check", "broken.yaml"]), 2);
});

test("a store keeps a line for each entry, and gives back the last of them", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-memory-"));
  const store = lines(root);

  const first = store.remember("ticket-14", { run: "r1", step: "code", text: "the parser lives in src/yaml.ts" });
  store.remember("ticket-14", { run: "r1", step: "review", text: "line, not comma", tags: ["style"] });
  store.remember("other", { run: "r2", step: "code", text: "nothing to do with it" });

  // One key is one store, so a second key sees nothing of the first.
  assert.equal(store.recall("ticket-14").length, 2);
  assert.equal(store.recall("other").length, 1);
  assert.deepEqual(store.recall("ticket-14", 1).map((one) => one.step), ["review"]);
  // A flow that asks for no seed gets none, where `slice(-0)` would give it all.
  assert.deepEqual(store.recall("ticket-14", 0), []);
  assert.deepEqual(store.keys(), ["other", "ticket-14"]);

  // Every entry names where it came from, so a wrong one is found and dropped.
  assert.equal(first.run, "r1");
  assert.equal(store.forget("ticket-14", first.id), 1);
  assert.equal(store.forget("ticket-14", first.id), 0);
  assert.deepEqual(store.recall("ticket-14").map((one) => one.text), ["line, not comma"]);
  // The file is a line of JSON for each entry, and nothing else.
  const file = readFileSync(join(root, ".orchy", "memory", "ticket-14.jsonl"), "utf8");
  assert.equal(file.trim().split("\n").length, 1);
  assert.equal((JSON.parse(file.trim()) as { text: string }).text, "line, not comma");

  assert.equal(store.forget("ticket-14"), 1);
  assert.deepEqual(store.recall("ticket-14"), []);
});

test("a store skips a line a hand broke, and opens all the same", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-broken-"));
  const store = lines(root);
  store.remember("k", { run: "r", step: "s", text: "good" });
  appendFileSync(join(root, ".orchy", "memory", "k.jsonl"), "{ half a line\n");
  store.remember("k", { run: "r", step: "s", text: "later" });

  // One malformed entry costs that entry, and not every flow that reads the store.
  assert.deepEqual(store.recall("k").map((one) => one.text), ["good", "later"]);
});

test("a store refuses an entry too long to seed a prompt", () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-long-"));
  const store = lines(root);
  // `most` bounds how many entries seed a prompt, and this bounds each one, so
  // the seed itself is bounded. A store of paragraphs is a document.
  assert.throws(() => store.remember("k", { run: "r", step: "s", text: "x".repeat(LONGEST + 1) }), /holds 2001 characters, and the most is 2000/);
  assert.equal(store.remember("k", { run: "r", step: "s", text: "x".repeat(LONGEST) }).text.length, LONGEST);
  assert.equal(store.recall("k").length, 1);
});

test("a scope is a key: the three words, and one a flow writes for itself", () => {
  assert.equal(keyOf(undefined, "bugfix"), undefined);
  assert.equal(keyOf({ scope: "none" }, "bugfix"), undefined);
  assert.equal(keyOf({ scope: "flow" }, "Bug Fix"), "flow-bug-fix");
  assert.equal(keyOf({ scope: "root" }, "bugfix"), "root");
  // The scope reads the values of the run, as a prompt does, so each ticket
  // gets its own store and a follow-up flow points at the same one.
  assert.equal(keyOf({ scope: "ticket/{{ issue }}" }, "bugfix", { issue: "PROJ-14" }), "ticket-proj-14");
  assert.equal(keyOf({ scope: "ticket/{{ issue }}" }, "corrections", { issue: "PROJ-14" }), "ticket-proj-14");
  // A key becomes a file name and never a path, so a walk out of the store is
  // not a thing that can be spelled.
  assert.equal(keyOf({ scope: "../../etc/passwd" }, "bugfix"), "etc-passwd");
  assert.equal(keyOf({ scope: ".." }, "bugfix"), "memory");
  assert.throws(
    () => keyOf({ scope: "ticket/{{ issue }}" }, "bugfix", {}),
    /nothing supplies "issue"/,
  );
});

test("validate refuses a memory that no run could resolve", () => {
  const scoped = (memory: unknown, takes?: TSchema) =>
    validate({
      name: "remembering",
      ...(takes ? { takes } : {}),
      memory: memory as never,
      steps: [agent({ id: "one", prompt: "p.md", tools: ["read"], returns: Summary })],
    });

  // A scope that reads a name the flow does not take is heard by `check`,
  // before a run starts and before a step spends anything.
  assert.ok(scoped({ scope: "ticket/{{ issue }}" }).some((p) => p.includes('does not take "issue"')));
  assert.equal(scoped({ scope: "ticket/{{ issue }}" }, Type.Object({ issue: Type.String() })).length, 0);
  assert.ok(scoped({ scope: "flow", most: -1 }).some((p) => p.includes("whole number")));
  assert.ok(scoped({ scope: "flow", every: 2 }).some((p) => p.includes('holds "every"')));
  assert.ok(scoped({ scope: "" }).some((p) => p.includes("has no scope")));
  assert.ok(scoped("flow").some((p) => p.includes("Write a memory as")));
  assert.equal(scoped({ scope: "flow" }).length, 0);
  assert.equal(scoped({ scope: "root", most: 0 }).length, 0);
});

test("validate refuses a step that remembers anything but none", () => {
  const stepped = (memory: unknown) =>
    validate({
      name: "remembering",
      memory: { scope: "flow" },
      steps: [{ ...agent({ id: "one", prompt: "p.md", tools: ["read"], returns: Summary }), memory } as AgentStep],
    });

  assert.ok(stepped("always").some((p) => p.includes("A step says only")));
  assert.ok(stepped({ scope: "root" }).some((p) => p.includes("The scope belongs to the flow")));
  assert.equal(stepped("none").length, 0);
});

test("a run seeds a prompt with what earlier runs recorded, and a step can decline it", async () => {
  const cwd = workspace();
  const store = lines(cwd);
  store.remember("flow-remembering", { run: "older", step: "code", text: "the parser lives in src/yaml.ts" });
  store.remember("flow-remembering", { run: "older", step: "review", text: "prefer a line to a comma" });

  const harness = fakeHarness({ summary: "done" }, { summary: "reviewed" });
  const state = await run(
    flow("remembering", {
      memory: { scope: "flow" },
      steps: [
        agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary }),
        // A step that reviews the work of another must be able to say that it
        // saw nothing but the work.
        agent({ id: "review", needs: ["code"], memory: "none", prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done");
  // The run resolves the key once and keeps it, so a resume reads the same store.
  assert.deepEqual(state.memory, { key: "flow-remembering", most: 20 });
  assert.match(harness.seen[0]?.prompt ?? "", /What earlier runs recorded/);
  assert.match(harness.seen[0]?.prompt ?? "", /the parser lives in src\/yaml\.ts/);
  assert.doesNotMatch(harness.seen[1]?.prompt ?? "", /What earlier runs recorded/);
  // The key rides on the request, so a harness that runs a process gives it to
  // the step. A step that declines the memory gets no key either.
  assert.equal(harness.seen[0]?.memory, "flow-remembering");
  assert.equal(harness.seen[1]?.memory, undefined);
  // The seed is part of the prompt, so the record keeps what the step was told.
  assert.match(state.steps.code?.prompt ?? "", /prefer a line to a comma/);
});

test("a seed holds what earlier runs recorded, and not what this run wrote", async () => {
  const cwd = workspace();
  const harness = fakeHarness({ summary: "done" });
  const state = await run(
    flow("writing", {
      memory: { scope: "flow" },
      steps: [
        call({ id: "record", module: "orchy:remember", with: { text: "written in this run" }, returns: Type.Object({ recorded: Type.Array(Type.String()) }) }),
        agent({ id: "later", needs: ["record"], prompt: "step.md", tools: ["read"], returns: Summary }),
      ],
    }),
    { cwd, harness },
  );

  assert.equal(state.status, "done", state.error ?? "");
  // What this run wrote is the state of this run, and the values of its steps
  // already carry it. The block says "earlier runs", so it holds only those.
  assert.doesNotMatch(harness.seen[0]?.prompt ?? "", /What earlier runs recorded/);
  assert.doesNotMatch(harness.seen[0]?.prompt ?? "", /written in this run/);
  // The store holds it all the same, for the run that comes after.
  assert.deepEqual(lines(cwd).recall("flow-writing").map((one) => one.text), ["written in this run"]);
});

test("a flow that declares no memory seeds nothing, and reads no store", async () => {
  const cwd = workspace();
  lines(cwd).remember("flow-quiet", { run: "older", step: "code", text: "a thing an earlier run knew" });

  const harness = fakeHarness({ summary: "done" });
  const state = await run(
    flow("quiet", { steps: [agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary })] }),
    { cwd, harness },
  );

  assert.equal(state.memory, undefined);
  assert.doesNotMatch(harness.seen[0]?.prompt ?? "", /What earlier runs recorded/);
});

test("a flow seeds the number of entries it asks for, and none when it asks for none", async () => {
  const cwd = workspace();
  const store = lines(cwd);
  for (const text of ["first", "second", "third"]) store.remember("flow-counting", { run: "r", step: "s", text });

  const seedOf = async (most: number) => {
    const harness = fakeHarness({ summary: "done" });
    await run(
      flow("counting", {
        memory: { scope: "flow", most },
        steps: [agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary })],
      }),
      { cwd, harness },
    );
    return harness.seen[0]?.prompt ?? "";
  };

  const two = await seedOf(2);
  assert.doesNotMatch(two, /first/);
  assert.match(two, /second/);
  assert.match(two, /third/);
  // `slice(-0)` is the whole list, so a flow that asks for no seed used to get all of it.
  assert.doesNotMatch(await seedOf(0), /What earlier runs recorded/);
});

test("a run that cannot resolve its scope is refused, and nothing starts", async () => {
  const cwd = workspace();

  await assert.rejects(
    run(
      flow("ticketed", {
        takes: Type.Object({ issue: Type.Optional(Type.String()) }),
        memory: { scope: "ticket/{{ issue }}" },
        steps: [agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary })],
      }),
      { cwd, with: {}, harness: fakeHarness({ summary: "done" }) },
    ),
    /nothing supplies "issue"/,
  );

  // The refusal came before a run directory existed, so nothing ran.
  assert.equal(existsSync(join(cwd, ".orchy", "runs")), false);
});

test("orchy:remember records a step, and the run after it reads what was recorded", async () => {
  const cwd = workspace();

  const bugfix = flow("bugfix", {
    takes: Type.Object({ issue: Type.String() }),
    memory: { scope: "ticket/{{ issue }}" },
    steps: [
      agent({ id: "code", prompt: "step.md", tools: ["read"], returns: Summary }),
      call({
        id: "record",
        needs: ["code"],
        module: "orchy:remember",
        with: { tags: ["handoff"] },
        returns: Type.Object({ recorded: Type.Array(Type.String()) }),
      }),
    ],
  });

  const first = await run(bugfix, { cwd, with: { issue: "PROJ-14" }, harness: fakeHarness({ summary: "I moved the parser" }) });
  assert.equal(first.status, "done", first.error ?? "");
  assert.equal((first.steps.record?.value as { recorded: string[] }).recorded.length, 1);

  const recorded = lines(cwd).recall("ticket-proj-14");
  assert.equal(recorded.length, 1);
  assert.match(recorded[0]?.text ?? "", /I moved the parser/);
  // Bookkeeping is a step, so the entry names the run and the step that wrote it.
  assert.equal(recorded[0]?.run, first.runId);
  assert.equal(recorded[0]?.step, "record");
  assert.deepEqual(recorded[0]?.tags, ["handoff"]);

  // A follow-up flow points at the same scope, and reads what the first one left.
  const follow = fakeHarness({ summary: "corrected" });
  await run(
    flow("corrections", {
      takes: Type.Object({ issue: Type.String() }),
      memory: { scope: "ticket/{{ issue }}" },
      steps: [agent({ id: "fix", prompt: "step.md", tools: ["read"], returns: Summary })],
    }),
    { cwd, with: { issue: "PROJ-14" }, harness: follow },
  );
  assert.match(follow.seen[0]?.prompt ?? "", /I moved the parser/);

  // Another ticket is another store, and sees none of it.
  const other = fakeHarness({ summary: "elsewhere" });
  await run(bugfix, { cwd, with: { issue: "PROJ-99" }, harness: other });
  assert.doesNotMatch(other.seen[0]?.prompt ?? "", /I moved the parser/);
});

test("orchy:remember refuses a flow that declares no memory, instead of recording nowhere", async () => {
  const cwd = workspace();

  const state = await run(
    flow("forgetful", {
      steps: [
        call({ id: "record", module: "orchy:remember", with: { text: "a thing" }, returns: Type.Object({ recorded: Type.Array(Type.String()) }) }),
      ],
    }),
    { cwd, harness: fakeHarness({ summary: "x" }) },
  );

  assert.equal(state.status, "failed");
  assert.match(state.steps.record?.error ?? "", /declares no memory/);
});

test("a command step learns the store from its environment", async () => {
  const cwd = workspace();

  const state = await run(
    flow("shelling", {
      memory: { scope: "flow" },
      steps: [
        call({
          id: "say",
          command: 'printf \'{"key":"%s","by":%s}\' "$ORCHY_MEMORY_KEY" "$ORCHY_STARTED_BY"',
          returns: Type.Object({ key: Type.String(), by: Type.Object({ runId: Type.String(), step: Type.String() }) }),
        }),
      ],
    }),
    { cwd, harness: fakeHarness({ summary: "x" }) },
  );

  // A command is a process, so it learns the store the way a process learns
  // anything, and `orchy memory add "$ORCHY_MEMORY_KEY"` writes where the run reads.
  assert.equal(state.status, "done", state.error ?? "");
  // It learns who it is from the same variable the door reads, so an entry it
  // adds names this run and this step, and not a person.
  assert.deepEqual(state.steps.say?.value, { key: "flow-shelling", by: { runId: state.runId, step: "say" } });
});

test("a flow step that names a flow with a memory of its own is refused", async () => {
  const inner = flow("panel", {
    memory: { scope: "flow" },
    steps: [agent({ id: "look", prompt: "look.md", tools: ["read"], returns: Summary })],
  });

  // A scope reads the values of the run, and expansion turns the values of an
  // inner flow into values of a step, so a scope that stood alone would resolve
  // against another flow's values here. Expansion would drop it in silence.
  await assert.rejects(
    () =>
      expandFlows(
        flow("outer", { steps: [{ kind: "flow", id: "review", needs: [], flow: "./panel.yaml" }] }),
        async () => inner,
      ),
    /remembers under "flow", and step "review" holds it/,
  );
});

test("a file keeps the memory of a flow, and the word a step declines it with", () => {
  const text = [
    "name: kept",
    "memory:",
    "  scope: ticket/{{ issue }}",
    "  most: 5",
    "takes:",
    "  type: object",
    "  required: [issue]",
    "  properties:",
    "    issue: { type: string }",
    "steps:",
    "  - id: code",
    "    kind: agent",
    "    prompt: p.md",
    "    tools: [write]",
    "    returns: { type: object }",
    "  - id: review",
    "    kind: agent",
    "    needs: [code]",
    "    memory: none",
    "    prompt: p.md",
    "    tools: [read]",
    "    returns: { type: object }",
  ].join("\n");

  const parsed = parseFlow(text);
  assert.deepEqual(validate(parsed), []);
  // A graphical editor writes the file it read, so neither field may be dropped.
  assert.deepEqual(parseFlow(formatFlow(parsed)), parsed);
  assert.deepEqual(parsed.memory, { scope: "ticket/{{ issue }}", most: 5 });
});

test("a cycle event names its limit, and a cycle that stops under accept says so", async () => {
  const cwd = workspace();
  const events: RunEvent[] = [];

  await run(reviewFlow(2, "accept"), {
    cwd,
    harness: fakeHarness({ summary: "v" }, { approved: false }),
    onEvent: (event) => events.push(event),
  });

  const cycles = events.filter((event) => event.type === "cycle") as Array<{ count: number; limit: number }>;
  assert.deepEqual(cycles.map((event) => [event.count, event.limit]), [[1, 2], [2, 2]]);
  const accepted = events.find((event) => event.type === "accept");
  assert.deepEqual(accepted, { type: "accept", step: "review", to: "code", limit: 2 });
  // The run went on, so the console hears the disagreement before it hears "done".
  assert.equal(events.indexOf(accepted as RunEvent), events.length - 2);
});

test("validate names the tools that exist, and the harness that has one, where it refuses a tool", () => {
  const problems = validate({
    name: "typo",
    harness: "pi",
    steps: [{ kind: "agent", id: "a", needs: [], prompt: "a.md", tools: ["teleport", "web"], returns: Summary } as never],
  });

  assert.ok(problems.some((p) => p.includes('the tool "teleport", which does not exist. Use one of: read, bash, edit')));
  assert.ok(problems.some((p) => p.includes('the tool "web", and the harness "pi" has none. Only claude and droid supply it.')));
});

test("validate names the workspace of none where a promise cannot be checked, and the fix", () => {
  const step = { kind: "agent", id: "a", needs: [], prompt: "a.md", tools: ["read"], returns: Summary, changes: "nothing" };
  const none = validate({ name: "none", workspace: { kind: "none" }, steps: [step as never] });
  assert.ok(none.some((p) => p.includes('the workspace of the flow is "none", which records no change. Write workspace:')));
  const missing = validate({ name: "missing", steps: [step as never] });
  assert.ok(missing.some((p) => p.includes("the flow has no workspace to check it. Write one, as workspace:")));
});

test("validate names the fields a flow holds where it refuses one", () => {
  const problems = validate({ name: "x", step: [], steps: [] } as never);
  assert.ok(problems.some((p) => p.includes('holds "step", which is not a field of a flow. A flow holds: name, workspace')));
});
