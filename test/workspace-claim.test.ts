import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { Type } from "@sinclair/typebox";
import { daemon } from "../src/daemon.ts";
import { call, flow, gate } from "../src/flow.ts";
import { run } from "../src/run.ts";
import { open } from "../src/store.ts";
import { claimWorkspace, pinWorkspaceClaim, releaseWorkspaceClaim } from "../src/workspace.ts";
import { formatFlow } from "../src/yaml.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const EMPTY = Type.Object({});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "orchy-workspace-claim-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "orchy@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Orchy Test"], { cwd: root });
  writeFileSync(join(root, "kept.txt"), "kept\n");
  execFileSync("git", ["add", "kept.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "start"], { cwd: root });
  return root;
}

async function until(done: () => boolean): Promise<void> {
  for (let count = 0; count < 250; count += 1) {
    if (done()) return;
    await new Promise((wait) => setTimeout(wait, 20));
  }
  throw new Error("the expected process state did not arrive");
}

function result(child: ChildProcess): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (part: Buffer) => (stdout += part.toString()));
  child.stderr?.on("data", (part: Buffer) => (stderr += part.toString()));
  return new Promise((done) => child.on("close", (code) => done({ code: code ?? -1, stdout, stderr })));
}

function writeFlow(root: string, command: string): void {
  writeFileSync(
    join(root, "flow.yaml"),
    formatFlow(
      flow("held", {
        workspace: { kind: "git", path: "." },
        steps: [call({ id: "work", command, returns: EMPTY })],
      }),
    ),
  );
}

