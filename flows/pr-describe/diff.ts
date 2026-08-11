import { execFileSync } from "node:child_process";

// ORCHY_BASE names the base branch, and defaults to main.
export default () => {
  const base = process.env.ORCHY_BASE ?? "main";
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const files = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const subjects = git("log", "--format=%s", `${base}..HEAD`).split("\n").filter(Boolean);
  return { base, files, subjects };
};
