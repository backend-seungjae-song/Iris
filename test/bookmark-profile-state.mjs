import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const MOD = pathToFileURL(path.resolve("server/browser-state.js")).href;

// 상태 폴더마다 모듈을 새로 읽음(경로를 로드 시점에 고정)
async function withState(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-bmprof-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify(seed));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`${MOD}?bm=${path.basename(dir)}`);
  mod.load();
  return mod;
}

const PROFILES = [{ id: "p_work", name: "Work" }, { id: "p_home", name: "Home" }];
const seed = () => ({
  profiles: PROFILES,
  bookmarksCommon: [{ url: "https://a.com/", title: "A" }],
  bookmarksBySpace: { w: [{ url: "https://b.com/", title: "B" }, { folder: "f1", title: "F", items: [{ url: "https://c.com/", title: "C" }] }] },
});
const flat = (mod) => {
  const s = mod.get();
  const out = {};
  for (const b of s.bookmarksCommon) out[b.url] = b.profile;
  for (const x of s.bookmarksBySpace.w) for (const b of x.folder ? x.items : [x]) out[b.url] = b.profile;
  return out;
};

test("북마크마다 열 계정을 정하고 지정 해제할 수 있다(폴더 안·공통 포함)", async (t) => {
  const mod = await withState(t, seed());
  assert.equal(mod.mutate({ op: "bookmark.edit", scope: "common", space: "w", url: "https://a.com/", profile: "p_work" }), true);
  assert.equal(mod.mutate({ op: "bookmark.edit", space: "w", url: "https://c.com/", profile: "" }), true, "기본 계정도 지정");
  assert.equal(mod.mutate({ op: "bookmark.edit", space: "w", url: "https://b.com/", profile: "없는계정" }), false);
  assert.deepEqual(flat(mod), { "https://a.com/": "p_work", "https://b.com/": undefined, "https://c.com/": "" });
  assert.equal(mod.mutate({ op: "bookmark.edit", space: "w", url: "https://c.com/", profile: null }), true);
  assert.equal(mod.mutate({ op: "bookmark.edit", space: "w", url: "https://c.com/", profile: null }), false, "이미 해제");
  assert.equal("profile" in mod.get().bookmarksBySpace.w[1].items[0], false);
});

test("계정을 지우면 그 계정을 쓰던 북마크는 지정 해제", async (t) => {
  const s = seed();
  s.bookmarksCommon[0].profile = "p_work";
  s.bookmarksBySpace.w[1].items[0].profile = "p_home";
  const mod = await withState(t, s);
  mod.mutate({ op: "profile.remove", id: "p_work" });
  assert.deepEqual(flat(mod), { "https://a.com/": undefined, "https://b.com/": undefined, "https://c.com/": "p_home" });
});

test("불러올 때 없는 계정을 가리키는 북마크 계정은 지운다", async (t) => {
  const s = seed();
  s.bookmarksCommon[0].profile = "사라진계정";
  s.bookmarksBySpace.w[0].profile = 7;
  s.bookmarksBySpace.w[1].items[0].profile = "p_home";
  const mod = await withState(t, s);
  assert.deepEqual(flat(mod), { "https://a.com/": undefined, "https://b.com/": undefined, "https://c.com/": "p_home" });
});
