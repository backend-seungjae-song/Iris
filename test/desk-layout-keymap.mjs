// 설정 > 단축키의 창 레이아웃 두 줄(⌃⌥S·⌃⌥R)과 등록 상태 표시
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ exists: true, revision: 0, hidden: [], local: true }));
const { settingsMarkup } = await import("../web/js/devtool/settings-view.js");
globalThis.fetch = previousFetch;
const { keymapRows } = await import("../web/js/desklayout/boot.js");

test("등록 상태에 따라 줄 옆 표시와 안내가 바뀐다", () => {
  const ok = keymapRows({ ok: true, packaged: true, shortcuts: { save: true, restore: false } });
  assert.deepEqual(ok.map((r) => [r.label, r.keys, r.note, r.noteBad]), [
    ["창 레이아웃 저장", "⌃⌥S", "등록됨", false],
    ["창 레이아웃 복원", "⌃⌥R", "등록 실패", true],
  ]);
  assert.match(ok[1].lock, /다른 앱이 이 조합을 이미 쓰고/);
  assert.match(ok[0].lock, /조합은 바꿀 수 없습니다/);
  assert.equal(keymapRows({ ok: true, packaged: false, shortcuts: null })[0].note, "개발 실행에서는 등록 안 함");
  assert.equal(keymapRows(null)[0].note, "", "상태를 못 받았으면 표시하지 않는다");
});

test("단축키 화면에 잠긴 줄로 그려진다(녹음 단추 없음)", () => {
  const items = keymapRows({ ok: true, packaged: true, shortcuts: { save: true, restore: true } });
  const html = settingsMarkup({ section: "keys", items });
  assert.match(html, /Mac 전체에서/);
  assert.match(html, /창 레이아웃 저장<\/span>\s*<span class="km-state">등록됨<\/span>/);
  assert.match(html, /<span class="km-kc">⌃<\/span><span class="km-kc">⌥<\/span><span class="km-kc">S<\/span>/);
  assert.doesNotMatch(html, /data-km-rec="desklayout-/);
});

test("단축키 화면이 기능 줄 훅을 부른다", () => {
  const page = readFileSync(new URL("../web/js/devtool/keymap-page.js", import.meta.url), "utf8");
  assert.match(page, /callHook\("desklayout\.keymapRows"\)/);
});
