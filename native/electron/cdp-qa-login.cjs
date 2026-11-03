const { randomBytes, createHash } = require("node:crypto");

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

function createQaLoginCommands({ loginProvider, input, resultSafety }) {
  const accountsFor = async (wc, approved = false) => {
    const provider = loginProvider();
    if (!provider) throw new Error("로그인 계정 제공자가 없습니다");
    const response = await provider(wc, { qaAccounts: true, qaApproved: approved });
    if (response?.error || !Array.isArray(response?.accounts)) throw new Error("로그인 계정 조회 실패");
    const origin = new URL(wc.getURL()).origin;
    if (response.origin !== origin) throw new Error("로그인 계정의 출처가 다릅니다");
    const id = (username) => createHash("sha256").update(origin + "\n" + username).digest("hex").slice(0, 24);
    const accounts = response.accounts.map((account) => ({ ...account, id: id(account.username) }));
    for (const account of accounts) resultSafety.rememberSecret(wc.id, account.password, { allowShort: true });
    return { origin, accounts, unavailable: (response.unavailable || []).map((account) => ({ ...account, id: id(account.username) })) };
  };
  const inspect = (send) => inIsolatedWorld(send, `(${inspectLoginPage.toString()})()`);
  return {
    async "qa-login-info"(send, wc, args = {}) {
      const page = await inspect(send);
      const { origin, accounts, unavailable } = await accountsFor(wc);
      const publicAccounts = [...accounts, ...unavailable].map(({ id, username, allowed, local }) => ({ id, username, allowed: allowed === true, local: local === true }));
      const candidates = args.account ? publicAccounts.filter((account) => account.id === args.account || account.username === args.account) : publicAccounts;
      const selected = candidates.length === 1 ? candidates[0] : null;
      return { ok: true, origin, accounts: publicAccounts, fields: page.fields, selectedAccount: selected?.id || null,
        sensitive: page.reasons.length > 0,
        humanRequired: page.reasons.length > 0 || !publicAccounts.length || page.fields.length !== 2,
        reason: page.reasons.join(" · ") || (!publicAccounts.length ? "사용 가능한 저장 계정이나 로컬 테스트 계정이 없습니다" : page.fields.length !== 2 ? "로그인 칸을 하나로 확인하지 못했습니다" : null),
        choose: !selected && publicAccounts.length > 1 };
    },
    async "qa-login-input"(send, wc, args = {}) {
      if (!["username", "password"].includes(args.field)) throw new Error("로그인 필드가 올바르지 않습니다");
      const { origin, accounts } = await accountsFor(wc, args.approved === true);
      if (origin !== args.origin) throw new Error("로그인 승인 후 출처가 바뀌었습니다");
      const account = accounts.find((entry) => entry.id === args.accountId);
      if (!account || (account.allowed !== true && args.approved !== true)) throw new Error("허용된 로그인 계정이 아닙니다");
      const verify = async () => {
        if (new URL(wc.getURL()).origin !== origin) throw new Error("로그인 입력 전 출처가 바뀌었습니다");
        const page = await inspect(send);
        if (page.reasons.length) throw new Error("결제·본인확인·캡차는 사람이 처리해야 합니다");
        const field = page.fields.find((entry) => entry.field === args.field);
        if (!field || Math.abs(field.x - args.x) > 1 || Math.abs(field.y - args.y) > 1) throw new Error("로그인 칸이 바뀌었습니다");
        const valid = await inIsolatedWorld(send, `(() => { const e = document.elementFromPoint(${JSON.stringify(args.x)},${JSON.stringify(args.y)}); return !!e && e === document.activeElement && e.localName === 'input' && ${args.field === "password" ? "e.type === 'password'" : "e.type !== 'password'"} && !e.value; })()`);
        if (valid !== true) throw new Error("비어 있는 로그인 칸에 포커스가 필요합니다");
      };
      await verify();
      const text = args.field === "password" ? account.password : account.username;
      if (typeof text !== "string" || !text) throw new Error("로그인 입력값이 없습니다");
      let result;
      try { result = await input(send, wc, { action: "type", text, verifyBeforeInput: verify }); }
      catch { throw new Error("QA 로그인 입력 실패"); }
      return resultSafety.redactSecrets(wc.id, { ...result, accountId: account.id, field: args.field, length: text.length });
    },
  };
}

module.exports = { createQaLoginCommands, inspectLoginPage, inIsolatedWorld };
