import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { harnessOf, type Flow } from "./flow.ts";
import { execOwned } from "./process.ts";
import { checkWorkspace } from "./workspace.ts";

/**
 * The brace names a flow reads that nothing supplies. A prompt that keeps one
 * fails after earlier steps can spend, so the check finds it before a run.
 */
export function unfilled(flow: Flow, flowPath?: string, texts?: Record<string, string>): string[] {
  const takes = ((flow.takes as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<
    string,
    unknown
  >;
  const problems: string[] = [];
  const check = (step: string, where: string, text: string, held?: Record<string, unknown>) => {
    for (const [, inside] of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const name = (inside as string).trim();
      if (Object.hasOwn(takes, name) || (held && Object.hasOwn(held, name))) continue;
      problems.push(
        `the step "${step}" reads "{{ ${name} }}" in its ${where}, and nothing supplies "${name}". Add it to "takes" on the flow${
          where === "prompt" ? ', or to "with" on the step' : ""
        }.`,
      );
    }
  };
  const base = flowPath ? dirname(resolve(flowPath)) : undefined;
  // A text given by the caller stands in for the file, so a prompt is checked
  // before anything is written. The keys normalize, so "./a.md" finds "a.md".
  const held = texts && Object.fromEntries(Object.entries(texts).map(([key, text]) => [normalize(key), text]));
  const readAt = (path?: string): string | undefined => {
    if (!path) return undefined;
    if (held && Object.hasOwn(held, normalize(path))) return held[normalize(path)];
    if (!base && !isAbsolute(path)) return undefined;
    try {
      return readFileSync(isAbsolute(path) ? path : resolve(base as string, path), "utf8");
    } catch {
      return undefined;
    }
  };
  type Named = { id: string; question?: string; prompt?: string; with?: Record<string, unknown>; fanout?: unknown };
  for (const step of (flow.steps ?? []) as unknown as Named[]) {
    if (typeof step.question === "string") check(step.id, "question", step.question, step.with);
    if (step.fanout && !Array.isArray(step.fanout)) continue;
    if (Array.isArray(step.fanout)) {
      for (const member of step.fanout as Array<{ name: string; prompt?: string; with?: Record<string, unknown> }>) {
        const text = readAt(member.prompt ?? step.prompt);
        // A member's `with` replaces the step's, as `expandFanout` writes it.
        if (text !== undefined) check(`${step.id}/${member.name}`, "prompt", text, member.with ?? step.with);
      }
      continue;
    }
    const text = readAt(step.prompt);
    if (text !== undefined) check(step.id, "prompt", text, step.with);
  }
  return problems;
}

/** The prompt, component, and inner flow files that a flow names but cannot read. */
export function missing(flow: Flow, flowPath: string): string[] {
  const base = dirname(resolve(flowPath));
  const gone: string[] = [];
  const check = (step: string, kind: string, path?: string) => {
    // A shipped component is a name Orchy answers for, not a file to find.
    if (!path || path.startsWith("orchy:")) return;
    const at = isAbsolute(path) ? path : resolve(base, path);
    const shown = isAbsolute(path) ? relative(base, path) || path : path;
    try {
      const found = statSync(at);
      accessSync(at, constants.R_OK);
      if (!found.isFile()) gone.push(`the step "${step}" names a ${kind} that is not a readable file: ${shown}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      gone.push(
        code === "ENOENT"
          ? `the step "${step}" names a ${kind} that is not there: ${shown}`
          : `the step "${step}" names a ${kind} that is not a readable file: ${shown}`,
      );
    }
  };
  // The union of step kinds narrows each field away; this check reads them loosely.
  type Named = { id: string; prompt?: string; module?: string; flow?: string; fanout?: unknown };
  for (const step of (flow.steps ?? []) as unknown as Named[]) {
    check(step.id, "prompt", step.prompt);
    check(step.id, "module", step.module);
    check(step.id, "flow file", step.flow);
    if (Array.isArray(step.fanout)) {
      for (const member of step.fanout as Array<{ name: string; prompt?: string; module?: string }>) {
        check(`${step.id}/${member.name}`, "prompt", member.prompt);
        check(`${step.id}/${member.name}`, "module", member.module);
      }
    }
  }
  return gone;
}

/** Local setup that only the command line checks, because it starts commands. */
export async function localSetup(
  flow: Flow,
  cwd: string,
  fallback: string,
): Promise<{ problems: string[]; notices: string[] }> {
  const problems: string[] = [];
  const notices: string[] = [];
  try {
    checkState(cwd);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  try {
    checkWorkspace(flow.workspace, cwd);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const harnesses = new Set(
    flow.steps.filter((step) => step.kind === "agent").map((step) => harnessOf(flow, step) ?? fallback),
  );
  for (const harness of harnesses) {
    if (harness === "pi") {
      notices.push('pi harness: bundled with Orchy');
      continue;
    }
    if (harness !== "claude" && harness !== "droid") continue;
    try {
      notices.push(`${harness} command: ${await versionOf(harness, cwd)}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { problems, notices };
}

/** Proves that the state path accepts a file, and leaves no probe behind. */
function checkState(cwd: string): void {
  const root = resolve(cwd);
  const state = join(root, ".orchy");
  let directory = root;
  try {
    const link = lstatSync(state);
    let found;
    try {
      found = statSync(state);
    } catch (error) {
      throw new Error(`the state path "${state}" cannot be read: ${reason(error)}`);
    }
    if (!found.isDirectory()) throw new Error(`the state path "${state}" is not a directory`);
    // A link to a directory is usable by the command line. The open below
    // checks the target instead of trusting the mode bits of the link.
    if (!link.isDirectory() && !link.isSymbolicLink()) {
      throw new Error(`the state path "${state}" is not a directory`);
    }
    directory = state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const probe = join(directory, `.orchy-check-${process.pid}-${randomUUID()}`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(probe, "wx");
  } catch (error) {
    throw new Error(`Orchy cannot write run state under "${state}": ${reason(error)}`);
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      try {
        unlinkSync(probe);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

/** Reads a command version without a model call, and ends the full probe tree. */
async function versionOf(command: "claude" | "droid", cwd: string): Promise<string> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(new Error("the version check took more than 2 seconds")), 2_000);
  try {
    const owned = execOwned(command, ["--version"], { cwd, env: process.env, maxBuffer: 4 * 1024 }, control.signal);
    owned.child.stdin.end();
    const answer = await owned.result;
    const version = firstLine(answer.stdout) ?? firstLine(answer.stderr);
    if (!version) throw new Error(`${command} answered --version with no version`);
    return version;
  } catch (error) {
    const held = error as { code?: unknown; message?: string; stderr?: string; stdout?: string };
    if (held.code === -2 || held.message?.includes("ENOENT")) {
      throw new Error(`the flow uses the "${command}" harness, but the ${command} command is not on PATH. Install it, then run orchy check again.`);
    }
    const detail = firstLine(held.stderr) ?? firstLine(held.stdout) ?? held.message ?? String(error);
    throw new Error(`the flow uses the "${command}" harness, but ${command} --version failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function firstLine(text?: string): string | undefined {
  return text?.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 300);
}

function reason(error: unknown): string {
  const held = error as NodeJS.ErrnoException;
  return held.code ? `${held.code}${held.message ? ` (${held.message})` : ""}` : error instanceof Error ? error.message : String(error);
}
