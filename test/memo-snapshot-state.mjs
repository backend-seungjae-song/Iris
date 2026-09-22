import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadMemoSnapshotState() {
  const source = fs.readFileSync(path.join(ROOT, "web/memo-snapshot-state.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: "web/memo-snapshot-state.js" });
  return context.IrisMemoSnapshotState;
}

test("dirty 중앙 메모는 전체 서버 스냅샷이 와도 로컬 초안을 보존한다", () => {
  const state = loadMemoSnapshotState();
  const merged = state.mergeSnapshot({ "w-video": "서버 이전본", "w-other": "다른 메모" }, {
    activeSpace: "w-video", draft: "작성 중인 초안", dirty: true,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(merged)), {
    "w-video": "작성 중인 초안", "w-other": "다른 메모",
  });
});

test("clean 중앙 메모는 전체 서버 스냅샷의 최신본을 받는다", () => {
  const state = loadMemoSnapshotState();
  const merged = state.mergeSnapshot({ "w-video": "서버 최신본" }, {
    activeSpace: "w-video", draft: "로컬 이전본", dirty: false,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(merged)), { "w-video": "서버 최신본" });
});

test("동일 폴더의 다른 runtime workspace 업데이트도 dirty 초안만 빼고 함께 반영한다", () => {
  const state = loadMemoSnapshotState();
  const merged = state.mergeUpdate({ "w-live": "로컬 이전본", "w-alias": "서버 이전본" }, {
    space: "w-alias", text: "다른 창 최신본",
  }, {
    activeSpace: "w-live", draft: "작성 중인 초안", dirty: true,
    spaceKeys: { "w-live": "folder:one", "w-alias": "folder:one" },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(merged)), {
    "w-live": "작성 중인 초안", "w-alias": "다른 창 최신본",
  });
});

test("이전 저장 ACK는 그 뒤 시작된 입력을 저장 완료로 만들지 않는다", () => {
  const state = loadMemoSnapshotState();
  let revision = 0;
  revision = state.advanceEditRevision(revision);
  const sentRevision = revision;
  revision = state.advanceEditRevision(revision);

  assert.equal(state.isCurrentRevision(sentRevision, revision), false);
  assert.equal(state.isCurrentRevision(revision, revision), true);
});

test("같은 서버 version의 영속 초안은 재연결 때 다시 저장한다", () => {
  const state = loadMemoSnapshotState();
  const draft = { text: "종료 직전 초안", baseVersion: "sha256:before", updatedAt: 10 };

  const recovered = state.recoverDraft({ text: "서버 이전본", version: "sha256:before" }, draft);

  assert.equal(recovered.action, "retry");
  assert.equal(recovered.text, "종료 직전 초안");
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.draft)), draft);
});

test("다른 서버 version의 초안은 양쪽 본문을 모두 포함해 병합한다", () => {
  const state = loadMemoSnapshotState();
  const recovered = state.recoverDraft({ text: "다른 창 최신본", version: "sha256:new" }, {
    text: "내 미저장 초안", baseVersion: "sha256:old", updatedAt: 10,
  });

  assert.equal(recovered.action, "merge");
  assert.match(recovered.text, /다른 창 최신본/);
  assert.match(recovered.text, /내 미저장 초안/);
  assert.equal(recovered.draft.baseVersion, "sha256:new");
});

test("서버와 같은 본문의 초안은 저장된 것으로 보고 제거한다", () => {
  const state = loadMemoSnapshotState();
  const recovered = state.recoverDraft({ text: "이미 저장됨", version: "sha256:new" }, {
    text: "이미 저장됨", baseVersion: "sha256:old", updatedAt: 10,
  });

  assert.equal(recovered.action, "clear");
  assert.equal(recovered.draft, null);
});

test("상태 불가 스냅샷은 현재 메모를 빈 객체로 초기화하지 않는다", () => {
  const state = loadMemoSnapshotState();
  const current = { "w-video": "현재 화면 본문" };
  const merged = state.mergeSnapshot({}, { current, unavailable: true });

  assert.deepEqual(JSON.parse(JSON.stringify(merged)), current);
});

test("ACK 본문과 현재 초안이 정확히 같을 때만 초안을 지운다", () => {
  const state = loadMemoSnapshotState();
  const draft = { text: "ACK 뒤에 더 쓴 내용", baseVersion: "sha256:before", updatedAt: 20 };

  assert.equal(state.isSavedDraft(draft, "먼저 보낸 내용"), false);
  assert.equal(state.isSavedDraft(draft, "ACK 뒤에 더 쓴 내용"), true);
});
