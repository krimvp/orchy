import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { type AgentStep, type CallStep, type Flow, agent, call, expandFanout, expandFlows, flow, gate, resolvePaths, validate } from "../src/flow.ts";
import type { AgentRequest, AgentResult, Harness } from "../src/harness.ts";
import { notesOf } from "../src/harness.ts";
import { type RunEvent, resume, run } from "../src/run.ts";
import { tail } from "../src/tail.ts";
import { claude } from "../src/claude.ts";
import { pi } from "../src/pi.ts";
import { parseFlow } from "../src/yaml.ts";

const Summary = Type.Object({ summary: Type.String() });

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

  // A run names itself first, so a parent process knows the run it drives.
  assert.deepEqual(events, [
    "run_start",
    "step_start", "step_end", "step_start", "step_end", "cycle",
    "step_start", "step_end", "step_start", "step_end", "run_end",
  ]);
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
  assert.deepEqual(
    output.map((event) => `${event.kind}: ${event.text}`),
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

/** A harness that writes a file before it answers, like an agent with `bash`. */
function writingHarness(directory: string, name: string, value: unknown): Harness {
  return {
    toTrajectory: () => undefined,
    async run() {
      writeFileSync(join(directory, name), "written by the step");
      return { value };
    },
  };
}

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
  assert.match(state.steps.a?.error ?? "", /promises to change nothing, but it changed sneaky\.txt/);
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
  assert.deepEqual(state.steps.a?.changed, ["new.txt"]);
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

  assert.deepEqual(state.steps.a?.changed, ["step.md"]);
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

test("every example flow is valid", async () => {
  // Reads the directory, so a new example is covered without touching this test.
  const root = join(import.meta.dirname, "..", "examples");
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
      assert.deepEqual(validate(expanded), [], `examples/${name}/${file} is not valid`);
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

  assert.ok(problems.some((p) => p.includes("both fans out and cycles")));
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

test("validate refuses a flow that runs fewer than one step at a time", () => {
  const problems = validate(
    flow("zero", {
      parallel: 0,
      steps: [agent({ id: "a", prompt: "a.md", tools: ["read"], returns: Summary })],
    }),
  );

  assert.ok(problems.some((p) => p.includes("fewer than one step")));
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

test("validate refuses a cycle on a gate step, which never sent the run back", () => {
  const problems = validate(
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
        "    returns: { type: object }",
        "    cycle: { to: one, when: { ok: false }, limit: 2, policy: escalate }",
      ].join("\n"),
    ),
  );

  assert.ok(problems.some((p) => p.includes('step "ask" holds "cycle", which a gate step cannot act on')));
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
  assert.match(state.steps.a?.error ?? "", /promises to change only docs, but it changed src\.txt/);
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
  assert.deepEqual(state.steps.a?.changed, ["docs/new.md"]);
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
  assert.match(state.question ?? "", /failed 2 times over: .*503/);

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
