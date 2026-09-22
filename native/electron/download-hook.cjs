// 내려받을 파일의 이름과 저장 위치를 정한다.
//
// 소유 범위
//   파일 이름 정규화 규칙과, 아직 저장되지 않았지만 이미 예약된 경로의 목록.
//
// 제공 API
//   createDownloadHook(deps) 가 safeDownloadName · reserveDownloadPath · installDownloadHook ·
//   noteExplicitSave 를 제공한다.
//   예약 목록 자체는 제공하지 않는다.
//
// 의존 대상
//   Electron 을 require 하지 않는다. 모든 창을 훑는 일과 fs·path·내려받기 상태·시각을 주입받는다.
//
// 유지 조건
//   이름은 서버가 보내는 값이므로 그대로 믿지 않는다. 경로 구분자·제어문자·앞의 점·
//   끝의 점과 공백·Windows 예약 이름을 제거한다. 길이 상한은 바이트 기준이다(한글은 한 자 3바이트).
//   저장 경로는 미리 예약한다. 파일 존재 여부만 확인하면 같은 이름의 내려받기 둘이 아직
//   존재하지 않는 같은 경로를 선택해 하나가 다른 하나를 덮어쓴다.
//   저장 위치가 미리 지정돼 있으면 setSavePath 로 정한다. 지정하지 않으면 네이티브 저장 창이
//   떠서 사용자가 누를 때까지 자동화가 멈춘다.
//   어느 탭에서 받았는지 함께 보낸다. 없으면 다른 탭에서 받은 파일이 엉뚱한 기록에 섞인다.
//   로컬 파일(file:)은 내려받지 않고 앱으로 넘긴다. 그 파일은 이미 디스크에 있고, 브라우저가
//   렌더링하지 못해 내려받기로 분류된 것뿐이다. 사용자가 「다른 이름으로 저장」을 요청한 경우는
//   예외로 그대로 저장한다(noteExplicitSave 가 그 표시를 보관한다).
//   받고 나서 여는 것은 로컬(loopback)에서 받은 것뿐이다. 무엇을 열지는 렌더러의 등록표가 정하므로
//   여기서는 저장된 경로만 보낸다.
//
// 영향 범위
//   공급자는 main.cjs 의 Electron BrowserWindow 와 download-state 다.
//   양방향 소비자는 하드닝된 세션마다 등록되는 will-download 하나다. 여기가 어긋나면
//   사용자에게는 내려받기 실패로만 보이고 원인을 알 수 없다.
//   현재 목록 확인: node bin/importers.mjs native/electron/download-hook.cjs

// 파일 이름은 서버가 보내는 값이므로 그대로 믿으면 안 된다. 경로 구분자만 바꾸면 제어문자·
// 끝의 점과 공백·Windows 예약 이름이 그대로 통과하고, 그런 이름은 저장 자체가 실패한다
// (사용자에게는 내려받기 실패로만 보인다).
//
// 저장 경로는 미리 예약한다. 파일 존재 여부만 보고 정하면 같은 이름의 내려받기가 동시에
// 시작될 때 아직 존재하지 않는 같은 경로를 선택해 하나가 다른 하나를 덮어쓴다.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const { isFileUrl, isLoopbackUrl } = require("./local-link.cjs");

// 사용자가 「다른 이름으로 저장」을 요청한 주소는 잠시 표시해 둔다. 표시가 없으면 file: 내려받기를
// 앱으로 넘기는 아래 규칙이 그 저장까지 가로채, 저장 요청이 열기로 바뀐다.
const EXPLICIT_SAVE_TTL_MS = 15000;