test("two processes cannot run in aliases of one Git workspace", async () => {
  const root = repository();
  const sub = join(root, "sub");
  mkdirSync(sub);
  const started = join(root, "started");
  const release = join(root, "release");
  const calls = join(root, "calls");
  const component = join(root, "hold.mjs");
  writeFileSync(
    component,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, "called\\n");
writeFileSync(${JSON.stringify(started)}, "yes");
while (!existsSync(${JSON.stringify(release)})) await new Promise((wait) => setTimeout(wait, 20));
console.log("{}");
`,
  );
  writeFlow(root, `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`);
  const first = spawn(process.execPath, [CLI, "run", join(root, "flow.yaml")], { cwd: root, stdio: "pipe" });
  const firstResult = result(first);

  try {
    await until(() => existsSync(started));
    const second = await result(
      spawn(process.execPath, [CLI, "run", join(root, "flow.yaml")], {
        cwd: sub,
        stdio: "pipe",
        env: { ...process.env, HOME: join(root, "other-home"), TMPDIR: join(root, "other-tmp") },
      }),
    );
    assert.equal(second.code, 1);
    assert.match(second.stderr, /is in use by run .* in process/);
    assert.equal(existsSync(join(sub, ".orchy")), false);
    assert.equal(readFileSync(calls, "utf8"), "called\n");

    writeFileSync(release, "yes");
    assert.equal((await firstResult).code, 0);
    const third = await result(
      spawn(process.execPath, [CLI, "run", join(root, "flow.yaml")], { cwd: sub, stdio: "pipe" }),
    );
    assert.equal(third.code, 0);
    assert.equal(readFileSync(calls, "utf8"), "called\ncalled\n");
  } finally {
    if (first.exitCode === null) first.kill("SIGKILL");
  }
});

test("separate Git worktrees can hold claims at the same time", () => {
  const root = repository();
  const other = mkdtempSync(join(tmpdir(), "orchy-worktree-"));
  rmSync(other, { recursive: true });
  execFileSync("git", ["worktree", "add", "-qb", `claim-${Date.now()}`, other], { cwd: root });
  const workspace = { kind: "git" as const, path: "." };
  const first = claimWorkspace(workspace, root, "first");
  const second = claimWorkspace(workspace, other, "second");
  try {
    assert.notEqual(first?.workspace, second?.workspace);
  } finally {
    assert.equal(releaseWorkspaceClaim(first), "released");
    assert.equal(releaseWorkspaceClaim(second), "released");
  }
});

test("a stale workspace claim gives exact recovery evidence", () => {
  const root = repository();
  const workspace = { kind: "git" as const, path: "." };
  const held = claimWorkspace(workspace, root, "old-run");
  assert.ok(held);
  writeFileSync(held.file, JSON.stringify({ ...held.owner, pid: 2_147_483_646, identity: "dead" }));

  assert.throws(
    () => claimWorkspace(workspace, root, "new-run"),
    (error: Error) => {
      assert.match(error.message, new RegExp(realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(error.message, /old-run/);
      assert.match(error.message, /2147483646/);
      assert.match(error.message, /orchy runs/);
      assert.match(error.message, /state\.json/);
      assert.match(error.message, /owner process and its descendants have ended/);
      return true;
    },
  );
  assert.equal(releaseWorkspaceClaim(held), "released");
});

test("a stale releaser does not remove a replacement claim", () => {
  const root = repository();
  const workspace = { kind: "git" as const, path: "." };
  const old = claimWorkspace(workspace, root, "old-run");
  assert.equal(releaseWorkspaceClaim(old), "released");
  const replacement = claimWorkspace(workspace, root, "new-run");

  try {
    assert.equal(releaseWorkspaceClaim(old), "replaced");
    assert.throws(() => claimWorkspace(workspace, root, "third-run"), /is in use by run new-run/);
  } finally {
    assert.equal(releaseWorkspaceClaim(replacement), "released");
  }
});

test("an unreadable workspace claim fails closed with its exact path", () => {
  const root = repository();
  const workspace = { kind: "git" as const, path: "." };
  const held = claimWorkspace(workspace, root, "old-run");
  assert.ok(held);
  writeFileSync(held.file, "{");

  try {
    assert.throws(
      () => claimWorkspace(workspace, root, "new-run"),
      (error: Error) => {
        assert.match(error.message, /claim owner record is not readable/i);
        assert.match(error.message, new RegExp(held.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  } finally {
    rmSync(held.directory, { recursive: true });
  }
});

test("a failed initial Git snapshot leaves no run directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-broken-workspace-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".git", "index"), "not an index");
  const runId = "snapshot-refused";

  await assert.rejects(
    () =>
      run(
        flow("broken", {
          workspace: { kind: "git", path: "." },
          steps: [call({ id: "never", command: `${JSON.stringify(process.execPath)} -e 'console.log("{}")'`, returns: EMPTY })],
        }),
        { cwd: root, runId },
      ),
    /git could not record the workspace/,
  );
  assert.equal(existsSync(join(root, ".orchy", "runs", runId)), false);
});

test("an already cancelled run takes no workspace claim", async () => {
  const root = repository();
  const control = new AbortController();
  control.abort(new Error("cancelled before start"));

  await assert.rejects(
    () =>
      run(
        flow("cancelled", {
          workspace: { kind: "git", path: "." },
          steps: [call({ id: "never", module: "missing.mjs", returns: EMPTY })],
        }),
        { cwd: root, runId: "cancelled", signal: control.signal },
      ),
    /cancelled before start/,
  );
  const next = claimWorkspace({ kind: "git", path: "." }, root, "next");
  assert.equal(releaseWorkspaceClaim(next), "released");
  assert.equal(existsSync(join(root, ".orchy", "runs", "cancelled")), false);
});

test("terminal events publish only after the workspace is available", async () => {
  const cases = [
    {
      status: "done",
      steps: [call({ id: "work", module: "done.mjs", returns: EMPTY })],
      module: `export default () => ({});\n`,
    },
    {
      status: "failed",
      steps: [call({ id: "work", module: "failed.mjs", returns: EMPTY })],
      module: `export default () => { throw new Error("expected failure"); };\n`,
    },
    {
      status: "waiting",
      steps: [gate({ id: "approve", question: "Approve?", returns: Type.Boolean() })],
    },
  ] as const;

  for (const [index, one] of cases.entries()) {
    const root = repository();
    const runId = `terminal-${index}`;
    if ("module" in one) writeFileSync(join(root, `${one.status}.mjs`), one.module);
    let available = false;
    const state = await run(flow(one.status, { workspace: { kind: "git", path: "." }, steps: [...one.steps] }), {
      cwd: root,
      runId,
      onEvent(event) {
        if (event.type !== "waiting" && event.type !== "run_end") return;
        const claim = claimWorkspace({ kind: "git", path: "." }, root, `observer-${index}`);
        available = true;
        assert.equal(releaseWorkspaceClaim(claim), "released");
      },
    });
    assert.equal(state.status, one.status);
    assert.equal(available, true);
  }
});

test("stop settles a claimed resume before dispatch can spawn it", async () => {
  const root = repository();
  const wrote = join(root, "resumed");
  writeFileSync(
    join(root, "flow.yaml"),
    formatFlow(
      flow("answer", {
        workspace: { kind: "git", path: "." },
        steps: [
          gate({ id: "approve", question: "Approve?", returns: Type.Boolean() }),
          call({
            id: "after",
            needs: ["approve"],
            command: `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(wrote)}, "yes"); console.log("{}")'`,
            returns: EMPTY,
          }),
        ],
      }),
    ),
  );
  const engine = daemon(root, false);
  try {
    engine.start({ path: "flow.yaml", flowName: "answer", harness: "pi" });
    await until(() => engine.store.runs().some((one) => one.status === "waiting"));
    const row = engine.store.runs().find((one) => one.status === "waiting");
    const runId = row?.runId as string;
    const state = engine.state(runId);
    const ticket = engine.resume(runId, true, "pi", undefined, "approve", state?.revision);
    const stopped = engine.stop(runId);

    assert.equal(await stopped, true);
    assert.equal(engine.state(runId)?.status, "stopped");
    assert.equal(existsSync(wrote), false);
    assert.equal(engine.pending().some((one) => one.ticket === ticket.ticket), false);
  } finally {
    await engine.close();
  }
});

