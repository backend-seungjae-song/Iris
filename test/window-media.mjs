// Electron을 띄우지 않고 창 제목과 그림의 권한·단일 실행·결합·용량 경계를 검증한다.
//
// 소유 범위
//   가짜 desktopCapturer와 nativeImage로 window-media의 항목별 결과와 getSources 호출 모양을 센다.
//
// 제공 API
//   node --test test/window-media.mjs 한 명령으로 창 media 계약을 판정한다.
//
// 유지 조건
//   권한 전에는 조회하지 않고, 제목과 그림은 같은 슬롯에서 :0·:1 창을 모두 받으며 한 항목의 실패가
//   batch를 중단시키지 않는다.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createWindowMedia, MAX_WIDTH, MAX_HEIGHT, MAX_THUMBNAIL_BYTES, MAX_RESPONSE_BYTES,
} = require("../native/electron/window-media.cjs");

function target(id, overrides = {}) {
  return { id, cgId: id, pid: id + 100, pidStart: "시작", ...overrides };
}

function image(bytes = Buffer.from([1, 2, 3]), options = {}) {
  const calls = [];
  const value = {
    calls,
    isEmpty() { return !!options.empty; },
    getSize() { return options.size || { width: 640, height: 400 }; },
    resize(size) {
      calls.push(size);
      if (options.resizeError) throw new Error("크기 변경 실패");
      return {
        isEmpty() { return !!options.resizedEmpty; },
        toPNG() {
          if (options.encodeError) throw new Error("인코딩 실패");
          return bytes;
        },
      };
    },
  };
  return value;
}

function setup({ status = "granted", getSources = async () => [] } = {}) {
  let calls = 0;
  const requests = [];
  const media = createWindowMedia({
    desktopCapturer: {
      async getSources(options) {
        calls += 1;
        requests.push(options);
        return getSources(options);
      },
    },
    systemPreferences: { getMediaAccessStatus(kind) { assert.equal(kind, "screen"); return status; } },
    nativeImage: {},
    log() {},
  });
  return { media, requests, calls: () => calls };
}

test("화면 기록 권한이 아니면 restricted를 보존하고 getSources를 부르지 않는다", async () => {
  for (const status of ["denied", "restricted", "not-determined"]) {
    const { media, calls } = setup({ status });
    const result = await media.thumbnails({ targets: [target(1)] });
    assert.equal(result.permission, status);
    assert.equal(calls(), 0);
    assert.deepEqual(result.missing, [{ id: 1, reason: "permission" }]);
  }
});

test("화면 기록 권한이 아니면 제목 조회도 getSources를 부르지 않는다", async () => {
  for (const status of ["denied", "restricted", "not-determined"]) {
    const { media, calls } = setup({ status });

    assert.deepEqual(await media.titles({ ids: [10] }), {
      ok: false, titles: {}, elapsedMs: 0, reason: "permission",
    });
    assert.equal(calls(), 0);
  }
});

test("진행 중인 캡처와 두 번째 요청을 겹쳐 부르지 않는다", async () => {
  let release;
  const { media, calls } = setup({
    getSources: () => new Promise((resolve) => { release = resolve; }),
  });
  const first = media.thumbnails({ targets: [target(1)] });
  const busy = await media.thumbnails({ targets: [target(2)] });

  assert.equal(calls(), 1);
  assert.deepEqual(busy.missing, [{ id: 2, reason: "busy" }]);
  release([]);
  await first;
});

test("제목 조회와 창 그림은 같은 단일 실행 슬롯을 쓴다", async () => {
  let release;
  const { media, calls } = setup({
    getSources: () => new Promise((resolve) => { release = resolve; }),
  });

  const titleRequest = media.titles({ ids: [1] });
  assert.deepEqual(await media.thumbnails({ targets: [target(2)] }), {
    permission: "granted", thumbs: {}, missing: [{ id: 2, reason: "busy" }], elapsedMs: 0,
  });
  release([{ id: "window:1:0", name: "첫 창" }]);
  await titleRequest;

  const thumbnailRequest = media.thumbnails({ targets: [target(2)] });
  assert.deepEqual(await media.titles({ ids: [1] }), {
    ok: false, titles: {}, elapsedMs: 0, reason: "busy",
  });
  release([{ id: "window:2:0", thumbnail: image() }]);
  await thumbnailRequest;
  assert.equal(calls(), 2);
});

test("제목 조회는 그림을 만들지 않고 :0과 :1 창을 모두 CGWindowID에 결합한다", async () => {
  const { media, requests } = setup({
    getSources: async () => [
      { id: "window:10:0", name: "영 꼬리" },
      { id: "window:20:1", name: "일 꼬리" },
      { id: "screen:30:0", name: "화면" },
    ],
  });

  const result = await media.titles({ ids: [10, 20] });

  assert.deepEqual(result.titles, { 10: "영 꼬리", 20: "일 꼬리" });
  assert.equal(result.ok, true);
  assert.equal(result.elapsedMs >= 0, true);
  assert.deepEqual(requests, [{
    types: ["window"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false,
  }]);
});

test("제목 getSources 예외는 던지지 않고 실패 사유로 돌려준다", async () => {
  const { media } = setup({ getSources: async () => { throw new Error("조회 실패"); } });

  const result = await media.titles({ ids: [10] });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "capture-failed");
  assert.deepEqual(result.titles, {});
  assert.equal(result.elapsedMs >= 0, true);
});

