// 서버 프로세스는 앱이 관리한다. 다만 다른 서버는 건드리지 않는다.
//
// 이 둘을 나누는 이유: 서버는 사용자 도구의 상태(탭·계정·기록)를 들고 있다. 앱을
// 켰다는 이유로 그것을 교체하면 그 상태가 사라진다. 반대로 앱이 자기가 띄운 서버를
// 남기고 종료하면, 다음에 켠 앱이 이전 서버에 붙어 "고쳤는데 그대로"가 된다.
import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { freePort } from "./lib/net.mjs";

const require = createRequire(import.meta.url);
const { ServerHost, probe } = require("../native/electron/server-host.cjs");

const fakeApp = { isPackaged: false };
// 오류를 버리지 않는다. listening 콜백만 달면 그 포트를 다른 프로세스가 가져갔을 때
// 이 promise 가 해소되지 않는다. 검사는 시간 초과로 끝나고 이유는 아무 데도 남지 않는다.
// 포트를 고르는 것과 실제로 잡는 것 사이에 틈이 있어 같은 저장소에서 다른 작업이 돌면
// 이 틈에 걸릴 수 있다. 오류를 남기면 무엇이 어느 포트에서 막혔는지 확인할 수 있다.
const listen = (server, port) => new Promise((resolve, reject) => {
  server.once("error", (e) => reject(new Error(`포트 ${port} 를 잡지 못했다: ${e.code || e.message}`)));
  server.listen(port, "127.0.0.1", resolve);
});
const close = (server) => new Promise((r) => server.close(r));
const health = (port) => new Promise((r) => {
  const t = setTimeout(() => r(null), 15000);
  const tick = async () => {
    const h = await probe(port);
    if (h) { clearTimeout(t); return r(h); }
    setTimeout(tick, 200);
  };
  tick();
});

test("아무도 없으면 probe는 null이다", async () => {
  assert.equal(await probe(await freePort()), null);
});

// 같은 상태 폴더를 보는 서버라고 답하는 가짜. 붙어야 하는 쪽이다.
function fakeServer(port, stateDir, pid = 99999) {
  return http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pid, port, stateDir }));
  });
}

test("같은 상태 폴더의 서버가 이미 있으면 붙기만 한다 — 띄우지도, 나갈 때 죽이지도 않는다", async () => {
  const port = await freePort();
  const stateDir = "/tmp/ac-test-nonexistent";
  const other = fakeServer(port, stateDir);
  await listen(other, port);

  const host = new ServerHost({ app: fakeApp, port, stateDir, onLog: () => {} });
  const r = await host.start();
  assert.equal(r.attached, true, "떠 있는 서버를 보고도 자기 것을 또 띄우면 상태 파일 주인이 둘이 된다");
  assert.equal(host.child, null, "붙었으면 자식이 없어야 한다");
  assert.equal(host.owned, false, "남의 서버를 자기 것으로 표시하면 종료 시 죽인다");
  assert.equal(r.health.pid, 99999);

  host.stop();
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal((await probe(port)).pid, 99999, "붙기만 한 서버는 앱이 나가도 살아 있어야 한다");
  await close(other);
});

test("다른 상태 폴더를 쓰는 서버에는 붙지 않고, 그 자리에 자식도 띄우지 않는다", async () => {
  // 포트가 같다고 같은 서버가 아니다. 개발 인스턴스나 다른 프로그램에 붙으면 사용자는 자기
  // 탭·북마크가 사라진 화면을 보고 다른 상태를 고치게 된다. 거기에 자식을 띄우는 것도
  // 안 된다. 그 자식은 자물쇠만 점유한 채 포트를 못 잡고 계속 재시도한다.
  const port = await freePort();
  const other = fakeServer(port, "/tmp/ac-test-남의-상태", 12345);
  await listen(other, port);

  const host = new ServerHost({ app: fakeApp, port, stateDir: "/tmp/ac-test-우리-상태", onLog: () => {} });
  const r = await host.start();
  assert.equal(r.attached, false, "다른 상태 폴더의 서버에 붙으면 안 된다");
  assert.equal(host.child, null, "그 자리에 자식을 띄우면 자물쇠만 쥔 좀비가 된다");
  assert.equal(r.conflict.pid, 12345, "무엇이 그 자리에 있는지 알려야 사람이 고칠 수 있다");

  host.stop();
  await close(other);
});

test("포트만 같고 우리 것이 아닌 응답은 통과시키지 않는다", () => {
  const host = new ServerHost({ app: fakeApp, port: 4271, stateDir: "/tmp/ac-state", onLog: () => {} });
  assert.equal(host.matches({ ok: true, port: 4271, stateDir: "/tmp/ac-state" }), true);
  assert.equal(host.matches({ ok: true, port: 4271, stateDir: "/tmp/ac-state/" }), true, "경로 표기 차이는 같은 것으로 본다");
  assert.equal(host.matches({ ok: true, port: 4271, stateDir: "/tmp/other" }), false);
  assert.equal(host.matches({ ok: true, port: 4291, stateDir: "/tmp/ac-state" }), false);
  assert.equal(host.matches({ hello: "world" }), false, "우연히 JSON 200을 주는 남의 프로그램");
  assert.equal(host.matches(null), false);
});

