// CDP 파일 업로드 계획과 가로챈 file chooser 처리.
//
// 소유 범위
//   webContents ID별 one-shot 업로드 계획, 만료 timer, 계획 소비와 사람 선택으로 넘어가는 판정.
//
// 제공 API
//   createUploadController(...)가 invalidPaths·arm·takePlan·forget·armed·serveFileChooser 명령을 준다.
//   원시 Map이나 계획 객체는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 절대경로·존재 판정, Electron 파일 대화상자·소유 창 adapter, 결과 기록
//   callback과 timer/시각 함수. CDP 명령은 serveFileChooser를 부를 때 send로 받는다.
//
// 유지 조건
//   상대경로나 없는 파일은 거부한다. 에이전트가 무장한 파일은 사람 창 없이 한 번만 소비하고,
//   계획이 없으면 사람에게 창을 띄운다. 취소는 빈 배열을 넣어 페이지가 계속 진행하게 한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs upload 명령·Page.fileChooserOpened와 Electron dialog/BrowserWindow이고,
//   양방향 소비자는 DOM.setFileInputFiles·observe의 fileChooser/lastUpload와 CLI·MCP upload 결과다.

function createUploadController({
  isAbsolute,
  existsSync,
  showOpenDialog,
  windowFromWebContents,
  recordUpload,
  clearChooser,
  aiDriving = () => false,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
}) {
  const uploadPlans = new Map();

  function invalidPaths(files) {
    return files.filter((file) => !isAbsolute(file) || !existsSync(file));
  }

  function arm(wcId, files, timeoutMs) {
    const previous = uploadPlans.get(wcId);
    if (previous && previous.timer) clearTimeoutFn(previous.timer);
    const plan = { files, done: null, timer: null };
    plan.timer = setTimeoutFn(() => {
      if (uploadPlans.get(wcId) === plan) uploadPlans.delete(wcId);
    }, timeoutMs);
    uploadPlans.set(wcId, plan);
  }

  function takePlan(wcId) {
    const plan = uploadPlans.get(wcId);
    if (!plan || !plan.files || !plan.files.length) return { askHuman: true, files: null };
    uploadPlans.delete(wcId);
    if (plan.timer) clearTimeoutFn(plan.timer);
    return { askHuman: false, files: plan.files };
  }

  function forget(wcId) {
    uploadPlans.delete(wcId);
  }

  // 올릴 파일이 정해져 있어 다음 파일 선택창을 CDP 가 받아야 하는가.
  function armed(wcId) {
    const plan = uploadPlans.get(wcId);
    return !!(plan && plan.files && plan.files.length);
  }

  async function serveFileChooser(send, wc, params) {
    const setFiles = async (files) => {
      try { await send("DOM.enable", {}); } catch {}
      await send("DOM.setFileInputFiles", { files, backendNodeId: params.backendNodeId });
    };
    const choice = takePlan(wc.id);
    if (!choice.askHuman) {
      try { await setFiles(choice.files); recordUpload(wc.id, { ok: true, files: choice.files, at: now() }); }
      catch (error) { recordUpload(wc.id, { ok: false, error: String((error && error.message) || error), at: now() }); }
      clearChooser(wc.id);
      return choice;
    }

    // AI 가 조작해서 뜬 선택창이면 OS 창을 띄우지 않는다. 그 창은 시트로 붙어 창 전체를 막고
    // 사용자 조작을 요구하는데, 올릴 파일을 정하지 않고 연 것이라 사용자가 답할 내용도 없다.
    // 빈 선택으로 닫고 무엇을 해야 하는지 장부에 남긴다.
    if (aiDriving(wc.id)) {
      try { await setFiles([]); } catch {}
      recordUpload(wc.id, { ok: false, at: now(),
        error: "파일 선택창이 떴는데 올릴 파일이 정해져 있지 않아 그냥 닫았습니다. browser_upload 로 파일을 먼저 정하고 다시 누르세요(사람이 골라야 하면 browser_ask_user)." });
      clearChooser(wc.id);
      return choice;
    }
    let owner = null;
    try {
      const host = wc.hostWebContents;
      owner = host ? windowFromWebContents(host) : null;
    } catch {}
    const properties = params.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"];
    let picked = [];
    try {
      const result = await showOpenDialog(owner, { properties });
      picked = result && !result.canceled ? (result.filePaths || []) : [];
    } catch {}
    try { await setFiles(picked); } catch {}
    clearChooser(wc.id);
    return choice;
  }

  return { invalidPaths, arm, takePlan, forget, armed, serveFileChooser };
}

module.exports = { createUploadController };
