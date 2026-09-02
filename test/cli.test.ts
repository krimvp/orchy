import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatFlow } from "../src/yaml.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

const COUNT = `export default (inputs: Record<string, unknown>) => ({ count: Object.keys(inputs).length });\n`;

const NUMBER = { type: "object", required: ["count"], properties: { count: { type: "number" } } };

/** A flow that takes one value, so a test can supply it wrong. */
const TAKING = {
  name: "taking",
  takes: { type: "object", required: ["issue"], properties: { issue: { type: "number" } } },
  steps: [{ id: "work", kind: "call", module: "count.ts", returns: NUMBER }],
};

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "orchy-cli-"));
  writeFileSync(join(root, "count.ts"), COUNT);
  writeFileSync(join(root, "flow.yaml"), formatFlow(TAKING as never));
  return root;
}

function orchy(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

test("a flag orchy does not know is refused, and nothing runs", () => {
  const root = project();
  const done = orchy(root, "run", "flow.yaml", "--bogus");
  assert.equal(done.status, 2);
  assert.match(done.stderr, /--bogus/);
  assert.equal(existsSync(join(root, ".orchy")), false);
});

test("an argument beyond what the command takes is refused", () => {
  const root = project();
  const done = orchy(root, "run", "flow.yaml", "extra.yaml", "--with", '{"issue":1}');
  assert.equal(done.status, 2);
  assert.match(done.stderr, /does not take "extra.yaml"/);
});

test("values the flow refuses end with the code for a wrong command, and no run", () => {
  const root = project();
  const done = orchy(root, "run", "flow.yaml", "--with", '{"issue":"five"}');
  assert.equal(done.status, 2);
  assert.match(done.stderr, /must be number/);
  // Nothing ran: the refusal came before a run directory existed.
  assert.equal(existsSync(join(root, ".orchy", "runs")), false);
});

test("a resume of a run this directory does not hold ends with the code for a wrong command", () => {
  const root = project();
  const done = orchy(root, "resume", "deadbeef");
  assert.equal(done.status, 2);
  assert.match(done.stderr, /holds no run "deadbeef"/);
});

test("a person reads, writes, and corrects a store from the command line", () => {
  const root = project();

  assert.match(orchy(root, "memory", "keys").stdout, /no scope holds anything/);

  // A person writes the scope their flow declares, and reaches the store a run
  // wrote: the command line reads a key the way the runner resolves one.
  const added = orchy(root, "memory", "add", "ticket/PROJ-14", "the parser lives in src/yaml.ts");
  assert.equal(added.status, 0);
  const id = added.stdout.split(" ")[0] as string;
  assert.match(added.stdout, /recorded in "ticket-proj-14"/);

  assert.match(orchy(root, "memory", "keys").stdout, /ticket-proj-14/);
  const listed = orchy(root, "memory", "list", "ticket-proj-14");
  assert.match(listed.stdout, /the parser lives in src\/yaml\.ts/);
  // An entry a person wrote says so, because an entry that cannot say where it
  // came from is one nobody knows whether to trust.
  assert.match(listed.stdout, /a person/);

  const asJson = orchy(root, "memory", "list", "ticket/PROJ-14", "--events");
  assert.equal((JSON.parse(asJson.stdout.trim()) as { text: string }).text, "the parser lives in src/yaml.ts");

  // The correction a person makes: one entry by its id, and nothing else.
  assert.match(orchy(root, "memory", "forget", "ticket-proj-14", "nosuchid").stderr, /holds no entry/);
  assert.equal(orchy(root, "memory", "forget", "ticket-proj-14", id).status, 0);
  assert.match(orchy(root, "memory", "list", "ticket-proj-14").stdout, /holds nothing/);
});

test("a command step that records is recorded as the step, and a person as a person", () => {
  const root = project();
  const by = JSON.stringify({ runId: "r1", step: "say" });
  const stepped = spawnSync(process.execPath, [CLI, "memory", "add", "flow-x", "found it"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ORCHY_STARTED_BY: by },
  });
  assert.equal(stepped.status, 0, stepped.stderr);
  assert.equal(orchy(root, "memory", "add", "flow-x", "checked it").status, 0);

  const listed = orchy(root, "memory", "list", "flow-x", "--events").stdout.trim().split("\n").map((line) => JSON.parse(line) as { run: string; step: string });
  // Every entry names where it came from, whichever door it came through.
  assert.deepEqual(listed.map((one) => [one.run, one.step]), [["r1", "say"], ["-", "a person"]]);
});

