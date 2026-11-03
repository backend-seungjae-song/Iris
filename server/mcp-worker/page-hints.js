// worker 사본 · 원본 cdp-hints.cjs 와 같은 입력에 같은 결과 (test/mcp-worker-snapshot-parity.mjs 가 대조)
// 원본은 ⑧에서 지움
// CDP 결과에 로그인 가능성과 사람 개입 필요를 보강하는 힌트.
//
// 소유 범위
//   보이는 로그인 입력과 결제·본인확인·캡차의 강한 DOM 신호, 호출자에게 돌려줄 안내 문구.
//
// 제공 API
//   loginHint(send) · humanHint(send).
//
// 의존 대상
//   호출자가 주입하는 CDP send 함수와 페이지의 __acQA 조회 helper·현재 DOM·location origin.
//   Electron debugger나 로그인 제공자·transport를 직접 잡지 않는다.
//
// 유지 조건
//   로그인할 수 있는 페이지와 사람이 직접 해야 하는 결제·인증·캡차를 결과에서 숨기지 않는다.
//   보이는 강한 신호가 없거나 조회가 실패하면 오탐 문구를 만들지 않는다.
//
// 영향 범위
//   공급자는 cdp-control.cjs snapshot/observe의 세션 send와 페이지 DOM이고, 양방향 소비자는
//   CLI·MCP 결과의 loginHint/humanHint 와 그 뒤 대화 질문 흐름이다. 힌트 누락은 자동 로그인
//   가능성을 놓치거나 사람 개입이 필요한 탭을 알리지 않은 채 작업이 멈추는 문제로 이어진다.

async function loginHint(send) {
  try {
    const r = await send("Runtime.evaluate", {
      expression: `(() => {
        const QA = window.__acQA || ((s) => [...document.querySelectorAll(s)]);
        const pw = QA('input[type=password]').filter((e) => e.offsetParent !== null);
        if (!pw.length) return "";
        return location.origin;
      })()`,
      returnByValue: true,
    });
    const origin = r && r.result && r.result.value;
    if (!origin) return null;
    return `로그인 칸 있음(${origin}) — 사람에게 넘기기 전에 login 먼저. 허용된 계정이 없으면 그때 사람 차례.`;
  } catch { return null; }
}

async function humanHint(send) {
  try {
    const r = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
      const vis = (e) => e && e.offsetParent !== null && e.getClientRects().length;
      const QA = window.__acQA || ((s) => [...document.querySelectorAll(s)]);
      const q = (sel) => QA(sel).filter(vis);
      const hit = [];
      if (q('input[autocomplete*="cc-number"], input[name*="cardnum" i], input[id*="cardnum" i]').length) hit.push("카드 정보 입력");
      const payFrame = QA("iframe").filter(vis)
        .some((f) => /(checkout|payment|\\bpay\\b|3ds|acs|stripe|toss|portone|iamport|inicis|kcp|nicepay|eximbay)/i.test(f.src || ""));
      if (payFrame) hit.push("결제 창");
      if (q('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]').length) hit.push("인증번호 입력");
      const cap = QA("iframe").filter(vis)
        .some((f) => /(recaptcha|hcaptcha|turnstile|captcha)/i.test(f.src || ""))
        || q(".g-recaptcha, #cf-turnstile, .h-captcha").length > 0;
      if (cap) hit.push("캡차");
      return hit;
    })()` });
    const hits = (r && r.result && r.result.value) || [];
    if (!Array.isArray(hits) || !hits.length) return null;
    return `사람만 할 수 있는 자리다(${hits.join(" · ")}). 대신하지 말고, 이 세션 대화에서 사용자에게 이 탭에서 해 달라고 직접 물어라. `
      + `답을 받은 뒤 화면을 다시 확인하고 이어 간다.`;
  } catch { return null; }
}

export { loginHint, humanHint };
