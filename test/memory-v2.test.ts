import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { flowKey, keyReference, lines, migrateLegacy, rootKey, scopeKey } from "../src/memory.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const entry = (text: string) => JSON.stringify({ id: text, at: "2026-01-01T00:00:00.000Z", run: "r", step: "s", text });

function root(): string {
  return mkdtempSync(join(tmpdir(), "orchy-memory-v2-"));
}

function command(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return commandWith(cwd, {}, ...args);
}

function commandWith(
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

test("typed exact scopes do not share one memory file", () => {
  const cwd = root();
  const store = lines(cwd);
  const slash = scopeKey("ticket/A/B");
  const dash = scopeKey("ticket/A-B");
  const unicode = scopeKey("東京");
  const otherUnicode = scopeKey("Москва");
  const lone = scopeKey("bad\ud800name");

  const cases: Array<[string, string]> = [[slash, "slash"], [dash, "dash"], [unicode, "tokyo"], [otherUnicode, "moscow"], [lone, "lone"]];
  for (const [key, text] of cases) {
    store.remember(key, { run: "r", step: "s", text });
  }

  assert.notEqual(slash, dash);
  assert.notEqual(unicode, otherUnicode);
  assert.equal(scopeKey("bad\ud800name"), lone);
  assert.deepEqual(store.recall(slash).map((one) => one.text), ["slash"]);
  assert.deepEqual(store.recall(dash).map((one) => one.text), ["dash"]);
  assert.equal(new Set(store.keys()).size, 5);
  assert.notEqual(flowKey("x"), scopeKey("flow-x"));
  assert.notEqual(rootKey(), scopeKey("root"));
});

test("legacy migration copies to one exact key and preserves its source", () => {
  const cwd = root();
  const directory = join(cwd, ".orchy", "memory");
  mkdirSync(directory, { recursive: true });
  const source = join(directory, "ticket-a-b.jsonl");
  const old = `${entry("kept")}\n{ broken by hand\n`;
  writeFileSync(source, old);
  const target = keyReference(scopeKey("ticket/A/B"));

  assert.deepEqual(lines(cwd).keys(), ["legacy=ticket-a-b"]);
  assert.equal(migrateLegacy(cwd, "legacy=ticket-a-b", target), 1);
  assert.equal(readFileSync(source, "utf8"), old);
  assert.deepEqual(lines(cwd).recall(scopeKey("ticket/A/B")).map((one) => one.text), ["kept"]);
  assert.deepEqual(lines(cwd).keys().sort(), ["legacy=ticket-a-b", target].sort());
  assert.throws(() => migrateLegacy(cwd, "legacy=ticket-a-b", target), /already exists/);
});

test("legacy migration refuses traversal, links, and old run keys", () => {
  const cwd = root();
  const directory = join(cwd, ".orchy", "memory");
  const outside = join(root(), "outside.jsonl");
  mkdirSync(directory, { recursive: true });
  writeFileSync(outside, `${entry("outside")}\n`);
  symlinkSync(outside, join(directory, "linked.jsonl"));
  const target = keyReference(scopeKey("safe"));

  assert.throws(() => migrateLegacy(cwd, "legacy=../outside", target), /not a canonical legacy name/);
  assert.throws(
    () => migrateLegacy(cwd, "legacy=missing", target),
    /legacy memory source "legacy=missing" does not exist.*orchy memory keys.*exact "legacy=" reference/s,
  );
  assert.throws(() => migrateLegacy(cwd, "legacy=linked", target), /outside the root|symbolic link/);
  assert.throws(
    () => lines(cwd).recall("ticket-a-b"),
    /uses the legacy memory key.*orchy memory keys.*orchy memory migrate legacy=ticket-a-b.*key scope '<exact scope>'.*legacy source stays/s,
  );
  assert.equal(existsSync(join(directory, "safe.jsonl")), false);
});

test("a command from an old run refuses its flat environment key", async () => {
  const cwd = root();
  const result = await commandWith(cwd, { ORCHY_MEMORY_KEY: "ticket-a-b" }, "memory", "add", "ticket-a-b", "no");

  assert.equal(result.code, 2);
  assert.match(result.stderr, /orchy memory migrate legacy=ticket-a-b.*legacy source stays/s);
  assert.deepEqual(lines(cwd).keys(), []);
});

test("a stale memory claim fails closed and names safe recovery", () => {
  const cwd = root();
  const directory = join(cwd, ".orchy", "memory");
  const claim = join(directory, ".claim");
  mkdirSync(directory, { recursive: true });
  writeFileSync(claim, JSON.stringify({ pid: 999_999_999, identity: "dead", token: "old" }));

  assert.throws(
    () => lines(cwd).remember(scopeKey("held"), { run: "r", step: "s", text: "no" }),
    (error: unknown) => error instanceof Error && error.message.includes(claim) &&
      error.message.includes("no live owner") && error.message.includes("only when no Orchy process writes memory"),
  );
  rmSync(claim);
  writeFileSync(claim, "not an owner");
  assert.throws(
    () => lines(cwd).remember(scopeKey("held"), { run: "r", step: "s", text: "no" }),
    (error: unknown) => error instanceof Error && error.message.includes(claim) &&
      error.message.includes("unreadable ownership") && error.message.includes("only when no Orchy process writes memory"),
  );
  rmSync(claim);
  const outside = join(root(), "outside-claim.json");
  writeFileSync(outside, JSON.stringify({ pid: process.pid, identity: "outside", token: "outside" }));
  symlinkSync(outside, claim);
  assert.throws(
    () => lines(cwd).remember(scopeKey("held"), { run: "r", step: "s", text: "no" }),
    (error: unknown) => error instanceof Error && error.message.includes(claim) &&
      error.message.includes("symbolic link") && error.message.includes("only when no Orchy process writes memory"),
  );
});

test("keys reports invalid v2 metadata", () => {
  const cwd = root();
  const directory = join(cwd, ".orchy", "memory");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `scope--${"a".repeat(64)}.jsonl`), `${entry("not metadata")}\n`);
  assert.throws(() => lines(cwd).keys(), /invalid v2 metadata/);
});

