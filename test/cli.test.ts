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

test("a memory command that is wrong says so, and writes nothing", () => {
  const root = project();

  assert.equal(orchy(root, "memory", "list").status, 2);
  assert.match(orchy(root, "memory", "list").stderr, /wants a scope/);
  assert.match(orchy(root, "memory", "add", "k").stderr, /wants the text to record/);
  assert.match(orchy(root, "memory", "sing", "k").stderr, /has no "sing"/);
  assert.equal(existsSync(join(root, ".orchy", "memory")), false);
});
