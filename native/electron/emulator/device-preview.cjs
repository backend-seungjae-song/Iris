// 에뮬레이터 탭 기기에서 실행 중인 Flutter 앱의 화면 비율을 바꾼다. 앱이 device_preview 패키지를 켜고
// `ext.device_preview.*` 서비스 확장을 노출할 때만 동작한다. 시뮬레이터를 새로 만들지 않고 앱 안에서
// 다른 기기의 화면 크기·안전 영역·OS 를 흉내 내므로, 같은 탭의 화면을 그대로 누르며 확인할 수 있다.
//
// 제공 API
//   createDevicePreview() → { presets(udid), apply(udid, presetId|null) }
//   presets 는 { ok, app, current, presets:[{id,name,platform}] }, apply 는 { ok, current }.
//   앱이 없으면 { ok:false, code:"no_app" }.
//
// 앱 찾기
//   Dart VM 서비스가 mDNS(_dartVmService._tcp)로 광고하는 주소를 모은다(server/app-pick.js 와 같은 경로).
//   iOS 시뮬레이터 앱은 Mac 프로세스라 getVM 의 pid 를 ps 로 보면 실행 파일 경로에
//   `CoreSimulator/Devices/<udid>/` 가 들어 있다. 이것으로 탭의 기기와 앱을 짝짓는다.
//   Android 에뮬레이터 앱은 mDNS 에 잡히지 않아 아직 찾지 못한다.
const { execFile, spawn } = require("child_process");
const WebSocket = require("ws");

const DNSSD_MS = 1500;
const CALL_TIMEOUT_MS = 6000;
// 같은 기기를 짧은 간격으로 다시 물을 때 dns-sd 를 매번 실행하지 않는다. 핫 리스타트하면 포트가 바뀌므로
// 연결이 끊긴 대상은 다시 찾는다.
const MISS_CACHE_MS = 10000;
const IOS_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function dnssd(args, ms) {
  return new Promise((resolve) => {
    let out = "";
    let p;
    try { p = spawn("dns-sd", args, { stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve(""); return; }
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => resolve(out));
    const t = setTimeout(() => { try { p.kill("SIGTERM"); } catch {} resolve(out); }, ms);
    p.on("close", () => { clearTimeout(t); resolve(out); });
  });
}

async function discoverMdns() {
  const browse = await dnssd(["-B", "_dartVmService._tcp", "local."], DNSSD_MS);
  const names = new Set();
  for (const line of browse.split("\n")) {
    const m = /_dartVmService\._tcp\.\s+(.+?)\s*$/.exec(line);
    if (m && m[1] && !/Instance Name/.test(line)) names.add(m[1].trim());
  }
  const found = [];
  for (const name of names) {
    const res = await dnssd(["-L", name, "_dartVmService._tcp", "local."], 1200);
    const port = /:(\d+)\s+\(interface/.exec(res);
    const code = /authCode=(\S+)/.exec(res);
    if (port && code) found.push({ port: Number(port[1]), token: code[1] });
  }
  return found;
}

function commandOf(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 }, (err, out) => resolve(err ? "" : String(out || "")));
  });
}

class VmClient {
  constructor(port, token) {
    this.uri = `ws://127.0.0.1:${port}/${token}/ws`;
    this.ws = null; this.seq = 0; this.waiting = new Map(); this.dead = false;
    this.isolateId = null; this.pid = null; this.extensions = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.uri);
      this.ws = ws;
      const fail = (e) => { this.dead = true; try { ws.close(); } catch {} reject(e instanceof Error ? e : new Error(String(e))); };
      const timer = setTimeout(() => fail(new Error("연결 시간 초과")), CALL_TIMEOUT_MS);
      ws.on("message", (d) => {
        let m; try { m = JSON.parse(d.toString()); } catch { return; }
        const w = m.id != null ? this.waiting.get(String(m.id)) : null;
        if (!w) return;
        this.waiting.delete(String(m.id));
        if (m.error) w.reject(new Error(m.error.message || "vm error")); else w.resolve(m.result);
      });
      ws.on("error", (e) => { clearTimeout(timer); fail(e); });
      ws.on("close", () => { this.dead = true; for (const w of this.waiting.values()) w.reject(new Error("closed")); this.waiting.clear(); });
      ws.on("open", async () => {
        try {
          const vm = await this.call("getVM");
          const iso = (vm.isolates || []).find((i) => i.name === "main") || (vm.isolates || [])[0];
          if (!iso) throw new Error("isolate 없음");
          const info = await this.call("getIsolate", { isolateId: iso.id });
          this.isolateId = iso.id;
          this.pid = vm.pid || null;
          this.extensions = info.extensionRPCs || [];
          clearTimeout(timer);
          resolve(this);
        } catch (e) { clearTimeout(timer); fail(e); }
      });
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) { reject(new Error("연결 없음")); return; }
      const id = String(++this.seq);
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error("시간 초과: " + method)); }, CALL_TIMEOUT_MS);
    });
  }

  // 확장 응답은 JSON 문자열로 감싸 오지 않고 result 객체로 온다. 실패는 { error:{code,message} } 봉투다.
  async ext(name, params = {}) {
    const r = await this.call(`ext.device_preview.${name}`, { isolateId: this.isolateId, ...params });
    if (r && r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    return r;
  }

  close() { this.dead = true; try { this.ws.close(); } catch {} }
}

function createDevicePreview() {
  const clients = new Map();   // udid → VmClient
  const misses = new Map();    // udid → 마지막으로 못 찾은 시각

  async function find(udid) {
    const known = clients.get(udid);
    if (known && !known.dead) return known;
    clients.delete(udid);
    if (!IOS_UDID_RE.test(udid || "")) return null;
    if (Date.now() - (misses.get(udid) || 0) < MISS_CACHE_MS) return null;
    for (const c of await discoverMdns()) {
      const client = new VmClient(c.port, c.token);
      try { await client.connect(); } catch { continue; }
      const onDevice = client.pid && (await commandOf(client.pid)).includes(`/Devices/${udid}/`);
      if (onDevice && client.extensions.includes("ext.device_preview.applyPreset")) {
        clients.set(udid, client);
        misses.delete(udid);
        return client;
      }
      client.close();
    }
    misses.set(udid, Date.now());
    return null;
  }

  const NO_APP = { ok: false, code: "no_app", error: "이 기기에 화면 비율을 바꿀 수 있는 앱(device_preview 를 켠 디버그 실행)이 없습니다." };

  async function presets(udid) {
    const client = await find(udid);
    if (!client) return NO_APP;
    try {
      const [list, state] = await Promise.all([client.ext("listPresets"), client.ext("getState")]);
      return {
        ok: true,
        current: state?.simulation?.presetId || null,
        presets: (list.presets || []).map((p) => ({ id: p.id, name: p.name, platform: p.platform })),
      };
    } catch (e) {
      client.close();
      return { ok: false, error: String(e.message || e) };
    }
  }

  async function apply(udid, presetId) {
    const client = await find(udid);
    if (!client) return NO_APP;
    try {
      const state = presetId
        ? await client.ext("applyPreset", { presetId: String(presetId), source: "iris" })
        : await client.ext("reset", { source: "iris" });
      return { ok: true, current: state?.simulation?.presetId || null };
    } catch (e) {
      if (e.code !== "unknownPreset") client.close();
      return { ok: false, error: String(e.message || e) };
    }
  }

  function dispose() { for (const c of clients.values()) c.close(); clients.clear(); }

  return { presets, apply, dispose };
}

module.exports = { createDevicePreview };