test("desktopCapturer의 :0과 :1 창을 모두 CGWindowID에 결합한다", async () => {
  const zero = image();
  const one = image(Buffer.from([4, 5, 6]));
  const { media, requests } = setup({
    getSources: async () => [
      { id: "window:10:0", thumbnail: zero },
      { id: "window:20:1", thumbnail: one },
      { id: "screen:30:0", thumbnail: image() },
    ],
  });

  const result = await media.thumbnails({ targets: [target(10), target(20)] });

  assert.deepEqual(Object.keys(result.thumbs).sort(), ["10", "20"]);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(requests, [{
    types: ["window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false,
  }]);
  assert.equal(result.elapsedMs >= 0, true);
});

test("가로와 세로 상한을 함께 적용해 긴 창도 320×200 안에 둔다", async () => {
  const tall = image(Buffer.from([1]), { size: { width: 1000, height: 2000 } });
  const wide = image(Buffer.from([2]), { size: { width: 2000, height: 500 } });
  const { media } = setup({ getSources: async () => [
    { id: "window:1:0", thumbnail: tall },
    { id: "window:2:0", thumbnail: wide },
  ] });

  await media.thumbnails({ targets: [target(1), target(2)] });

  assert.deepEqual(tall.calls, [{ width: 100, height: MAX_HEIGHT, quality: "good" }]);
  assert.deepEqual(wide.calls, [{ width: MAX_WIDTH, height: 80, quality: "good" }]);
});

test("한 그림 용량 초과는 그 항목만 빼고 작은 그림은 살린다", async () => {
  const { media } = setup({ getSources: async () => [
    { id: "window:1:0", thumbnail: image(Buffer.alloc(MAX_THUMBNAIL_BYTES, 1)) },
    { id: "window:2:0", thumbnail: image(Buffer.from([1, 2, 3])) },
  ] });

  const result = await media.thumbnails({ targets: [target(1), target(2)] });

  assert.equal("1" in result.thumbs, false);
  assert.equal("2" in result.thumbs, true);
  assert.deepEqual(result.missing, [{ id: 1, reason: "too-large" }]);
});

test("전체 응답 예산을 넘은 뒤 항목만 빼고 앞선 그림은 남긴다", async () => {
  const bytes = Buffer.alloc(180 << 10, 1);
  const count = Math.ceil(MAX_RESPONSE_BYTES / Math.ceil(bytes.length * 4 / 3)) + 2;
  const targets = Array.from({ length: count }, (_, index) => target(index + 1));
  const sources = targets.map((item) => ({ id: `window:${item.cgId}:0`, thumbnail: image(bytes) }));
  const { media } = setup({ getSources: async () => sources });

  const result = await media.thumbnails({ targets });

  assert.equal(Object.keys(result.thumbs).length > 0, true);
  assert.equal(Object.keys(result.thumbs).length < targets.length, true);
  assert.equal(result.missing.every((item) => item.reason === "too-large"), true);
});

test("빈 썸네일은 인코딩 전에 empty-thumbnail로 뺀다", async () => {
  const empty = image(Buffer.from([1]), { empty: true, encodeError: true });
  const { media } = setup({ getSources: async () => [{ id: "window:1:0", thumbnail: empty }] });

  const result = await media.thumbnails({ targets: [target(1)] });

  assert.deepEqual(result.missing, [{ id: 1, reason: "empty-thumbnail" }]);
  assert.deepEqual(empty.calls, []);
});

test("getSources·resize·인코딩 예외를 항목별 capture-failed로 접고 batch를 살린다", async () => {
  const resizeFailure = image(Buffer.from([1]), { resizeError: true });
  const encodeFailure = image(Buffer.from([2]), { encodeError: true });
  const good = image(Buffer.from([3]));
  const { media } = setup({ getSources: async () => [
    { id: "window:1:0", thumbnail: resizeFailure },
    { id: "window:2:0", thumbnail: encodeFailure },
    { id: "window:3:0", thumbnail: good },
  ] });

  const result = await media.thumbnails({ targets: [target(1), target(2), target(3)] });
  assert.equal("3" in result.thumbs, true);
  assert.deepEqual(result.missing, [
    { id: 1, reason: "capture-failed" },
    { id: 2, reason: "capture-failed" },
  ]);

  const failed = setup({ getSources: async () => { throw new Error("캡처 실패"); } }).media;
  assert.deepEqual((await failed.thumbnails({ targets: [target(4), target(5)] })).missing, [
    { id: 4, reason: "capture-failed" },
    { id: 5, reason: "capture-failed" },
  ]);
});
