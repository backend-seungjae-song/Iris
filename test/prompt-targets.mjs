import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PROMPT_TARGET_TTL_MS,
  activatePromptTargets,
  issuePromptTarget,
  resetPromptTargetsForTest,
  createPromptTargetStore,
} from "../server/prompt-targets.js";
import { handleEmulatorTargets } from "../server/emulator-targets.js";
import { runSessionCmd } from "../server/browser-commands.js";

function actions() {
  const calls = [];
  return {
    calls,
    api: {
      replaceGroups: (records) => calls.push(["groups", records.map((r) => r.target)]),
      replaceTabs: (records) => calls.push(["tabs", records.map((r) => r.target)]),
      addElements: (records) => calls.push(["elements", records.map((r) => r.target)]),
      replaceDevices: (records) => calls.push(["devices", records.map((r) => r.target)]),
    },
  };
}

test.beforeEach(() => resetPromptTargetsForTest());

test("재시작 후 대기 지목은 유지되고 소비·폐기 결과와 다른 pane 검증도 유지된다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pending-targets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pending.json"), a = actions();
  let store = createPromptTargetStore({ file });
  const sent = store.issuePromptTarget({ pane: "owner", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  const unsent = store.issuePromptTarget({ pane: "owner", kind: "tab", ref: "@work-tab-b12345", target: { tabId: "tab-b" } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store = createPromptTargetStore({ file });
  assert.match(store.activatePromptTargets({ pane: "other", markers: [sent.delimiter], actions: a.api }).rejected[0].reason, /다른 세션/);
  const restored = createPromptTargetStore({ file }).activatePromptTargets({ pane: "owner", markers: [sent.delimiter], actions: a.api });
  assert.equal(restored.activated.length, 1);
  store = createPromptTargetStore({ file });
  assert.equal(store.activatePromptTargets({ pane: "owner", markers: [sent.delimiter, unsent.delimiter], actions: a.api }).rejected.length, 2);
});

test("소비 결과를 저장하지 못하면 지목 권한을 적용하지 않는다", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pending-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "pending.json"), store = createPromptTargetStore({ file }), a = actions();
  const pending = store.issuePromptTarget({ pane: "owner", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(() => store.activatePromptTargets({ pane: "owner", markers: [pending.delimiter], actions: a.api }));
  assert.deepEqual(a.calls, []);
});

test("세션 시작의 등록 요청은 작성 중인 지목을 삭제하거나 소비하지 않는다", () => {
  const a = actions();
  const pending = issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  assert.equal(runSessionCmd("prompt-targets", { registerOnly: true, markers: [] }, "w1:p1").ok, true);
  const result = activatePromptTargets({ pane: "w1:p1", markers: [pending.delimiter], actions: a.api });
  assert.equal(result.activated.length, 1);
  assert.deepEqual(result.rejected, []);
});

test("대기 없는 구분자는 거절하고 활성 상태를 바꾸지 않는다", () => {
  const a = actions();
  const result = activatePromptTargets({ pane: "w1:p1", markers: ["@work-tab-a12345~unknown12"], actions: a.api });
  assert.equal(result.activated.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /대기 지정|사용/);
  assert.deepEqual(a.calls, []);
});

test("nonce는 같은 pane에서 한 번만 쓰며 대상 문자열 변조도 거절한다", () => {
  const a = actions();
  const pending = issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  const wrongPane = activatePromptTargets({ pane: "w1:p2", markers: [pending.delimiter], actions: a.api });
  assert.match(wrongPane.rejected[0].reason, /다른 세션/);
  assert.deepEqual(a.calls, []);

  const accepted = activatePromptTargets({ pane: "w1:p1", markers: [pending.delimiter], actions: a.api });
  assert.equal(accepted.activated.length, 1);
  assert.deepEqual(a.calls, [["tabs", [{ tabId: "tab-a" }]]]);

  a.calls.length = 0;
  const replay = activatePromptTargets({ pane: "w1:p1", markers: [pending.delimiter], actions: a.api });
  assert.equal(replay.activated.length, 0);
  assert.match(replay.rejected[0].reason, /대기 지정|사용/);
  assert.deepEqual(a.calls, []);

  const next = issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  const changed = next.delimiter.replace("work-tab-a12345", "work-tab-b12345");
  const mismatch = activatePromptTargets({ pane: "w1:p1", markers: [changed], actions: a.api });
  assert.match(mismatch.rejected[0].reason, /일치하지 않/);
  assert.deepEqual(a.calls, []);
});

test("메시지를 보내면 그 메시지에 없던 같은 pane의 대기 지정은 폐기되고 다른 pane 것은 남는다", () => {
  const a = actions();
  const sent = issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } });
  const erased = issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-b12345", target: { tabId: "tab-b" } });
  const other = issuePromptTarget({ pane: "w1:p2", kind: "tab", ref: "@work-tab-c12345", target: { tabId: "tab-c" } });
  assert.equal(activatePromptTargets({ pane: "w1:p1", markers: [sent.delimiter], actions: a.api }).activated.length, 1);
  a.calls.length = 0;
  const late = activatePromptTargets({ pane: "w1:p1", markers: [erased.delimiter], actions: a.api });
  assert.equal(late.activated.length, 0);
  assert.match(late.rejected[0].reason, /대기 지정|사용/);
  assert.deepEqual(a.calls, []);
  assert.equal(activatePromptTargets({ pane: "w1:p2", markers: [other.delimiter], actions: a.api }).activated.length, 1);

  const unsent = issuePromptTarget({ pane: "w1:p1", kind: "device", ref: "@device:emulator-5554", target: { udid: "emulator-5554" } });
  a.calls.length = 0;
  assert.deepEqual(activatePromptTargets({ pane: "w1:p1", markers: [], actions: a.api }), { activated: [], rejected: [] });
  assert.equal(activatePromptTargets({ pane: "w1:p1", markers: [unsent.delimiter], actions: a.api }).activated.length, 0);
  assert.deepEqual(a.calls, []);
});

