// 설정 단축키 검색은 이름·표시 조합뿐 아니라 "cmd shift d" 처럼 글자로 친 조합도 찾는다.
import assert from "node:assert/strict";
import test from "node:test";

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ exists: true, revision: 0, hidden: [], local: true }));
const { matchOne } = await import("../web/js/devtool/settings-view.js");
globalThis.fetch = previousFetch;

const sketch = { id: "sketch", label: "화면 스케치", where: "어디서나", keys: "⌘⇧D" };
const tabPrev = { id: "tab-prev", label: "터미널 탭 이전", where: "어디서나", keys: "⌥←" };
const find = { id: "find-in-page", label: "페이지에서 찾기", where: "브라우저 탭에서", keys: "⌘F" };

test("글자로 친 조합을 표시 조합과 대조한다", () => {
  for (const q of ["cmd shift d", "shift cmd d", "cmd+shift+d", "ctrl shift d", "⌘⇧d"]) assert.ok(matchOne(sketch, q), q);
  assert.ok(matchOne(tabPrev, "opt left"));
  assert.ok(matchOne(sketch, "cmd shift"), "수정키만 치면 그 수정키로 시작하는 조합");
});

test("다른 조합은 찾지 않는다", () => {
  assert.equal(matchOne(sketch, "cmd d"), false);
  assert.equal(matchOne(find, "cmd shift"), false);
  assert.equal(matchOne(find, "cmd shift f"), false);
});

test("이름 검색은 그대로 동작한다", () => {
  assert.ok(matchOne(sketch, "스케치"));
  assert.ok(matchOne(find, "⌘f"));
  assert.equal(matchOne(sketch, "녹화"), false);
});

// ⌥←/→ 는 메인 창에서 herdr 터미널 탭을 넘긴다(keynav.js cycleCenterTab). 가운데 파일 탭으로 적으면 설정만 보고 고를 수 없다.
test("⌥←/→ 이름은 실제로 넘기는 탭을 적는다", async () => {
  const { KEYMAP } = await import("../web/js/core/keymap.js");
  for (const id of ["tab-prev", "tab-next"]) assert.match(KEYMAP.find((x) => x.id === id).label, /^터미널 탭/, id);
});

// 입력칸은 query 로 다시 그려지므로 저장한 검색어에는 친 공백이 남아 있다.
test("앞뒤 공백이 있는 검색어도 같은 결과를 낸다", () => {
  assert.ok(matchOne(sketch, "cmd shift "));
  assert.ok(matchOne(sketch, " 스케치 "));
  assert.ok(matchOne(sketch, "   "));
});
