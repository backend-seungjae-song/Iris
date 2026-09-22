import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoDockStore } from "../server/memo-dock-store.js";

function tempState(t, initial) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-memo-dock-"));
  const filePath = path.join(stateDir, "memos.json");
  if (initial !== undefined) fs.writeFileSync(filePath, typeof initial === "string" ? initial : JSON.stringify(initial));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  return { stateDir, filePath };
}

test("저장 성공은 디스크 반영 뒤에만 메모리 문서를 전진시킨다", (t) => {
  const { stateDir, filePath } = tempState(t, { "folder:v2:one": "이전 본문" });
  let store;
  let persistedWhileOld = false;
  const persistState = (target, next) => {
    persistedWhileOld = store.document("folder:v2:one").text === "이전 본문";
    fs.writeFileSync(target, JSON.stringify(next));
  };
  store = new MemoDockStore({ stateDir, persistState });
  const before = store.document("folder:v2:one");

  const result = store.setDocument({
    space: "folder:v2:one", baseVersion: before.version, text: "새 본문", requestId: "save-1",
  });

  assert.equal(result.ok, true);
  assert.equal(persistedWhileOld, true, "파일 commit 전에는 메모리 정본을 바꾸지 않는다");
  assert.equal(store.document("folder:v2:one").text, "새 본문");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { "folder:v2:one": "새 본문" });
  assert.match(result.doc.version, /^sha256:[0-9a-f]{64}$/);
});

test("파일 저장 실패는 메모리와 디스크를 모두 이전 본문으로 유지한다", (t) => {
  const { stateDir, filePath } = tempState(t, { "folder:v2:one": "보존할 본문" });
  const store = new MemoDockStore({ stateDir, persistState: () => { throw new Error("disk full"); } });
  const before = store.document("folder:v2:one");

  const result = store.setDocument({
    space: "folder:v2:one", baseVersion: before.version, text: "반영되면 안 됨", requestId: "save-fail",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERSIST_FAILED");
  assert.deepEqual(store.document("folder:v2:one"), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { "folder:v2:one": "보존할 본문" });
});

test("stale baseVersion은 최신 문서를 반환하고 기존 본문을 덮지 않는다", (t) => {
  const { stateDir, filePath } = tempState(t, { "folder:v2:one": "처음" });
  const store = new MemoDockStore({ stateDir });
  const base = store.document("folder:v2:one").version;
  const first = store.setDocument({ space: "folder:v2:one", baseVersion: base, text: "첫 창", requestId: "first" });

  const stale = store.setDocument({ space: "folder:v2:one", baseVersion: base, text: "둘째 창", requestId: "second" });

  assert.equal(first.ok, true);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "CONFLICT");
  assert.equal(stale.current.text, "첫 창");
  assert.equal(store.document("folder:v2:one").text, "첫 창");
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { "folder:v2:one": "첫 창" });
});

test("ACK 유실 뒤 같은 요청이나 같은 본문을 재시도해도 멱등 성공한다", (t) => {
  const { stateDir } = tempState(t, { "folder:v2:one": "처음" });
  const store = new MemoDockStore({ stateDir });
  const base = store.document("folder:v2:one").version;
  const input = { space: "folder:v2:one", baseVersion: base, text: "한 번만", requestId: "retry-me" };

  const first = store.setDocument(input);
  const sameRequest = store.setDocument(input);
  const sameText = store.setDocument({ ...input, requestId: "retry-new-id" });

  assert.deepEqual(sameRequest, first);
  assert.equal(sameText.ok, true);
  assert.equal(sameText.unchanged, true);
  assert.equal(store.document("folder:v2:one").text, "한 번만");
});

test("손상된 memos.json은 빈 상태로 덮지 않고 모든 쓰기를 차단한다", (t) => {
  const broken = "{ this is not json";
  const { stateDir, filePath } = tempState(t, broken);
  const before = fs.readFileSync(filePath);
  const store = new MemoDockStore({ stateDir });

  const save = store.setDocument({ space: "folder:v2:one", baseVersion: "sha256:none", text: "덮지 마", requestId: "broken-save" });
  const remap = store.remapSpaces({ old: "folder:v2:one" });

  assert.equal(save.error.code, "CORRUPT_STATE");
  assert.equal(remap.error.code, "CORRUPT_STATE");
  assert.deepEqual(fs.readFileSync(filePath), before);
});

test("키 이관은 양쪽 본문을 한 번만 보존하고 재시도 때 중복하지 않는다", (t) => {
  const oldKey = "folder:old-device:ino:born";
  const newKey = "folder:v2:ino:born";
  const { stateDir, filePath } = tempState(t, { [oldKey]: "재부팅 전", [newKey]: "재부팅 후" });
  const store = new MemoDockStore({ stateDir });

  const first = store.remapSpaces({ [oldKey]: newKey });
  const afterFirst = fs.readFileSync(filePath, "utf8");
  const second = store.remapSpaces({ [oldKey]: newKey });

  assert.equal(first.ok, true);
  assert.equal(first.changed, true);
  assert.match(store.document(newKey).text, /재부팅 전/);
  assert.match(store.document(newKey).text, /재부팅 후/);
  assert.equal(Object.hasOwn(store.snapshot().texts, oldKey), false);
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(fs.readFileSync(filePath, "utf8"), afterFirst);
});

test("옛 키의 빈 본문도 제거해 v2의 실제 본문을 투영에서 가리지 못하게 한다", (t) => {
  const oldKey = "folder:old-device:ino:born";
  const newKey = "folder:v2:ino:born";
  const { stateDir } = tempState(t, { [newKey]: "지켜야 할 본문", [oldKey]: "" });
  const store = new MemoDockStore({ stateDir });

  assert.equal(store.hasSpace(oldKey), true, "빈 값이어도 정리할 저장 키는 존재한다");
  const result = store.remapSpaces({ [oldKey]: newKey });

  assert.equal(result.ok, true);
  assert.equal(store.document(newKey).text, "지켜야 할 본문");
  assert.equal(Object.hasOwn(store.snapshot().texts, oldKey), false);
});
