// 탭 띠에서 사람이 보는 위치 기준으로 활성 탭과 그룹 순서를 정하는지.
// 활성 탭을 닫으면 띠의 바로 옆 탭으로. 그룹 순서는 끌기로만 바뀜.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const MOD = pathToFileURL(path.resolve("server/browser-state.js")).href;

async function withState(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-strip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify(seed));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`${MOD}?strip=${path.basename(dir)}`);
  mod.load();
  return mod;
}

// 배열 순서 a b c d e, 띠 순서 [G1: b c] [G2(접힘): d] a e
const seed = () => ({
  tabsBySpace: { s: ["a", "b", "c", "d", "e"].map((id) => ({ id, url: `https://${id}.test`, profile: null, ...(id === "b" || id === "c" ? { group: "g1" } : id === "d" ? { group: "g2" } : {}) })) },
  groupsBySpace: { s: [{ id: "g1", name: "G1", collapsed: false }, { id: "g2", name: "G2", collapsed: true }] },
  activeBySpace: { s: "b" },
});

test("그룹 안 활성 탭을 닫으면 배열 끝이 아니라 띠에서 바로 오른쪽 탭이 활성", async (t) => {
  const mod = await withState(t, seed());
  assert.equal(mod.mutate({ op: "tab.close", space: "s", id: "b" }), true);
  assert.equal(mod.get().activeBySpace.s, "c");
});

test("오른쪽 탭이 없으면 왼쪽, 접힌 그룹의 탭은 고르지 않음", async (t) => {
  const st = seed(); st.activeBySpace.s = "e";
  const mod = await withState(t, st);
  mod.mutate({ op: "tab.close", space: "s", id: "e" });
  assert.equal(mod.get().activeBySpace.s, "a");
  mod.mutate({ op: "tab.close", space: "s", id: "a" });
  assert.equal(mod.get().activeBySpace.s, "c");
});

test("그룹을 펼치거나 접어도 그룹 순서는 그대로", async (t) => {
  const mod = await withState(t, seed());
  mod.mutate({ op: "group.collapse", space: "s", id: "g2", collapsed: false });
  mod.mutate({ op: "group.collapse", space: "s", id: "g1", collapsed: true });
  assert.deepEqual(mod.get().groupsBySpace.s.map((g) => g.id), ["g1", "g2"]);
});

test("그룹 끌기: before 그룹 앞으로, before 없으면 맨 끝, 제자리는 변경 없음", async (t) => {
  const st = seed(); st.groupsBySpace.s.push({ id: "g3", name: "G3", collapsed: false });
  const mod = await withState(t, st);
  assert.equal(mod.mutate({ op: "group.move", space: "s", id: "g3", before: "g1" }), true);
  assert.deepEqual(mod.get().groupsBySpace.s.map((g) => g.id), ["g3", "g1", "g2"]);
  assert.equal(mod.mutate({ op: "group.move", space: "s", id: "g3", before: null }), true);
  assert.deepEqual(mod.get().groupsBySpace.s.map((g) => g.id), ["g1", "g2", "g3"]);
  assert.equal(mod.mutate({ op: "group.move", space: "s", id: "g1", before: "g2" }), false);
  assert.equal(mod.mutate({ op: "group.move", space: "s", id: "없음", before: null }), false);
});
