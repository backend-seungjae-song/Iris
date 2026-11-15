// 세션 공유 백그라운드 탭. 여러 AI 세션이 같은 페이지를 읽을 때 세션마다 탭을 열지 않고 Iris 가 소유한 숨은 탭 하나를 같이 씀
// - 숨은 창 하나 안의 <webview> 로 띄움: 봇 감지 회피·구글 로그인 처리가 webview 종류에만 붙음(main.cjs web-contents-created, webview-lifecycle.cjs)
// - 상태는 메인이 가짐: MCP worker 를 교체해도 탭이 고아로 남지 않음
// - 서버에는 팝업과 같은 browser-tab-wc/browser-tab-gone 으로 등록 · 스페이스가 없어 세션 탭 목록에는 안 보임
// - 캐시 없음: 열린 탭이 캐시 · 마지막 사용 뒤 idleMs 지나면 닫아 메모리 반환
// - 큰 결과는 서버 명령 결과 보관(dispatcher·browser-dialog)을 거치지 않게 여기서 파일로 씀(save)
// - 팝업은 열지 않음(allowpopups 없음): 숨은 탭이 사용자 화면에 창을 띄우면 안 됨 · 로그인은 같은 프로필 일반 탭에서

const path = require("node:path");

const HOST_HTML = "data:text/html;charset=utf-8,<!doctype html><html><body style='margin:0;overflow:hidden'></body></html>";
const VIEW_W = 1440, VIEW_H = 900;
const ATTACH_TIMEOUT_MS = 15000;
const READ_CHUNK = 4 * 1024 * 1024;

// 같은 프로필·같은 주소면 같은 탭 · 해시까지 같아야 같은 주소(해시 라우팅 페이지)
function bgTabKey(url, partition) {
  return `${partition}|${new URL(String(url)).href}`;
}

// 열 수 있는 요청인지 · 실패면 사람이 읽을 이유
function checkOpenRequest({ url, partition } = {}, isAllowedPartition) {
  let u;
  try { u = new URL(String(url || "")); } catch { return "url 이 주소 형식이 아닙니다."; }
  if (!/^https?:$/.test(u.protocol)) return "http(s) 주소만 공유 탭으로 열 수 있습니다.";
  if (!isAllowedPartition(String(partition || ""))) return "알 수 없는 로그인 칸(partition)입니다.";
  return null;
}

// 지금 닫을 탭 키 목록 · lastUsed 기준
function idleKeys(entries, now, idleMs) {
  const out = [];
  for (const [key, entry] of entries) if (now - entry.lastUsed >= idleMs) out.push(key);
  return out;
}

