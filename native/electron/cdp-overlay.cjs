// 모든 CDP 프레임에 유지하는 overlay source와 주입 identifier 장부.
//
// 소유 범위
//   탭·기능 key별 active source와 최상위/자식 session별 새 문서 주입 identifier.
//
// 제공 API
//   injectAllFrames(wcId, key, source, on, send, sessions) ·
//   injectActive(wcId, sid, send, runImmediately) · resetSession(wcId).
//   원시 Map이나 identifier 배열은 내주지 않는다.
//
// 의존 대상
//   호출자가 주입하는 세션 지정 가능 CDP send 함수와 현재 child session ID 목록.
//   Electron webContents나 debugger를 직접 잡지 않는다.
//
// 유지 조건
//   같은 key를 다시 켜면 기존 identifier를 먼저 걷고 한 벌만 남긴다. 켜진 동안 늦게 붙은 OOPIF에도
//   같은 source를 심고, 끄면 모든 세션의 새 문서 주입을 제거한 뒤 active source도 지운다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 session prime/reset·Target attach와 main.cjs의 ac-frames-inject IPC이고,
//   양방향 소비자는 선택 overlay·조작 기록기·Runtime 현재 문서와 Page 새 문서 주입이다. identifier
//   수명은 iframe 이동·늦은 OOPIF·세션 재부착과 off 뒤 overlay 재등장 여부에도 영향을 준다.

const overlaySrc = new Map();
const overlayScripts = new Map();
const okey = (wcId, key) => wcId + "|" + key;

function injectActive(wcId, sid, send, runImmediately) {
  for (const [k, src] of overlaySrc) {
    if (!k.startsWith(wcId + "|")) continue;
    const add = () => send("Page.addScriptToEvaluateOnNewDocument", { source: src, runImmediately: !!runImmediately }, sid)
      .then((r) => { if (r && r.identifier) (overlayScripts.get(k) || []).push({ sid, identifier: r.identifier }); })
      .catch(() => {});
    if (runImmediately) {
      add();
      send("Runtime.evaluate", { expression: src }, sid).catch(() => {});
    } else {
      send("Runtime.evaluate", { expression: src }, sid).catch(() => {});
      add();
    }
  }
}

function resetSession(wcId) {
  for (const k of [...overlayScripts.keys()]) {
    if (!k.startsWith(wcId + "|")) continue;
    if (overlaySrc.has(k)) overlayScripts.set(k, []);
    else overlayScripts.delete(k);
  }
}

function injectAllFrames(wcId, key, source, on, send, sessions) {
  const id = Number(wcId);
  const src = String(source || "");
  const k = okey(id, key);
  for (const rec of overlayScripts.get(k) || []) {
    send("Page.removeScriptToEvaluateOnNewDocument", { identifier: rec.identifier }, rec.sid).catch(() => {});
  }
  if (!on) overlaySrc.delete(k); else overlaySrc.set(k, src);
  const added = [];
  overlayScripts.set(k, added);
  for (const sid of sessions) {
    send("Runtime.evaluate", { expression: src }, sid).catch(() => {});
    if (!on) continue;
    send("Page.addScriptToEvaluateOnNewDocument", { source: src, runImmediately: false }, sid)
      .then((r) => { if (r && r.identifier) added.push({ sid, identifier: r.identifier }); })
      .catch(() => {});
  }
  if (!on) overlayScripts.delete(k);
  return true;
}

// 이 탭에 켜진 overlay(지목·녹화)가 하나라도 있는가. CDP 부착을 유지할지 정하는 쪽이 묻는다.
function hasActive(wcId) {
  const prefix = Number(wcId) + "|";
  for (const k of overlaySrc.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

module.exports = { injectAllFrames, injectActive, resetSession, hasActive };
