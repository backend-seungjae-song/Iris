// 잠들지 않게 한 탭: 서버에 저장되고, 유휴 회수 판정에서 보호되고, 앱을 켤 때는 바로 불러오지 않는다
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const STATE = pathToFileURL(path.resolve("server/browser-state.js")).href;

async function withState(t, seed, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-keep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "browser-state.json"), JSON.stringify(seed));
  process.env.IRIS_STATE_DIR = dir;
  const mod = await import(`${STATE}?keep=${tag}-${path.basename(dir)}`);
  mod.load();
  return { dir, mod };
}

const SEED = { tabsBySpace: { s1: [{ id: "browser:a", url: "https://a.test" }, { id: "browser:b", url: "https://b.test" }] } };

test("켜고 끄면 탭에 저장되고, 같은 값이면 바뀐 것이 없다", async (t) => {
  const { dir, mod } = await withState(t, SEED, "toggle");
  assert.equal(mod.mutate({ op: "tab.keepAwake", space: "s1", id: "browser:a", on: true }), true);
  assert.equal(mod.get().tabsBySpace.s1[0].keepAwake, true);
  assert.equal(mod.mutate({ op: "tab.keepAwake", space: "s1", id: "browser:a", on: true }), false, "이미 켠 탭");
  assert.equal(mod.get().tabsBySpace.s1[1].keepAwake, undefined, "다른 탭은 그대로");
  mod.flushNow();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "browser-state.json"), "utf8"));
  assert.equal(saved.tabsBySpace.s1[0].keepAwake, true, "다시 켜도 남도록 파일에 저장");
  assert.equal(mod.mutate({ op: "tab.keepAwake", space: "s1", id: "browser:a", on: false }), true);
  assert.equal("keepAwake" in mod.get().tabsBySpace.s1[0], false, "끄면 필드를 지운다");
});

test("없는 탭·빈 id 는 바꾸지 않는다", async (t) => {
  const { mod } = await withState(t, SEED, "missing");
  assert.equal(mod.mutate({ op: "tab.keepAwake", space: "s1", id: "browser:none", on: true }), false);
  assert.equal(mod.mutate({ op: "tab.keepAwake", space: "s1", on: true }), false);
});

test("잠들지 않게 한 탭은 회수 판정에서만 제외되고 백그라운드 절전 판정은 보통 탭과 같다", async () => {
  const state = await import("../web/js/browser/state.js");
  const store = await import("../web/js/browser/webview-store.js");
  const webview = await import("../web/js/browser/webview.js");
  state.replaceBrowserState({ tabsBySpace: { s1: [
    { id: "browser:keep", url: "https://k.test", keepAwake: true },
    { id: "browser:plain", url: "https://p.test" },
  ] }, activeBySpace: {} });
  store.registerWebview("browser:keep", { el: { dataset: {} }, ready: true });
  store.registerWebview("browser:plain", { el: { dataset: {} }, ready: true });
  const none = new Set();
  assert.equal(webview.keptAwake("browser:keep"), true);
  assert.equal(webview.keptAwake("browser:plain"), false);
  assert.equal(webview.webviewProtected("browser:keep", none, none), false, "안 보는 동안 절전은 받는다");
  assert.equal(webview.webviewProtected("browser:plain", none, none), false);
});

test("앱을 켤 때는 잠들지 않게 한 탭도 보고 있는 탭이 아니면 바로 불러오지 않는다", async () => {
  const webview = await import("../web/js/browser/webview.js");
  assert.equal(webview.shouldMaterializeTab("browser:keep", "browser:other", true), false);
  const dock = fs.readFileSync("web/js/browser/dock.js", "utf8");
  assert.doesNotMatch(dock, /keepAwake/, "복원 판정에 잠들지 않게 값을 넣지 않는다");
});

test("표시와 메뉴 줄", async () => {
  const ka = await import("../web/js/browser/keep-awake.js");
  assert.equal(ka.keepAwakeMark(false), "");
  assert.match(ka.keepAwakeMark(true), /class="ckeep"[^>]*aria-label="잠들지 않음"/);
  assert.equal(ka.keepAwakeItem("s1", { id: "browser:a" }).label, "잠들지 않게 하기");
  assert.equal(ka.keepAwakeItem("s1", { id: "browser:a", keepAwake: true }).label, "잠들지 않게 끄기");
});
