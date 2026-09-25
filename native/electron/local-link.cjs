// 로컬 링크 판정. 주소가 이 기계의 것인지와, 페이지가 로컬 링크를 열 자격이 있는지를 가른다.
//
// 소유 범위
//   file: 인가와 loopback(127.0.0.1·localhost·[::1]) 인가의 판정. 그 둘뿐이다.
//   어떤 확장자를 앱이 렌더링하는지는 여기서 알지 않는다. 그것은 렌더러의 등록표가 소유한다.
//
// 제공 API
//   isFileUrl(url) · isLoopbackUrl(url) · isLocalPage(url) · consoleOpenTarget(target).
//
// 의존 대상
//   아무것도 require 하지 않는다. Electron 도 Node API 도 사용하지 않아 검사가 그대로 호출한다.
//
// 설계 이유
//   같은 판정을 창 열기·이동·내려받기·우클릭 네 곳이 공유한다. 각자 정규식을 두면
//   하나를 수정할 때 나머지 셋이 일치하지 않게 된다.
//
// 유지 조건
//   원격 페이지가 여는 file: 은 허용하지 않는다. 허용하면 외부 페이지가 이 기계의 파일을 앱
//   화면에 띄울 수 있다. 내용을 가져가지는 못해도 사용자가 요청하지 않은 파일이 열린다.
//   loopback 판정은 host 만 확인한다. 주소 안에 localhost 문자열이 있는 것과 그 호스트로
//   요청하는 것은 다르다(https://evil.example/?x=localhost 가 통과하면 안 된다).
//
// 영향 범위
//   native/electron/{webview-lifecycle,download-hook,webview-context-menu}.cjs.
//   검사는 bin/smoke/sections/local-link.mjs.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function isFileUrl(url) { return /^file:/i.test(String(url || "")); }

function isLoopbackUrl(url) {
  const raw = String(url || "");
  if (!/^https?:/i.test(raw)) return false;
  try { return LOOPBACK_HOSTS.has(new URL(raw).hostname.toLowerCase()); } catch { return false; }
}

// 로컬에서 온 페이지만 로컬 링크를 열 자격이 있다.
function isLocalPage(url) { return isFileUrl(url) || isLoopbackUrl(url); }

// 보조 창(분리 브라우저·메모)이 콘솔 창에 열어 달라고 넘기는 대상. 절대 경로와 웹 주소만 받는다.
// file: 은 받지 않는다. 메모 창의 링크는 원격도 쓸 수 있는 글에서 온다.
function consoleOpenTarget(target) {
  const t = String(target || "");
  return t.startsWith("/") || /^https?:\/\//i.test(t) ? t : null;
}

module.exports = { isFileUrl, isLoopbackUrl, isLocalPage, consoleOpenTarget };
