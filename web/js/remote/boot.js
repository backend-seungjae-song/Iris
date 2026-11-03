import { isHostWindows } from "../core/host-path.js";
import { createDropdown } from "../core/dropdown.js";
// 소유 범위: Mac 원격 관리 화면
// 제공 API: panelHtml, initCapability(ctx)
// 의존 대상: capability context의 wsSend와 remote.* 서버 메시지
// 유지 조건: 서버가 보낸 공개 상태만 표시
// 영향 범위: remote rail 화면과 원격 서비스 요청

export const panelHtml = `
  <div class="remote-body" id="remote-body" data-mode="manage">
    <header class="remote-head">
      <div>
        <h2>휴대폰 원격 제어</h2>
        <p id="remote-subtitle">이 컴퓨터의 원격 제어와 등록 기기를 관리합니다.</p>
      </div>
    </header>
    <section class="remote-guide remote-setup-only" id="remote-guide" aria-live="polite" hidden>
      <div class="remote-section-head"><h3>연결 순서</h3><span class="remote-progress" id="remote-progress"></span></div>
      <ol class="remote-steps" id="remote-steps"></ol>
    </section>
    <section class="remote-card remote-status-card remote-manage-only" id="remote-status-card" aria-live="polite">
      <div class="remote-state-line"><span class="remote-dot" id="remote-dot"></span><strong id="remote-status">확인 중…</strong></div>
      <p class="remote-detail" id="remote-detail">저장된 설정을 확인하고 있습니다.</p>
      <button type="button" class="cc-btn cc-btn-pri" id="remote-action" hidden></button>
    </section>
    <section class="remote-card remote-status-card remote-health remote-manage-only" id="remote-health" aria-live="polite" hidden>
      <div class="remote-state-line"><span class="remote-dot remote-dot-warn"></span><strong id="remote-health-title"></strong></div>
      <p class="remote-detail" id="remote-health-detail"></p>
      <button type="button" class="cc-btn cc-btn-pri" id="remote-health-action" hidden></button>
    </section>
    <p class="remote-feedback" id="remote-feedback" role="status" hidden></p>
    <section class="remote-requests" id="remote-requests" hidden>
      <div class="remote-section-head"><h3>응답 대기</h3></div>
      <div class="remote-request-list" id="remote-request-list"></div>
    </section>
    <section class="remote-card remote-pair-card" id="remote-pair-card" hidden>
      <div id="remote-pair-scan" hidden>
        <h3>휴대폰에서 QR 코드 스캔</h3>
        <canvas class="remote-qr" id="remote-qr" role="img" aria-label="기기 추가 QR 코드"></canvas>
      </div>
      <div id="remote-pair-code" hidden>
        <h3>기기 확인</h3>
        <p class="remote-pair-device" id="remote-pair-device"></p>
        <label class="remote-code-label" for="remote-code">휴대폰 화면에 표시된 6자리 코드를 입력하세요</label>
        <input class="remote-code" id="remote-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
        <button type="button" class="cc-btn cc-btn-pri" id="remote-code-confirm">확인</button>
      </div>
      <p class="remote-countdown" id="remote-countdown"></p>
      <button type="button" class="cc-btn cc-btn-txt" id="remote-pair-cancel">취소</button>
    </section>
    <section class="remote-devices remote-manage-only" id="remote-devices">
      <div class="remote-section-head">
        <h3>등록 기기</h3>
        <button type="button" class="cc-btn cc-btn-pri" id="remote-pair-start">기기 추가</button>
      </div>
      <p class="remote-device-note" id="remote-device-note" hidden></p>
      <div class="remote-device-list" id="remote-device-list"></div>
    </section>
    <section class="remote-settings remote-manage-only" id="remote-settings">
      <div class="remote-section-head"><h3>설정</h3></div>
      <div class="remote-setting-row" id="remote-hook">
        <div>
          <strong>Claude 질문 응답</strong>
          <span id="remote-hook-status"></span>
        </div>
        <button type="button" class="cc-btn cc-btn-pri" id="remote-hook-action"></button>
      </div>
      <details class="remote-setting" id="remote-pin-card" hidden>
        <summary>
          <span class="remote-setting-label"><strong>접속 PIN</strong><span id="remote-pin-status">설정됨</span></span>
        </summary>
        <div class="remote-setting-body">
          <p class="remote-pin-detail">PIN 기한이 지난 뒤 다시 연결할 때 입력할 숫자 6자리 이상을 정하세요.</p>
          <div id="remote-pin-slot">
            <form class="remote-pin-form" id="remote-pin-form">
              <label for="remote-pin">새 PIN</label>
              <input class="remote-pin-input" id="remote-pin" type="password" inputmode="numeric" minlength="6" maxlength="32" autocomplete="new-password" />
              <label for="remote-pin-confirm">PIN 확인</label>
              <input class="remote-pin-input" id="remote-pin-confirm" type="password" inputmode="numeric" minlength="6" maxlength="32" autocomplete="new-password" />
              <button type="submit" class="cc-btn cc-btn-pri" id="remote-pin-save">PIN 변경</button>
            </form>
          </div>
          <div class="remote-pin-idle">
            <span class="remote-field-label" id="remote-pin-idle-label">PIN 다시 확인</span>
            <div id="remote-pin-idle"></div>
            <p>폰 화면을 사용하는 동안 기한이 갱신됩니다. 다른 앱에서 돌아오면 기한 안에서 자동으로 다시 연결합니다.</p>
          </div>
        </div>
      </details>
    </section>
  </div>
`;

