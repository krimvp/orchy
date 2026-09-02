import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Memory } from "./flow.ts";

/**
 * One thing a run recorded. Every entry names the run and the step that wrote
 * it, because a store that cannot say where a claim came from is a store nobody
 * can correct: a wrong entry is found by its provenance and dropped by its id.
 * See ADR 0029.
 */
export interface Entry {
  id: string;
  at: string;
  run: string;
  step: string;
  text: string;
  tags?: string[];
}

/**
 * Recover before the run, store while it runs. The contract, and the only one.
 * The shape behind it is not the point: a line per entry today, a table
 * tomorrow, and the runner reads neither. See ADR 0029.
 */
export interface Storage {
  /** The last `most` entries of one key, or every one of them when `most` is absent. */
  recall(key: string, most?: number): Entry[];
  remember(key: string, entry: Omit<Entry, "id" | "at">): Entry;
  /** Drops one entry, or the whole key when no id is named. Answers how many went. */
  forget(key: string, id?: string): number;
  keys(): string[];
}

/** How many entries seed a prompt when the flow names no number. */
export const MOST = 20;

/**
 * How long one entry may be, in characters. `most` bounds how many entries
 * seed a prompt, and this bounds each one, so the seed itself is bounded: a
 * store of paragraphs is a document, and a document belongs in the repository.
 */
export const LONGEST = 2000;

/**
 * The one storage: a line of JSON per entry, under `.orchy/memory`. A memory is
 * prose, and prose holds commas, quotes and newlines, so a line of JSON escapes
 * what a row of CSV would have to quote. The file stays greppable, appendable,
 * and readable in a diff, which is what a person needs to correct one.
 */
export function lines(root: string): Storage {
  const directory = join(resolve(root), ".orchy", "memory");
  const fileOf = (key: string) => join(directory, `${key}.jsonl`);

  return {
    recall(key, most) {
      const all = read(fileOf(key));
      if (most === undefined) return all;
      // `slice(-0)` is the whole list, so a flow that asks for no seed gets one.
      return most <= 0 ? [] : all.slice(-most);
    },

    remember(key, entry) {
      if (entry.text.length > LONGEST) {
        throw new Error(
          `an entry holds ${entry.text.length} characters, and the most is ${LONGEST}. Record a sentence or two, and leave the rest in the repository.`,
        );
      }
      const whole: Entry = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...entry };
      mkdirSync(directory, { recursive: true });
      appendFileSync(fileOf(key), `${JSON.stringify(whole)}\n`);
      return whole;
    },

    forget(key, id) {
      const file = fileOf(key);
      const all = read(file);
      if (id === undefined) {
        rmSync(file, { force: true });
        return all.length;
      }
      const kept = all.filter((entry) => entry.id !== id);
      if (kept.length === all.length) return 0;
      writeFileSync(file, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      return all.length - kept.length;
    },

    keys() {
      try {
        return readdirSync(directory)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => name.slice(0, -".jsonl".length))
          .sort();
      } catch {
        // No store yet is no key, and not a fault. Nothing has remembered.
        return [];
      }
    },
  };
}

function read(file: string): Entry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // A line a hand broke costs that line, and not the run. A store that
      // refuses to open because one entry is malformed is a store that stops
      // every flow pointing at it.
    }
  }
  return entries;
}

/**
 * The same grammar a prompt reads. `buildPrompt` in `src/run.ts` fills a prompt
 * with it, and a scope reads the values of the run the same way, so a flow says
 * `scope: "ticket/{{ issue }}"` and each ticket gets its own store.
 */
const NAMED = /\{\{([^{}]*)\}\}/g;

/** The three words that are not keys. Everything else a flow writes is one. */
const RESERVED = ["none", "flow", "root"];

/**
 * The key one run reads and writes, or nothing when the flow remembers none.
 * The run resolves this once and keeps it, so a resume reads the same store
 * even when the file it came from has moved on. See ADR 0029.
 */
export function keyOf(memory: Memory | undefined, flowName: string, takes?: Record<string, unknown>): string | undefined {
  if (!memory) return undefined;
  const scope = memory.scope;
  if (scope === "none") return undefined;
  if (scope === "flow") return asKey(`flow-${flowName}`);
  if (scope === "root") return "root";
  return asKey(
    scope.replace(NAMED, (_all, inside: string) => {
      const name = inside.trim();
      if (!takes || !Object.hasOwn(takes, name)) {
        throw new Error(
          `the flow "${flowName}" remembers under "${scope}", and nothing supplies "${name}". Add it to "takes" on the flow, and give it to the run.`,
        );
      }
      const value = takes[name];
      return typeof value === "string" ? value : JSON.stringify(value);
    }),
  );
}

/**
 * A key becomes a file name, and never a path. So `../` is not a case to guard
 * against: it is not spellable here. A name a person still reads is worth more
 * than a name that round-trips, because the store is read by hand as well.
 *
 * The command line reads a key through this too, so a person types the scope
 * their flow declares — `ticket/PROJ-14` — and reaches the store the run wrote.
 */
export function asKey(text: string): string {
  const flat = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // A name of dots alone is `.` or `..`, which name a directory and not a store.
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return (flat || "memory").slice(0, 100);
}

/** What a flow gets wrong about its memory, for `validate()`. See ADR 0029. */
export function memoryProblems(memory: unknown, takes: unknown): string[] {
  const problems: string[] = [];
  if (typeof memory !== "object" || memory === null || Array.isArray(memory)) {
    return [`the flow remembers ${JSON.stringify(memory)}. Write a memory as { scope, most }.`];
  }
  const held = memory as Partial<Memory> & Record<string, unknown>;
  for (const key of Object.keys(held).filter((one) => !["scope", "most"].includes(one))) {
    problems.push(`the memory of the flow holds "${key}", which is not a field of a memory. A memory holds "scope" and "most".`);
  }
  if (typeof held.scope !== "string" || held.scope.trim() === "") {
    problems.push(
      `the memory of the flow has no scope. Write "none", "flow", "root", or a key of your own, such as "ticket/{{ issue }}".`,
    );
  }
  if (held.most !== undefined && (!Number.isInteger(held.most) || (held.most as number) < 0)) {
    problems.push(`the memory of the flow seeds ${JSON.stringify(held.most)} entries. Write a whole number of none or more.`);
  }

  // A scope that reads a name the flow does not take resolves to nothing at the
  // door of the run, and a run that gets that far has already loaded a flow.
  // Say it here, where a `check` says it and nothing has started.
  if (typeof held.scope === "string" && !RESERVED.includes(held.scope)) {
    const named = Object.keys(
      ((takes ?? {}) as { properties?: Record<string, unknown> }).properties ?? {},
    );
    for (const [, inside] of held.scope.matchAll(NAMED)) {
      const name = String(inside).trim();
      if (!named.includes(name)) {
        problems.push(
          `the flow remembers under "${held.scope}", which reads "{{ ${name} }}", and the flow does not take "${name}". Add it to "takes", or write a scope that does not read it.`,
        );
      }
    }
  }
  return problems;
}
