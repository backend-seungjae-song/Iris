import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const browserStateUrl = pathToFileURL(path.resolve("server/browser-state.js")).href;

test("레거시 경로의 모든 브라우저 설정을 폴더 객체 키로 손실 없이 합친다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-state-migration-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const legacy = "/tmp/legacy-shop";
  const stable = "folder:test:shop";
  fs.writeFileSync(path.join(stateDir, "browser-state.json"), JSON.stringify({
    bookmarksBySpace: {
      [legacy]: [{ url: "https://legacy.test", title: "legacy" }],
      [stable]: [{ url: "https://stable.test", title: "stable" }],
    },
    tabsBySpace: {
      [legacy]: [{ id: "legacy-tab", url: "https://legacy.test" }],
      [stable]: [{ id: "stable-tab", url: "https://stable.test" }],
    },
    groupsBySpace: {
      [legacy]: [{ id: "legacy-group", name: "legacy" }],
      [stable]: [{ id: "stable-group", name: "stable" }],
    },
    activeBySpace: { [legacy]: "legacy-tab", [stable]: "stable-tab" },
    defaultProfileBySpace: { [legacy]: "legacy-profile", [stable]: "stable-profile" },
    urlHistoryBySpace: {
      [legacy]: ["https://legacy.test"],
      [stable]: ["https://stable.test"],
    },
    activeSpace: legacy,
  }));
  process.env.IRIS_STATE_DIR = stateDir;
  const state = await import(`${browserStateUrl}?test=${Date.now()}-${Math.random()}`);
  state.load();

  assert.equal(state.remapSpaces({ [legacy]: stable }, { preferSource: true }), true);
  const migrated = state.get();
  for (const field of ["bookmarksBySpace", "tabsBySpace", "groupsBySpace", "activeBySpace", "defaultProfileBySpace", "urlHistoryBySpace"]) {
    assert.equal(Object.hasOwn(migrated[field], legacy), false, `${field}에 레거시 경로가 남지 않아야 한다`);
  }
  assert.deepEqual(migrated.bookmarksBySpace[stable].map((x) => x.url), ["https://stable.test", "https://legacy.test"]);
  assert.deepEqual(migrated.tabsBySpace[stable].map((x) => x.id), ["stable-tab", "legacy-tab"]);
  assert.deepEqual(migrated.groupsBySpace[stable].map((x) => x.id), ["stable-group", "legacy-group"]);
  assert.equal(migrated.activeBySpace[stable], "legacy-tab");
  assert.equal(migrated.defaultProfileBySpace[stable], "legacy-profile");
  assert.deepEqual(migrated.urlHistoryBySpace[stable], ["https://legacy.test", "https://stable.test"]);
  assert.equal(migrated.activeSpace, stable);
});