test("append and forget serialize across memory processes", async () => {
  const cwd = root();
  const reference = keyReference(scopeKey("shared"));
  const initial = await Promise.all(
    Array.from({ length: 5 }, (_, index) => command(cwd, "memory", "add", reference, `old-${index}`)),
  );
  assert.equal(initial.every((one) => one.code === 0), true, initial.map((one) => one.stderr).join("\n"));
  const first = lines(cwd).recall(scopeKey("shared"))[0]?.id as string;

  const changes = await Promise.all([
    command(cwd, "memory", "forget", reference, first),
    ...Array.from({ length: 8 }, (_, index) => command(cwd, "memory", "add", reference, `new-${index}`)),
  ]);
  assert.equal(changes.every((one) => one.code === 0), true, changes.map((one) => one.stderr).join("\n"));
  assert.equal(lines(cwd).recall(scopeKey("shared")).length, 12);
});

test("two migration processes publish one target without overwriting", async () => {
  const cwd = root();
  const directory = join(cwd, ".orchy", "memory");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "old.jsonl"), `${entry("only once")}\n`);
  const target = keyReference(scopeKey("new"));

  const results = await Promise.all([
    command(cwd, "memory", "migrate", "legacy=old", target),
    command(cwd, "memory", "migrate", "legacy=old", target),
  ]);
  assert.deepEqual(results.map((one) => one.code).sort(), [0, 1]);
  assert.match(results.find((one) => one.code === 0)?.stdout ?? "", /legacy=old.*key=v2:.*remains unchanged/s);
  assert.deepEqual(lines(cwd).recall(scopeKey("new")).map((one) => one.text), ["only once"]);
  assert.equal(existsSync(join(directory, "old.jsonl")), true);
});
