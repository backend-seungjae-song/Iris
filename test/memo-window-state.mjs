import assert from "node:assert/strict";
import test from "node:test";

import {
  closeMemoWindowRecord,
  memoOpenCounts,
  normalizeMemoWindowRecords,
  openMemoWindowRecord,
  patchMemoWindowRecord,
} from "../native/electron/memo-window-state.cjs";

test("사용자 X만 복원 목록에서 창을 빼고 앱 종료 close는 열린 창을 보존한다", () => {
  let records = [];
  records = openMemoWindowRecord(records, {
    instanceId: "win-a", kind: "local", spaceKey: "folder:k", noteId: "note-a",
    bounds: { x: 10, y: 20, width: 520, height: 420 },
  });
  records = openMemoWindowRecord(records, {
    instanceId: "win-b", kind: "shared",
    bounds: { x: 30, y: 40, width: 520, height: 420 },
  });

  const quitting = closeMemoWindowRecord(records, "win-a", { appQuitting: true });
  assert.deepEqual(quitting, records);
  const userClosed = closeMemoWindowRecord(records, "win-a", { appQuitting: false });
  assert.deepEqual(userClosed.map((record) => record.instanceId), ["win-b"]);
});

test("같은 메모는 마지막 창이 닫혔을 때만 open count가 0이다", () => {
  let records = [];
  records = openMemoWindowRecord(records, { instanceId: "one", kind: "local", spaceKey: "folder:k", noteId: "note-a" });
  records = openMemoWindowRecord(records, { instanceId: "two", kind: "local", spaceKey: "folder:k", noteId: "note-a" });
  assert.equal(memoOpenCounts(records)["folder:k\nnote-a"], 2);
  records = closeMemoWindowRecord(records, "one", { appQuitting: false });
  assert.equal(memoOpenCounts(records)["folder:k\nnote-a"], 1);
  records = closeMemoWindowRecord(records, "two", { appQuitting: false });
  assert.equal(memoOpenCounts(records)["folder:k\nnote-a"], undefined);
});

test("메모 창 bounds와 보기 모드를 갱신하고 폐기된 필드와 malformed record를 버린다", () => {
  const normalized = normalizeMemoWindowRecords([
    { instanceId: "bad-kind", kind: "wat" },
    { instanceId: "bad-local", kind: "local", spaceKey: "folder:k" },
    { instanceId: "shared", kind: "shared", obsoleteFlag: true, bounds: { x: 1, y: 2, width: 520, height: 420 } },
  ]);
  assert.deepEqual(normalized.map((record) => record.instanceId), ["shared"]);
  assert.equal(Object.hasOwn(normalized[0], "obsoleteFlag"), false);

  const patched = patchMemoWindowRecord(normalized, "shared", {
    viewMode: "preview",
    bounds: { x: 100, y: 110, width: 700, height: 600 },
  });
  assert.equal(patched[0].viewMode, "preview");
  assert.deepEqual(patched[0].bounds, { x: 100, y: 110, width: 700, height: 600 });
});

test("항상 위 상태는 창마다 저장되고 명시하지 않은 기존 레코드는 해제 상태로 이관된다", () => {
  const normalized = normalizeMemoWindowRecords([
    { instanceId: "old", kind: "shared" },
    { instanceId: "pinned", kind: "shared", alwaysOnTop: true },
  ]);
  assert.equal(normalized[0].alwaysOnTop, false);
  assert.equal(normalized[1].alwaysOnTop, true);

  const patched = patchMemoWindowRecord(normalized, "pinned", { alwaysOnTop: false });
  assert.equal(patched[1].alwaysOnTop, false);
  assert.equal(normalized[1].alwaysOnTop, true);
});
