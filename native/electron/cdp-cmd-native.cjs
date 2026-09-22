// 브라우저 밖의 대화상자·파일·로그인·macOS AX를 잇는 CDP command handler.
//
// 소유 범위
//   dialog·dialogs·upload·download·login·nativewin·nativekey·nativeclick의 실행 순서와 응답.
//
// 제공 API
//   createNativeCommands(ctx)가 명령 이름별 async handler 표를 준다. 원시 상태 컨테이너는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 observation/dialog-plan/upload/download/login/result-safety/native AX 포트와
//   fs/path/os, 명령마다 넘기는 CDP send·Electron webContents. Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   dialogs 기본은 사람이 처리하고, upload 무장은 큐를 잡지 않으며, download는 명시 무장일 때만 자동화한다.
//   login은 허용된 계정만 provider가 채우고 secret은 결과에서 지우며 native 입력의 사람 경로를 보존한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 session observation·dialog plan·provider와 upload/download/result-safety/native AX다.
//   양방향 소비자는 cdp-control.cjs handler 표·default 안내, 서버 dialog plan과 CLI/MCP 파일·로그인·native 흐름이다.

function createNativeCommands({
  observation,
  planFor,
  ctlSend,
  upload,
  nodeFromArgs,
  downloadState,
  loginProvider,
  resultSafety,
  nativeAx,
  fs,
  path,
  os,
}) {
  return {
    // 지금 떠 있는 확인 창을 닫는다. 이 명령이 없으면 창이 뜬 동안 다른 명령을 실행할 수 없다.
    // 브라우저 층 명령이라 페이지가 멈춰 있어도 동작한다.
    async dialog(send, wc, args) {
      const accept = String(args.answer || "cancel") !== "cancel";
      const asked = observation.dialogOpen(wc.id);
      if (!asked) return { ok: true, none: true, note: "떠 있는 확인 창이 없습니다." };
      await send("Page.handleJavaScriptDialog", {
        accept, ...(asked.type === "prompt" && args.text != null ? { promptText: String(args.text) } : {}),
      });
      observation.closeDialog(wc.id);
      return { ok: true, answered: accept ? "ok" : "cancel", kind: asked.type, message: asked.message };
    },
    async dialogs(_send, wc, args) {  // 대화상자 자동 응답 무장/해제. 기본(해제)은 사람이 보고 누르는 지금 동작 그대로.
      const plan = planFor(wc.id);
      const raw = String(args.plan == null ? "" : args.plan).trim();
      plan.text = args.text == null ? null : String(args.text);
      // 무장은 서버에도 알려야 한다. 지금 페이지의 alert/confirm 은 네이티브 창이 아니라 주입한
      // shim 이 서버에 물어보는 형태라, Page.javascriptDialogOpening 은 오지 않는다.
      // 서버가 무장을 모르면 무장해도 사람이 누를 때까지 멈춰 있어 무장이 무효가 된다.
      const arm = (p) => ctlSend({ type: "browser-dialog-plan", wc: wc.id, plan: p, text: plan.text });
      if (!raw || raw === "off") { plan.queue = []; plan.mode = null; arm(null); return { ok: true, mode: "off", note: "사람이 처리" }; }
      const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = parts.find((s) => s !== "ok" && s !== "cancel");
      if (bad) return { error: `알 수 없는 응답 "${bad}" — ok · cancel · off 만 가능` };
      if (parts.length === 1) { plan.queue = []; plan.mode = parts[0]; arm({ mode: parts[0] }); return { ok: true, mode: parts[0] }; }
      plan.queue = parts; plan.mode = null;   // 큐가 비면 다시 사람이 처리한다. 예정에 없던 대화상자는 멈춰서 드러나는 게 낫다
      arm({ queue: parts });
      return { ok: true, queue: parts };
    },
    async upload(send, wc, args) {  // 네이티브 파일 선택 창: 페이지에 로컬 파일을 넣는다.
      const files = (Array.isArray(args.paths) ? args.paths : String(args.paths || "").split(",").map((s) => s.trim()))
        .filter(Boolean).map((p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p));
      if (!files.length) return { error: "올릴 파일 경로가 없습니다." };
      const missing = upload.invalidPaths(files);
      if (missing.length) return { error: "없거나 절대경로가 아닌 파일: " + missing.join(", ") };
      await send("DOM.enable", {});
      // ① 대상을 준 경우: 그 입력칸에 바로 넣는다. 네이티브 창이 뜨지 않아 가장 확실하다.
      if (args.ref || args.sel) {
        const { backendNodeId, sid } = await nodeFromArgs(send, wc, args);
        await send.on(sid)("DOM.setFileInputFiles", { files, backendNodeId });
        return { ok: true, files, via: "direct" };
      }
      // ② 대상을 모르는 경우(버튼이 숨은 input을 여는 흔한 형태): 선택 창을 가로채고 기다린다.
      // 무장만 하고 바로 돌려준다. 명령 큐는 탭마다 하나라 여기서 기다리면 뒤이은 click이 그 뒤에
      // 갇혀 선택창이 열리지 않는다(확인 결과: 타임아웃 뒤에야 클릭이 실행됐다).
      const ms = Math.min(120000, Math.max(1000, Number(args.timeout) || 60000));
      upload.arm(wc.id, files, ms);
      return { ok: true, armed: true, files, expiresInSec: Math.round(ms / 1000),
        note: "이제 파일 선택을 여는 버튼을 누르세요. 선택창 대신 이 파일이 들어갑니다." };
    },
    async download(_send, _wc, args) {  // 다운로드 저장 창: 무장하면 네이티브 창 없이 지정 폴더에 저장한다.
      const raw = String(args.dir == null ? "" : args.dir).trim();
      if (!raw || raw === "off") { downloadState.disarm(); return { ok: true, mode: "off", note: "사람이 저장 위치를 고릅니다", last: downloadState.snapshot().last }; }
      const dir = raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw;
      if (!path.isAbsolute(dir)) return { error: "절대경로가 필요합니다: " + raw };
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { error: "폴더를 만들 수 없습니다: " + e.message }; }
      downloadState.arm(dir, args.once === true || String(args.once) === "true");
      const downloadStatus = downloadState.snapshot();
      return { ok: true, dir, once: downloadStatus.once, last: downloadStatus.last };
    },
    async login(_send, wc, args) {  // 저장된 로그인으로 이 페이지에 로그인한다. 허용 목록에 오른 (사이트, 아이디)만 된다.
      const provider = loginProvider();
      if (!provider) return { error: "로그인 제공자가 없습니다(앱 내부 오류)." };
      const r = await provider(wc, { username: args.username == null ? null : String(args.username) });
      if (r && r.secret) { resultSafety.rememberSecret(wc.id, r.secret); delete r.secret; }
      return r;
    },
    async nativewin() {   // OS가 그린 창·시트를 본다. CDP로는 안 보이는 층이다.
      const win = await nativeAx.axDescribe();
      return win;
    },
    async nativekey(_send, _wc, args) {   // 네이티브 창에 키를 보낸다. 열림/저장 패널의 버튼은 그룹 안에 중첩돼
      // 이름으로 못 짚는 경우가 많은데, esc/enter는 어떤 패널에서도 통한다.
      return await nativeAx.axKey(args.key);
    },
    async nativeclick(_send, _wc, args) {  // 그 창의 버튼을 이름으로 누른다.
      const name = String(args.button || "").trim();
      if (!name) return { error: "누를 버튼 이름이 필요합니다. 먼저 nativewin으로 확인하세요." };
      return await nativeAx.axClick(name);
    },
  };
}

module.exports = { createNativeCommands };
