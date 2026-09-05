import assert from "node:assert/strict";
import test from "node:test";
import { missingRequired, requiredDefaults, writeField } from "../ui/src/contract.ts";

test("a contract form accepts empty values after a person answers", () => {
  const value = { title: "", findings: [], approved: false };

  assert.deepEqual(missingRequired(value, ["title", "findings", "approved"]), []);
  assert.deepEqual(missingRequired({}, ["title", "findings", "approved"]), ["title", "findings", "approved"]);
});

test("a contract form omits an optional field until a person answers", () => {
  const started = requiredDefaults(
    {
      title: { type: "string" },
      findings: { type: "array", items: { type: "string" } },
      note: { type: "string" },
      approved: { type: "boolean" },
    },
    ["title", "findings", "approved"],
  );
  const absent = writeField({ kept: true }, "note", undefined);
  const empty = writeField(absent, "note", "");
  const no = writeField(absent, "approved", false);

  assert.deepEqual(started, { title: "", findings: [] });
  assert.deepEqual(absent, { kept: true });
  assert.deepEqual(empty, { kept: true, note: "" });
  assert.deepEqual(no, { kept: true, approved: false });
});
