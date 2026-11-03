// worker 사본 · 원본 cdp-qa-login.cjs 의 inspectLoginPage·inIsolatedWorld 와 같은 입력에 같은 결과 (test/mcp-worker-qa-input-route.mjs 가 대조)
// 원본은 ⑧에서 지움
import { randomBytes } from "node:crypto";

// 로그인 칸과 사람 확인이 필요한 화면의 읽기 전용 조회
function inspectLoginPage() {
  const visible = (element) => {
    const css = getComputedStyle(element), box = element.getBoundingClientRect();
    return css.display !== "none" && css.visibility !== "hidden" && Number(css.opacity) > 0
      && box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight;
  };
  const reasons = [];
  const documents = [document];
  for (let index = 0; index < documents.length; index++) {
    for (const frame of Array.from(documents[index].querySelectorAll('iframe')).filter(visible)) {
      let child = null;
      try { child = frame.contentDocument; } catch {}
      if (!child) { if (!reasons.includes("프레임 안 화면은 사람이 확인해야 합니다")) reasons.push("프레임 안 화면은 사람이 확인해야 합니다"); }
      else if (!documents.includes(child)) documents.push(child);
    }
  }
  const query = (selector) => documents.flatMap((doc) => Array.from(doc.querySelectorAll(selector)).filter(visible));
  if (query('input[autocomplete*="cc-number"],input[name*="cardnum" i],input[id*="cardnum" i]').length) reasons.push("카드 정보 입력");
  // 내 컴퓨터의 개발 서버(localhost)는 로컬 계정이라 인증번호를 세션이 받아 직접 넣음(marble-walk 로컬 CMS 2단계 인증). 결제·캡차는 그대로 사람 몫
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$|\.localhost$/i.test(globalThis.location?.hostname || "");
  if (!loopback && query('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i]').length) reasons.push("인증번호 입력");
  if (query('iframe').some((frame) => /(checkout|payment|3ds|acs|stripe|toss|portone|iamport|inicis|kcp|nicepay|eximbay)/i.test(frame.src || ""))) reasons.push("결제 창");
  if (query('iframe').some((frame) => /(recaptcha|hcaptcha|turnstile|captcha)/i.test(frame.src || "")) || query('.g-recaptcha,#cf-turnstile,.h-captcha').length) reasons.push("캡차");
  const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
  const usernames = Array.from(document.querySelectorAll('input[autocomplete="username"],input[type="email"],input[name*="user" i],input[name*="email" i],input[name*="login" i],input[id*="user" i],input[id*="email" i],input[id*="login" i]')).filter(visible)
    .filter((element) => !["password", "hidden", "submit", "button"].includes(element.type));
  const fields = [];
  if (passwords.length === 1 && usernames.length === 1) {
    for (const [field, element] of [["username", usernames[0]], ["password", passwords[0]]]) {
      const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) continue;
      if (document.elementFromPoint(x, y) !== element || element.disabled || element.readOnly || element.closest('[inert],[aria-disabled="true"]')) continue;
      fields.push({ field, x, y });
    }
  }
  return { fields, reasons };
}

async function inIsolatedWorld(send, expression) {
  const tree = await send("Page.getFrameTree");
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) throw new Error("로그인 화면의 프레임을 확인할 수 없습니다");
  const world = await send("Page.createIsolatedWorld", { frameId, worldName: "iris-qa-login-" + randomBytes(8).toString("hex") });
  if (!world?.executionContextId) throw new Error("로그인 조회 영역을 만들지 못했습니다");
  const result = await send("Runtime.evaluate", { expression, contextId: world.executionContextId, returnByValue: true });
  if (result.exceptionDetails || !result?.result || !Object.hasOwn(result.result, "value")) throw new Error("로그인 화면 조회 실패");
  return result.result.value;
}

export { inIsolatedWorld, inspectLoginPage };
