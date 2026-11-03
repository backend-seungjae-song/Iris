// localhost 개발 서버의 2단계 인증 칸은 세션이 입력할 수 있고, 외부 주소는 그대로 사람 몫(marble-walk 로컬 CMS /two-factor/verify)
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const { headlessLaunchOptions } = require("../bin/headless-browser.cjs");
const { inspectLoginPage } = require("../native/electron/cdp-qa-login.cjs");

const page = `<label>인증 코드<input autocomplete="one-time-code" name="otp"></label><button>확인</button>`;

test("인증번호 칸은 localhost 에서는 사람 확인 이유가 아니고, 외부 주소에서는 그대로 사람 확인이다", async t => {
  const browser = await puppeteer.launch(headlessLaunchOptions());
  t.after(() => browser.close());
  const tab = await browser.newPage();
  await tab.setRequestInterception(true);
  tab.on("request", request => request.respond({ status: 200, contentType: "text/html", body: page }));
  const reasonsAt = async url => { await tab.goto(url); return tab.evaluate(`(${inspectLoginPage.toString()})()`).then(result => result.reasons); };
  assert.deepEqual(await reasonsAt("http://localhost:3002/two-factor/verify"), []);
  assert.deepEqual(await reasonsAt("http://127.0.0.1:3002/two-factor/verify"), []);
  assert.deepEqual(await reasonsAt("https://cms.example.com/two-factor/verify"), ["인증번호 입력"]);
  assert.deepEqual(await reasonsAt("http://localhost.example.com/verify"), ["인증번호 입력"]);
});