let ctx;
let current = null;
let feedback = "";
let pendingRemoval = null;
let countdownTimer = null;
let lastPairPhase = null;
let tailscale = null;
let tailscaleTimer = null;
let screenOpen = false;
let loginRequested = false;
let openedLoginUrl = null;
let pinPauseNoticeShown = false;
let startupStateTimer = null;
const PIN_PAUSED_NOTICE_ID = "remote-pin-paused";
const PIN_IDLE_MINUTES = [10, 20, 30, 60];
let idleDropdown = null;

function byId(id) {
  return document.getElementById(id);
}

function openRemoteScreen() {
  document.querySelector?.('.rail-ico[data-rail="remote"]')?.click?.();
}

function notifyPausedForPin() {
  if (pinPauseNoticeShown) return;
  pinPauseNoticeShown = true;
  const title = "휴대폰 원격 제어가 멈췄습니다";
  const body = "접속 PIN을 정하면 다시 켜집니다.";
  ctx.showNotice?.({
    id: PIN_PAUSED_NOTICE_ID,
    title,
    body,
    warn: true,
    action: { label: "원격 화면 열기", run: openRemoteScreen },
  });
  try { ctx.acHost?.notify?.({ id: PIN_PAUSED_NOTICE_ID, title, body, level: "warn" }); } catch {}
}

// 접속 PIN이나 등록 기기가 없으면 연결 순서를 보여 주고, 둘 다 있으면 관리 화면을 보여 준다
function setupNeeded(state) {
  if (!state) return false;
  return state.pinConfigured !== true || !(Array.isArray(state.devices) && state.devices.length > 0);
}

function viewOf(state) {
  if (!state) return { tone: "wait", title: "확인 중…", detail: "저장된 설정을 확인하고 있습니다." };
  if (state.pinConfigured !== true) return {
    tone: "warn", title: "접속 PIN 설정 필요", detail: "접속 PIN을 저장해야 원격 제어를 켤 수 있습니다.",
  };
  if (state.busy && state.status !== "on") return {
    tone: "wait", title: "원격 제어 켜는 중", detail: "외부 수신을 준비하고 있습니다.",
    action: "enable", label: "켜는 중", disabled: true,
  };
  if (state.status === "on") {
    const listener = state.listener;
    const detail = listener?.address && Number.isInteger(listener.port)
      ? `외부 수신: ${listener.address}:${listener.port}` : "외부 수신 주소를 확인하지 못했습니다.";
    return { tone: "on", title: "원격 제어 켜짐", detail, action: "disable", label: "끄기" };
  }
  if (state.status === "error") return {
    tone: "error", title: "원격 제어 오류", detail: state.error?.message || "원격 제어는 꺼져 있습니다.",
    action: state.error?.action === "stop" ? "retry-stop" : "enable",
    label: state.error?.action === "stop" ? "다시 중지" : "다시 켜기",
  };
  return { tone: "off", title: "원격 제어 꺼짐", detail: "원격 제어를 사용하지 않습니다.", action: "enable", label: "켜기" };
}

