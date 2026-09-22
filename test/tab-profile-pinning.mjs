// 탭이 앉아 있는 세션은 저장돼야 한다.
//
// `profile: null`은 스페이스 기본을 따른다는 뜻이다. 그러면 그 탭이 실제로 어느 세션에
// 앉아 있는지 아무 데도 기록되지 않는다. 기본이 바뀌면 그 탭들은 다음에 열릴 때 다른
// 파티션에 붙고, 사용자에게는 이유 없는 로그아웃으로 보인다.
//
// 그래서 두 지점에서 기록한다. 이미 있던 탭은 불러올 때 1회, 새로 여는 탭은 여는 시점이다.
// 적는 값은 "지금 이 탭이 실제로 쓰고 있는 것"이라 이관 자체는 아무것도 바꾸지 않는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const MOD = pathToFileURL(path.resolve("server/browser-state.js")).href;

// 상태 폴더마다 모듈을 새로 읽는다. 모듈이 경로를 로드 시점에 고정하기 때문이다.
async function withState(t, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify(seed));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`${MOD}?pin=${path.basename(dir)}`);
  return { dir, mod };
}

const PROFILES = [{ id: "p_study", name: "Study" }, { id: "p_work", name: "Work" }];

test("불러올 때, 계정을 안 들고 있던 탭에 지금 쓰는 계정이 적힌다", async (t) => {
  const { mod } = await withState(t, {
    profiles: PROFILES,
    defaultProfileBySpace: { s1: "p_study", s2: "없는계정", s3: "" },
    tabsBySpace: {
      s1: [{ id: "a", url: "https://a.test", profile: null }, { id: "b", url: "https://b.test", profile: "p_work" }],
      s2: [{ id: "c", url: "https://c.test", profile: null }],
      s3: [{ id: "d", url: "https://d.test", profile: null }],
    },
  });
  const st = mod.load();
  const by = (sp, id) => st.tabsBySpace[sp].find((t) => t.id === id);

  assert.equal(by("s1", "a").profile, "p_study", "그 스페이스의 기본을 적어야 한다");
  assert.equal(by("s1", "b").profile, "p_work", "이미 들고 있던 계정은 건드리지 않는다");
  // 목록에 없는 계정을 가리키는 기본값은 기본 세션이다. 그 참조를 그대로 적으면 아무도
  // 로그인한 적 없는 빈 파티션이 생긴다.
  assert.equal(by("s2", "c").profile, "", "없는 계정을 가리키면 기본 세션이다");
  assert.equal(by("s3", "d").profile, "", "기본이 없으면 기본 세션이다");

  // 다시 불러도 같아야 한다. 이관이 매번 값을 바꾸면 안 된다.
  const again = mod.load();
  assert.equal(again.tabsBySpace.s1.find((t) => t.id === "a").profile, "p_study");
});

test("적어 둔 뒤에는 기본을 바꿔도 이미 있던 탭이 따라가지 않는다", async (t) => {
  const { mod } = await withState(t, {
    profiles: PROFILES,
    defaultProfileBySpace: { s1: "p_study" },
    tabsBySpace: { s1: [{ id: "a", url: "https://a.test", profile: null }] },
  });
  const st = mod.load();
  assert.equal(st.tabsBySpace.s1[0].profile, "p_study");

  mod.mutate({ op: "space.defaultProfile", space: "s1", profile: "p_work" });
  assert.equal(st.tabsBySpace.s1[0].profile, "p_study",
    "기본을 바꿨다고 이미 열려 있던 탭이 다른 세션으로 옮겨가면 그 자리에서 로그아웃된다");
});

test("새로 여는 탭은 그 순간의 기본을 적어 둔다", async (t) => {
  const { mod } = await withState(t, {
    profiles: PROFILES,
    defaultProfileBySpace: { s1: "p_study" },
    tabsBySpace: { s1: [] },
  });
  const st = mod.load();

  mod.mutate({ op: "tab.open", space: "s1", id: "new1", url: "https://n.test" });
  assert.equal(st.tabsBySpace.s1.find((t) => t.id === "new1").profile, "p_study",
    "null로 남기면 나중에 기본이 바뀔 때 이 탭이 옮겨 간다");

  // 기본을 바꾼 뒤 여는 탭은 새 기본을 따른다. 기본 계정의 정의가 그것이다.
  mod.mutate({ op: "space.defaultProfile", space: "s1", profile: "p_work" });
  mod.mutate({ op: "tab.open", space: "s1", id: "new2", url: "https://n2.test" });
  assert.equal(st.tabsBySpace.s1.find((t) => t.id === "new2").profile, "p_work");
  assert.equal(st.tabsBySpace.s1.find((t) => t.id === "new1").profile, "p_study", "앞서 연 탭은 제자리");

  // 명시로 준 계정은 기본보다 우선한다.
  mod.mutate({ op: "tab.open", space: "s1", id: "new3", url: "https://n3.test", profile: "p_study" });
  assert.equal(st.tabsBySpace.s1.find((t) => t.id === "new3").profile, "p_study");
});
