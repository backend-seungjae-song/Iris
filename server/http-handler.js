import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBrowserCmdResilient } from "./browser-commands.js";
import {
  closeDialogAsk,
  dialogPlanText,
  metaOfWc,
  openDialogAsk,
  plannedAnswer,
} from "./browser-runtime.js";
import { portWithLegacy } from "./env.cjs";
import { resolvePickSource } from "./pick-source.js";
import { handleFeatureState } from "./feature-state.js";

// HTTP request/Origin/MIME/routes 정책의 단일 소유 모듈.
//
// 소유 범위
//   host/remote/Origin 허용 판정, static MIME/no-cache, dialog/browser/run/health routes.
//
// 제공 API
//   PORT/HOST/REMOTE 상수, IP·connection 판정 함수와 createHttpHandler request handler factory.
//   실제 HTTP listener와 WebSocketServer 인스턴스는 노출하거나 만들지 않는다.
//
// 의존 대상
//   browser-commands·browser-runtime·runtime-state·run owner와 node fs/path에 의존하고,
//   IRIS_HOME과 RunManager 접근자는 composition root에서 주입받는다.
//
// 유지 조건
//   /pick-source는 로컬 오리진의 소스 위치만 응답하고 파일 내용은 싣지 않는다.
//   /dialog-ask가 Origin gate보다 먼저인 순서, loopback + Tailscale 100.64/10 허용 범위,
//   DNS rebinding Origin 차단, AC5 로컬 POST gate, route 응답·CORS·MIME·cache 타이밍을 보존한다.
//
// 영향 범위
//   server/index.js의 createServer/WSS verifyClient/bind와 browser-runtime dialog owner,
//   Electron·CLI·MCP HTTP 소비자, bin/smoke.mjs Origin/MIME/route 소유·entry 연결 검사.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, "..", "web");
// IRIS_PORT를 먼저 본다. PORT는 흔한 이름이라 다른 프로그램도 사용한다.
// 그 이름으로 설정을 받으면 같은 값을 상속한 다른 개발 서버가 이 포트를 함께 잡는다.
// PORT는 이전 설정 호환으로만 남긴다(launchd plist가 아직 그 이름을 쓸 수 있다).
//
// 순서를 바꿔 PORT를 먼저 보면 IRIS_PORT가 무시된다.
// 확인 결과: `IRIS_PORT=4293 IRIS_STATE_DIR=~/.iris-verify node server/index.js` 가
// 상태 폴더는 바꿨는데 포트는 4271에 바인딩됐다. 그 셸에 PORT=4271이 설정돼 있었기 때문이다.
// 그 결과 격리하려고 실행한 서버가 실제 앱과 같은 포트를 잡았다. 같은 원인이 index.js 의
// 포트 대기 주석에도 적혀 있다(EADDRINUSE 종료 62회).
export const PORT = portWithLegacy();
// 원격(AC4~6): REMOTE=1이면 0.0.0.0 바인딩해 Tailscale IP로 폰이 접속.
// 단 접속 IP를 localhost + Tailscale 대역으로만 허용해 미인증 외부 주체를 차단(AC6).
// 로컬 전용(기본)은 127.0.0.1.
export const REMOTE = process.env.REMOTE === "1";
export const HOST = process.env.HOST || (REMOTE ? "0.0.0.0" : "127.0.0.1");

