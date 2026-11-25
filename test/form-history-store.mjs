import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFormHistoryStore } = require("../native/electron/form-history-store.cjs");
const { createPartitionStores } = require("../native/electron/partition-data-store.cjs");
const FILE = "form-history.enc";
const BASE = "persist:acbrowser";
const OTHER = "persist:acprof:other";
const DAY = 86_400_000;

function fixture(t) {
  const stateDir = fs.mkdtempSync(path.join(tmpdir(), "iris-form-history-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let time = 400 * DAY;
  let readable = true;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (data) => Buffer.from(Buffer.from(data).toString("base64")),
    decryptString: (data) => {
      if (!readable) throw new Error("복호화 불가");
      return Buffer.from(data.toString(), "base64").toString();
    },
  };
  const registry = () => createPartitionStores({ stateDir, fs, safeStorage, files: [FILE], platform: "darwin" });
  const stores = registry();
  const reopen = () => createFormHistoryStore(registry().open(FILE), () => time);
  return {
    store: createFormHistoryStore(stores.open(FILE), () => time), purge: stores.purge, reopen, advance: (ms) => { time += ms; },
    lock: () => { readable = false; }, unlock: () => { readable = true; },
    file: path.join(stateDir, "form-history.enc"), stateDir,
  };
}

test("프로필별로 합산하고 접두어 일치 항목을 횟수와 최근 사용순으로 정렬한다", (t) => {
  const { store, advance, reopen, file } = fixture(t);
  const add = (value) => store.add(BASE, [{ key: " City ", value }]);
  assert.deepEqual(store.query(BASE, "city", ""), []);
  add("Seoul");
  advance(1);
  add("Sejong");
  add("Busan");
  advance(1);
  add("Seoul");
  advance(1);
  add("Seattle");
  store.add(OTHER, [{ key: "city", value: "Seward" }]);

  assert.deepEqual(reopen().query(BASE, "CITY", "se"), ["Seoul", "Seattle", "Sejong"]);
  assert.deepEqual(store.query(OTHER, "city", ""), ["Seward"]);
  assert.equal(fs.readFileSync(file).includes("Seoul"), false);
});

test("키당 50개, 조회당 8개, 값 길이와 365일 만료 조건을 지킨다", (t) => {
  const { store, advance, reopen } = fixture(t);
  for (let i = 0; i < 51; i++) {
    store.add(BASE, [{ key: "item", value: `value-${i}` }]);
    advance(1);
  }
  store.add(BASE, [
    { key: "item", value: "" },
    { key: "item", value: " ".repeat(5) },
    { key: "item", value: "x".repeat(201) },
    { key: "item", value: "y".repeat(200) },
  ]);
  assert.deepEqual(store.query(BASE, "item", ""), ["y".repeat(200), ...Array.from({ length: 7 }, (_, i) => `value-${50 - i}`)]);
  assert.deepEqual(store.query(BASE, "item", "value-0"), []);
  assert.deepEqual(store.query(BASE, "item", "value-1"), Array.from({ length: 8 }, (_, i) => `value-${19 - i}`));
  assert.deepEqual(store.query(BASE, "item", "value-2").includes("value-2"), false);
  assert.deepEqual(store.query(BASE, "item", "x"), []);

  advance(365 * DAY);
  const expired = reopen();
  assert.deepEqual(expired.query(BASE, "item", ""), ["y".repeat(200)]);
  advance(1);
  assert.deepEqual(expired.query(BASE, "item", ""), []);
  advance(-365 * DAY);
  assert.deepEqual(reopen().query(BASE, "item", ""), []);
});

test("선택 값이나 프로필을 지워도 다른 기록은 보존한다", async (t) => {
  const { store, purge, reopen } = fixture(t);
  store.add(BASE, [{ key: "__proto__", value: "first" }, { key: "__proto__", value: "second" }]);
  store.add(OTHER, [{ key: "__proto__", value: "other" }]);
  assert.equal(store.remove(BASE, "__proto__", "first"), true);
  assert.deepEqual(reopen().query(BASE, "__proto__", ""), ["second"]);
  await purge(OTHER);
  assert.deepEqual(reopen().query(OTHER, "__proto__", ""), []);
  assert.deepEqual(store.query(BASE, "__proto__", ""), ["second"]);
});

test("추가 요청에서 처음 50개 항목만 받는다", (t) => {
  const { store, reopen } = fixture(t);
  const entries = Array.from({ length: 51 }, (_, i) => ({ key: `field-${i + 1}`, value: "sample" }));
  assert.equal(store.add(BASE, entries), true);
  const instance = reopen();
  assert.deepEqual(instance.query(BASE, "field-50", ""), ["sample"]);
  assert.deepEqual(instance.query(BASE, "field-51", ""), []);
});

test("100자까지의 키를 저장한다", (t) => {
  const { store, reopen } = fixture(t);
  const limit = "a".repeat(100);
  const tooLong = "b".repeat(101);
  assert.equal(store.add(BASE, [{ key: limit, value: "sample" }]), true);
  assert.equal(store.add(BASE, [{ key: tooLong, value: "sample" }]), false);
  assert.deepEqual(reopen().query(BASE, limit, ""), ["sample"]);
  assert.deepEqual(reopen().query(BASE, tooLong, ""), []);
});

test("프로필당 키가 500개를 넘으면 가장 오래 사용하지 않은 키를 버린다", (t) => {
  const { store, advance, reopen } = fixture(t);
  const add = (partition, key) => store.add(partition, [{ key, value: "sample" }]);
  add(BASE, "reused");
  advance(1);
  add(BASE, "oldest");
  advance(1);
  for (let batch = 0; batch < 9; batch++) {
    store.add(BASE, Array.from({ length: 50 }, (_, i) => ({ key: `field-${batch * 50 + i}`, value: "sample" })));
  }
  store.add(BASE, Array.from({ length: 48 }, (_, i) => ({ key: `field-${450 + i}`, value: "sample" })));
  add(OTHER, "oldest");
  advance(1);
  add(BASE, "reused");
  assert.deepEqual(store.query(BASE, "oldest", ""), ["sample"]);
  advance(1);
  add(BASE, "latest");

  const instance = reopen();
  assert.deepEqual(instance.query(BASE, "oldest", ""), []);
  assert.deepEqual(instance.query(BASE, "reused", ""), ["sample"]);
  assert.deepEqual(instance.query(BASE, "latest", ""), ["sample"]);
  assert.deepEqual(instance.query(OTHER, "oldest", ""), ["sample"]);
});

test("읽기 실패 중에는 파일을 옮기거나 쓰지 않고 읽기가 회복되면 이어서 저장한다", (t) => {
  const { store, reopen, advance, lock, unlock, file, stateDir } = fixture(t);
  store.add(BASE, [{ key: "city", value: "Seoul" }]);
  const original = fs.readFileSync(file);
  const instance = reopen();
  lock();
  assert.deepEqual(instance.query(BASE, "city", ""), []);
  assert.equal(instance.add(BASE, [{ key: "city", value: "Busan" }]), false);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(stateDir), [FILE]);
  unlock();
  assert.deepEqual(instance.query(BASE, "city", ""), ["Seoul"]);
  advance(1);
  assert.equal(instance.add(BASE, [{ key: "city", value: "Busan" }]), true);
  assert.deepEqual(reopen().query(BASE, "city", ""), ["Busan", "Seoul"]);
});
