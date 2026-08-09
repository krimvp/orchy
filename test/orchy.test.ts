import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { agent, call, flow, gate, validate } from "../src/flow.ts";
import type { AgentRequest, AgentResult, Harness } from "../src/pi.ts";
import { resume, run } from "../src/run.ts";
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

  assert.deepEqual(events, [
    "step_start", "step_end", "step_start", "step_end", "cycle",
    "step_start", "step_end", "step_start", "step_end", "run_end",
  ]);
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
    async run() {
      writeFileSync(join(directory, name), "written by the step");
      return { value };
    },
  };
}

test("validate refuses a promise that no workspace can check", () => {
  const problems = validate(
    flow("unchecked", {
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: false })],
    }),
  );

  assert.ok(problems.some((p) => p.includes("no workspace to check it")));
});

test("a step that promises to change nothing fails when it changes a file", async () => {
  const cwd = gitWorkspace();

  const state = await run(
    flow("promise", {
      workspace: { kind: "git", path: "." },
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: false })],
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
      steps: [agent({ id: "a", prompt: "step.md", tools: ["read"], returns: Summary, changes: false })],
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

test("the example flows are valid", async () => {
  for (const name of ["code-review", "grilling"]) {
    const module = await import(`../examples/${name}/flow.ts`);
    assert.deepEqual(validate(module.default), [], `examples/${name} is not valid`);
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

test("the YAML loader refuses a flow that is not valid", () => {
  assert.throws(
    () => parseFlow("name: broken\nsteps:\n  - id: a\n    kind: agent\n    needs: [ghost]\n"),
    /is not valid/,
  );
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
      harness: { async run() { return { value: { summary: "done" }, trajectory: session }; } },
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
