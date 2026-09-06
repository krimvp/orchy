import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** A path is inside a root when it reaches it with no step back. */
function inside(root: string, path: string, equal = false): boolean {
  const step = relative(root, path);
  return (equal && step === "") || (step !== "" && !step.startsWith("..") && !isAbsolute(step));
}

/** Whether a path exists as a directory entry, including a broken link. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a file against the root and checks where links take it. For a new
 * file, the nearest existing parent must resolve inside the root.
 */
export function withinRoot(root: string, given: string): string {
  const writtenRoot = resolve(root);
  const path = resolve(writtenRoot, given);
  if (!inside(writtenRoot, path)) outside(path, writtenRoot);

  const canonicalRoot = realpathSync(writtenRoot);
  let existing = path;
  while (!exists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) outside(path, writtenRoot);
    existing = parent;
  }

  let canonical: string;
  try {
    canonical = realpathSync(existing);
  } catch {
    throw new Error(`the file at "${path}" cannot be resolved under the root "${writtenRoot}"`);
  }
  if (!inside(canonicalRoot, canonical, existing !== path)) outside(path, writtenRoot);
  return path;
}

function outside(path: string, root: string): never {
  throw new Error(`the file at "${path}" is outside the root "${root}". Use a path under the root.`);
}
