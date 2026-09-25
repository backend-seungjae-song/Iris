import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const browserStateUrl = pathToFileURL(path.resolve("server/browser-state.js")).href;

async function freshState(t, initial) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-bookmark-folders-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  if (initial) fs.writeFileSync(path.join(stateDir, "browser-state.json"), JSON.stringify(initial));
  process.env.IRIS_STATE_DIR = stateDir;
  const state = await import(`${browserStateUrl}?test=${Date.now()}-${Math.random()}`);
  state.load();
  return state;
}
const shape = (list) => list.map((x) => (x.folder ? `${x.folder}[${x.items.map((i) => i.url).join(",")}]` : x.url));

test("폴더를 만들고 북마크를 넣고 꺼내고, 폴더를 지우면 안의 북마크는 그 자리에 남는다", async (t) => {
  const s = await freshState(t);
  const M = (m) => s.mutate({ space: "sp", ...m });
  M({ op: "bookmark.add", url: "a", title: "A" });
  M({ op: "bookmark.add", url: "b", title: "B" });
  assert.equal(M({ op: "bookmark.folder.add", folder: "f1", title: "폴더" }), true);
  assert.equal(M({ op: "bookmark.move", url: "a", into: "f1" }), true);
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp), ["b", "f1[a]"]);
  assert.equal(M({ op: "bookmark.add", url: "a" }), false, "폴더 안에 있는 주소도 같은 목록의 중복이다");
  assert.equal(M({ op: "bookmark.add", url: "c", folder: "f1" }), true);
  assert.equal(M({ op: "bookmark.edit", url: "c", newUrl: "b" }), false, "폴더 밖 주소와 겹치는 편집은 거절한다");
  assert.equal(M({ op: "bookmark.move", folder: "f1", before: "b" }), true);
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp), ["f1[a,c]", "b"]);
  assert.equal(M({ op: "bookmark.move", folder: "f1", into: "f1" }), false, "폴더 안에 폴더는 두지 않는다");
  assert.equal(M({ op: "bookmark.folder.rename", folder: "f1", title: "  " }), false);
  assert.equal(M({ op: "bookmark.folder.rename", folder: "f1", title: "읽을거리" }), true);
  assert.equal(M({ op: "bookmark.move", url: "a", beforeFolder: "f1" }), true, "폴더에서 꺼내 폴더 앞에 둔다");
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp), ["a", "f1[c]", "b"]);
  assert.equal(M({ op: "bookmark.folder.remove", folder: "f1" }), true);
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp), ["a", "c", "b"]);
  assert.equal(M({ op: "bookmark.remove", url: "c" }), true);
  assert.equal(M({ op: "bookmark.move", url: "b" }), false, "이미 끝에 있으면 바뀐 것이 없다");
});

test("공통 목록은 스페이스와 무관하고, 세션 목록과 주소가 겹치는 이동은 거절한다", async (t) => {
  const s = await freshState(t);
  s.mutate({ op: "bookmark.add", space: "sp1", url: "a" });
  s.mutate({ op: "bookmark.add", space: "sp1", url: "b" });
  assert.equal(s.mutate({ op: "bookmark.move", space: "sp1", url: "a", toScope: "common" }), true);
  assert.deepEqual(shape(s.get().bookmarksCommon), ["a"]);
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp1), ["b"]);
  assert.equal(s.mutate({ op: "bookmark.folder.add", space: "sp2", scope: "common", folder: "cf", title: "공통 폴더" }), true);
  assert.equal(s.mutate({ op: "bookmark.add", space: "sp2", scope: "common", url: "z", folder: "cf" }), true);
  assert.deepEqual(shape(s.get().bookmarksCommon), ["a", "cf[z]"]);
  s.mutate({ op: "bookmark.add", space: "sp1", url: "a" });
  assert.equal(s.mutate({ op: "bookmark.move", space: "sp1", url: "a", toScope: "common" }), false, "양쪽에 같은 주소가 있으면 어느 쪽도 잃지 않게 거절한다");
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp1), ["b", "a"]);
  assert.equal(s.mutate({ op: "bookmark.move", space: "sp1", scope: "common", folder: "cf", toScope: "space", before: "b" }), true);
  assert.deepEqual(shape(s.get().bookmarksBySpace.sp1), ["cf[z]", "b", "a"]);
  assert.deepEqual(shape(s.get().bookmarksCommon), ["a"]);
});

test("스페이스 키를 합칠 때 폴더가 여럿이어도 모두 남고 겹치는 주소는 하나만 남는다", async (t) => {
  const s = await freshState(t, {
    bookmarksBySpace: {
      old: [{ folder: "g1", title: "G1", items: [{ url: "a" }] }, { folder: "g2", title: "G2", items: [{ url: "z" }] }, { url: "y" }],
      now: [{ url: "a" }, { folder: "g1", title: "G1", items: [{ url: "k" }] }],
    },
  });
  assert.equal(s.remapSpaces({ old: "now" }), true);
  assert.deepEqual(shape(s.get().bookmarksBySpace.now), ["a", "g1[k]", "g2[z]", "y"]);
});

test("저장된 폴더에 items 가 없어도 읽을 때 빈 목록으로 고친다", async (t) => {
  const s = await freshState(t, { bookmarksBySpace: { sp: [{ folder: "f", title: "F" }] }, bookmarksCommon: "잘못된 값" });
  assert.deepEqual(s.get().bookmarksBySpace.sp[0].items, []);
  assert.deepEqual(s.get().bookmarksCommon, []);
  assert.equal(s.mutate({ op: "bookmark.add", space: "sp", url: "a", folder: "f" }), true);
});
