// 기본 로그인 칸을 이름으로 지정할 수 있는가.
//
// 배경: 목록에는 "기본"이 있는데 그 이름으로 탭을 열면 "그런 로그인 칸이
// 없습니다"가 나왔다. 찾은 것과 못 찾은 것을 참/거짓으로 갈랐기
// 때문이다. 기본 칸의 id 는 빈 문자열(web/js/browser/profiles.js 의 PROFILE_DEFAULT_ID)이라
// 찾았는데도 거짓이 된다. 못 찾은 것만 null 이므로 그것으로 갈라야 한다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { setProfiles, profileRefToId, profileNames } from "../server/browser-runtime.js";
import { PROFILE_DEFAULT, PROFILE_DEFAULT_ID } from "../web/js/browser/profiles.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// 렌더러가 보내는 그대로다. 맨 앞이 기본 칸이고 그 id 는 빈 문자열이다.
const AS_SENT = [{ id: PROFILE_DEFAULT_ID, name: PROFILE_DEFAULT }, { id: "p_1", name: "Study" }];

test("기본 칸의 id 는 빈 문자열이다", () => {
  // 이 전제가 깨지면 아래 판정이 전부 의미를 잃는다. 값을 여기서 고정한다.
  assert.equal(PROFILE_DEFAULT_ID, "");
  assert.equal(PROFILE_DEFAULT, "기본");
});

test("목록에 보이는 이름은 전부 해석된다", () => {
  setProfiles(AS_SENT);
  for (const name of profileNames()) {
    assert.notEqual(profileRefToId(name), null, `목록에 있는데 해석이 안 된다: ${name}`);
  }
});

test("기본은 빈 문자열로, 다른 칸은 자기 id 로, 없는 이름만 null 로 해석된다", () => {
  setProfiles(AS_SENT);
  assert.equal(profileRefToId("기본"), "", "기본 칸이 null 로 떨어지면 '없는 칸'이 된다");
  assert.equal(profileRefToId("Study"), "p_1");
  assert.equal(profileRefToId("p_1"), "p_1", "id 로도 찾아야 한다");
  assert.equal(profileRefToId("없는칸"), null);
  assert.equal(profileRefToId(""), null, "빈 참조는 지정이 없는 것이다");
});

test("탭 여는 자리가 없음과 기본을 갈라서 본다", () => {
  // 여기서 참/거짓으로 가르면 기본 칸이 거부된다.
  const src = read("server/browser-commands.js");
  assert.match(src, /if \(profileId === null\) \{ resolve\(\{ ok: false, error: `그런 로그인 칸/,
    "기본 칸(빈 id)을 '없는 칸'으로 거부하는 판정으로 돌아갔다");
});

test("고른 칸을 그대로 넘긴다 — 기본도 포함해서", () => {
  // 거부는 안 하는데 키를 안 넘기면 스페이스 기본 칸으로 열린다. "기본"을 골랐는데 로그인된
  // 칸이 열린다. 같은 참/거짓 판정 실수가 여기에도 적용된다.
  const src = read("server/browser-commands.js");
  assert.match(src, /\.\.\.\(profileId != null \? \{ profile: profileId \} : \{\}\)/,
    "고른 칸이 기본이면 키가 빠져 스페이스 기본으로 열린다");
  assert.doesNotMatch(src, /\.\.\.\(profileId \? \{ profile: profileId \} : \{\}\)/,
    "참/거짓으로 거르는 옛 줄이 남아 있다");
});

test("상태 층은 빈 문자열을 기본 칸으로 읽는다", () => {
  // 서버가 profile: "" 를 넘겨도 상태가 그것을 버리면 아무 소용이 없다.
  const src = read("server/browser-state.js");
  assert.match(src, /if \(value == null \|\| value === "" \|\| value === "기본"\) return "";/,
    "빈 문자열을 기본으로 읽지 않는다");
  assert.match(src, /hasOwnProperty\.call\(m, "profile"\)/,
    "키가 있는지로 지정 여부를 가르지 않는다 — 빈 문자열 지정이 사라진다");
});
