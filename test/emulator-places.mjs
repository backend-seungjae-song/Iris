import test from "node:test";
import assert from "node:assert/strict";
import { mergePlaces, parsePlaces, placeRecord, restoreDevice, restoreTarget } from "../web/js/emulator/places.js";

const entry = (over = {}) => ({ tab: { id: "emu-a", label: "iPhone 17", deviceId: "UDID-1" }, detached: false, inColumn: false, inStage: false, ...over });
const info = { key: "K1", index: 2, active: true, running: true, name: "iPhone 17" };

// 저장 → 읽기 → 복원 자리가 있던 자리와 같아야 함(사용자 결정: 있던 자리 그대로)
test("있던 자리를 저장하고 같은 자리로 복원한다", () => {
  const cases = [
    [entry(), "strip"],
    [entry({ inColumn: true, home: "column" }), "column"],
    [entry({ detached: true, detachHome: "column", bounds: { x: 10, y: 20, width: 460, height: 920 } }), "detached"],
  ];
  for (const [e, want] of cases) {
    const [rec] = parsePlaces(JSON.stringify([placeRecord(e, info)]));
    assert.equal(rec.place, want);
    assert.equal(restoreTarget(rec, true).place, want);
    assert.equal(rec.deviceId, "UDID-1");
    assert.equal(rec.key, "K1");
  }
  const [det] = parsePlaces(JSON.stringify([placeRecord(cases[2][0], info)]));
  assert.deepEqual(det.bounds, { x: 10, y: 20, width: 460, height: 920 });
  assert.equal(det.detachHome, "column");
});

// 종료 때 켜져 있던 기기만 다시 켬, 꺼 둔 기기는 창만(사용자 결정)
test("켜짐 여부를 그대로 저장한다", () => {
  const on = parsePlaces(JSON.stringify([placeRecord(entry(), { ...info, running: true })]))[0];
  const off = parsePlaces(JSON.stringify([placeRecord(entry(), { ...info, running: false })]))[0];
  assert.equal(on.running, true);
  assert.equal(off.running, false);
});

test("무대에 있던 화면은 그 화면을 나갈 때 가는 자리로, 좁은 창의 세로 열은 탭 + narrowed", () => {
  assert.deepEqual(restoreTarget({ place: "stage", home: "column", stageFrom: "tab" }, true), { place: "column", narrowed: false });
  assert.deepEqual(restoreTarget({ place: "stage", home: null, stageFrom: "tab" }, true), { place: "strip", narrowed: false });
  assert.deepEqual(restoreTarget({ place: "column" }, false), { place: "strip", narrowed: true });
  assert.deepEqual(restoreTarget({ place: "strip", narrowed: true }, true), { place: "strip", narrowed: true });
});

test("Android 시리얼 기록은 AVD 이름으로 켠다", () => {
  assert.equal(restoreDevice({ deviceId: "emulator-5554", name: "Pixel_8_API_35" }), "Pixel_8_API_35");
  assert.equal(restoreDevice({ deviceId: "UDID-1", name: "iPhone 17" }), "UDID-1");
  assert.equal(restoreDevice({ deviceId: "emulator-5554", name: "Changed label", deviceKey: "Pixel_API_35" }), "Pixel_API_35");
});

test("모양이 틀린 기록은 버린다", () => {
  assert.deepEqual(parsePlaces("not json"), []);
  assert.deepEqual(parsePlaces('{"a":1}'), []);
  const bad = [{ key: "K", id: "bad id!", place: "strip" }, { key: "K", id: "ok", place: "nowhere" }, { key: "K", id: "ok2", place: "strip", deviceId: "a b" }];
  assert.deepEqual(parsePlaces(JSON.stringify(bad)), []);
  const [rec] = parsePlaces(JSON.stringify([{ key: "K", id: "ok", place: "detached", bounds: { x: "1" }, home: "x" }]));
  assert.equal(rec.bounds, null);
  assert.equal(rec.home, null);
});

// 스페이스가 아직 안 보여 복원 못 한 기록은 지우지 않음. 같은 스페이스에 지금 화면이 있으면 지금 것이 이김
test("복원 못 한 기록은 저장 때 합쳐 보존한다", () => {
  const cur = [{ key: "K1", id: "emu-a" }];
  const pending = [{ key: "K2", id: "emu-b" }, { key: "K1", id: "emu-c" }, { key: "K3", id: "emu-a" }];
  assert.deepEqual(mergePlaces(cur, pending).map((r) => r.id), ["emu-a", "emu-b", "emu-c"]);
  assert.deepEqual(mergePlaces([], pending).map((r) => r.id), ["emu-b", "emu-c", "emu-a"]);
});

test("세션 소유 에뮬레이터는 소유 세션을 저장하고, 같은 스페이스의 공용 기록과 따로 보존한다", () => {
  const owned = placeRecord(entry({ tab: { id: "emu-b", label: "iPhone 16", deviceId: "UDID-2", owner: "w1:p2" } }), info);
  const [back] = parsePlaces(JSON.stringify([owned]));
  assert.equal(back.owner, "w1:p2");
  assert.equal(parsePlaces(JSON.stringify([{ ...owned, owner: "bad owner" }])).length, 0);
  const shared = placeRecord(entry(), info);
  assert.equal(shared.owner, null);
  const merged = mergePlaces([shared], [back]);
  assert.deepEqual(merged.map((r) => r.id), ["emu-a", "emu-b"]);
  assert.deepEqual(mergePlaces([shared], [{ ...shared, id: "emu-old" }]).map((r) => r.id), ["emu-a"]);
});

// 같은 스페이스에서 아직 복원되지 않은 다른 기기와 세로 열을 보존한다.
test("여러 공용 기기와 각 열의 선택을 저장한다", () => {
  const first = placeRecord(entry({ inColumn: true, group: "emulator" }), info);
  const second = placeRecord(entry({ tab: { id: "emu-b", deviceId: "UDID-2" }, inColumn: true, group: "emu-b" }), info);
  const merged = mergePlaces([first], [second]);
  assert.equal(merged.length, 2);
  const restored = parsePlaces(JSON.stringify(merged));
  assert.deepEqual(restored.map(r => [r.deviceId, r.group, r.active]), [["UDID-1", "emulator", true], ["UDID-2", "emu-b", true]]);
});
