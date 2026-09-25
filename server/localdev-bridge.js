// 로컬 데브 화면의 서버 쪽. localdev 라우터에서 상태를 읽고 시작·정지·종료를 컨트롤 서버에 전한다.
//
// 소유 범위
//   localdev.* WS 메시지 두 종류. localdev.status 는 status.json 을, localdev.action 은 /api/<동작> 을 대신 부른다.
//
// 유지 조건
//   렌더러가 직접 부르지 못하는 이유가 둘이다. status.json 에는 CORS 헤더가 없고, 컨트롤 서버는
//   Origin 이 http://localdev.test 인 요청만 받는다. 컨트롤 서버는 같은 사용자의 로컬 프로세스를 이미
//   같은 권한으로 보므로 이 서버가 그 Origin 을 적어 보낸다. 대신 여기서 이 Mac 의 연결(ws._local)만 받는다.
//   주소는 라우터(localdev.test)를 거친다. 대시보드가 쓰는 경로와 같아야 라우터가 내려갔을 때 연결
//   실패로 드러난다. 파일을 직접 읽으면 데몬이 멈춘 뒤의 낡은 상태를 정상처럼 보여 준다.
//   전역 fetch 를 쓴다. 기능 검사(test/feature-server.mjs)가 외부 네트워크를 이 이름으로 막는다.

const BASE = "http://localdev.test";
const ACTIONS = new Set(["start", "stop", "kill"]);
const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;
const STATUS_TIMEOUT = 4000;
// 컨트롤 서버의 stop 은 최대 8초, start 는 3초 생존 확인을 기다린다.
const ACTION_TIMEOUT = 15000;

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
}

async function readStatus() {
  try {
    const res = await fetch(`${BASE}/status.json?_=${Date.now()}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(STATUS_TIMEOUT) });
    if (!res.ok) return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data || typeof data !== "object" || !Array.isArray(data.routes) || !Array.isArray(data.projects)) {
      return { ok: false, reason: "unreachable", detail: "status.json 형식이 다릅니다" };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: "unreachable", detail: String(e?.cause?.code || e?.name || e?.message || e) };
  }
}

async function runAction(action, name, port) {
  const body = { name };
  if (action === "kill") body.port = port;
  try {
    const res = await fetch(`${BASE}/api/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify(body),
      // 라우터가 3xx 를 주면 조작 요청이 다른 주소로 다시 가므로 따라가지 않는다.
      redirect: "error",
      signal: AbortSignal.timeout(ACTION_TIMEOUT),
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && !!j.ok, status: res.status, error: j.error || null };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.cause?.code || e?.name || e?.message || e) };
  }
}

export function handleLocaldev(ws, msg) {
  if (!msg.type.startsWith("localdev.")) return false;
  if (msg.type === "localdev.status") {
    // 창이 보낸 요청 id 를 그대로 돌려준다. 창은 이것으로 응답이 어느 요청 것인지 가린다.
    const id = String(msg.id || "");
    if (!ws._local) { send(ws, { type: "localdev.status", id, ok: false, reason: "remote" }); return true; }
    readStatus().then((out) => send(ws, { type: "localdev.status", ...out, id }));
    return true;
  }
  if (msg.type === "localdev.action") {
    const id = String(msg.id || "");
    const action = String(msg.action || "");
    const name = String(msg.name || "");
    const port = Number(msg.port);
    const fail = (error) => send(ws, { type: "localdev.result", id, ok: false, status: 0, error });
    if (!ws._local) return fail("local only"), true;
    if (!ACTIONS.has(action)) return fail("bad action"), true;
    if (!NAME_RE.test(name)) return fail("invalid name"), true;
    if (action === "kill" && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return fail("bad port"), true;
    runAction(action, name, port).then((out) => send(ws, { type: "localdev.result", id, ...out }));
    return true;
  }
  return false;
}
