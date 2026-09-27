import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_NOTICES,
  createRequestVersion,
  keepGlobalNotice,
  retainNotice,
  validationView,
} from "../ui/src/notice-state.ts";

test("the event view keeps only the newest notices", () => {
  const notices = Array.from({ length: MAX_NOTICES + 3 }, (_, index) => ({ type: "step_end", at: String(index) }));
  assert.equal(retainNotice(notices).length, MAX_NOTICES);
  assert.equal(retainNotice(notices)[0]?.at, "3");
});

test("global notices do not retain output events", () => {
  assert.equal(keepGlobalNotice({ type: "output", at: "now" }), false);
  assert.equal(keepGlobalNotice({ type: "step_end", at: "now" }), false);
  assert.equal(keepGlobalNotice({ type: "run_end", at: "now" }), true);
});

test("only the latest validation request can update the editor", () => {
  const request = createRequestVersion();
  const older = request.next();
  const newer = request.next();
  assert.equal(request.isCurrent(older), false);
  assert.equal(request.isCurrent(newer), true);
});

test("the editor hides an old verdict and blocks save while validation is pending", () => {
  const oldFlow = {};
  const currentFlow = {};
  const view = validationView(currentFlow, oldFlow, ["old problem"], ["old warning"], undefined, undefined);
  assert.deepEqual(view.problems, []);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.checking, true);
  assert.equal(view.canSave, false);
});

test("the editor hides the previous verdict during a retry", () => {
  const currentFlow = {};
  const view = validationView(currentFlow, currentFlow, ["old problem"], ["old warning"], undefined, undefined, true);
  assert.deepEqual(view.problems, []);
  assert.deepEqual(view.warnings, []);
  assert.equal(view.checking, true);
  assert.equal(view.canSave, false);
});

test("the editor blocks save after validation fails", () => {
  const currentFlow = {};
  const view = validationView(currentFlow, undefined, [], [], currentFlow, "daemon unavailable");
  assert.equal(view.error, "daemon unavailable");
  assert.equal(view.checking, false);
  assert.equal(view.canSave, false);
});