// AC6 강제: 허용 대역 = 루프백 + Tailscale CGNAT(100.64.0.0/10). 그 외 원격 주소는 거부.
// Tailscale은 tailnet에 가입한 기기에만 100.x 주소를 부여하므로 기기 소속이 인증 역할을 한다.
export function normalizeIp(ip) {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip; // IPv4-mapped IPv6
}
export function isAllowedRemote(rawIp) {
  const ip = normalizeIp(rawIp);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  // 100.64.0.0/10 = 100.64.0.0 ~ 100.127.255.255 (Tailscale CGNAT)
  const m = ip.match(/^100\.(\d+)\./);
  if (m) { const o = Number(m[1]); return o >= 64 && o <= 127; }
  return false;
}
// Origin 검사: cross-site + DNS rebinding 차단. Origin.host === Host(요청 헤더) 대조는 rebinding을
// 막지 못한다. 공격자가 자기 도메인을 loopback으로 rebinding하면 Origin과 Host가 둘 다 그 도메인이라
// 일치해 통과한다. 그래서 Host 헤더(공격자 제어 가능)가 아니라 신뢰 대역의 리터럴 IP·loopback으로만
// Origin 호스트를 허용한다. DNS 이름 Origin(attacker.com, 100.64.attacker.example)은 전부 탈락.
// MagicDNS 이름 등으로 접속하는 경우만 IRIS_ALLOWED_ORIGIN_HOSTS로 명시 허용.
function isTrustedOriginHost(host) {
  // URL.hostname은 IPv6를 대괄호째("[::1]") 반환하므로 두 형태 모두 인정.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  // 엄격한 4-옥텟 IPv4 리터럴만 인정(DNS 이름 배제). loopback(127/8) + Tailscale CGNAT(100.64/10).
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return false;
  if (oct[0] === 127) return true;
  if (oct[0] === 100 && oct[1] >= 64 && oct[1] <= 127) return true;
  return false;
}
function originAllowed(req) {
  const o = req.headers?.origin;
  if (!o) return true; // 네이티브 클라이언트(curl 등)는 Origin이 없음
  let host;
  try { host = new URL(o).hostname; } catch { return false; }
  if (isTrustedOriginHost(host)) return true;
  const extra = (process.env.IRIS_ALLOWED_ORIGIN_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(host);
}
// IP 필터는 REMOTE 플래그·바인딩과 무관하게 항상 적용한다. HOST=0.0.0.0 으로 잘못 설정해도
// 미인증 외부 주체를 막는다(AC6). 허용 = 루프백 + Tailscale 대역, 그리고 Origin 통과.
export function connectionAllowed(req) {
  if (!isAllowedRemote(req.socket?.remoteAddress)) return false;
  return originAllowed(req);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  // Monaco(vendor)가 쓰는 타입. 잘못된 타입으로 주면 폰트 아이콘·nls가 깨진다.
  ".ttf": "font/ttf", ".woff": "font/woff", ".json": "application/json", ".svg": "image/svg+xml", ".map": "application/json",
  ".wasm": "application/wasm" };

export function createHttpHandler({ irisHome, capabilityHost }) {
  return (req, res) => {
  // 정적 파일과 같은 경로로 판정해야 인코딩·상위 경로로 기능 게이트를 우회하지 못한다.
  let pathname;
  try { pathname = path.posix.normalize(decodeURIComponent(req.url.split("?")[0])); }
  catch { res.writeHead(400).end("bad path"); return; }
  // 페이지가 띄우는 확인 창(alert/confirm/prompt). 게스트에 주입한 스크립트가 동기 XHR로 여기에 걸리고,
  // 사용자가 그 탭에서 응답할 때까지 이 응답을 보류해 그 탭의 페이지만 멈춘다. 원래 대화상자와 같은
  // 의미이고 다른 탭·다른 창은 영향이 없다(네이티브 시트는 창 전체를 막았다).
  //
  // 이 경로는 originAllowed 게이트 앞에 둔다. 호출 주체가 사용자가 보고 있는 임의의 웹페이지라
  // 그 Origin은 신뢰 목록에 절대 들어오지 않는다. 게이트 뒤에 두면 실제 사이트에서는 언제나 403이고,
  // 그 403에는 CORS 헤더가 없어 브라우저가 응답을 읽지도 못한 채 NetworkError를 낸다. 그러면
  // ask()가 이를 무시해 null이 되고 confirm이 묻지 않고 false가 된다. 즉 페이지의 확인 대화상자가 전부
  // 동작하지 않는다(확인 결과: https 사이트의 취소 버튼이 반응하지 않았다). 대신 아래 두 단계로 막는다.
  // 루프백 IP, 그리고 wc가 실제로 그 Origin을 띄우고 있는 탭인지.
  if (req.method === "GET" && pathname === "/dialog-ask") {
    const ip = normalizeIp(req.socket?.remoteAddress);
    // 실패 응답에도 CORS를 붙인다. 없으면 페이지 쪽에서 상태코드조차 못 보고 NetworkError가 되어
    // 원인을 알 수 없게 된다.
    const deny = (code, why) => {
      res.writeHead(code, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end(why);
    };
    if (!(ip === "127.0.0.1" || ip === "::1")) { deny(403, "local only"); return; }
    const q = new URL(req.url, "http://127.0.0.1").searchParams;
    const wc = Number(q.get("wc") || 0);
    // 다른 탭의 wc를 사칭해 그 탭 이름으로 대화상자를 띄우는 것을 막는다. 묻는 페이지의 Origin이
    // 그 wc가 지금 띄우고 있는 문서의 Origin과 같아야 한다.
    const askOrigin = req.headers?.origin;
    if (askOrigin && askOrigin !== "null") {
      const meta = metaOfWc(wc);
      let tabOrigin = null;
      try { tabOrigin = meta && meta.url ? new URL(meta.url).origin : null; } catch { tabOrigin = null; }
      // 최상위 문서 말고 그 탭의 iframe 이 물을 수도 있다. 최상위 origin 만 보면 그런 확인창이
      // 모두 막히고, 페이지에서는 취소로 처리돼 버튼이 동작하지 않는다(확인 결과:
      // 다른 출처의 iframe 안에 뜬 주문서). 그 탭이 실제로 띄우고 있는 문서들의 origin 을 함께 본다.
      const frameOK = meta && Array.isArray(meta.frameOrigins) && meta.frameOrigins.includes(askOrigin);
      if (tabOrigin && tabOrigin !== askOrigin && !frameOK) { deny(403, "origin/wc mismatch"); return; }
    }
    const kind = ["alert", "confirm", "prompt"].includes(q.get("kind")) ? q.get("kind") : "alert";
    const msg = String(q.get("msg") || "").slice(0, 2000);
    // 무장돼 있으면 사람을 부르지 않고 그 자리에서 답한다. 무장이 없으면 종전대로 사람이 답한다.
    // noplan=1 은 무장을 건너뛴다. 인증서 신뢰처럼 사용자만 결정해야 하는 질문이 사용한다.
    // 페이지 확인창 자동응답을 켰다는 이유로 인증서를 신뢰하면 무장의 범위를 벗어난다.
    const auto = q.get("noplan") === "1" ? null : plannedAnswer(wc);
    if (auto) {
      const text = dialogPlanText(wc);
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ answer: auto === "cancel" ? "cancel" : "ok",
        text: kind === "prompt" && text != null ? text : String(q.get("def") || "") }));
      return;
    }
    const id = openDialogAsk(wc, kind, msg, (answer, text) => {
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ answer, text: text == null ? "" : text }));
    }, q.get("def"));
    // 질문을 띄운 페이지가 사라지면(이동·닫힘) 질문도 사라진다. 표시까지 제거하지 않으면 그 탭은 계속
    // 응답 대기 상태로 남아 목록과 모달에 표시된다(확인 결과: 재시작 뒤에도 @t72가 남았다).
    req.on("close", () => {
      closeDialogAsk(id);
    });
    return;
  }
  // /dialog-ask 를 제외한 나머지는 종전대로 오리진·원격 게이트를 통과해야 한다.
  if (!connectionAllowed(req)) { res.writeHead(403).end("forbidden"); return; }
  if (pathname === "/features") {
    const ip = normalizeIp(req.socket?.remoteAddress);
    handleFeatureState(req, res, ip === "127.0.0.1" || ip === "::1");
    return;
  }
  if (capabilityHost?.http(req, res, pathname)) return;
  // AI→브라우저 제어: iris-browser CLI가 POST /browser-cmd로 명령을 보낸다. 로컬(루프백) 전용(AC5).
  if (req.method === "POST" && pathname === "/browser-cmd") {
    const ip = normalizeIp(req.socket?.remoteAddress);
    if (!(ip === "127.0.0.1" || ip === "::1")) { res.writeHead(403).end('{"ok":false,"error":"local only (AC5)"}'); return; }
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let j; try { j = JSON.parse(body || "{}"); } catch { res.writeHead(400).end('{"ok":false,"error":"bad json"}'); return; }
      const r = await runBrowserCmdResilient(String(j.cmd || ""), j.args || {}, j.session ? String(j.session) : null,
        j.run ? String(j.run) : null);
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(r));
    });
    return;
  }
  // 요소 지목 시 소스 위치를 찾는다. 지목한 시점에 앱이 한 번 찾아 블록에 싣는다. 받는 쪽이 다시
  // grep 하지 않게 하기 위해서다. 실행 출력과 같은 등급이라 루프백에만 연다.
  if (req.method === "POST" && pathname === "/pick-source") {
    const ip = normalizeIp(req.socket?.remoteAddress);
    if (!(ip === "127.0.0.1" || ip === "::1")) { res.writeHead(403).end('{"ok":false,"error":"local only (AC5)"}'); return; }
    let body = ""; req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", async () => {
      let j; try { j = JSON.parse(body || "{}"); } catch { res.writeHead(400).end('{"ok":false,"error":"bad json"}'); return; }
      let out;
      // 소스를 찾지 못한 것이 지목을 막으면 안 되므로, 실패하면 빈 결과로 응답한다.
      try { out = { ok: true, ...(await resolvePickSource(j.pick || {})) }; }
      catch (e) { out = { ok: false, error: String(e?.message || e) }; }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // 이 포트를 누가 사용 중인지 한 줄로 응답한다. 앱이 시작할 때 서버를 새로 띄울지 기존 서버에
  // 연결할지를 이 값으로 판단한다. 없으면 앱이 자기 서버를 실행하고, 있으면 기존 서버를 그대로 쓴다.
  // 상태 폴더까지 실어야 개발 인스턴스와 설치본을 헷갈리지 않는다(포트만으론 구별이 안 된다).
  if (req.method === "GET" && pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, pid: process.pid, port: PORT, stateDir: irisHome }));
    return;
  }
  let rel = pathname === "/" ? "/index.html" : pathname;
  // 폴더로 끝나는 주소는 그 안의 index.html 이다. 없으면 readFile 이 폴더를 읽다 404 가 되어
  // /memolab/ 같은 단일 페이지가 주소로 열리지 않는다.
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(WEB, path.normalize(rel));
  if (!file.startsWith(WEB)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    // 앱 셸은 절대 캐시하지 않는다. 여기엔 빌드 해시도 버전도 없어서, 한 번 캐시되면 앱을 다시
    // 실행해도 이전 화면이 그대로 표시되고 수정이 반영되지 않는다.
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "text/plain",
      "cache-control": "no-store, must-revalidate",
    });
    res.end(data);
  });
  };
}

