import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import { agent, call, flow, gate, validate } from "../src/flow.ts";
import type { AgentRequest, AgentResult, Harness } from "../src/pi.ts";
import { resume, run } from "../src/run.ts";

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
