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