function createDownloadHook({ fs, path, downloadState, allWindows, now = Date.now,
  aiDriving = () => false, noteBlockedDownload = () => {} }) {
  const reservedPaths = new Set();
  const explicitSaves = new Map();   // url → 요청 시각
  function noteExplicitSave(url) {
    const u = String(url || ""); if (!u) return;
    explicitSaves.set(u, now());
    for (const [k, at] of explicitSaves) if (now() - at > EXPLICIT_SAVE_TTL_MS) explicitSaves.delete(k);
  }
  function takeExplicitSave(url) {
    const at = explicitSaves.get(String(url || ""));
    if (at == null) return false;
    explicitSaves.delete(String(url || ""));
    return now() - at <= EXPLICIT_SAVE_TTL_MS;
  }
  // 이 내려받기를 시작한 탭의 창. 없으면 결과를 알릴 대상이 없다.
  function toHost(wc, channel, payload) {
    try {
      const host = wc && !wc.isDestroyed() && wc.hostWebContents;
      if (host && !host.isDestroyed()) { host.send(channel, payload); return true; }
    } catch {}
    return false;
  }
  function safeDownloadName(raw) {
    let n = String(raw || "").normalize("NFC");
    n = n.replace(/[/\\]/g, "_");                    // 경로 구분자. 다른 폴더로 벗어나는 것을 막는다
    n = n.replace(/[\x00-\x1f\x7f]/g, "");           // 제어문자
    n = n.replace(/[<>:"|?*]/g, "_");                // 다른 OS에서 못 쓰는 글자(옮겨 갈 수 있다)
    n = n.replace(/^\.+/, "");                       // 앞의 점. 숨김 파일이 되어 보이지 않는다
    n = n.replace(/[. ]+$/, "");                     // 끝의 점·공백. Windows 가 저장을 거부한다
    if (WIN_RESERVED.test(n)) n = "_" + n;
    if (!n) n = "download";
    // 파일 이름 길이 상한은 바이트 기준이다. 한글은 한 자에 3바이트라 글자 수로 자르면 넘친다.
    const ext = path.extname(n).slice(0, 20);
    let base = path.basename(n, path.extname(n));
    while (Buffer.byteLength(base + ext, "utf8") > 200) base = base.slice(0, -1);
    return (base || "download") + ext;
  }
  function reserveDownloadPath(dir, raw) {
    const name = safeDownloadName(raw);
    const ext = path.extname(name), base = path.basename(name, ext);
    for (let n = 0; n < 10000; n++) {
      const p = path.join(dir, n ? `${base} (${n})${ext}` : name);
      if (!reservedPaths.has(p) && !fs.existsSync(p)) { reservedPaths.add(p); return p; }
    }
    // 1만 개가 다 찼다. 마지막 자리를 덮어쓰지 않고 겹치지 않는 이름을 만든다.
    const p = path.join(dir, `${base} (${now()})${ext}`);
    reservedPaths.add(p); return p;
  }
  function installDownloadHook(sess) {
    sess.on("will-download", (_ev, item, wc) => {
      const sourceUrl = (() => { try { return String(item.getURL() || ""); } catch { return ""; } })();
      // 로컬 파일 링크는 내려받을 대상이 아니다. 그 파일은 이미 디스크에 있고, 브라우저가
      // 렌더링하지 못해 내려받기로 분류된 것뿐이므로(표·문서·압축파일) 앱이 받아서 그린다.
      // 사용자가 「다른 이름으로 저장」을 요청한 경우는 요청대로 저장한다.
      if (isFileUrl(sourceUrl) && !takeExplicitSave(sourceUrl)) {
        if (toHost(wc, "ac-open-local", { target: sourceUrl })) {
          try { item.cancel(); } catch {}
          return;
        }
      }
      try {
        // 저장 위치가 미리 지정돼 있으면 setSavePath 로 정한다. 그러면 Electron이 네이티브 저장
        // 창을 띄우지 않는다. 그 창이 뜨면 사용자가 누를 때까지 자동화가 멈춘다.
        const downloadStatus = downloadState.snapshot();
        // 저장 위치를 정하지 않은 채 자동화가 시작한 내려받기는 취소한다. 두면 Electron 이 OS 저장
        // 창을 띄우고, 그 창이 닫힐 때까지 조작이 막힌다.
        // 임의 위치에 자동 저장하지도 않는다. 어디에 무엇을 남길지는 미리 지정한 저장 위치가 정하며,
        // 지정하지 않은 채 남기는 것은 사용자가 요청하지 않은 쓰기다. 자동화는 browser_download 로
        // 위치를 정하고 다시 실행하면 된다. 사용자가 시작한 내려받기는 저장 창을 그대로 띄운다.
        if (!downloadStatus.dir && wc && !wc.isDestroyed() && aiDriving(wc.id)) {
          noteBlockedDownload(wc, item);
          // 사용자에게도 한 줄 알린다. 사용자가 방금 누른 것이 여기서 취소됐을 수 있고, 알림이
          // 없으면 버튼이 동작하지 않는 것처럼 보인다.
          try {
            const host = wc.hostWebContents;
            const line = `내려받기를 취소했습니다: ${item.getFilename()} — AI 조작 중이고 받을 자리가 정해져 있지 않았습니다. 다시 눌러 주세요.`;
            if (host && !host.isDestroyed()) host.send("ac-native-notice", { text: line });
            else for (const w of allWindows()) if (!w.isDestroyed()) w.webContents.send("ac-native-notice", { text: line });
          } catch {}
          item.cancel();
          return;
        }
        if (downloadStatus.dir) {
          const dest = reserveDownloadPath(downloadStatus.dir, item.getFilename());
          item.setSavePath(dest);
          item.once("done", () => reservedPaths.delete(dest));
          downloadState.claim(dest);
          item.once("done", (__e, state) => {
            downloadState.complete(dest, state);
          });
        }
      } catch {}
      try {
        // 내려받은 뒤에는 뷰어가 맡는 파일만 연다. 판정은 렌더러의 등록표가 하므로 여기서는 경로만
        // 보낸다. 대상은 로컬(loopback)에서 받은 것뿐이다. 일반 웹에서 받은 파일까지 열면 사용자가
        // 요청하지 않은 창이 뜬다. 저장 위치를 지정하지 않아 저장 창에서 고른 경우도 여기로 온다.
        if (isLoopbackUrl(sourceUrl)) {
          item.once("done", (___e, doneState) => {
            if (doneState !== "completed") return;
            let saved = ""; try { saved = String(item.getSavePath() || ""); } catch {}
            if (saved) toHost(wc, "ac-downloaded", { path: saved });
          });
        }
      } catch {}
      try {
        // 어느 탭에서 받은 것인지 함께 보낸다. 이 값이 없으면 받는 창이 자기 녹화 대상 탭의 결과인지
        // 구분할 수 없어, 다른 탭이나 공유 브라우저에서 받은 파일이 엉뚱한 기록에 섞인다.
        const ev = { k: "dialog", kind: "download", msg: item.getFilename(),
          wc: wc && !wc.isDestroyed() ? wc.id : null,
          url: String(item.getURL() || "").slice(0, 300), bytes: item.getTotalBytes() || 0 };
        // hostWebContents는 webview 게스트에만 있다. 없으면(버전·경로 차이) 누락시키지 않고 모든 창에 보낸다.
        // 렌더러는 녹화 중일 때만 받으므로 중복은 녹화 중인 창 수만큼이고, 누락보다 낫다.
        const host = wc && wc.hostWebContents;
        if (host && !host.isDestroyed()) host.send("ac-rec-native", ev);
        else for (const w of allWindows()) if (!w.isDestroyed()) w.webContents.send("ac-rec-native", ev);
      } catch {}
    });
  }
  return { safeDownloadName, reserveDownloadPath, installDownloadHook, noteExplicitSave };
}

module.exports = { createDownloadHook };
