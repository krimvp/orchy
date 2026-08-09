#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { run } from "./run.ts";

const [command, file] = process.argv.slice(2);

if (command !== "run" || !file) {
  console.error("use: orchy run <flow file>");
  process.exit(2);
}

const module = await import(pathToFileURL(resolve(file)).href);
const state = await run(module.default);

console.log(JSON.stringify(state, null, 2));
process.exit(state.status === "done" ? 0 : 1);