function createBgTabs({ BrowserWindow, webContents, webviewPreloadPath, guardWebviewPartition, isAllowedPartition, ctlSend, randomUuid,
  fs = require("node:fs"), idleMs = 3 * 60 * 1000, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, log = () => {} }) {
  const entries = new Map();   // key → { tabId, domId, wc, guest, lastUsed, report }
  const opening = new Map();   // key → Promise (처음 여는 중에 온 다른 세션은 같은 열기를 기다림)
  let host = null, hostReady = null, sweep = null;

  const hostJs = (src) => host.webContents.executeJavaScript(src);

  function ensureHost() {
    if (host && !host.isDestroyed()) return hostReady;
    host = new BrowserWindow({
      show: false, width: VIEW_W, height: VIEW_H, skipTaskbar: true, focusable: false,
      webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, spellcheck: false },
    });
    // 일반 브라우저 창과 같은 webview 설정(browser-window-manager.cjs will-attach-webview)
    host.webContents.on("will-attach-webview", (_ev, webPreferences) => {
      webPreferences.preload = webviewPreloadPath;
      guardWebviewPartition(webPreferences);
      webPreferences.nodeIntegrationInSubFrames = true;
      webPreferences.disableDialogs = true;
      webPreferences.backgroundThrottling = false;
      webPreferences.transparent = false;
    });
    host.on("closed", () => { host = null; hostReady = null; });
    hostReady = host.loadURL(HOST_HTML).then(() => host);
    if (!sweep) {
      sweep = setIntervalFn(() => { for (const key of idleKeys(entries, now(), idleMs)) void close(key); }, 15000);
      if (sweep.unref) sweep.unref();
    }
    return hostReady;
  }

  // 붙은 webview 의 guest 를 그 요소에서 직접 읽음 · did-attach-webview 는 어느 요소인지 알려 주지 않음
  async function guestOf(domId) {
    const end = now() + ATTACH_TIMEOUT_MS;
    while (now() < end) {
      const id = await hostJs(`(() => { const w = document.getElementById(${JSON.stringify(domId)}); try { return w ? w.getWebContentsId() : -1; } catch { return 0; } })()`);
      if (id === -1) return null;
      if (id > 0) { const guest = webContents.fromId(id); if (guest && !guest.isDestroyed()) return guest; }
      await sleep(100);
    }
    return null;
  }

  async function create(key, url, partition) {
    await ensureHost();
    const tabId = "bg:" + randomUuid();
    const domId = "bg-" + tabId.slice(3);
    // 사람 확인(ac-botcheck)은 webview preload 가 sendToHost 로 알림 · 숨은 창은 통과할 수 없으니 기록만 함
    await hostJs(`(() => {
      const w = document.createElement("webview");
      w.id = ${JSON.stringify(domId)};
      w.setAttribute("partition", ${JSON.stringify(partition)});
      w.setAttribute("src", ${JSON.stringify(url)});
      w.style.cssText = "position:absolute;left:0;top:0;width:${VIEW_W}px;height:${VIEW_H}px;display:flex";
      const marks = window.__bgChallenge || (window.__bgChallenge = {});
      w.addEventListener("ipc-message", (e) => { if (e.channel === "ac-botcheck") marks[w.id] = true; });
      w.addEventListener("did-navigate", () => { delete marks[w.id]; });
      document.body.appendChild(w);
      return 1;
    })()`);
    const guest = await guestOf(domId);
    if (!guest) {
      await removeElement(domId);
      throw new Error(`공유 탭 webview 가 붙지 않았습니다(${ATTACH_TIMEOUT_MS / 1000}초).`);
    }
    try { guest.setBackgroundThrottling(false); } catch {}
    const report = () => {
      let title = "", cur = "";
      try { title = guest.getTitle() || ""; cur = guest.getURL() || ""; } catch {}
      ctlSend({ type: "browser-tab-wc", wc: guest.id, tabId, url: cur || url, title: title || "공유 탭", win: "bg" });
    };
    const entry = { tabId, domId, wc: guest.id, guest, lastUsed: now(), report };
    entries.set(key, entry);
    report();
    guest.on("did-navigate", report);
    guest.on("page-title-updated", report);
    guest.once("destroyed", () => {
      if (entries.get(key) === entry) entries.delete(key);
      ctlSend({ type: "browser-tab-gone", wc: entry.wc, tabId });
    });
    log("[bg-tab] 열림", tabId, url);
    return entry;
  }

  async function removeElement(domId) {
    try {
      if (host && !host.isDestroyed()) await hostJs(`(() => { const w = document.getElementById(${JSON.stringify(domId)}); if (w) w.remove(); return 1; })()`);
    } catch {}
  }

  async function challenged(entry) {
    try { return await hostJs(`!!(window.__bgChallenge || {})[${JSON.stringify(entry.domId)}]`); } catch { return false; }
  }

  // 같은 키의 탭을 돌려주거나 새로 엶 · 부를 때마다 사용 시각 갱신과 서버 재등록(실행기 재연결 뒤 서버 장부가 비어 있을 수 있음)
  async function open({ url, partition } = {}) {
    const why = checkOpenRequest({ url, partition }, isAllowedPartition);
    if (why) throw new Error(why);
    const key = bgTabKey(url, partition);
    let entry = entries.get(key), fresh = false;
    if (!entry) {
      if (!opening.has(key)) opening.set(key, create(key, String(url), String(partition)).finally(() => opening.delete(key)));
      entry = await opening.get(key);
      fresh = true;
    } else {
      entry.report();
    }
    entry.lastUsed = now();
    return { tabId: entry.tabId, wcId: entry.wc, fresh, challenge: await challenged(entry) };
  }

  function entryOfTab(tabId) {
    for (const entry of entries.values()) if (entry.tabId === tabId) return entry;
    return null;
  }

  // 조각 끝이 서로게이트 쌍 가운데면 한 글자 앞에서 자름 · 쌍이 갈리면 UTF-8 로 바꿀 때 글자가 깨짐
  function readPart(entry, ref, off) {
    return entry.guest.executeJavaScript(`(() => { const t = ${ref}.text; let e = Math.min(t.length, ${off + READ_CHUNK});
      if (e < t.length && e > ${off + 1}) { const c = t.charCodeAt(e - 1); if (c >= 0xD800 && c <= 0xDBFF) e--; }
      return t.slice(${off}, e); })()`);
  }

  // 페이지 안 작업 결과(window.__irisJobs[jobId].text)를 파일로 · base64 면 디코딩해 씀 · 이미 있는 파일은 덮지 않음
  async function save({ tabId, jobId, file, base64 } = {}) {
    const entry = entryOfTab(String(tabId || ""));
    if (!entry) throw new Error("공유 탭이 닫혔습니다. 다시 요청하세요.");
    if (!/^j[a-z0-9]+$/.test(String(jobId || ""))) throw new Error("작업 id 형식이 아닙니다.");
    if (!path.isAbsolute(String(file || ""))) throw new Error("저장 경로는 절대 경로여야 합니다.");
    entry.lastUsed = now();
    const ref = `(window.__irisJobs || {})[${JSON.stringify(jobId)}]`;
    const length = await entry.guest.executeJavaScript(`(() => { const j = ${ref}; return j && j.state === "done" ? j.text.length : -1; })()`);
    if (length < 0) throw new Error("끝난 페이지 작업이 없습니다.");
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const fh = await fs.promises.open(file, "wx");
    let bytes = 0;
    try {
      if (base64) {
        let text = "";
        for (let off = 0; off < length;) { const part = await readPart(entry, ref, off); text += part; off += part.length; }
        const buf = Buffer.from(text, "base64");
        await fh.write(buf);
        bytes = buf.length;
      } else {
        for (let off = 0; off < length;) {
          const part = await readPart(entry, ref, off);
          off += part.length;
          const buf = Buffer.from(part, "utf8");
          await fh.write(buf);
          bytes += buf.length;
        }
      }
    } finally {
      await fh.close();
    }
    try { await entry.guest.executeJavaScript(`(() => { if (window.__irisJobs) delete window.__irisJobs[${JSON.stringify(jobId)}]; return 1; })()`); } catch {}
    return { path: file, bytes };
  }

  async function close(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    await removeElement(entry.domId);
    log("[bg-tab] 닫힘", entry.tabId);
    if (!entries.size && !opening.size) closeAll();
    return true;
  }

  function closeAll() {
    entries.clear();
    if (sweep) { clearIntervalFn(sweep); sweep = null; }
    if (host && !host.isDestroyed()) { try { host.destroy(); } catch {} }
    host = null; hostReady = null;
  }

  // 사용자 창을 고르는 코드(second-instance·창 전환)가 이 창을 빼도록
  function isHost(win) { return !!win && win === host; }

  // 서버 요청 처리 · { op: "open" | "save" | "list" | "closeAll" }
  async function handle(args = {}) {
    if (args.op === "open") return open(args);
    if (args.op === "save") return save(args);
    if (args.op === "list") return { tabs: [...entries].map(([key, e]) => ({ key, tabId: e.tabId, wcId: e.wc, idleMs: now() - e.lastUsed })) };
    if (args.op === "closeAll") { closeAll(); return { closed: true }; }
    throw new Error("알 수 없는 공유 탭 요청: " + String(args.op));
  }

  return { open, save, close, closeAll, handle, isHost };
}

module.exports = { createBgTabs, bgTabKey, checkOpenRequest, idleKeys };
