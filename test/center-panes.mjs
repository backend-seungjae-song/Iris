import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { addTab, getActiveTabId, getTabs, isTabVisible, removeTab, replaceTabs, setActiveTab } from "../web/js/center/tab-store.js";
import { paneActives, paneCanSplit, paneFocus, paneHas, paneIndex, paneLayout, paneMove, paneRatio, paneRemove, paneRename, paneRestore, paneSelect, paneSnapshot, paneSplit, paneSync, paneTabs } from "../web/js/center/pane-store.js";
let seq = 0;
const setup = () => {
  const space = `panes-${++seq}`;
  const tabs = [{ id: "f", kind: "file" }, { id: "g", kind: "diff" }, { id: "b", kind: "browser" }, { id: "c", kind: "browser" }];
  replaceTabs(space, tabs); setActiveTab(space, "f"); return { space, tabs };
};
const ids = (space, tabs, index) => paneTabs(space, tabs, index).map((t) => t.id);
test("지목한 탭만 분할하고 양쪽 활성 탭은 유지하며 명령 대상은 포커스 칸", () => {
  const { space, tabs } = setup();
  assert.equal(paneSplit(space, tabs, "b"), true);
  assert.deepEqual(paneActives(space), ["f", "b"]);
  assert.equal(getActiveTabId(space), "b");
  assert.equal(isTabVisible(space, "f"), true);
  assert.equal(isTabVisible(space, "b"), true);
  assert.equal(isTabVisible(space, "c"), false);
  paneFocus(space, 0);
  assert.equal(getActiveTabId(space), "f");
  assert.equal(isTabVisible(space, "b"), true);
  setActiveTab(space, "c"); assert.equal(getActiveTabId(space), "c");
  assert.deepEqual(ids(space, tabs, 0), ["f", "g", "c"]);
  assert.deepEqual(ids(space, tabs, 1), ["b"]);
});
test("새 탭 종류가 한 칸에만 있으면 그 칸, 두 칸 모두 있으면 포커스 칸", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "b");
  addTab(space, { id: "h", kind: "file" }); addTab(space, { id: "d", kind: "browser" });
  assert.equal(paneIndex(space, "h"), 0); assert.equal(paneIndex(space, "d"), 1);
  paneFocus(space, 0); addTab(space, { id: "e", kind: "browser" }); assert.equal(paneIndex(space, "e"), 0);
  setActiveTab(space, "b"); assert.equal(paneLayout(space).focus, 1);
  assert.equal(paneActives(space)[0], "f");
});
test("두 칸 모두 새 탭 종류가 없으면 포커스 칸", () => {
  const space = `affinity-${++seq}`, tabs = [{ id: "f", kind: "file" }, { id: "g", kind: "file" }];
  replaceTabs(space, tabs); paneSplit(space, tabs, "g"); paneFocus(space, 0);
  addTab(space, { id: "b", kind: "browser" }); assert.equal(paneIndex(space, "b"), 0);
});
test("비포커스 활성 탭 제거와 빈 칸 접기", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "b");
  removeTab(space, tabs.find(t => t.id === "f"));
  assert.deepEqual(paneActives(space), ["c", "b"]);
  removeTab(space, tabs.find(t => t.id === "g"));
  assert.ok(paneLayout(space));
  removeTab(space, tabs.find(t => t.id === "c"));
  assert.equal(paneLayout(space), null); assert.equal(getActiveTabId(space), "b");
  assert.deepEqual(getTabs(space).map(t => t.id), ["b"]);
});
test("같은 종류도 분할 가능, 오른쪽 탭은 세 번째 칸으로 분할 금지", () => {
  const { space, tabs } = setup();
  assert.equal(paneSplit(space, tabs.filter(t => t.kind === "browser"), "b"), true);
  assert.equal(paneSplit(space, tabs, "b"), false);
  assert.equal(paneSplit(space, tabs, "c"), false);
  assert.equal(paneMove(space, tabs, "b", -1), false);
});
test("텍스트 파일 하나도 같은 탭 객체로 두 칸에 열고 반복 분할은 활성화만", () => {
  const space = `shared-${++seq}`, tab = { id: "f", kind: "file", draft: "unsaved" }, tabs = [tab];
  replaceTabs(space, tabs); setActiveTab(space, "f");
  assert.equal(paneCanSplit(space, tabs, "f"), false);
  assert.equal(paneSplit(space, tabs, "f", true), true);
  assert.strictEqual(paneTabs(space, tabs, 0)[0], tab); assert.strictEqual(paneTabs(space, tabs, 1)[0], tab);
  assert.deepEqual(paneActives(space), ["f", "f"]);
  assert.equal(paneIndex(space, "f"), 1);
  paneFocus(space, 0); assert.equal(paneIndex(space, "f"), 0);
  setActiveTab(space, "f", 1); assert.equal(paneIndex(space, "f"), 1);
  paneSelect(space, "f", 0); assert.equal(paneSplit(space, tabs, "f", true, 0), true);
  assert.equal(paneLayout(space).focus, 1); assert.deepEqual(ids(space, tabs, 1), ["f"]);
  assert.equal(paneCanSplit(space, tabs, "f", true, 1), false);
});
test("스페이스별 비율과 공유 탭 이름 변경은 목록 순서·양쪽 활성 상태 보존", () => {
  const a = setup(), b = setup(); paneSplit(a.space, a.tabs, "f", true); paneSplit(b.space, b.tabs, "g");
  paneRatio(a.space, 0.7); assert.equal(paneLayout(b.space).ratio, 0.5);
  paneRatio(a.space, 99); assert.equal(paneLayout(a.space).ratio, 0.8);
  paneRatio(a.space, NaN); assert.equal(paneLayout(a.space).ratio, 0.5);
  paneRename(a.space, "f", "renamed"); a.tabs[0].id = "renamed"; paneSync(a.space, a.tabs);
  assert.equal(isTabVisible(a.space, "renamed"), true);
  assert.deepEqual(ids(a.space, a.tabs, 0), ["renamed", "g", "b", "c"]);
  assert.deepEqual(paneActives(a.space), ["renamed", "renamed"]);
});
test("legacy 브라우저 지연 복원 전 대기 배정과 저장값 보존", () => {
  const space = `restore-${++seq}`;
  const saved = { ratio: 0.63, focus: 0, right: ["b"], leftActive: "f", rightActive: "b" };
  paneRestore(space, saved); addTab(space, { id: "f", kind: "file" });
  assert.equal(paneLayout(space), null); assert.deepEqual(paneSnapshot(space), saved);
  addTab(space, { id: "b", kind: "browser" });
  assert.deepEqual(paneActives(space), ["f", "b"]);
  assert.equal(getActiveTabId(space), "f"); assert.equal(paneLayout(space).ratio, 0.63);
  paneSync(space, getTabs(space));
  assert.deepEqual(paneSnapshot(space), { ratio: 0.63, focus: 0, panes: [{ ids: ["f"], active: "f" }, { ids: ["b"], active: "b" }] });
});
test("저장된 오른쪽 활성 탭이 늦게 추가되어도 선택을 잃지 않음", () => {
  const space = `late-${++seq}`;
  const saved = { ratio: 0.6, focus: 1, right: ["b", "c"], leftActive: "f", rightActive: "c" };
  paneRestore(space, saved); addTab(space, { id: "f", kind: "file" }); addTab(space, { id: "b", kind: "browser" });
  assert.equal(paneLayout(space), null); assert.deepEqual(paneSnapshot(space), saved);
  addTab(space, { id: "c", kind: "browser" });
  assert.equal(getActiveTabId(space), "c"); assert.equal(paneLayout(space).ratio, 0.6);
});
test("최초 브라우저 반영 완료 때 삭제된 복원 탭은 남은 탭으로 대체", () => {
  const space = `missing-${++seq}`;
  paneRestore(space, { right: ["b", "c"], rightActive: "c", leftActive: "f", ratio: 0.7 });
  addTab(space, { id: "f", kind: "file" }); addTab(space, { id: "b", kind: "browser" });
  paneSync(space, getTabs(space), true);
  assert.deepEqual(paneActives(space), ["f", "b"]);
});
test("새 저장 형식의 명시 순서·공유 파일·늦은 브라우저·비율을 복원", () => {
  const space = `new-restore-${++seq}`;
  const saved = { ratio: 0.66, focus: 1, panes: [{ ids: ["g", "f"], active: "f" }, { ids: ["f", "b"], active: "b" }] };
  paneRestore(space, saved); addTab(space, { id: "f", kind: "file" }); addTab(space, { id: "g", kind: "diff" });
  assert.equal(paneLayout(space), null); assert.deepEqual(paneSnapshot(space), saved);
  addTab(space, { id: "b", kind: "browser" });
  assert.deepEqual(paneSnapshot(space), saved);
  assert.deepEqual(ids(space, getTabs(space), 0), ["g", "f"]);
  paneFocus(space, 0); addTab(space, { id: "h", kind: "file" }); assert.equal(paneIndex(space, "h"), 0);
});
test("새 복원에서 없는 탭 정리와 대기 중 이름 변경", () => {
  const space = `new-missing-${++seq}`;
  paneRestore(space, { focus: 1, ratio: 0.7, panes: [{ ids: ["g", "old"], active: "old" }, { ids: ["b", "gone"], active: "gone" }] });
  paneRename(space, "old", "f");
  addTab(space, { id: "f", kind: "file" }); addTab(space, { id: "b", kind: "browser" });
  paneSync(space, getTabs(space), true);
  assert.deepEqual(paneActives(space), ["f", "b"]); assert.equal(paneLayout(space).ratio, 0.7);
});
test("저장된 단일 뷰어 중복 소속은 포커스 칸에만 복원", () => {
  const space = `restore-exclusive-${++seq}`, tabs = [{ id: "f", kind: "file" }, { id: "b", kind: "browser" }];
  paneRestore(space, { focus: 1, panes: [{ ids: ["f", "b"], active: "b" }, { ids: ["b"], active: "b" }] });
  replaceTabs(space, tabs);
  assert.deepEqual(ids(space, tabs, 0), ["f"]); assert.deepEqual(ids(space, tabs, 1), ["b"]);
});
test("공유 raw CSV가 표 모드로 바뀌면 포커스 칸 소속만 유지", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "f", true);
  tabs[0].sheetMode = true;
  paneSync(space, tabs, false, (tab) => tab.kind === "file" && !tab.sheetMode);
  assert.deepEqual(ids(space, tabs, 0), ["g", "b", "c"]); assert.deepEqual(ids(space, tabs, 1), ["f"]);
  assert.notEqual(paneActives(space)[0], "f"); assert.equal(paneLayout(space).focus, 1);
});
test("끌기는 종류를 섞고 대상 끝에 추가하며 sync가 명시 소속·순서 보존", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "b");
  assert.equal(paneMove(space, tabs, "c", 1, 0), true);
  assert.equal(paneMove(space, tabs, "g", 1, 0), true);
  paneSync(space, tabs);
  assert.deepEqual(ids(space, tabs, 0), ["f"]); assert.deepEqual(ids(space, tabs, 1), ["b", "c", "g"]);
  assert.equal(getActiveTabId(space), "g"); assert.equal(paneMove(space, tabs, "g", 1, 1), false);
});
test("공유 파일 끌기는 원래 칸에서만 제거하고 대상에 중복 추가하지 않음", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "f", true);
  assert.equal(paneMove(space, tabs, "f", 1, 0), true);
  assert.deepEqual(ids(space, tabs, 0), ["g", "b", "c"]); assert.deepEqual(ids(space, tabs, 1), ["f"]);
  paneSync(space, tabs); assert.deepEqual(ids(space, tabs, 0), ["g", "b", "c"]);
});
test("단일 탭 drag는 분할하지 않고 마지막 소속 이동은 빈 칸 접기", () => {
  const space = `drag-one-${++seq}`, tabs = [{ id: "f", kind: "file" }]; replaceTabs(space, tabs);
  assert.equal(paneMove(space, tabs, "f", 1), false);
  paneSplit(space, tabs, "f", true);
  assert.equal(paneMove(space, tabs, "f", 1, 0), true);
  assert.equal(paneLayout(space), null); assert.equal(getActiveTabId(space), "f"); assert.equal(paneHas(space, "f"), true);
});
test("공유 파일 닫기는 칸 소속만 제거하고 마지막 닫기에서 전체 membership 종료", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "f", true);
  assert.equal(paneRemove(space, "f", 0), true); assert.equal(paneHas(space, "f"), true);
  assert.strictEqual(paneTabs(space, tabs, 1)[0], tabs[0]);
  assert.equal(paneRemove(space, "f", 0), false);
  assert.equal(paneRemove(space, "f", 1), true); assert.equal(paneHas(space, "f"), false);
  assert.equal(paneLayout(space), null);
  removeTab(space, tabs[0]); assert.equal(paneHas(space, "f"), false);
});
test("같은 탭 객체를 목록에 다시 넣는 소비자도 포커스 배정 유지", () => {
  const { space, tabs } = setup(); paneSplit(space, tabs, "b");
  getTabs(space).push({ id: "returned", kind: "file" });
  setActiveTab(space, "returned");
  assert.equal(getActiveTabId(space), "returned"); assert.equal(paneLayout(space).focus, 0);
});
test("현재 탭 이동 분할하면 남는 칸은 마지막으로 보던 탭", () => {
  const { space, tabs } = setup();
  setActiveTab(space, "c"); setActiveTab(space, "f");
  assert.equal(paneSplit(space, tabs, "f"), true);
  assert.deepEqual(paneActives(space), ["c", "f"]);
});
test("메뉴는 텍스트만 복제하고 단일 뷰어·오른쪽 칸 분할은 제한", () => {
  const source = readFileSync(new URL("../web/js/centersplit/boot.js", import.meta.url), "utf8").replace(/^import .*;$/gm, "").replace("export function initCapability", "function initCapability");
  const { space } = setup(), hooks = new Map();
  const context = vm.createContext({
    provide: (name, fn) => hooks.set(name, fn), callHook: (name, tab) => name === "viewer.presentsTab" && !!tab.sheetMode,
    paneCanSplit, paneIndex, paneLayout, paneMove, paneRatio, paneSplit, getTabs, getCenterSpace: () => space,
    renderTabs() {}, showActiveTab() {}, persistFileTabs() {}, syncPaneView() {},
  });
  vm.runInContext(source + "\ninitCapability();", context);
  const menu = hooks.get("split.tabItems"), text = { id: "text", kind: "file" };
  replaceTabs(space, [text]);
  assert.equal(menu(text, space)[0].disabled, false); menu(text, space)[0].act();
  assert.deepEqual(ids(space, getTabs(space), 0), ["text"]); assert.deepEqual(ids(space, getTabs(space), 1), ["text"]);
  assert.equal(menu(text, space, 1)[0].disabled, true);
  const sheetSpace = `sheet-${++seq}`, sheet = { id: "sheet", kind: "file", sheetMode: true }; replaceTabs(sheetSpace, [sheet]);
  assert.equal(menu(sheet, sheetSpace)[0].disabled, true);
  const browserSpace = `browser-${++seq}`, browser = { id: "browser", kind: "browser" }; replaceTabs(browserSpace, [browser]);
  assert.equal(menu(browser, browserSpace)[0].disabled, true);
});
