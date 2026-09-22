// 안 보이는 게스트에 물려주는 대체 viewport 가 누구에게 걸리는가.
//
// 이 보정은 그릴 표면이 없어 폭 0 이 된 배경 탭을 구제한다. 그런데 적용 지점이 방금 붙은
// 게스트 전부라서 브라우저 탭이 아닌 webview 에도 걸린다. 장부는 탭만 알기 때문에 그런
// webview 는 늘 "안 보이는 탭" 으로 읽히고, 탭이 아니라서 다시 보이는 시점도 오지 않아
// 한 번 고정된 크기를 풀 수 없다.
//
// 확인 결과: rail 「서버」 화면의 대시보드 webview 가 브라우저 탭 크기 843×857 로
// 고정됐다. 실제 표시 폭은 699 여서 왼쪽이 비고 오른쪽이 잘려 보였다.
//
// 그래서 그 지점에서는 실제 크기를 먼저 본다. 아래 넷이 그 판정을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const { createHiddenViewport } = require_("../native/electron/cdp-hidden-viewport.cjs");

// send 를 가로채 무엇이 나갔는지 모은다. 크기 질문에는 시킨 값을 돌려준다.
function rig({ size = [0, 0], sizeFails = false } = {}) {
  const sent = [];
  const send = (method, params) => {
    sent.push({ method, params });
    if (method === "Runtime.evaluate") {
      return sizeFails
        ? Promise.reject(new Error("세션 끊김"))
        : Promise.resolve({ result: { value: size } });
    }
    return Promise.resolve({});
  };
  const viewport = createHiddenViewport({
    isTabShown: () => false,
    shownStateKnown: () => true,
    hasExplicitDevice: () => false,
    navigationEpoch: () => 1,
    now: () => Date.now(),
    isDisabled: () => false,
  });
  viewport.setDefaultViewport(843, 857);   // 사람이 보던 브라우저 탭 크기
  const metrics = () => sent.filter((s) => s.method === "Emulation.setDeviceMetricsOverride");
  return { viewport, send, sent, metrics };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("옵션 없이 부르면 예전처럼 곧바로 건다", async () => {
  const { viewport, send, metrics } = rig({ size: [699, 801] });
  viewport.pin(7, send);
  await settle();
  assert.equal(metrics().length, 1);
  assert.deepEqual(metrics()[0].params.width, 843);
});

test("폭이 0 인 게스트는 그대로 구제한다", async () => {
  const { viewport, send, metrics } = rig({ size: [0, 0] });
  viewport.pin(7, send, { onlyIfCollapsed: true });
  await settle();
  assert.equal(metrics().length, 1, "배경 탭 보호가 사라지면 그 탭이 자기를 폰으로 읽는다");
  assert.equal(metrics()[0].params.width, 843);
  assert.equal(metrics()[0].params.height, 857);
});

test("그릴 표면이 있는 게스트에는 남의 크기를 박지 않는다", async () => {
  const { viewport, send, metrics } = rig({ size: [699, 801] });
  viewport.pin(7, send, { onlyIfCollapsed: true });
  await settle();
  assert.equal(metrics().length, 0, "탭이 아닌 webview 가 브라우저 탭 크기로 굳는 자리");
});

test("크기를 못 재면 예전대로 건다", async () => {
  const { viewport, send, metrics } = rig({ sizeFails: true });
  viewport.pin(7, send, { onlyIfCollapsed: true });
  await settle();
  assert.equal(metrics().length, 1, "못 잰 것을 '표면이 있다' 로 읽으면 배경 탭이 무방비가 된다");
});
