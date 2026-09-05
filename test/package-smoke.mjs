import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const consumer = mkdtempSync(join(tmpdir(), "orchy-package-"));
let archive;

function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result;
}

try {
  const packed = run("npm", ["pack", "--ignore-scripts", "--json"], root);
  const [manifest] = JSON.parse(packed.stdout);
  archive = join(root, manifest.filename);
  const names = new Set(manifest.files.map((file) => file.path));
  for (const file of ["dist/cli.js", "ui/dist/index.html", "starter/flow.yaml", "starter/hello.mjs", "starter/agent.yaml", "starter/prompts/summarize.md"]) {
    assert.equal(names.has(file), true, `${file} is absent from ${manifest.filename}`);
  }

  writeFileSync(join(consumer, "package.json"), '{"name":"orchy-consumer","private":true,"type":"module"}\n');
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive]);
  run("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", "typescript@5.9.3", "@types/node@26.2.0"]);
  const cli = join(consumer, "node_modules", ".bin", "orchy");
  run(cli, ["--version"]);
  run(cli, ["init"]);
  run(cli, ["check", "flow.yaml"]);
  const done = run(cli, ["run", "flow.yaml"]);
  assert.match(done.stdout, /Orchy ran a model-free flow/);

  writeFileSync(
    join(consumer, "import.mjs"),
    'import { validate } from "@krimvp/orchy";\nif (validate({ name: "plain", steps: [] }).length === 0) process.exit(1);\n',
  );
  run(process.execPath, ["import.mjs"]);
  writeFileSync(
    join(consumer, "import.ts"),
    'import { validate, type Flow, type Harness } from "@krimvp/orchy";\nconst flow: Flow = { name: "plain", steps: [] };\nconst problems: string[] = validate(flow);\nconst harness: Harness | undefined = undefined;\nvoid problems;\nvoid harness;\n',
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022","strict":true,"skipLibCheck":false,"noEmit":true},"include":["import.ts"]}\n',
  );
  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"]);
  assert.match(readFileSync(join(consumer, "flow.yaml"), "utf8"), /name: first-success/);
  console.log(`installed, typed, and ran ${manifest.filename} in a clean consumer`);
} finally {
  if (archive) rmSync(archive, { force: true });
  rmSync(consumer, { recursive: true, force: true });
}
