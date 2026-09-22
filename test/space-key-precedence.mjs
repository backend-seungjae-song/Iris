import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("server/space-key.js")).href;

// 서버와 같은 순서로 쓴다. import는 아무것도 읽지 않고, load()를 불러야 읽는다.
// (자물쇠를 얻기 전에 상태를 읽지 않기 위해 그렇게 만들었다. server/space-key.js의 load() 주석 참조.)
async function fresh(stateDir, tag) {
  process.env.IRIS_STATE_DIR = stateDir;
  const mod = await import(`${moduleUrl}?test=${tag}-${Date.now()}-${Math.random()}`);
  mod.load();
  return mod;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 260));
}

test("생성 폴더에서 다른 폴더 객체로 이동하면 identity가 바인딩을 바꾼다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-requested-"));
  const createdAt = fs.mkdtempSync(path.join(os.tmpdir(), "iris-created-at-"));
  const movedTo = fs.mkdtempSync(path.join(os.tmpdir(), "iris-moved-to-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(createdAt, { recursive: true, force: true }));
  t.after(() => fs.rmSync(movedTo, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "requested");

  const createdPath = fs.realpathSync(createdAt);
  keys.learnFolder("w-new", createdAt, keys.REQUESTED);
  const before = keys.keyOf("w-new");
  const learned = keys.learnFolder("w-new", movedTo, keys.CONFIRMED);

  assert.equal(keys.folderOf("w-new"), fs.realpathSync(movedTo));
  assert.equal(keys.srcOf("w-new"), keys.CONFIRMED);
  assert.notEqual(keys.keyOf("w-new"), before);
  assert.equal(learned.previousKey, before);
  assert.deepEqual(keys.remapsFor(["w-new"])[before], undefined,
    "다른 폴더로 간 것은 상태 이관이 아니라 그 폴더의 상태를 읽는 바인딩 변경이다");
  assert.equal(keys.remapsFor(["w-new"])[createdPath], before,
    "이전 폴더의 경로 저장분은 이전 객체 키에 남는다");
  await settle();
  const reloaded = await fresh(stateDir, "requested-history");
  assert.equal(reloaded.remapsFor(["w-new"])[createdPath], before,
    "이전 폴더 객체 기록은 서버 재시작 뒤에도 유지된다");
});

test("폴더 객체 키는 같은 객체의 경로가 바뀌어도 유지된다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-reload-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "iris-folder-move-"));
  const beforePath = path.join(parent, "before");
  const afterPath = path.join(parent, "after");
  fs.mkdirSync(beforePath);
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "same-object");

  const legacyPath = fs.realpathSync(beforePath);
  const before = keys.keyForDir(beforePath);
  keys.learnFolder("w-new", beforePath, keys.CONFIRMED);
  fs.renameSync(beforePath, afterPath);
  const learned = keys.learnFolder("w-new", afterPath, keys.CONFIRMED);

  assert.equal(keys.keyForDir(afterPath), before);
  assert.equal(keys.keyOf("w-new"), before);
  assert.equal(keys.folderOf("w-new"), fs.realpathSync(afterPath));
  assert.equal(learned.previousKey, null);
  assert.equal(keys.remapsFor(["w-new"])[legacyPath], before,
    "연결이 끊겼던 렌더러의 옛 경로 저장분도 같은 객체 키로 이관한다");
});

test("폴더 객체 키와 위치는 저장 후 다시 읽어도 유지된다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-identity-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-folder-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await fresh(stateDir, "identity-write");

  first.learnFolder("w-new", dir, first.CONFIRMED);
  const key = first.keyOf("w-new");
  await settle();

  const second = await fresh(stateDir, "identity-read");
  assert.equal(second.keyOf("w-new"), key);
  assert.equal(second.folderOf("w-new"), fs.realpathSync(dir));
  assert.equal(second.isFolderKey(key), true);
  assert.equal(second.isFolderKey(dir), false, "절대경로는 더 이상 영속 폴더 키가 아니다");
});

test("레거시 경로 레코드는 같은 폴더 객체 키로 승격된다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-legacy-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-legacy-folder-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(stateDir, "space-keys.json"), JSON.stringify({
    "w-old": { dir, src: "identity", aliases: [] },
  }));

  const keys = await fresh(stateDir, "legacy");
  const key = keys.keyOf("w-old");

  assert.equal(keys.isFolderKey(key), true);
  assert.notEqual(key, fs.realpathSync(dir));
  assert.equal(keys.remapsFor([])[fs.realpathSync(dir)], key);
  assert.equal(keys.remapsFor([])["w-old"], key);
  await settle();
  assert.equal(fs.readdirSync(stateDir).some((name) => name.startsWith("space-keys.json.bak-")), true,
    "레거시 표를 처음 고치기 전에 원본 백업을 남긴다");
});

