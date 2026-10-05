import assert from "node:assert/strict";
import test from "node:test";
import { formatBinding, bindingOf, KEYMAP } from "../web/js/core/keymap.js";
import { matchOne, settingsMarkup } from "../web/js/devtool/settings-view.js";

test("Windows binding labels use Ctrl, Alt and Shift, including physical letter keys", () => {
  globalThis.acHost = { platform: "win32" };
  assert.equal(formatBinding(bindingOf("file-search")), "Ctrl+Shift+P");
  assert.equal(formatBinding({ mod: true, alt: true, shift: true, code: "KeyZ" }), "Ctrl+Alt+Shift+Z");
  assert.equal(formatBinding({ alt: true, key: "ArrowLeft" }), "Alt+←");
  assert.equal(formatBinding({ key: "F12" }), "F12");
  const search = { label: "파일 검색", keys: "Ctrl+Shift+P" };
  for (const q of ["ctrl shift p", "shift ctrl p", "cmd+shift+p", "ctrl shift"]) assert.equal(matchOne(search, q), true, q);
  assert.equal(matchOne(search, "ctrl p"), false);
  const html = settingsMarkup({ section: "keys", items: [{ id: "file-search", label: "파일 검색", where: "어디서나", keys: "Ctrl+Shift+P" }], screens: [], toggles: [] });
  assert.match(html, />Ctrl<\/span>/);
  assert.match(html, />Shift<\/span>/);
  assert.match(html, />P<\/span>/);
});

test("Darwin defaults stay available before a Windows preload is loaded", () => {
  assert.deepEqual(KEYMAP.find((item) => item.id === "screen-toggle").def, { alt: true, code: "Tab" });
  assert.deepEqual(KEYMAP.find((item) => item.id === "reload-tab").def, { mod: true, key: "r" });
  assert.deepEqual(KEYMAP.find((item) => item.id === "close-tab").def, { mod: true, key: "w" });
});

test("Darwin and missing bridge retain current glyph labels and search", () => {
  for (const acHost of [undefined, { platform: "darwin" }]) {
    globalThis.acHost = acHost;
    assert.equal(formatBinding(bindingOf("file-search")), "⌘⇧P");
    assert.equal(formatBinding({ mod: true, alt: true, shift: true, key: "z" }), "⌘⌥⇧Z");
    assert.equal(matchOne({ keys: "⌘⇧P" }, "ctrl shift p"), true);
  }
});