test("같은 폴더를 다른 이름으로 부르는 것을 다르다고 하지 않는다", () => {
  // macOS에서 /tmp는 /private/tmp의 symlink다. 문자열로만 비교하면 자기 서버를 다른 것으로 보고
  // 붙지 않는다. 그러면 앱은 창만 열고 감시도 켜지 않은 채 재연결 상태에 머문다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-same-"));
  try {
    const viaTmp = dir.startsWith("/private/") ? dir.slice("/private".length) : dir;
    const host = new ServerHost({ app: fakeApp, port: 4271, stateDir: viaTmp, onLog: () => {} });
    assert.equal(host.matches({ ok: true, port: 4271, stateDir: dir }), true,
      `${viaTmp} 와 ${dir} 는 같은 폴더다`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("자식이 이미 있으면 또 띄우지 않는다", async () => {
  // 감시 tick과 backoff 재시작이 겹치면 자식이 둘이 되고, this.child는 하나만 가리킨다.
  // 그러면 앱을 꺼도 종료되지 않는 고아 서버가 남는다.
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-double-"));
  const host = new ServerHost({ app: fakeApp, port, stateDir, onLog: () => {} });
  try {
    await host.start();
    const first = host.child;
    assert.ok(first, "자식이 떠 있어야 이 검사가 뜻이 있다");
    host.spawnOnce();
    assert.equal(host.child, first, "두 번째 spawnOnce가 자식을 갈아치웠다 — 앞의 것은 추적에서 사라진다");
  } finally {
    host.stop();
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("붙어 있던 서버가 사라지면 앱이 이어서 띄운다", async () => {
  // 외부에서 서버 관리 잡을 내리면 이 상황이 된다. 감시가 없으면 화면은 "재연결 중…" 상태로
  // 멈추고, 앱은 자기가 서버를 띄울 수 있다는 것을 알지 못한다.
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-watch-"));
  const other = fakeServer(port, stateDir);
  await listen(other, port);

  process.env.IRIS_SERVER_WATCH_MS = "2000";
  const host = new ServerHost({ app: fakeApp, port, stateDir, onLog: () => {} });
  try {
    assert.equal((await host.start()).attached, true);
    await close(other);                       // 붙어 있던 서버가 사라진다
    const took = await (async () => {
      for (let i = 0; i < 60; i++) {
        const h = await probe(port);
        if (h && h.stateDir === stateDir && host.owned) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
    assert.ok(took, "붙어 있던 서버가 사라졌는데 앱이 이어받지 않았다");
  } finally {
    delete process.env.IRIS_SERVER_WATCH_MS;
    host.stop();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("아무도 없으면 자기 서버를 띄우고, 나갈 때 데려간다", async () => {
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-host-"));
  const host = new ServerHost({ app: fakeApp, port, stateDir, onLog: () => {} });
  try {
    const r = await host.start();
    assert.equal(r.attached, false, "빈 자리에서는 자기 서버를 띄워야 한다");
    assert.ok(r.health, "띄운 서버가 healthz로 답해야 한다");
    assert.equal(r.health.port, port);
    assert.equal(r.health.stateDir, stateDir, "자식은 앱이 지정한 상태 폴더를 써야 한다 — 아니면 설치본과 개발본이 같은 파일을 쓴다");
    assert.ok(host.child && host.owned);

    // 자식에게 넘긴 로그가 실제로 상태 폴더에 쌓인다. 무슨 일이 있었는지 볼 곳이 있어야 한다.
    assert.ok(fs.existsSync(path.join(stateDir, "server.log")));

    host.stop();
    const gone = await (async () => {
      for (let i = 0; i < 40; i++) {
        if (!(await probe(port))) return true;
        await new Promise((r2) => setTimeout(r2, 150));
      }
      return false;
    })();
    assert.ok(gone, "앱이 나가면 자기가 띄운 서버도 내려가야 한다 — 남으면 다음 앱이 옛 서버에 붙는다");
    // 자물쇠도 함께 풀려야 다음 서버가 기다리지 않고 바로 뜬다.
    assert.equal(fs.existsSync(path.join(stateDir, "server.lock")), false, "SIGTERM 핸들러가 server.lock을 지워야 한다");
  } finally {
    host.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("죽어도 무한히 다시 띄우지 않는다 — 재시도 예산이 있다", async () => {
  const host = new ServerHost({ app: fakeApp, port: await freePort(), stateDir: "/tmp/ac-test-nonexistent", onLog: () => {} });
  host.owned = true;
  host.stopping = true; // 실제 재기동은 막고 예산 계산만 본다
  const budget = [];
  for (let i = 0; i < 10; i++) {
    host.stopping = false;
    host.onChildExit(1, null);
    budget.push(host.owned);
  }
  host.stopping = true;
  assert.equal(budget[0], true, "첫 죽음은 다시 띄워야 한다");
  assert.equal(budget[budget.length - 1], false, "빠르게 반복해 죽으면 멈추고 사람에게 알려야 한다 — launchd KeepAlive가 6,957번 돈 자리다");
});
