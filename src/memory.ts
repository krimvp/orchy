import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Memory } from "./flow.ts";
import { ownerLives, processIdentity } from "./claim.ts";
import { withinRoot } from "./root.ts";

export interface Entry {
  id: string;
  at: string;
  run: string;
  step: string;
  text: string;
  tags?: string[];
}

export interface Storage {
  recall(key: string, most?: number): Entry[];
  remember(key: string, entry: Omit<Entry, "id" | "at">): Entry;
  forget(key: string, id?: string): number;
  /** Canonical `key=` references and unmigrated `legacy=` references. */
  keys(): string[];
}

export const MOST = 20;
export const LONGEST = 2000;

const MARK = "memory-v2";
type LogicalKey = ["root"] | ["flow", string] | ["scope", string];
interface Header {
  _orchy: typeof MARK;
  key: string;
}
interface Owner {
  pid: number;
  identity: string;
  token: string;
}

/** The one storage: one metadata line, then one JSON line for each entry. */
export function lines(root: string): Storage {
  const directory = memoryDirectory(root);

  return {
    recall(key, most) {
      const all = readV2(memoryFile(root, directory, key), key);
      if (most === undefined) return all;
      return most <= 0 ? [] : all.slice(-most);
    },

    remember(key, entry) {
      if (entry.text.length > LONGEST) {
        throw new Error(
          `an entry holds ${entry.text.length} characters, and the most is ${LONGEST}. Record a sentence or two, and leave the rest in the repository.`,
        );
      }
      const file = memoryFile(root, directory, key);
      const whole: Entry = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), ...entry };
      prepareDirectory(root, directory);
      withMemoryClaim(directory, () => {
        if (!exists(file)) publish(file, `${header(key)}\n`);
        else readV2(file, key);
        appendFileSync(file, `${JSON.stringify(whole)}\n`);
      });
      return whole;
    },

    forget(key, id) {
      const file = memoryFile(root, directory, key);
      prepareDirectory(root, directory);
      return withMemoryClaim(directory, () => {
        const all = readV2(file, key);
        if (id === undefined) {
          rmSync(file, { force: true });
          return all.length;
        }
        const kept = all.filter((entry) => entry.id !== id);
        if (kept.length === all.length) return 0;
        replace(file, `${header(key)}\n${kept.map((entry) => `${JSON.stringify(entry)}\n`).join("")}`);
        return all.length - kept.length;
      });
    },

    keys() {
      try {
        withinRoot(root, directory);
        return readdirSync(directory)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => referenceOf(directory, name))
          .sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

/** Copies one named legacy file to one exact key. The source stays for review. */
export function migrateLegacy(root: string, source: string, target: string): number {
  const directory = memoryDirectory(root);
  const legacy = legacyName(source);
  const key = referencedKey(target);
  prepareDirectory(root, directory);
  return withMemoryClaim(directory, () => {
    const sourceFile = withinRoot(root, join(directory, `${legacy}.jsonl`));
    let stat;
    try {
      stat = lstatSync(sourceFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `the legacy memory source "${source}" does not exist at "${sourceFile}". ` +
            `Run "orchy memory keys" and pass one exact "legacy=" reference.`,
        );
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`the legacy memory "${source}" is not a regular file`);
    const text = readFileSync(sourceFile, "utf8");
    const entries = readEntries(text);
    const targetFile = fileOf(directory, key);
    publish(targetFile, `${header(key)}\n${text}`);
    return entries.length;
  });
}

/** Makes a canonical key reference that a person can give to the memory command. */
export function keyReference(key: string): string {
  parseKey(key);
  return `key=${key}`;
}

/** Reads a canonical key reference. */
export function referencedKey(reference: string): string {
  if (!reference.startsWith("key=")) {
    throw new Error(`the memory target "${reference}" is not a canonical key. Use "orchy memory key" to make one.`);
  }
  const key = reference.slice("key=".length);
  parseKey(key);
  return key;
}

export function scopeKey(scope: string): string {
  return encoded(["scope", scope]);
}

export function flowKey(name: string): string {
  return encoded(["flow", name]);
}

export function rootKey(): string {
  return encoded(["root"]);
}

function encoded(value: LogicalKey): string {
  return `v2:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function parseKey(key: string): LogicalKey {
  if (!key.startsWith("v2:")) legacyRun(key);
  try {
    const value = JSON.parse(Buffer.from(key.slice(3), "base64url").toString("utf8")) as unknown;
    const valid =
      Array.isArray(value) &&
      ((value.length === 1 && value[0] === "root") ||
        (value.length === 2 && (value[0] === "flow" || value[0] === "scope") && typeof value[1] === "string"));
    if (!valid || encoded(value as LogicalKey) !== key) throw new Error();
    return value as LogicalKey;
  } catch {
    throw new Error(`the memory key "${key}" is not valid. Make it with "orchy memory key".`);
  }
}

function legacyRun(key: string): never {
  throw new Error(
    `the run uses the legacy memory key "${key}". Run "orchy memory keys", choose its exact scope, then copy it with ` +
      `"orchy memory migrate legacy=${key} \"$(orchy memory key scope '<exact scope>')\"". ` +
      `Use "key flow <exact flow name>" or "key root" instead when that is its identity. The legacy source stays. Start a new run after migration.`,
  );
}

function fileOf(directory: string, key: string): string {
  const logical = parseKey(key);
  const shown = logical[0] === "root" ? "root" : `${logical[0]}-${logical[1]}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return join(directory, `${asKey(shown).slice(0, 40)}--${digest}.jsonl`);
}

function memoryFile(root: string, directory: string, key: string): string {
  const file = withinRoot(root, fileOf(directory, key));
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new Error(`the memory file "${file}" is a symbolic link. Replace it with a regular file.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

function memoryDirectory(root: string): string {
  return join(resolve(root), ".orchy", "memory");
}

function prepareDirectory(root: string, directory: string): void {
  withinRoot(root, directory);
  mkdirSync(directory, { recursive: true });
  withinRoot(root, directory);
}

function header(key: string): string {
  return JSON.stringify({ _orchy: MARK, key } satisfies Header);
}

function readV2(file: string, key: string): Entry[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const [first = "", ...rest] = text.split("\n");
  let value: unknown;
  try {
    value = JSON.parse(first);
  } catch {
    invalidMetadata(file);
  }
  if (!isHeader(value) || value.key !== key) invalidMetadata(file);
  return readEntries(rest.join("\n"));
}

function isHeader(value: unknown): value is Header {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const held = value as Record<string, unknown>;
  return Object.keys(held).sort().join(",") === "_orchy,key" && held._orchy === MARK && typeof held.key === "string";
}

function invalidMetadata(file: string): never {
  throw new Error(`the memory file "${file}" has invalid v2 metadata. Correct its first line before Orchy uses it.`);
}

function readEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // A line a hand broke costs that line, and not the store.
    }
  }
  return entries;
}

function referenceOf(directory: string, name: string): string {
  const file = join(directory, name);
  if (lstatSync(file).isSymbolicLink()) throw new Error(`the memory file "${file}" is a symbolic link. Replace it with a regular file.`);
  if (!/--[a-f0-9]{64}\.jsonl$/.test(name)) return `legacy=${name.slice(0, -".jsonl".length)}`;
  const first = readFileSync(file, "utf8").split("\n")[0] ?? "";
  let value: unknown;
  try {
    value = JSON.parse(first);
  } catch {
    invalidMetadata(file);
  }
  if (!isHeader(value)) invalidMetadata(file);
  const expected = fileOf(directory, value.key);
  if (expected !== file) invalidMetadata(file);
  return keyReference(value.key);
}

function legacyName(reference: string): string {
  if (!reference.startsWith("legacy=")) throw new Error(`the memory source "${reference}" is not a legacy reference`);
  const name = reference.slice("legacy=".length);
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name) || asKey(name) !== name) {
    throw new Error(`the legacy memory source "${reference}" is not a canonical legacy name`);
  }
  return name;
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function publish(file: string, text: string): void {
  const prepared = `${file}.writing.${randomUUID()}`;
  writeFileSync(prepared, text, { flag: "wx" });
  try {
    linkSync(prepared, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`the memory target "${file}" already exists. Choose an empty exact key.`);
    }
    throw error;
  } finally {
    rmSync(prepared, { force: true });
  }
}

function replace(file: string, text: string): void {
  const prepared = `${file}.writing.${randomUUID()}`;
  writeFileSync(prepared, text, { flag: "wx" });
  try {
    renameSync(prepared, file);
  } finally {
    rmSync(prepared, { force: true });
  }
}

/** Serializes changes across Orchy processes with one fully written hard-link claim. */
function withMemoryClaim<T>(directory: string, work: () => T): T {
  const owner: Owner = { pid: process.pid, identity: processIdentity(), token: randomUUID() };
  const prepared = join(directory, `.claim.${owner.token}.json`);
  const claim = join(directory, ".claim");
  writeFileSync(prepared, JSON.stringify(owner), { flag: "wx" });
  let held = false;
  let result: T | undefined;
  let primary: unknown;
  let failed = false;
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        linkSync(prepared, claim);
        held = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let current: Owner;
        try {
          current = readClaim(directory, claim);
        } catch (ownerError) {
          if ((ownerError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw ownerError;
        }
        if (!ownerLives(current)) {
          throw new Error(
            `the memory claim "${claim}" has no live owner. Remove it only when no Orchy process writes memory.`,
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (!held) {
      throw new Error(`the memory claim "${claim}" still belongs to a live writer after five seconds. Try again when it ends.`);
    }
    result = work();
  } catch (error) {
    failed = true;
    primary = error;
  }

  let cleanup: unknown;
  if (held) {
    try {
      const current = readClaim(directory, claim);
      if (current.token !== owner.token) {
        throw new Error(`the memory claim "${claim}" changed owners before release. Orchy left it in place.`);
      }
      rmSync(claim);
    } catch (error) {
      cleanup = error;
    }
  }
  try {
    rmSync(prepared, { force: true });
  } catch (error) {
    cleanup ??= error;
  }

  if (failed) {
    if (cleanup) {
      const first = primary instanceof Error ? primary.message : String(primary);
      const after = cleanup instanceof Error ? cleanup.message : String(cleanup);
      throw new Error(
        `${first}\nWhile handling that failure, Orchy could not release claim "${claim}": ${after}`,
        { cause: primary },
      );
    }
    throw primary;
  }
  if (cleanup) {
    const reason = cleanup instanceof Error ? cleanup.message : String(cleanup);
    throw new Error(
      `the memory operation may have changed its target, but Orchy could not release claim "${claim}": ${reason}`,
    );
  }
  return result as T;
}

function readClaim(directory: string, claim: string): Owner {
  try {
    withinRoot(directory, claim);
  } catch {
    throw new Error(
      `the memory claim "${claim}" is a symbolic link or leaves the memory directory. ` +
        `Replace it only when no Orchy process writes memory.`,
    );
  }
  const stat = lstatSync(claim);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `the memory claim "${claim}" is not a regular file. Replace it only when no Orchy process writes memory.`,
    );
  }

  let descriptor: number;
  try {
    descriptor = openSync(claim, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(
        `the memory claim "${claim}" is a symbolic link. Replace it only when no Orchy process writes memory.`,
      );
    }
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(
        `the memory claim "${claim}" is not a regular file. Replace it only when no Orchy process writes memory.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(descriptor, "utf8"));
    } catch {
      throw new Error(
        `the memory claim "${claim}" has unreadable ownership. Remove it only when no Orchy process writes memory.`,
      );
    }
    if (!isOwner(value)) {
      throw new Error(
        `the memory claim "${claim}" has unreadable ownership. Remove it only when no Orchy process writes memory.`,
      );
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function isOwner(value: unknown): value is Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const held = value as Record<string, unknown>;
  return Object.keys(held).sort().join(",") === "identity,pid,token" && Number.isInteger(held.pid) &&
    (held.pid as number) > 0 && typeof held.identity === "string" && held.identity.length > 0 &&
    typeof held.token === "string" && held.token.length > 0;
}

const NAMED = /\{\{([^{}]*)\}\}/g;
const RESERVED = ["none", "flow", "root"];

export function keyOf(memory: Memory | undefined, flowName: string, takes?: Record<string, unknown>): string | undefined {
  if (!memory) return undefined;
  const scope = memory.scope;
  if (scope === "none") return undefined;
  if (scope === "flow") return flowKey(flowName);
  if (scope === "root") return rootKey();
  return scopeKey(
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

/** The legacy file-name conversion. New memory uses a typed key and a digest. */
export function asKey(text: string): string {
  const flat = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return (flat || "memory").slice(0, 100);
}

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
  if (typeof held.scope === "string" && !RESERVED.includes(held.scope)) {
    const named = Object.keys(((takes ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
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
