// 사람이 직접 실행하는 탐침. AI 브라우저 제어가 "활성 스페이스의 탭"만 대상으로 하는지 본다.
//
// 검사가 아니라 탐침이다. 단정문이 없고 결과를 사람이 읽는다. 그래서 `test/`가 아니라 여기 둔다.
// `test/`에 두면 스위트가 항상 건너뛰면서 개수만 채워, 실제로 도는 검사보다 많아 보인다.
//
// 이 탐침은 사람이 쓰고 있는 앱을 건드린다. 활성 스페이스를 실제로 바꾸므로 실행하는 동안
// 화면이 따라 움직인다. 자동으로 실행하면 사용자가 보고 있는 화면이 바뀐다.
//
// 실행:
//   node scripts/probe/space-binding.mjs <스페이스id> <스페이스id> [포트]
//   포트를 안 주면 IRIS_PORT(없으면 기본 포트)를 따른다. 이름은 server/env.cjs가 한 곳에서 정한다.
//   스페이스 id는 `browser_tabs`나 앱 화면에서 얻는다. 특정 기기의 id를 이 파일에 적으면
//   다른 사람에게는 쓸 수 없고 공개본에도 그대로 포함된다.
import http from "node:http";
import WS from "ws";
import { port as defaultPort } from "../../server/env.cjs";

const WebSocket = WS.WebSocket || WS;
const [a, b, portArg] = process.argv.slice(2);
const PORT = Number(portArg) || defaultPort();

if (!a || !b) {
  console.error("쓰기: node scripts/probe/space-binding.mjs <스페이스id> <스페이스id> [포트]");
  process.exit(2);
}

const url = () => new Promise((res) => {
  const p = JSON.stringify({ cmd: "url" });
  const r = http.request({ host: "127.0.0.1", port: PORT, path: "/browser-cmd", method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(p) } },
    (resp) => { let s = ""; resp.on("data", (c) => (s += c)); resp.on("end", () => { try { res(JSON.parse(s)); } catch { res({ ok: false }); } }); });
  r.on("error", () => res({ ok: false })); r.write(p); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.on("open", async () => {
  const setSpace = (sp) => ws.send(JSON.stringify({ type: "browser-sync", mutation: { op: "space.active", space: sp } }));
  for (const sp of [a, b, a, b]) {
    setSpace(sp); await sleep(1200);
    const r = await url();
    console.log(`activeSpace=${sp.slice(0, 8)} → ${r.ok ? (r.data.title + " | " + r.data.url) : "ERR: " + r.error}`);
  }
  ws.close(); process.exit(0);
});
ws.on("error", (e) => { console.error("WS 오류:", e.message); process.exit(1); });