test("a dispatcher can relinquish a claimed resume as uncertain", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-uncertain-resume-"));
  const directory = join(root, ".orchy");
  mkdirSync(directory);
  const store = open(join(directory, "index.db"));
  const row = store.acceptWork({
    kind: "resume",
    flowName: "answer",
    path: "flow.yaml",
    harness: "pi",
    runId: "waiting-run",
    acceptedRevision: 2,
    payload: { kind: "resume", hasValue: true, value: true, gate: "approve" },
  });
  assert.ok(row);
  assert.ok(store.claimWork(row.ticket));
  assert.equal(store.orphanOwnedWork(row.ticket), true);
  store.close();

  const recovered = daemon(root, false);
  try {
    const receipt = recovered.pending().find((one) => one.ticket === row.ticket);
    assert.equal(receipt?.status, "uncertain");
    assert.match(receipt?.error ?? "", /uncertain resume delivery/);
  } finally {
    await recovered.close(false);
  }
});

test("a second daemon keeps a live owner's fast terminal receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchy-live-delivery-"));
  const directory = join(root, ".orchy");
  const runId = "fast-run";
  mkdirSync(join(directory, "runs", runId), { recursive: true });
  writeFileSync(
    join(directory, "runs", runId, "state.json"),
    JSON.stringify({
      runId,
      flow: { name: "fast", steps: [] },
      startedAt: new Date().toISOString(),
      status: "done",
      steps: {},
      cycles: {},
    }),
  );
  const owner = open(join(directory, "index.db"));
  const row = owner.acceptWork({
    kind: "start",
    flowName: "fast",
    path: "flow.yaml",
    harness: "pi",
    plannedRunId: runId,
    payload: { kind: "start" },
  });
  assert.ok(row);
  assert.ok(owner.claimWork(row.ticket));

  const observer = daemon(root, false);
  try {
    const receipt = observer.pending().find((one) => one.ticket === row.ticket);
    assert.equal(receipt?.runId, runId);
    assert.equal(owner.work(row.ticket)?.status, "delivered");
  } finally {
    await observer.close(false);
    owner.finishWork(row.ticket);
    owner.close();
  }
});

test(
  "daemon close releases a start claim acquired before run_start",
  { skip: process.platform === "win32" },
  async () => {
    const root = repository();
    const hook = join(root, ".git", "hooks", "slow-status");
    writeFileSync(hook, "#!/bin/sh\nsleep 2\n");
    chmodSync(hook, 0o700);
    execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: root });
    writeFlow(root, `${JSON.stringify(process.execPath)} -e 'console.log("{}")'`);
    const known = claimWorkspace({ kind: "git", path: "." }, root, "probe");
    assert.ok(known);
    assert.equal(releaseWorkspaceClaim(known), "released");
    const engine = daemon(root, false);

    engine.start({ path: "flow.yaml", flowName: "held", harness: "pi" });
    await until(() => existsSync(known.file));
    await engine.close();
    const next = claimWorkspace({ kind: "git", path: "." }, root, "next");
    assert.equal(releaseWorkspaceClaim(next), "released");
  },
);

