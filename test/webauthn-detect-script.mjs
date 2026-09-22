import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { WEBAUTHN_SCRIPT } = require("../native/electron/browser-hardening.cjs");

// 게스트 main world 를 흉내 낸다. get/create 는 브라우저처럼 대기 promise 를 돌려준다.
function guest({ uvpaa = false } = {}) {
  const posts = [];
  const pending = () => new Promise(() => {});
  const window = {
    location: { host: "accounts.google.com", href: "https://accounts.google.com/v3/signin/identifier" },
    postMessage: (m) => { if (m && m.__acWebAuthn) posts.push(m.__acWebAuthn); },
    PublicKeyCredential: {
      isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(uvpaa),
      isConditionalMediationAvailable: () => Promise.resolve(true),
    },
  };
  window.top = window;
  const navigator = { credentials: { get: pending, create: pending } };
  const ctx = vm.createContext({ window, navigator, location: window.location });
  vm.runInContext(WEBAUTHN_SCRIPT, ctx);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { posts, navigator, flush };
}
const phases = (posts) => posts.map((p) => p.phase + (p.api ? ":" + p.api : ""));

test("조건부(자동완성) get 은 시작으로 보고하지 않는다", async () => {
  const g = guest();
  g.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) }, mediation: "conditional" });
  await g.flush();
  assert.deepEqual(phases(g.posts), ["ready", "probe:conditional"]);
  assert.equal(g.posts.some((p) => p.phase === "start"), false);
});

test("일반 get 은 플랫폼 인증기 여부와 함께 시작으로 보고한다", async () => {
  const g = guest();
  g.navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } });
  await g.flush();
  const start = g.posts.find((p) => p.phase === "start");
  assert.ok(start, "start 가 없다");
  assert.equal(start.kind, "get");
  assert.equal(start.platform, false);
  assert.equal(start.host, "accounts.google.com");
});

test("mediation 이 다른 값이면 여전히 시작으로 본다", async () => {
  const g = guest({ uvpaa: true });
  g.navigator.credentials.get({ publicKey: {}, mediation: "required" });
  await g.flush();
  const start = g.posts.find((p) => p.phase === "start");
  assert.ok(start);
  assert.equal(start.platform, true);
});

test("publicKey 가 없는 호출(비밀번호 자격증명)은 아무것도 보고하지 않는다", async () => {
  const g = guest();
  g.navigator.credentials.get({ password: true, mediation: "conditional" });
  await g.flush();
  assert.deepEqual(phases(g.posts), ["ready"]);
});