function drawQr(qr, canvasId = "remote-qr") {
  const canvas = byId(canvasId);
  if (!canvas || !qr || !Number.isInteger(qr.size) || !Array.isArray(qr.rows)) return;
  const quiet = 4;
  const scale = 4;
  const side = (qr.size + (quiet * 2)) * scale;
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext?.("2d");
  if (!context) return;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, side, side);
  context.fillStyle = "#000";
  for (let row = 0; row < qr.size; row++) {
    const value = qr.rows[row];
    if (typeof value !== "string" || value.length !== qr.size) continue;
    for (let column = 0; column < qr.size; column++) {
      if (value[column] === "1") context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
}

function updateCountdown() {
  const target = byId("remote-countdown");
  if (!target || !current?.pairing) return;
  const seconds = Math.max(0, Math.ceil((current.pairing.expiresAt - Date.now()) / 1_000));
  target.textContent = `남은 시간 ${seconds}초`;
}

function renderPairing() {
  const pairing = current?.status === "on" ? current.pairing : null;
  const card = byId("remote-pair-card");
  const scan = byId("remote-pair-scan");
  const code = byId("remote-pair-code");
  const start = byId("remote-pair-start");
  if (start) {
    start.hidden = !!pairing;
    start.disabled = current?.status !== "on";
  }
  if (!card || !scan || !code) return;
  card.hidden = !pairing;
  scan.hidden = pairing?.phase !== "scan";
  code.hidden = pairing?.phase !== "code";
  if (!pairing) {
    lastPairPhase = null;
    return;
  }
  if (pairing.phase === "scan") drawQr(pairing.qr);
  if (pairing.phase === "code") {
    const device = byId("remote-pair-device");
    if (device) device.textContent = pairing.deviceName;
    const confirm = byId("remote-code-confirm");
    if (confirm) confirm.disabled = false;
    if (lastPairPhase !== "code") {
      const input = byId("remote-code");
      if (input) input.value = "";
    }
  }
  lastPairPhase = pairing.phase;
  updateCountdown();
}

function formatAddedAt(value) {
  if (!Number.isSafeInteger(value)) return "추가 날짜를 확인하지 못했습니다.";
  try {
    return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "추가 날짜를 확인하지 못했습니다.";
  }
}

function renderDevices() {
  const list = byId("remote-device-list");
  const note = byId("remote-device-note");
  if (note) {
    note.hidden = current?.status === "on";
    note.textContent = "원격 제어를 켜면 기기를 추가할 수 있습니다.";
  }
  if (!list || typeof document.createElement !== "function") return;
  const devices = Array.isArray(current?.devices) ? current.devices : [];
  if (pendingRemoval && !devices.some((device) => device.deviceId === pendingRemoval)) pendingRemoval = null;
  const nodes = [];
  if (!devices.length) {
    const empty = document.createElement("p");
    empty.className = "remote-empty";
    empty.textContent = "등록된 기기가 없습니다.";
    nodes.push(empty);
  }
  for (const device of devices) {
    const row = document.createElement("div");
    row.className = "remote-device";
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = device.name;
    const date = document.createElement("span");
    date.textContent = formatAddedAt(device.addedAt);
    text.append(name, date);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cc-btn cc-btn-danger";
    remove.textContent = pendingRemoval === device.deviceId ? "한 번 더 누르면 삭제" : "삭제";
    remove.addEventListener("click", () => {
      if (pendingRemoval !== device.deviceId) {
        pendingRemoval = device.deviceId;
        renderDevices();
        return;
      }
      pendingRemoval = null;
      remove.disabled = true;
      ctx.wsSend({ type: "remote.device.remove", deviceId: device.deviceId });
    });
    row.append(text, remove);
    nodes.push(row);
  }
  list.replaceChildren(...nodes);
}

function renderFeedback() {
  const target = byId("remote-feedback");
  if (!target) return;
  target.hidden = !feedback;
  target.textContent = feedback;
}

function agentName(ref) {
  const agent = Array.isArray(current?.agents) ? current.agents.find((entry) => entry.ref === ref) : null;
  return agent?.name || "Claude";
}

function sendAnswer(request, answer) {
  ctx.wsSend({ type: "remote.request.answer", request: request.ref, answer });
}

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderPermission(card, request) {
  const detail = document.createElement("pre");
  detail.className = "remote-request-detail";
  detail.textContent = `${request.body.tool}\n${request.body.description}\n${request.body.input}`;
  const actions = document.createElement("div");
  actions.className = "remote-request-actions";
  actions.append(
    makeButton("허용", "cc-btn cc-btn-pri", () => sendAnswer(request, { behavior: "allow" })),
    makeButton("거절", "cc-btn cc-btn-danger", () => sendAnswer(request, { behavior: "deny" })),
  );
  card.append(detail, actions);
}

function renderQuestion(card, request) {
  const controls = [];
  request.body.questions.forEach((question, questionIndex) => {
    const group = document.createElement("fieldset");
    group.className = "remote-question";
    const legend = document.createElement("legend");
    legend.textContent = question.question;
    group.append(legend);
    const choices = [];
    question.options.forEach((option, optionIndex) => {
      const label = document.createElement("label");
      label.className = "remote-question-option";
      const input = document.createElement("input");
      input.type = question.multiSelect ? "checkbox" : "radio";
      input.name = `remote-question-${request.ref}-${questionIndex}`;
      input.value = option.label;
      const text = document.createElement("span");
      text.textContent = option.description ? `${option.label} — ${option.description}` : option.label;
      label.append(input, text);
      group.append(label);
      choices.push(input);
    });
    const direct = document.createElement("input");
    direct.type = "text";
    direct.className = "remote-question-text";
    direct.maxLength = 2000;
    direct.placeholder = "직접 입력";
    group.append(direct);
    controls.push({ question, choices, direct });
    card.append(group);
  });
  card.append(makeButton("답변 보내기", "cc-btn cc-btn-pri", () => {
    const answers = [];
    for (const control of controls) {
      const text = control.direct.value.trim();
      if (text) answers.push({ text });
      else {
        const labels = control.choices.filter((input) => input.checked).map((input) => input.value);
        if (labels.length === 0 || (!control.question.multiSelect && labels.length !== 1)) {
          feedback = "각 질문의 선택지 또는 직접 입력을 채우세요.";
          renderFeedback();
          return;
        }
        answers.push({ labels });
      }
    }
    sendAnswer(request, { answers });
  }));
}

function renderRequests() {
  const section = byId("remote-requests");
  const list = byId("remote-request-list");
  if (!section || !list || typeof document.createElement !== "function") return;
  const requests = Array.isArray(current?.requests) ? current.requests : [];
  section.hidden = requests.length === 0;
  const nodes = requests.map((request) => {
    const card = document.createElement("article");
    card.className = "remote-request";
    const title = document.createElement("h4");
    title.textContent = `${agentName(request.agent)} · ${request.kind === "claude-permission" ? "허용 요청" : "질문"}`;
    card.append(title);
    if (request.kind === "claude-permission") renderPermission(card, request);
    else renderQuestion(card, request);
    return card;
  });
  list.replaceChildren(...nodes);
}

function renderHook() {
  const status = byId("remote-hook-status");
  const action = byId("remote-hook-action");
  if (!status || !action) return;
  const installed = current?.questionHookInstalled === true;
  status.textContent = installed ? "설치됨" : "설치하면 휴대폰과 이 화면에서 Claude 질문에 답할 수 있습니다.";
  action.textContent = installed ? "제거" : "설치";
  action.dataset.hookAction = installed ? "remove" : "install";
  action.disabled = false;
  action.classList.toggle("cc-btn-danger", installed);
  action.classList.toggle("cc-btn-pri", !installed);
}

function renderPin() {
  const card = byId("remote-pin-card");
  const status = byId("remote-pin-status");
  const save = byId("remote-pin-save");
  const configured = current?.pinConfigured === true;
  if (card) card.hidden = !configured;
  if (status) status.textContent = configured ? "설정됨" : "설정 필요";
  if (save) {
    save.textContent = configured ? "PIN 변경" : "PIN 저장";
    save.disabled = false;
  }
  if (idleDropdown && PIN_IDLE_MINUTES.includes(current?.pinIdleMinutes)) {
    idleDropdown.setValue(String(current.pinIdleMinutes));
    idleDropdown.el.querySelector(".cc-dd-trigger").disabled = false;
  }
}

function render() {
  const host = byId("remote-body");
  if (!host) return;
  const view = viewOf(current);
  host.dataset.tone = view.tone;
  host.dataset.mode = setupNeeded(current) ? "setup" : "manage";
  const subtitle = byId("remote-subtitle");
  if (subtitle) {
    subtitle.textContent = host.dataset.mode === "setup"
      ? "순서대로 따라 하면 휴대폰이 연결됩니다."
      : "이 컴퓨터의 원격 제어와 등록 기기를 관리합니다.";
  }
  byId("remote-status").textContent = view.title;
  byId("remote-detail").textContent = view.detail;
  const action = byId("remote-action");
  action.disabled = view.disabled === true;
  action.hidden = !view.action;
  action.dataset.remoteAction = view.action || "";
  action.textContent = view.label || "";
  action.classList.toggle("cc-btn-pri", view.action === "enable");
  action.classList.toggle("cc-btn-danger", view.action === "disable");
  renderPairing();
  renderDevices();
  renderRequests();
  renderHook();
  renderGuide();
  renderHealth();
  renderPin();
  renderFeedback();
}

function tailscaleView(value) {
  if (!value) return { tone: "wait", title: "Tailscale 확인 중…", detail: "원격 연결에 쓰는 Tailscale 상태를 확인하고 있습니다." };
  const busyLabel = { install: "설치 중…", start: "켜는 중…", connect: "연결 중…" }[value.busy];
  const view = {
    "not-installed": value.canInstall
      ? { tone: "off", title: "Tailscale 없음", detail: "원격 연결에 Tailscale이 필요합니다. Homebrew로 설치합니다.", action: "install", label: "설치" }
      : { tone: "off", title: "Tailscale 없음", detail: "tailscale.com에서 Tailscale을 설치하세요." },
    "daemon-off": { tone: "off", title: "Tailscale 꺼짐", detail: isHostWindows() ? "켜면 Windows 관리자 권한을 요청합니다." : "켜면 macOS 관리자 암호를 한 번 묻습니다.", action: "start", label: "켜기" },
    "needs-login": value.authUrl && openedLoginUrl === value.authUrl
      ? { tone: "wait", title: "로그인 대기", detail: "Iris 탭에서 Tailscale 로그인을 마치세요.", action: "reopen", label: "로그인 화면 다시 열기" }
      : value.loginPending
      ? { tone: "wait", title: "로그인 준비 중", detail: "Tailscale에서 로그인 주소를 받는 중입니다. 받으면 Iris 탭으로 열립니다." }
      : { tone: "off", title: "로그인 필요", detail: "Iris 탭에서 Tailscale 계정으로 로그인합니다.", action: "connect", label: "로그인" },
    stopped: { tone: "off", title: "Tailscale 연결 꺼짐", detail: "로그인은 되어 있습니다.", action: "connect", label: "연결" },
    "needs-approval": { tone: "warn", title: "기기 승인 대기", detail: "Tailscale 관리 화면에서 이 컴퓨터를 승인하세요." },
    starting: { tone: "wait", title: "Tailscale 시작 중", detail: "잠시 기다려 주세요." },
    running: { tone: "on", title: "Tailscale 연결됨",
      detail: [value.tailnet, value.address].filter(Boolean).join(" · ") || "연결되어 있습니다." },
  }[value.phase] || { tone: "wait", title: "Tailscale 확인 중…", detail: "" };
  if (busyLabel) return { ...view, label: busyLabel, disabled: true };
  if (value.error?.message) return { ...view, tone: "error", detail: value.error.message };
  return view;
}

// 연결 순서. 각 단계의 완료는 실제 상태로 판정하고, 첫 미완료 단계에만 설명과 버튼 표시
function guideSteps() {
  const mac = tailscaleView(tailscale);
  const tailnet = tailscale?.tailnet;
  const phones = Array.isArray(tailscale?.phones) ? tailscale.phones : [];
  const online = phones.filter((phone) => phone.online);
  const devices = Array.isArray(current?.devices) ? current.devices : [];
  const busy = current?.busy && current?.status !== "on";
  const failed = current?.status === "error";
  const pairing = current?.status === "on" && current?.pairing;
  return [
    {
      title: "접속 PIN 설정",
      done: current?.pinConfigured === true,
      detail: "휴대폰에서 입력할 숫자 6자리 이상을 두 번 입력해 저장하세요.",
      pinForm: true,
    },
    {
      title: isHostWindows() ? "Windows Tailscale 연결" : "Mac Tailscale 연결",
      done: tailscale?.phase === "running",
      detail: mac.detail,
      tone: mac.tone,
      action: mac.action ? { kind: `ts-${mac.action}`, label: mac.label, disabled: mac.disabled } : null,
    },
    {
      title: "원격 제어 켜기",
      done: current?.status === "on",
      detail: failed && current.error?.message ? current.error.message : "이 컴퓨터가 Tailscale 주소로만 휴대폰 연결을 받습니다.",
      tone: failed ? "error" : undefined,
      action: {
        kind: current?.error?.action === "stop" ? "retry-stop" : "enable",
        label: busy ? "켜는 중…" : failed ? "다시 켜기" : "켜기",
        disabled: !!busy,
      },
    },
    {
      title: "휴대폰 등록",
      done: devices.length > 0,
      detail: pairing
        ? "휴대폰 Iris Remote 앱에서 ‘QR 코드 스캔’을 누르고 아래 QR을 찍으세요. 휴대폰에 뜬 6자리 숫자를 아래에 입력하면 끝납니다."
        : online.length > 0
          ? "휴대폰에서 Iris Remote 앱을 연 뒤 아래 ‘기기 추가’를 눌러 QR을 띄우세요."
          : `먼저 휴대폰에 Tailscale을 설치하고 이 컴퓨터와 같은 계정${tailnet ? `(${tailnet})` : ""}으로 로그인하세요. 아래 QR을 휴대폰 카메라로 찍으면 설치 화면이 열립니다. 그다음 휴대폰에서 Iris Remote 앱을 열고 ‘기기 추가’를 눌러 QR을 띄우세요.`,
      qr: !pairing && online.length === 0 ? tailscale?.phoneInstallQr : null,
      action: pairing ? null : { kind: "pair", label: "기기 추가" },
    },
  ];
}

function renderGuide() {
  const guide = byId("remote-guide");
  const list = byId("remote-steps");
  if (!guide || !list || typeof document.createElement !== "function") return;
  const pinCard = byId("remote-pin-card");
  const pinForm = byId("remote-pin-form");
  if (pinCard && pinForm) (byId("remote-pin-slot") || pinCard).append(pinForm);
  const steps = guideSteps();
  guide.hidden = !setupNeeded(current);
  const progress = byId("remote-progress");
  if (progress) progress.textContent = `${steps.filter((step) => step.done).length}/${steps.length}`;
  const currentIndex = steps.findIndex((step) => !step.done);
  // 끝난 단계는 보여 주지 않는다. 남은 단계만 원래 번호로 나열하고 첫 단계에만 설명과 버튼을 둔다
  const nodes = steps.map((step, index) => {
    if (step.done) return null;
    const item = document.createElement("li");
    item.className = "remote-step";
    item.dataset.state = index === currentIndex ? "current" : "later";
    if (step.tone === "error" && index === currentIndex) item.dataset.tone = "error";
    const head = document.createElement("div");
    head.className = "remote-step-head";
    const mark = document.createElement("span");
    mark.className = "remote-step-mark";
    mark.textContent = String(index + 1);
    const title = document.createElement("strong");
    title.textContent = step.title;
    head.append(mark, title);
    item.append(head);
    if (index === currentIndex) {
      const detail = document.createElement("p");
      detail.className = "remote-step-detail";
      detail.textContent = step.detail;
      item.append(detail);
      if (step.pinForm && pinForm) item.append(pinForm);
      if (step.qr) {
        const canvas = document.createElement("canvas");
        canvas.className = "remote-qr";
        canvas.id = "remote-guide-qr";
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", "휴대폰 Tailscale 설치 QR 코드");
        item.append(canvas);
      }
      if (step.action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "cc-btn cc-btn-pri";
        button.dataset.guideAction = step.action.kind;
        button.textContent = step.action.label;
        button.disabled = !!step.action.disabled;
        item.append(button);
      }
    }
    return item;
  }).filter(Boolean);
  list.replaceChildren(...nodes);
  const qr = steps[currentIndex]?.qr;
  if (qr) drawQr(qr, "remote-guide-qr");
}

// 설정이 끝난 뒤 Tailscale이 끊기면 관리 화면 위쪽에 원인과 복구 버튼을 보여 준다
function renderHealth() {
  const card = byId("remote-health");
  if (!card) return;
  const broken = !!tailscale && tailscale.phase !== "running" && !setupNeeded(current);
  card.hidden = !broken;
  if (!broken) return;
  const view = tailscaleView(tailscale);
  byId("remote-health-title").textContent = view.title;
  byId("remote-health-detail").textContent = view.detail;
  const action = byId("remote-health-action");
  action.hidden = !view.action;
  action.disabled = view.disabled === true;
  action.dataset.guideAction = view.action ? `ts-${view.action}` : "";
  action.textContent = view.label || "";
}

function runGuideAction(kind) {
  if (kind === "ts-reopen") {
    if (tailscale?.authUrl) openLoginTab(tailscale.authUrl);
    return;
  }
  if (kind.startsWith("ts-")) {
    const action = kind.slice(3);
    if (action === "connect") {
      loginRequested = true;
      if (tailscale?.authUrl) openLoginTab(tailscale.authUrl);
    }
    ctx.wsSend({ type: `remote.tailscale.${action}` });
    return;
  }
  if (kind === "pair") ctx.wsSend({ type: "remote.pair.start" });
  else ctx.wsSend({ type: `remote.${kind}` });
}

function scheduleTailscalePoll() {
  if (tailscaleTimer) clearTimeout(tailscaleTimer);
  if (!screenOpen) return;
  const settled = tailscale?.phase === "running" && !tailscale.busy && !tailscale.loginPending;
  tailscaleTimer = setTimeout(() => ctx.wsSend({ type: "remote.tailscale.status" }), settled ? 15_000 : 3_000);
}

function openLoginTab(url) {
  openedLoginUrl = url;
  ctx.openBrowserTab?.(url);
}

function receiveTailscale(message) {
  tailscale = message;
  if (message.phase !== "needs-login") loginRequested = false;
  else if (loginRequested && message.authUrl && openedLoginUrl !== message.authUrl) openLoginTab(message.authUrl);
  renderGuide();
  renderHealth();
  scheduleTailscalePoll();
}

function receiveState(message) {
  current = message;
  feedback = "";
  if (message.pausedForPin === true) notifyPausedForPin();
  render();
}

function receiveError(message) {
  feedback = message.message || "원격 설정 요청을 처리하지 못했습니다.";
  const save = byId("remote-pin-save");
  if (save) save.disabled = false;
  render();
}

function receiveAnswerResult(message) {
  const labels = {
    delivered: "답변을 전달했습니다.",
    "already-answered": "이미 다른 화면에서 답했습니다.",
    expired: "응답 시간이 지났습니다.",
    failed: "답변을 전달하지 못했습니다.",
  };
  feedback = labels[message.result] || "답변 결과를 확인하지 못했습니다.";
  renderFeedback();
}

function receiveHookResult(message) {
  feedback = message.installed ? "질문 응답을 설치했습니다." : "질문 응답을 제거했습니다.";
  renderFeedback();
}

function ensureCountdown() {
  if (countdownTimer) return;
  countdownTimer = setInterval(updateCountdown, 1_000);
}

function enter() {
  screenOpen = true;
  render();
  ensureCountdown();
  ctx.wsSend({ type: "remote.status" });
  ctx.wsSend({ type: "remote.tailscale.status" });
}

function sendPairCode() {
  const input = byId("remote-code");
  const code = input?.value || "";
  if (!/^\d{6}$/.test(code)) {
    feedback = "6자리 숫자를 입력하세요.";
    renderFeedback();
    return;
  }
  byId("remote-code-confirm").disabled = true;
  ctx.wsSend({ type: "remote.pair.confirm", code });
}

function sendAccessPin(event) {
  event?.preventDefault?.();
  const input = byId("remote-pin");
  const confirmation = byId("remote-pin-confirm");
  const pin = input?.value || "";
  const confirmed = confirmation?.value || "";
  if (!/^\d{6,32}$/.test(pin)) {
    feedback = "접속 PIN은 숫자 6자리 이상이어야 합니다.";
    renderFeedback();
    return;
  }
  if (pin !== confirmed) {
    feedback = "접속 PIN 확인 값이 일치하지 않습니다.";
    renderFeedback();
    return;
  }
  if (input) input.value = "";
  if (confirmation) confirmation.value = "";
  byId("remote-pin-save").disabled = true;
  ctx.wsSend({ type: "remote.pin.set", pin, confirmation: confirmed });
}

function receivePinResult(message) {
  feedback = message.configured === true
    ? message.resumed === true
      ? "접속 PIN을 저장하고 원격 제어를 다시 켰습니다."
      : "접속 PIN을 저장했습니다."
    : "접속 PIN을 저장하지 못했습니다.";
  renderFeedback();
  ctx.wsSend({ type: "remote.status" });
}

export function requestPinIdle(minutes) {
  if (!PIN_IDLE_MINUTES.includes(minutes)) return false;
  const trigger = idleDropdown?.el.querySelector(".cc-dd-trigger");
  if (trigger) trigger.disabled = true;
  ctx.wsSend({ type: "remote.pin-idle.set", minutes });
  return true;
}

function receivePinIdleResult(message) {
  feedback = `PIN 다시 확인 기한을 ${message.minutes}분으로 저장했습니다.`;
  renderFeedback();
  ctx.wsSend({ type: "remote.status" });
}

function requestStartupState() {
  if (typeof ctx.wsIsOpen !== "function") return;
  if (ctx.wsIsOpen()) {
    startupStateTimer = null;
    ctx.wsSend({ type: "remote.status" });
    return;
  }
  startupStateTimer = setTimeout(requestStartupState, 250);
  startupStateTimer?.unref?.();
}

export function initCapability(context) {
  ctx = context;
  if (startupStateTimer) clearTimeout(startupStateTimer);
  startupStateTimer = setTimeout(requestStartupState, 0);
  startupStateTimer?.unref?.();
  try {
    ctx.acHost?.onNoticeActivated?.((message) => {
      if (message?.id === PIN_PAUSED_NOTICE_ID) openRemoteScreen();
    });
  } catch {}
  byId("remote-pin-form")?.addEventListener("submit", sendAccessPin);
  const idleMount = byId("remote-pin-idle");
  if (idleMount && typeof document.createElement === "function") {
    idleDropdown?.destroy();
    idleDropdown = createDropdown({
      items: PIN_IDLE_MINUTES.map((minutes) => ({ value: String(minutes), label: `${minutes}분 동안 사용하지 않을 때` })),
      value: "10",
      ariaLabel: "PIN 다시 확인 기한",
      onChange: (value) => requestPinIdle(Number(value)),
    });
    idleMount.append(idleDropdown.el);
  }
  for (const id of ["remote-pin", "remote-pin-confirm"]) {
    byId(id)?.addEventListener("input", (event) => {
      event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 32);
    });
  }
  byId("remote-action")?.addEventListener("click", (event) => {
    const action = event.currentTarget.dataset.remoteAction;
    if (!action) return;
    event.currentTarget.disabled = true;
    ctx.wsSend({ type: `remote.${action}` });
  });
  byId("remote-health-action")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    if (!button.dataset.guideAction || button.disabled) return;
    button.disabled = true;
    runGuideAction(button.dataset.guideAction);
  });
  byId("remote-steps")?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-guide-action]");
    if (!button || button.disabled) return;
    button.disabled = true;
    runGuideAction(button.dataset.guideAction);
  });
  byId("remote-pair-start")?.addEventListener("click", () => ctx.wsSend({ type: "remote.pair.start" }));
  byId("remote-pair-cancel")?.addEventListener("click", () => ctx.wsSend({ type: "remote.pair.cancel" }));
  byId("remote-code-confirm")?.addEventListener("click", sendPairCode);
  byId("remote-code")?.addEventListener("input", (event) => {
    event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
  });
  byId("remote-code")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendPairCode();
  });
  byId("remote-hook-action")?.addEventListener("click", (event) => {
    const action = event.currentTarget.dataset.hookAction;
    if (!action) return;
    event.currentTarget.disabled = true;
    ctx.wsSend({ type: `remote.question-hook.${action}` });
  });
  return {
    screen: {
      enter,
      leave() {
        screenOpen = false;
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        if (tailscaleTimer) clearTimeout(tailscaleTimer);
        tailscaleTimer = null;
      },
    },
    ws: {
      "remote.state": receiveState,
      "remote.error": receiveError,
      "remote.tailscale": receiveTailscale,
      "remote.request.answer.result": receiveAnswerResult,
      "remote.question-hook.result": receiveHookResult,
      "remote.pin.result": receivePinResult,
      "remote.pin-idle.result": receivePinIdleResult,
    },
  };
}
