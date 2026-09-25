// 기기·설정 화면. Orca MobileEmulatorSettingsPane(에이전트 제어 행 제외) +
// MobileEmulatorAvailabilityDetails + 기기 선택을 일반 DOM 코드로 옮긴 것이다.
//
// 소유 범위
//   rail 기기 화면의 왼쪽 패널. 위에서부터 기본 기기 선택, 플랫폼(iOS·Android)별 기기 목록과 그 머리의
//   도구 상태, 맨 아래 필요한 도구(Android SDK·iOS 시뮬레이터) 칸이다. 목록에서 하나를 눌러 기기 화면을
//   여는 일도 여기서 시작한다. "Enable Mobile Emulator" 켜고 끄기는 Orca 설정 화면의 기능이지만
//   Iris 는 기능 켜기·끄기(capabilities)가 대신하므로 옮기지 않았다.
//
// 제공 API
//   mountDevicePanel(container, opts) → { dispose(), refresh(), render() }. 목록 표기 deviceLabel · runtimeLabel ·
//   devicePlatform. opts: host · onOpenDevice(device) · headTools(머리 줄. 제목 뒤에 개수·상태·새로 고침을 붙이고 dispose 때 뗀다) ·
//   currentUdid()(지금 스페이스의 기기 화면이 보는 기기, 목록의 선택 표시).
//
// 의존 대상
//   host(window.acHost.emulator) RPC(emulator.availability)와 getSettings/setSettings/
//   pickSdkFolder/androidAction, 공용 드롭다운(core/dropdown.js). 그 밖의 앱 셸 모듈은 import 하지 않는다.
//
// 유지 조건
//   기기 목록은 사용 가능 여부 RPC 결과(availability.devices)를 그대로 쓴다. 에뮬레이터 화면
//   자체가 쓰는 emulator.listDevices 와 이름이 같은 필드지만 다른 RPC 응답이라 각각 새로 고침한다.
//   플랫폼은 runtime 으로 나눈다. Android 행은 서버가 runtime "Android" 를 붙이고(orca-emulator.cjs 의
//   toSimulatorRow), iOS 행은 simctl 런타임 식별자다.
//   서버 문구는 영어라 도구 상태 설명은 여기서 한국어로 쓴다.
//
// 영향 범위
//   web/js/emulator/boot.js, web/js/emulator/launch-button.js, web/js/emulator/pane.js.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/devices-panel.js
import { createDropdown } from "../core/dropdown.js";
import { xcodeGuidance } from "./xcode-guidance.js";
import { androidGuidance } from "./android-guidance.js";

const AUTOMATIC_DEVICE_VALUE = "__iris_automatic_emulator_device__";
const SIMULATOR_STATE_SUFFIX_RE = /\s+\((Booted|Booting|Creating|Shutdown|Shutting Down|Unavailable|Unknown)\)\s*$/i;