test("a cancelled run keeps its workspace until its command tree ends", async () => {
  const root = repository();
  const ready = join(root, "descendant-ready");
  const late = join(root, "late");
  const component = join(root, "tree.mjs");
  writeFileSync(
    component,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(late)}, "yes"), 3000); setTimeout(() => {}, 6000);`)}], { stdio: "ignore" });
child.unref();
setTimeout(() => {}, 6000);
`,
  );
  const workspace = { kind: "git" as const, path: "." };
  const slow = flow("slow", {
    workspace,
    steps: [call({ id: "work", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`, returns: EMPTY })],
  });
  const quick = flow("quick", {
    workspace,
    steps: [call({ id: "work", command: `${JSON.stringify(process.execPath)} -e 'console.log("{}")'`, returns: EMPTY })],
  });
  const control = new AbortController();
  const running = run(slow, { cwd: root, signal: control.signal });
  await until(() => existsSync(ready));
  control.abort(new Error("the run was stopped"));

  await assert.rejects(() => run(quick, { cwd: root }), /is in use by run/);
  assert.equal((await running).status, "stopped");
  assert.equal((await run(quick, { cwd: root })).status, "done");
  await new Promise((wait) => setTimeout(wait, 3100));
  assert.equal(existsSync(late), false);
});

test("daemon stop releases a claim after it confirms a forced group stop", async () => {
  const root = repository();
  const ready = join(root, "forced-ready");
  const component = join(root, "forced.mjs");
  writeFileSync(
    component,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "yes"); setTimeout(() => {}, 6000);`)}], { stdio: "ignore" });
child.unref();
setTimeout(() => {}, 6000);
`,
  );
  writeFlow(root, `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`);
  const engine = daemon(root, false);
  try {
    const ticket = engine.start({ path: "flow.yaml", flowName: "held", harness: "pi" });
    await until(() => existsSync(ready));
    await until(() => engine.pending().some((one) => one.ticket === ticket.ticket && one.runId !== undefined));
    const runId = engine.pending().find((one) => one.ticket === ticket.ticket)?.runId as string;
    assert.equal(await engine.stop(runId), true);
    const next = claimWorkspace({ kind: "git", path: "." }, root, "next");
    assert.equal(releaseWorkspaceClaim(next), "released");
  } finally {
    await engine.close();
  }
});

test("daemon close releases a claim only after its process group ends", async () => {
  const root = repository();
  const ready = join(root, "close-ready");
  const component = join(root, "close.mjs");
  writeFileSync(
    component,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "yes");
setTimeout(() => {}, 6000);
`,
  );
  writeFlow(root, `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`);
  const engine = daemon(root, false);
  engine.start({ path: "flow.yaml", flowName: "held", harness: "pi" });
  await until(() => existsSync(ready));
  await engine.close();
  const next = claimWorkspace({ kind: "git", path: "." }, root, "next");
  assert.equal(releaseWorkspaceClaim(next), "released");
});

test("failed group verification keeps the pinned workspace claim", async () => {
  const root = repository();
  const ready = join(root, "failed-ready");
  const component = join(root, "failed.mjs");
  writeFileSync(
    component,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "yes");
setTimeout(() => {}, 6000);
`,
  );
  writeFlow(root, `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`);
  const engine = daemon(root, false);
  let pid = 0;
  try {
    const ticket = engine.start({ path: "flow.yaml", flowName: "held", harness: "pi" });
    await until(() => existsSync(ready));
    await until(() => engine.pending().some((one) => one.ticket === ticket.ticket && one.runId !== undefined));
    const runId = engine.pending().find((one) => one.ticket === ticket.ticket)?.runId as string;
    pid = engine.state(runId)?.pid as number;
    const realKill = process.kill.bind(process);
    mock.method(
      process,
      "kill",
      ((target: number, signal?: number | NodeJS.Signals) => {
        if (target !== -pid) return realKill(target, signal as NodeJS.Signals);
        if (signal === "SIGTERM" || signal === "SIGKILL") return realKill(pid, signal);
        return true;
      }) as typeof process.kill,
    );

    await assert.rejects(engine.stop(runId), /did not end after SIGKILL/);
    mock.restoreAll();
    assert.throws(() => claimWorkspace({ kind: "git", path: "." }, root, "next"), /has a stale claim/);
    assert.equal(await engine.stop(runId), true);
    const next = claimWorkspace({ kind: "git", path: "." }, root, "next");
    assert.equal(releaseWorkspaceClaim(next), "released");
  } finally {
    mock.restoreAll();
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    await engine.close();
  }
});

test("daemon stop reports an unreadable pinned claim after it records stopped", async () => {
  const root = repository();
  const ready = join(root, "unreadable-ready");
  const component = join(root, "unreadable.mjs");
  writeFileSync(
    component,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(ready)}, "yes");
setTimeout(() => {}, 6000);
`,
  );
  writeFlow(root, `${JSON.stringify(process.execPath)} ${JSON.stringify(component)}`);
  const engine = daemon(root, false);
  let held: ReturnType<typeof pinWorkspaceClaim>;
  try {
    const ticket = engine.start({ path: "flow.yaml", flowName: "held", harness: "pi" });
    await until(() => existsSync(ready));
    await until(() => engine.pending().some((one) => one.ticket === ticket.ticket && one.runId !== undefined));
    const runId = engine.pending().find((one) => one.ticket === ticket.ticket)?.runId as string;
    const pid = engine.state(runId)?.pid as number;
    held = pinWorkspaceClaim({ kind: "git", path: "." }, root, runId, pid);
    assert.ok(held);
    writeFileSync(held.file, "{");

    await assert.rejects(engine.stop(runId), (error: Error) => {
      assert.match(error.message, /claim owner record is not readable/i);
      assert.match(error.message, new RegExp((held as NonNullable<typeof held>).file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
    assert.equal(engine.state(runId)?.status, "stopped");
  } finally {
    if (held) rmSync(held.directory, { recursive: true });
    await engine.close();
  }
});
