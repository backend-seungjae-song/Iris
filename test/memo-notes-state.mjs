import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoNotesStore } from "../server/memo-notes.js";

function tempState(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `iris-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixedStore(t, name, extra = {}) {
  const ids = ["note-a", "note-b", "note-c", "note-d"];
  return new MemoNotesStore({
    stateDir: tempState(t, name),
    now: () => 1_786_000_000_000,
    idFactory: () => ids.shift(),
    ...extra,
  });
}

test("같은 스페이스의 새 메모는 독립되고 본문 상한을 조용히 자르지 않는다", (t) => {
  const store = fixedStore(t, "memo-independent");

  const a = store.createLocal({ space: "folder:k", requestId: "create-a" });
  const aRetry = store.createLocal({ space: "folder:k", requestId: "create-a" });
  const b = store.createLocal({ space: "folder:k", requestId: "create-b" });

  assert.equal(a.ok, true);
  assert.equal(aRetry.note.id, a.note.id, "같은 생성 요청은 메모를 하나 더 만들지 않는다");
  assert.notEqual(a.note.id, b.note.id);
  assert.deepEqual(store.notesForSpace("folder:k").map((note) => note.id), ["note-a", "note-b"]);

  const max = "가".repeat(200_000);
  assert.equal(store.setDocument({ scope: "local", space: "folder:k", noteId: a.note.id,
    baseRev: 0, text: max, requestId: "save-a-1" }).ok, true);
  assert.equal(store.document({ scope: "local", space: "folder:k", noteId: a.note.id }).text.length, 200_000);
  assert.equal(store.document({ scope: "local", space: "folder:k", noteId: b.note.id }).text, "");

  const tooLarge = store.setDocument({ scope: "local", space: "folder:k", noteId: b.note.id,
    baseRev: 0, text: max + "나", requestId: "save-b-too-large" });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.error.code, "TEXT_TOO_LARGE");
  assert.equal(store.document({ scope: "local", space: "folder:k", noteId: b.note.id }).text, "");
});

test("revision 충돌·중복 요청·삭제 경합은 최신 본문을 덮지 않는다", (t) => {
  const store = fixedStore(t, "memo-revision");
  const note = store.createLocal({ space: "folder:k", requestId: "create" }).note;

  const first = store.setDocument({ scope: "local", space: "folder:k", noteId: note.id,
    baseRev: 0, text: "첫 저장", requestId: "save-1" });
  const duplicate = store.setDocument({ scope: "local", space: "folder:k", noteId: note.id,
    baseRev: 0, text: "첫 저장", requestId: "save-1" });
  const stale = store.setDocument({ scope: "local", space: "folder:k", noteId: note.id,
    baseRev: 0, text: "오래된 창", requestId: "save-stale" });

  assert.equal(first.rev, 1);
  assert.equal(duplicate.rev, 1);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "CONFLICT");
  assert.equal(stale.current.text, "첫 저장");
  assert.equal(stale.current.rev, 1);

  const deleted = store.deleteLocal({ space: "folder:k", noteId: note.id, requestId: "delete" });
  assert.equal(deleted.ok, true);
  assert.equal(store.document({ scope: "local", space: "folder:k", noteId: note.id, includeDeleted: true }).text, "첫 저장");
  const afterDelete = store.setDocument({ scope: "local", space: "folder:k", noteId: note.id,
    baseRev: 1, text: "삭제 뒤 저장", requestId: "save-after-delete" });
  assert.equal(afterDelete.ok, false);
  assert.equal(afterDelete.error.code, "NOTE_DELETED");

  const restored = store.restoreLocal({ space: "folder:k", noteId: note.id, requestId: "restore" });
  assert.equal(restored.ok, true);
  assert.equal(restored.note.id, note.id);
  assert.equal(restored.note.text, "첫 저장");
  assert.equal(restored.note.rev, 1);
});

test("손상 파일과 원자 저장 실패는 이전 bytes와 메모리 정본을 보존한다", (t) => {
  const stateDir = tempState(t, "memo-corrupt");
  const file = path.join(stateDir, "memo-notes.json");
  fs.writeFileSync(file, "{잘린-json", "utf8");
  const corrupt = new MemoNotesStore({ stateDir });

  const blocked = corrupt.createLocal({ space: "folder:k", requestId: "blocked" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "CORRUPT_STATE");
  assert.equal(fs.readFileSync(file, "utf8"), "{잘린-json");

  const failed = fixedStore(t, "memo-write-fail", {
    persistState: () => { throw new Error("disk full"); },
  });
  const result = failed.createLocal({ space: "folder:k", requestId: "fail-create" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PERSIST_FAILED");
  assert.deepEqual(failed.notesForSpace("folder:k"), []);
});

test("스페이스 remap은 양쪽 메모와 divergent ID 충돌을 모두 보존한다", (t) => {
  const stateDir = tempState(t, "memo-remap");
  fs.writeFileSync(path.join(stateDir, "memo-notes.json"), JSON.stringify({
    version: 1,
    localBySpace: {
      old: { order: ["same", "old-only"], notes: {
        same: { id: "same", name: "옛 충돌", text: "old text", rev: 2, createdAt: 1, updatedAt: 2, deletedAt: null },
        "old-only": { id: "old-only", name: "옛 것", text: "old only", rev: 0, createdAt: 1, updatedAt: 1, deletedAt: null },
      } },
      stable: { order: ["same", "new-only"], notes: {
        same: { id: "same", name: "새 충돌", text: "new text", rev: 3, createdAt: 1, updatedAt: 3, deletedAt: null },
        "new-only": { id: "new-only", name: "새 것", text: "new only", rev: 0, createdAt: 1, updatedAt: 1, deletedAt: null },
      } },
    },
    shared: { text: "", rev: 0, updatedAt: 0 },
  }));
  const generated = ["collision-copy"];
  const store = new MemoNotesStore({ stateDir, idFactory: () => generated.shift() });

  const moved = store.remapSpaces({ old: "stable" });
  assert.equal(moved.ok, true);
  assert.deepEqual(new Set(store.notesForSpace("stable", { includeDeleted: true }).map((note) => note.text)),
    new Set(["old text", "old only", "new text", "new only"]));
  assert.deepEqual(store.notesForSpace("old", { includeDeleted: true }), []);
});

test("공유 메모는 창 수와 무관한 단일 revision 문서다", (t) => {
  const store = fixedStore(t, "memo-shared");
  assert.deepEqual(store.document({ scope: "shared" }), { text: "", rev: 0, updatedAt: 0 });
  const saved = store.setDocument({ scope: "shared", baseRev: 0, text: "모든 창의 글", requestId: "shared-1" });
  assert.equal(saved.ok, true);
  assert.deepEqual(store.document({ scope: "shared" }), {
    text: "모든 창의 글", rev: 1, updatedAt: 1_786_000_000_000,
  });
});