test("a memory command that is wrong says so, and writes nothing", () => {
  const root = project();

  assert.equal(orchy(root, "memory", "list").status, 2);
  assert.match(orchy(root, "memory", "list").stderr, /wants a scope/);
  assert.match(orchy(root, "memory", "add", "k").stderr, /wants the text to record/);
  assert.match(orchy(root, "memory", "sing", "k").stderr, /has no "sing"/);
  assert.equal(existsSync(join(root, ".orchy", "memory")), false);
});

test("a flag on a command that does not take it is refused, and nothing runs", () => {
  const root = project();
  const done = orchy(root, "run", "flow.yaml", "--from", "work", "--with", '{"issue":1}');
  assert.equal(done.status, 2);
  assert.match(done.stderr, /orchy run does not take --from/);
  assert.equal(existsSync(join(root, ".orchy")), false);
});

test("a flag given twice, and a flag with no value, are refused", () => {
  const root = project();
  const twice = orchy(root, "run", "flow.yaml", "--with", '{"issue":1}', "--with", '{"issue":2}');
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /--with is given twice/);
  const bare = orchy(root, "run", "flow.yaml", "--with");
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--with wants a value/);
  assert.equal(existsSync(join(root, ".orchy")), false);
});

test("orchy check says what the flow takes", () => {
  const root = project();
  const done = orchy(root, "check", "flow.yaml");
  assert.equal(done.status, 0);
  assert.match(done.stdout, /is valid: 1 step\. It takes: issue \(number\)\. Supply them with --with/);
});

test("a directory, or a file that is not a flow file, is refused with the file to name", () => {
  const root = project();
  writeFileSync(join(root, "flow.json"), "{}");
  const directory = orchy(root, "check", ".");
  assert.equal(directory.status, 2);
  assert.match(directory.stderr, /is a directory\. Name the flow file in it, as ".*flow\.yaml"/);
  const json = orchy(root, "check", "flow.json");
  assert.equal(json.status, 2);
  assert.match(json.stderr, /is not a flow file\. A flow file is TypeScript or YAML/);
});

const GO = { type: "object", required: ["go"], properties: { go: { type: "boolean" } } };

test("orchy runs says why a run failed, and for whom a run waits", () => {
  const root = project();
  writeFileSync(join(root, "boom.ts"), 'export default () => { throw new Error("boom"); };\n');
  const failing = { name: "failing", steps: [{ id: "work", kind: "call", module: "boom.ts", returns: NUMBER }] };
  const gated = { name: "gated", steps: [{ id: "ask", kind: "gate", question: "Go on?", returns: GO }] };
  writeFileSync(join(root, "failing.yaml"), formatFlow(failing as never));
  writeFileSync(join(root, "gated.yaml"), formatFlow(gated as never));
  assert.equal(orchy(root, "run", "failing.yaml").status, 1);
  assert.equal(orchy(root, "run", "gated.yaml").status, 3);

  const listed = orchy(root, "runs");
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /^run\s+status\s+flow\s+started\n/);
  assert.match(listed.stdout, /failed\s+failing\s+\S+\s+step "work" failed: boom/);
  assert.match(listed.stdout, /waiting\s+gated\s+\S+\s+waits for "ask"/);

  const rows = orchy(root, "runs", "--events").stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(rows.some((row) => row.status === "failed" && row.error === 'step "work" failed: boom'));
});

test("a run that waits says the shape of the answer beside the command that gives it", () => {
  const root = project();
  const gated = { name: "gated", steps: [{ id: "ask", kind: "gate", question: "Go on?", returns: GO }] };
  writeFileSync(join(root, "gated.yaml"), formatFlow(gated as never));
  const done = orchy(root, "run", "gated.yaml");
  assert.equal(done.status, 3);
  assert.match(done.stderr, /answer with: orchy resume \S+ '<json value>'\nthe value matches: \{"type":"object","required":\["go"\]/);
});
