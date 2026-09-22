import assert from "node:assert/strict";
import test from "node:test";

import { edgesOf } from "../bin/graph.mjs";

// 간선을 못 읽으면 그 파일이 부르는 것들이 "아무도 안 부름"으로 잡힌다. 그래서 이 파서의
// 구멍은 정상 모듈을 고아로 잘못 판정한다. 확인 결과: 큰따옴표만 보던
// 규칙 아래서 web/memolab/app.js 의 간선이 0개였고 store.js·terms.js 가 고아로 잡혔다.
const KNOWN = new Set(["web/x/app.js", "web/x/store.js", "web/x/terms.js", "web/x/words.js", "web/x/preload.cjs"]);
const edges = (source) => edgesOf("web/x/app.js", KNOWN, source);

test("ESM 정적 import 를 두 따옴표 모두에서 읽는다", () => {
  assert.deepEqual(edges(`import { Store } from './store.js';`), ["web/x/store.js"]);
  assert.deepEqual(edges(`import { Store } from "./store.js";`), ["web/x/store.js"]);
});

test("한 파일의 여러 import 를 다 읽는다", () => {
  const source = [
    `import { Store } from './store.js';`,
    `import { TERMS } from './terms.js';`,
    `import { wordCfg } from "./words.js";`,
  ].join("\n");
  assert.deepEqual(edges(source), ["web/x/store.js", "web/x/terms.js", "web/x/words.js"]);
});

test("동적 import·require 계열도 두 따옴표 모두에서 읽는다", () => {
  assert.deepEqual(edges(`await import('./store.js')`), ["web/x/store.js"]);
  assert.deepEqual(edges(`await import("./store.js")`), ["web/x/store.js"]);
  assert.deepEqual(edges(`const s = require('./store.js')`), ["web/x/store.js"]);
  assert.deepEqual(edges(`const s = require("./store.js")`), ["web/x/store.js"]);
  assert.deepEqual(edges(`require.resolve('./store.js')`), ["web/x/store.js"]);
  assert.deepEqual(edges(`require.resolve("./store.js")`), ["web/x/store.js"]);
});

test("URL·path.join 으로 실리는 경로도 두 따옴표 모두에서 읽는다", () => {
  assert.deepEqual(edges(`new URL('./store.js', import.meta.url)`), ["web/x/store.js"]);
  assert.deepEqual(edges(`new URL("./store.js", import.meta.url)`), ["web/x/store.js"]);
  assert.deepEqual(edges(`path.join(__dirname, './preload.cjs')`), ["web/x/preload.cjs"]);
  assert.deepEqual(edges(`path.join(__dirname, "./preload.cjs")`), ["web/x/preload.cjs"]);
});

test("주석 안의 import 는 간선이 아니다", () => {
  // 주석 처리한 import 를 유효한 간선으로 세면 쓰이지 않는 파일이 쓰이는 것으로 보인다.
  assert.deepEqual(edges(`// import { Store } from './store.js';`), []);
  assert.deepEqual(edges(`/* import { Store } from './store.js'; */`), []);
});

test("모르는 파일을 가리키는 import 는 간선이 아니다", () => {
  assert.deepEqual(edges(`import x from './not-in-the-repo.js';`), []);
});