test("같은 폴더 객체를 가리키는 두 workspace에 상태를 모두 투영한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-project-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-project-folder-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "project");

  keys.learnFolder("w-one", dir, keys.CONFIRMED);
  keys.learnFolder("w-two", dir, keys.CONFIRMED);
  const key = keys.keyOf("w-one");
  const value = [{ url: "https://example.test" }];
  const projected = keys.projectByWorkspace({ [key]: value }, ["w-one", "w-two"]);

  assert.deepEqual(projected, { "w-one": value, "w-two": value });
});

test("재부팅 전후 키가 섞인 동일 폴더 workspace는 한 저장 키와 한 이관 방향으로 수렴한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-split-identity-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-split-identity-folder-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stat = fs.statSync(dir, { bigint: true });
  const born = stat.birthtimeNs > 0n ? stat.birthtimeNs : 0n;
  const tail = `${stat.ino.toString(36)}:${born.toString(36)}`;
  const olderKey = `folder:previous-device:${tail}`;
  const newerKey = `folder:${stat.dev.toString(36)}:${tail}`;
  fs.writeFileSync(path.join(stateDir, "space-keys.json"), JSON.stringify({
    "w-live": { dir, key: olderKey, src: "identity", aliases: [], history: [] },
    "w-stale": { dir, key: newerKey, src: "identity", aliases: [], history: [
      { dir, key: olderKey, aliases: [] },
    ] },
  }));

  const keys = await fresh(stateDir, "split-identity");
  const canonical = keys.keyOf("w-live");
  const remaps = keys.driftedKeyRemaps();

  assert.equal(canonical, `folder:v2:${tail}`,
    "canonical 키는 레코드 로드 순서나 재부팅 전후 dev 값이 아니라 identity에서 순수 계산한다");

  assert.equal(keys.keyOf("w-stale"), canonical,
    "같은 폴더 객체를 가리키는 runtime workspace가 서로 다른 키로 다시 쓰면 안 된다");
  assert.equal(keys.keyOf(olderKey), canonical,
    "복원된 메모 창이 재부팅 전 folder key를 보내도 canonical 키로 저장해야 한다");
  assert.equal(keys.keyOf(newerKey), canonical,
    "복원된 메모 창이 재부팅 후 v1 folder key를 보내도 canonical 키로 저장해야 한다");
  assert.deepEqual(keys.allKeys(), { "w-live": canonical, "w-stale": canonical });
  assert.equal(remaps[canonical], undefined, "canonical 키를 다른 키로 계속 이관하면 안 된다");
  assert.equal(remaps[olderKey], canonical);
  assert.equal(remaps[newerKey], canonical,
    "모든 v1 키에 남은 상태만 결정론적 v2 키로 한 번 이관한다");
});

test("같은 저장 정체성을 쓰는 workspace는 MCP의 프로젝트 경계에서 같게 판정한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-access-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-project-access-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "iris-project-other-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "access");

  keys.learnFolder("w-one", dir, keys.CONFIRMED);
  keys.learnFolder("w-two", dir, keys.CONFIRMED);
  keys.learnFolder("w-other", other, keys.CONFIRMED);

  assert.equal(keys.sameStorageSpace("w-one", "w-two"), true);
  assert.equal(keys.sameStorageSpace("w-one", "w-other"), false);
});

test("같은 저장 정체성의 workspace가 여럿이어도 사람이 고른 runtime workspace를 유지한다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-key-active-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-project-active-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "active");

  keys.learnFolder("w-one", dir, keys.CONFIRMED);
  keys.learnFolder("w-two", dir, keys.CONFIRMED);
  const key = keys.keyOf("w-one");

  assert.equal(keys.idOfKey(key, ["w-one", "w-two"], "w-two"), "w-two");
  assert.equal(keys.idOfKey(key, ["w-one", "w-two"], "w-gone"), "w-one");
});

test("레거시 복구는 직접 경로만 확정하고 같은 이름 후보는 추측하지 않는다", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-space-recovery-"));
  const left = fs.mkdtempSync(path.join(os.tmpdir(), "iris-recovery-left-"));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), "iris-recovery-right-"));
  const leftGift = path.join(left, "shop");
  const rightGift = path.join(right, "shop");
  fs.mkdirSync(leftGift);
  fs.mkdirSync(rightGift);
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(left, { recursive: true, force: true }));
  t.after(() => fs.rmSync(right, { recursive: true, force: true }));
  const keys = await fresh(stateDir, "recovery");

  const result = keys.planRecovery({
    legacySpaces: [leftGift, "w-direct", "w-ambiguous"],
    slugsBySpace: { "w-ambiguous": ["shop"] },
    dirsBySpace: {},
    candidateDirs: [leftGift, rightGift],
    direct: { "w-direct": leftGift },
  });

  assert.equal(result.map[leftGift], keys.keyForDir(leftGift));
  assert.equal(result.map["w-direct"], keys.keyForDir(leftGift));
  assert.equal(Object.hasOwn(result.map, "w-ambiguous"), false);
  assert.match(result.unresolved.find((x) => x.space === "w-ambiguous")?.reason || "", /후보 2곳/);
});
