import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const MOD = pathToFileURL(path.resolve("server/browser-state.js")).href;

// 상태 폴더마다 모듈을 새로 읽음(경로를 로드 시점에 고정)
async function withState(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-linkrules-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify(seed));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`${MOD}?lr=${path.basename(dir)}`);
  mod.load();
  return mod;
}

const PROFILES = [{ id: "p_work", name: "Work" }, { id: "p_home", name: "Home" }];

test("규칙 목록을 통째로 바꾸고, 모양이 틀리거나 없는 계정을 가리키는 규칙은 뺀다", async (t) => {
  const mod = await withState(t, { profiles: PROFILES });
  assert.equal(mod.mutate({ op: "linkRules.set", rules: [
    { pattern: "github.com/acme", profile: "p_work" },
    { pattern: "notion.so", profile: "" },
    { pattern: "Bad Pattern", profile: "p_work" },
    { pattern: "x.com", profile: "없는계정" },
    { pattern: "github.com/acme", profile: "p_home" },
    "문자열",
  ] }), true);
  assert.deepEqual(mod.get().linkProfileRules, [
    { pattern: "notion.so", profile: "" },
    { pattern: "github.com/acme", profile: "p_home" },
  ]);
  assert.equal(mod.mutate({ op: "linkRules.set", rules: mod.get().linkProfileRules }), false, "같으면 바뀐 것 없음");
});

test("계정을 지우면 그 계정으로 열던 규칙도 지운다", async (t) => {
  const mod = await withState(t, { profiles: PROFILES, linkProfileRules: [
    { pattern: "a.com", profile: "p_work" }, { pattern: "b.com", profile: "p_home" },
  ] });
  mod.mutate({ op: "profile.remove", id: "p_work" });
  assert.deepEqual(mod.get().linkProfileRules, [{ pattern: "b.com", profile: "p_home" }]);
});

test("계정을 정하지 않고 연 새 탭(AI 도구·휴대폰)은 규칙 계정, 정했으면 그 계정, 규칙 밖은 스페이스 기본", async (t) => {
  const mod = await withState(t, { profiles: PROFILES, defaultProfileBySpace: { w: "p_home" },
    linkProfileRules: [{ pattern: "figma.com/design/VENU", profile: "p_work" }] });
  mod.mutate({ op: "tab.open", space: "w", id: "a", url: "https://www.figma.com/design/VENU/x?node-id=1" });
  mod.mutate({ op: "tab.open", space: "w", id: "b", url: "https://www.figma.com/design/VENU/x", profile: "" });
  mod.mutate({ op: "tab.open", space: "w", id: "c", url: "https://www.figma.com/files/recent" });
  const byId = Object.fromEntries(mod.get().tabsBySpace.w.map((x) => [x.id, x.profile]));
  assert.deepEqual(byId, { a: "p_work", b: "", c: "p_home" });
});

test("불러올 때 저장 파일의 이상한 규칙을 정리한다", async (t) => {
  const mod = await withState(t, { profiles: PROFILES, linkProfileRules: "망가짐" });
  assert.deepEqual(mod.get().linkProfileRules, []);
});