const SVG = (inner, cls) => `<svg class="${cls || "emu-ic"}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICON = {
  refresh: SVG('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  ios: SVG('<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 5.5h4"/>', "emu-ic emu-dp-plat-ic"),
  android: SVG('<path d="M5 16a7 7 0 0 1 14 0v3H5z"/><path d="m7.5 10.5-2-3"/><path d="m16.5 10.5 2-3"/><path d="M9.5 14h.01"/><path d="M14.5 14h.01"/>', "emu-ic emu-dp-plat-ic"),
  folder: SVG('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>'),
};

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

function button(className, label, icon) {
  const b = el("button", className);
  b.type = "button";
  if (icon) b.insertAdjacentHTML("beforeend", icon);
  if (label) b.append(document.createTextNode(label));
  return b;
}

function pill(text, tone) {
  return setPill(el("span"), text, tone);
}

function setPill(node, text, tone) {
  node.className = "emu-pill" + (tone ? " emu-pill-" + tone : "");
  node.textContent = text;
  return node;
}

export function deviceLabel(device) {
  const state = (device.state || "").trim();
  const name = (device.name || "").replace(SIMULATOR_STATE_SUFFIX_RE, "").trim();
  if (device.isAvailable === false) return name + " (사용 불가)";
  if (!state || state.toLowerCase() === "shutdown") return name;
  return name + " (" + state + ")";
}

// simctl 은 런타임을 식별자(com.apple.CoreSimulator.SimRuntime.iOS-18-3)로 준다. 목록에는 iOS 18.3 으로 보인다.
export function runtimeLabel(runtime) {
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtime || "");
  return m ? m[1] + " " + m[2].replace(/-/g, ".") : (runtime || "");
}

export function devicePlatform(device) {
  return device && device.runtime === "Android" ? "android" : "ios";
}

export function mountDevicePanel(container, opts) {
  const { host, onOpenDevice, headTools, currentUdid } = opts;
  let disposed = false;
  let availability = null;
  let refreshing = false;
  let xcodeBusy = false;
  let androidBusy = false;
  let busyLabel = "";
  let setupError = "";
  let settings = { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null };

  container.replaceChildren();
  const root = el("div", "emu-dp");

  // 머리 줄(제목 옆): 기기 수 · 전체 상태 · 새로 고침
  const headCount = el("span", "emu-dp-count");
  const headSpacer = el("span", "emu-sp");
  const headPill = el("span");
  const refreshBtn = button("emu-ib", "", ICON.refresh);
  refreshBtn.title = "새로 고침";
  refreshBtn.setAttribute("aria-label", "새로 고침");
  refreshBtn.addEventListener("click", () => void refresh());
  const headParts = [headCount, headSpacer, headPill, refreshBtn];
  if (headTools) headTools.append(...headParts);

  const scroll = el("div", "emu-dp-scroll");
  const note = el("div", "emu-dp-note");
  note.hidden = true;

  // ① 기본 기기
  const defBlk = el("section", "emu-dp-blk");
  const defHead = el("div", "emu-dp-blk-h");
  defHead.append(el("h3", "emu-dp-h3", "기본 기기"));
  const defBody = el("div", "emu-dp-def");
  const defaultDropdown = createDropdown({
    items: [{ value: AUTOMATIC_DEVICE_VALUE, label: "자동 선택", sub: "켜진 기기 우선" }],
    value: AUTOMATIC_DEVICE_VALUE,
    ariaLabel: "기본 기기",
    className: "emu-dp-dd",
    showSub: true,
    onChange: async (value) => {
      const next = value === AUTOMATIC_DEVICE_VALUE ? null : value;
      const r = await host.setSettings({ mobileEmulatorDefaultDeviceUdid: next }).catch(() => null);
      if (r && r.ok) settings = r.settings;
    },
  });
  const defDesc = el("div", "emu-dp-desc");
  defBody.append(defaultDropdown.el, defDesc);
  defBlk.append(defHead, defBody);

  // ② 플랫폼별 기기
  const groupsEl = el("div", "emu-dp-groups");
  scroll.append(note, defBlk, groupsEl);

  // ③ 필요한 도구
  const tools = el("section", "emu-dp-tools");

  root.append(scroll, tools);
  container.append(root);

  function iosReady(a) { return Boolean(a && a.simctl && a.simctl.ok && a.serveSim && a.serveSim.ok); }
  function androidReady(a) { return Boolean(a && a.android && a.android.sdkFound
    && (a.devices || []).some((device) => devicePlatform(device) === "android")); }
  function showsIos(a) { return !a || !a.platform || a.platform === "darwin"; }

  function renderHead(a) {
    const devices = (a && a.devices) || [];
    headCount.textContent = a ? "기기 " + devices.length + "개" : "";
    if (refreshing || !a) { setPill(headPill, "확인 중…"); headPill.classList.add("emu-pill-loading"); }
    else if (a.available) setPill(headPill, "준비됨", "ok");
    else setPill(headPill, "설정 필요", "warn");
    refreshBtn.disabled = refreshing;
  }

  // RPC 자체가 실패했을 때만 따로 알린다. 도구가 없는 경우는 아래 필요한 도구 칸이 설명한다.
  function renderNote(a) {
    const failed = a && a.rpcFailed;
    note.hidden = !failed && !setupError && !busyLabel;
    note.classList.toggle("busy", Boolean(busyLabel));
    note.textContent = busyLabel || setupError || (failed ? a.message : "");
    note.setAttribute("role", busyLabel ? "status" : "alert");
  }

  function renderDefaultDevice(a) {
    const devices = ((a && a.devices) || []).filter((d) => d.isAvailable !== false);
    defDesc.textContent = devices.length === 0
      ? "기기가 발견되면 자동으로 하나를 고릅니다."
      : "새로 여는 기기 화면이 이 기기로 시작합니다.";
    defaultDropdown.setItems([
      { value: AUTOMATIC_DEVICE_VALUE, label: "자동 선택", sub: "켜진 기기 우선" },
      ...devices.map((d) => ({ value: d.udid, label: deviceLabel(d), sub: runtimeLabel(d.runtime) })),
    ]);
    const want = settings.mobileEmulatorDefaultDeviceUdid;
    defaultDropdown.setValue(want && devices.some((d) => d.udid === want) ? want : AUTOMATIC_DEVICE_VALUE);
  }

  function deviceRow(d, selectedUdid) {
    const row = el("button", "emu-dp-row");
    row.type = "button";
    row.disabled = d.isAvailable === false;
    row.classList.toggle("on", !!selectedUdid && d.udid === selectedUdid);
    const booted = (d.state || "").toLowerCase() === "booted";
    row.append(
      el("span", "emu-dotst " + (booted ? "emu-dotst-work" : "emu-dotst-idle")),
      el("span", "emu-dp-name", deviceLabel(d).replace(/ \(Booted\)$/i, "")),
      el("span", "emu-dp-rt", runtimeLabel(d.runtime)),
    );
    if (booted) row.title = "켜져 있음";
    row.addEventListener("click", () => {
      if (onOpenDevice) onOpenDevice(d);
      render();
    });
    return row;
  }

  function group(kind, title, icon, devices, ready, emptyText, selectedUdid) {
    const blk = el("section", "emu-dp-blk emu-dp-group");
    blk.dataset.platform = kind;
    const h = el("div", "emu-dp-blk-h");
    h.insertAdjacentHTML("beforeend", icon);
    h.append(el("h3", "emu-dp-h3", title), el("span", "emu-dp-n", String(devices.length)), el("span", "emu-sp"));
    h.append(availability ? (ready ? pill("준비됨", "ok") : pill("설정 필요", "warn")) : pill("확인 중…"));
    blk.append(h);
    if (devices.length) {
      const list = el("div", "emu-dp-list");
      for (const d of devices) list.append(deviceRow(d, selectedUdid));
      blk.append(list);
    } else {
      blk.append(el("div", "emu-dp-empty", availability ? emptyText : "확인 중…"));
    }
    return blk;
  }

  function renderGroups(a) {
    const devices = (a && a.devices) || [];
    const selectedUdid = currentUdid ? currentUdid() : null;
    const ios = devices.filter((d) => devicePlatform(d) === "ios");
    const android = devices.filter((d) => devicePlatform(d) === "android");
    const out = [];
    if (showsIos(a)) {
      out.push(group("ios", "iOS 시뮬레이터", ICON.ios, ios, iosReady(a),
        iosReady(a) ? "iOS 시뮬레이터가 없습니다. Xcode 설정의 Platforms 에서 추가하세요."
          : "iOS 시뮬레이터를 쓸 수 없습니다. 아래 필요한 도구에서 설정합니다.", selectedUdid));
    }
    out.push(group("android", "Android", ICON.android, android, androidReady(a),
      androidReady(a) ? "Android 가상 기기가 없습니다. 아래 필요한 도구에서 설정하세요."
        : "Android SDK 를 찾지 못해 기기를 불러오지 못했습니다. 아래 필요한 도구에서 설정합니다.", selectedUdid));
    groupsEl.replaceChildren(...out);
  }

  function toolRow(ok, title, missLabel, detail, path, actions) {
    const row = el("div", "emu-dp-trow");
    row.append(el("span", "emu-dp-st" + (ok ? "" : " miss")));
    const body = el("div", "emu-dp-tbody");
    const t = el("div", "emu-dp-tt", title);
    if (!ok && missLabel) t.append(pill(missLabel, "warn"));
    const d = el("div", "emu-dp-td", detail);
    if (path) { d.append(el("br")); d.append(el("span", "emu-dp-path", path)); }
    body.append(t, d);
    if (actions.length) {
      const acts = el("div", "emu-dp-tacts");
      acts.append(...actions);
      body.append(acts);
    }
    row.append(body);
    return row;
  }

  async function handleLocateSdk() {
    if (androidBusy) return;
    androidBusy = true; busyLabel = "SDK 폴더 선택 대기 중…"; setupError = ""; render();
    try {
      const r = await host.pickSdkFolder();
      if (r?.ok && r.path) {
        const s = await host.setSettings({ androidSdkPath: r.path });
        if (!s?.ok) throw new Error(s?.error || "SDK 폴더를 저장하지 못했습니다.");
        settings = s.settings;
        busyLabel = "Android 도구 다시 확인 중…"; render();
        await refresh();
      }
    } catch (error) { setupError = error?.message || "SDK 폴더를 선택하지 못했습니다."; }
    finally { androidBusy = false; busyLabel = ""; render(); }
  }
  async function handleClearSdk() {
    if (androidBusy) return;
    androidBusy = true; busyLabel = "Android 도구 다시 확인 중…"; setupError = ""; render();
    try {
      const s = await host.setSettings({ androidSdkPath: null });
      if (!s?.ok) throw new Error(s?.error || "SDK 설정을 지우지 못했습니다.");
      settings = s.settings;
      await refresh();
    } catch (error) { setupError = error?.message || "SDK 설정을 지우지 못했습니다."; }
    finally { androidBusy = false; busyLabel = ""; render(); }
  }

  async function handleAndroidAction(action) {
    if (androidBusy) return;
    if (action === "locate") { await handleLocateSdk(); return; }
    androidBusy = true;
    busyLabel = action === "open" ? "Android Studio 여는 중…" : "설치 페이지 여는 중…";
    setupError = ""; render();
    try {
      const result = await host.androidAction(action);
      if (!result?.ok) setupError = result?.error || "Android Studio를 열지 못했습니다.";
    } catch (error) { setupError = error?.message || "Android Studio를 열지 못했습니다."; }
    finally { androidBusy = false; busyLabel = ""; render(); }
  }

  async function handleXcodeAction(action) {
    if (xcodeBusy) return;
    xcodeBusy = true;
    busyLabel = action === "select" ? "Xcode 선택 대기 중…" : "Xcode 여는 중…";
    setupError = "";
    render();
    try {
      const result = await host.xcodeAction(action);
      if (!result?.ok && !result?.canceled) setupError = result?.error || "Xcode 작업을 마치지 못했습니다.";
      if (result?.ok) await refresh();
    } catch (error) {
      setupError = error?.message || "Xcode 작업을 마치지 못했습니다.";
    } finally {
      xcodeBusy = false;
      busyLabel = "";
      render();
    }
  }

  function renderTools(a) {
    tools.replaceChildren();
    const head = el("div", "emu-dp-blk-h");
    head.append(el("h3", "emu-dp-h3", "필요한 도구"), el("span", "emu-sp"));
    tools.append(head);
    if (!a) { tools.classList.remove("need"); const loading = pill("확인 중…"); loading.classList.add("emu-pill-loading"); head.append(loading); return; }

    const android = a.android || { sdkFound: false, sdkPath: undefined };
    const androidHelp = androidGuidance(a);
    const androidActions = [];
    if (androidHelp) {
      const primary = button("emu-btn", androidHelp.label);
      primary.disabled = androidBusy || refreshing;
      primary.addEventListener("click", () => void handleAndroidAction(androidHelp.action));
      androidActions.push(primary);
    }
    if (androidHelp?.secondaryAction === "locate" || !androidHelp) {
      const locate = button("emu-btn emu-btn-ghost", "SDK 폴더 지정", ICON.folder);
      locate.disabled = androidBusy || refreshing;
      locate.addEventListener("click", () => void handleLocateSdk());
      androidActions.push(locate);
    }
    if (settings.androidSdkPath) {
      const clear = button("emu-btn emu-btn-ghost", "지정 해제");
      clear.disabled = androidBusy || refreshing;
      clear.addEventListener("click", () => void handleClearSdk());
      androidActions.push(clear);
    }
    if (androidHelp) {
      const retry = button("emu-btn emu-btn-ghost", "다시 확인");
      retry.disabled = androidBusy || refreshing;
      retry.addEventListener("click", () => void refresh());
      androidActions.push(retry);
    }
    const rows = [];
    const androidOk = androidReady(a);
    rows.push(toolRow(androidOk, "Android 가상 기기", "설정 필요",
      androidHelp?.message || (androidOk ? "준비됨" : "Android 도구와 기기 목록을 다시 확인하세요."),
      android.sdkPath || a.androidSetup?.sdkPath || "", androidActions));
    let total = 1, ok = androidOk ? 1 : 0;

    if (showsIos(a)) {
      total += 1;
      const iosOk = iosReady(a);
      if (iosOk) ok += 1;
      const guidance = iosOk ? null : xcodeGuidance(a);
      const iosDetail = iosOk ? "준비됨" : (guidance?.message || a.simctl?.message || a.serveSim?.message || "Xcode에서 iOS 시뮬레이터를 설정하세요.");
      const actions = [];
      if (guidance) {
        const action = button("emu-btn", guidance.label);
        action.disabled = xcodeBusy;
        action.addEventListener("click", () => void handleXcodeAction(guidance.action));
        actions.push(action);
        if (guidance.secondaryAction) {
          const secondary = button("emu-btn emu-btn-ghost", guidance.secondaryLabel);
          secondary.disabled = xcodeBusy;
          secondary.addEventListener("click", () => void handleXcodeAction(guidance.secondaryAction));
          actions.push(secondary);
        }
      }
      rows.push(toolRow(iosOk, "iOS 시뮬레이터 (Xcode)", "없음", iosDetail, "", actions));
    }
    const missing = total - ok;
    tools.classList.toggle("need", missing > 0);
    if (refreshing) { const loading = pill("확인 중…"); loading.classList.add("emu-pill-loading"); head.append(loading); }
    else head.append(missing > 0 ? pill(missing + "개 설정 필요", "warn") : el("span", "emu-dp-n", ok + "/" + total));
    tools.append(...rows);
  }

  function render() {
    if (disposed) return;
    renderHead(availability);
    renderNote(availability);
    renderDefaultDevice(availability);
    renderGroups(availability);
    renderTools(availability);
  }

  function failedAvailability(message) {
    return {
      platform: "", available: false, devices: [], simctl: { ok: false }, serveSim: { ok: false },
      android: { sdkFound: false, message: "" }, rpcFailed: true,
      message: message || "에뮬레이터 사용 가능 여부를 확인하지 못했습니다.",
    };
  }

  async function refresh() {
    refreshing = true; render();
    try {
      const s = await host.getSettings();
      if (s && s.ok) settings = s.settings;
    } catch {}
    try {
      const res = await host.rpc("emulator.availability", {});
      availability = res && res.ok ? res.result : failedAvailability(res && res.error && res.error.message);
    } catch (e) {
      availability = failedAvailability(e && e.message);
    }
    refreshing = false;
    render();
  }

  render();
  void refresh();

  return {
    dispose() { disposed = true; defaultDropdown.destroy(); container.replaceChildren(); for (const n of headParts) n.remove(); },
    refresh() { if (!disposed) void refresh(); },
    render,
  };
}
