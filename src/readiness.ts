import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import type { Flow } from "./flow.ts";

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