test("24시간이 지난 nonce는 만료로 거절한다", () => {
  const a = actions();
  const createdAt = 1_000;
  const pending = issuePromptTarget({ pane: "w1:p1", kind: "device", ref: "@device:emulator-5554",
    target: { udid: "emulator-5554" }, createdAt });
  const result = activatePromptTargets({ pane: "w1:p1", markers: [pending.delimiter], actions: a.api,
    now: createdAt + PROMPT_TARGET_TTL_MS + 1 });
  assert.equal(result.activated.length, 0);
  assert.match(result.rejected[0].reason, /만료/);
  assert.deepEqual(a.calls, []);
});

test("종류별 활성화는 입력 순서를 지키고 대상 중복을 제거한다", () => {
  const a = actions();
  const pending = [
    issuePromptTarget({ pane: "w1:p1", kind: "tab", ref: "@work-tab-a12345", target: { tabId: "tab-a" } }),
    issuePromptTarget({ pane: "w1:p1", kind: "element", ref: "@work-tab-b12345", target: { tabId: "tab-b" } }),
    issuePromptTarget({ pane: "w1:p1", kind: "group", ref: "@work-group-c12345", target: { space: "work", group: "g1" } }),
    issuePromptTarget({ pane: "w1:p1", kind: "device", ref: "@device:emulator-5554", target: { udid: "emulator-5554" } }),
    issuePromptTarget({ pane: "w1:p1", kind: "device", ref: "@device:emulator-5554", target: { udid: "emulator-5554" } }),
    issuePromptTarget({ pane: "w1:p1", kind: "device", ref: "@device:ios-2", target: { udid: "ios-2" } }),
  ];
  const markers = pending.map((item) => item.delimiter);
  const result = activatePromptTargets({ pane: "w1:p1", markers: [...markers, markers[0]], actions: a.api });
  assert.equal(result.rejected.length, 0);
  assert.equal(result.activated.length, 5);
  assert.deepEqual(a.calls, [
    ["groups", [{ space: "work", group: "g1" }]],
    ["tabs", [{ tabId: "tab-a" }]],
    ["elements", [{ tabId: "tab-b" }]],
    ["devices", [{ udid: "emulator-5554" }, { udid: "ios-2" }]],
  ]);
});

test("기기 등록 상한을 넘긴 유효 nonce는 64개 뒤까지 소비하고 초과 대상을 거절한다", () => {
  const a = actions();
  a.api.maxDevices = 4;
  const pending = Array.from({ length: 65 }, (_, index) => `d${index + 1}`).map((udid) => issuePromptTarget({ pane: "w1:p1", kind: "device",
    ref: `@device:${udid}`, target: { udid } }));
  const result = activatePromptTargets({ pane: "w1:p1", markers: pending.map((item) => item.delimiter), actions: a.api });
  assert.deepEqual(result.activated.map((item) => item.target.udid), ["d1", "d2", "d3", "d4"]);
  assert.equal(result.rejected.length, 61);
  assert.equal(result.rejected.every((item) => /상한\(4대\)/.test(item.reason)), true);
  assert.deepEqual(a.calls, [["devices", [{ udid: "d1" }, { udid: "d2" }, { udid: "d3" }, { udid: "d4" }]]]);
  const replay = activatePromptTargets({ pane: "w1:p1", markers: [pending[64].delimiter], actions: a.api });
  assert.match(replay.rejected[0].reason, /이미 사용됨/);
});

test("에뮬레이터 대기 지정은 인증된 로컬 UI만 만들고 훅 경로는 nonce만 소비한다", () => {
  const sent = [];
  const ws = { _local: true, _ui: false, send: (raw) => sent.push(JSON.parse(raw)) };
  assert.equal(handleEmulatorTargets(ws, { type: "emulator.target-pending", request: "r1",
    pane: "w1:p1", udid: "emulator-5554", name: "Pixel" }), true);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].delimiter, undefined);
  const before = actions();
  const fabricated = activatePromptTargets({ pane: "w1:p1",
    markers: ["@device:emulator-5554~fabricated_nonce"], actions: before.api });
  assert.equal(fabricated.activated.length, 0);
  assert.deepEqual(before.calls, []);

  ws._ui = true;
  sent.length = 0;
  handleEmulatorTargets(ws, { type: "emulator.target-pending", request: "r2",
    pane: "w1:p1", udid: "emulator-5554", persistentId: "Pixel_API_35", name: "Pixel", platform: "android" });
  assert.equal(sent[0].ok, true);
  assert.match(sent[0].delimiter, /^@device:emulator-5554~[a-f0-9]{32}$/);
  const a = actions();
  const result = activatePromptTargets({ pane: "w1:p1", markers: [sent[0].delimiter], actions: a.api });
  assert.equal(result.activated.length, 1);
  assert.deepEqual(a.calls, [["devices", [{ udid: "avd:Pixel_API_35" }]]]);
});
