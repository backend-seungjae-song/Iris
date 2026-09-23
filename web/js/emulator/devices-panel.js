// 기기·설정 화면. Orca MobileEmulatorSettingsPane(에이전트 제어 행 제외) +
// MobileEmulatorAvailabilityDetails + 기기 선택을 일반 DOM 코드로 옮긴 것이다.
//
// 소유 범위
//   사용 가능 여부(Android SDK·iOS 시뮬레이터) 표시와 새로 고침, 기본 기기 선택, 기기 목록에서
//   하나를 눌러 에뮬레이터 탭을 여는 일. "Enable Mobile Emulator" 켜고 끄기는 Orca 설정 화면의
//   기능이지만 Iris 는 기능 켜기·끄기(capabilities)가 대신하므로 옮기지 않았다.
//
// 제공 API
//   mountDevicePanel(container, opts) → { dispose(), refresh() }. 목록 표기 deviceLabel · runtimeLabel.
//
// 의존 대상
//   host(window.acHost.emulator) RPC(emulator.availability)와 getSettings/setSettings/
//   pickSdkFolder/openAndroidStudioDownload 뿐이다. Iris 앱 셸 모듈은 import 하지 않는다.
//
// 유지 조건
//   기기 목록은 사용 가능 여부 RPC 결과(availability.devices)를 그대로 쓴다. 에뮬레이터 화면
//   자체가 쓰는 emulator.listDevices 와 이름이 같은 필드지만 다른 RPC 응답이라 각각 새로 고침한다.
//
// 영향 범위
//   web/js/emulator/boot.js, web/js/emulator/launch-button.js.
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/emulator/devices-panel.js
const AUTOMATIC_DEVICE_VALUE = "__iris_automatic_emulator_device__";
const ANDROID_STUDIO_URL = "https://developer.android.com/studio";
const SIMULATOR_STATE_SUFFIX_RE = /\s+\((Booted|Booting|Creating|Shutdown|Shutting Down|Unavailable|Unknown)\)\s*$/i;

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
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
  const m = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(runtime);
  return m ? m[1] + " " + m[2].replace(/-/g, ".") : runtime;
}

export function mountDevicePanel(container, opts) {
  const { host, onOpenDevice } = opts;
  let disposed = false;
  let availability = null;
  let refreshing = false;
  let settings = { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null };

  container.replaceChildren();
  const root = el("div", "emu-devices");

  const statusRow = el("div", "emu-devices-status-row");
  const statusDetail = el("div", "emu-devices-status-detail");
  const statusMain = el("div", "emu-devices-status-main");
  statusMain.append(statusDetail);
  const badge = el("span", "emu-devices-badge", "확인 중…");
  const refreshBtn = el("button", "emu-btn emu-devices-refresh", "새로 고침");
  refreshBtn.type = "button";
  refreshBtn.addEventListener("click", () => void refresh());
  statusRow.append(statusMain, badge, refreshBtn);

  const toolchain = el("div", "emu-devices-toolchain");

  const defaultRow = el("div", "emu-devices-default-row");
  const defaultLabel = el("div", "emu-devices-default-label", "기본 기기");
  const defaultDesc = el("div", "emu-devices-default-desc");
  const defaultSelect = el("select", "emu-devices-default-select");
  defaultSelect.addEventListener("change", async () => {
    const value = defaultSelect.value === AUTOMATIC_DEVICE_VALUE ? null : defaultSelect.value;
    const r = await host.setSettings({ mobileEmulatorDefaultDeviceUdid: value }).catch(() => null);
    if (r && r.ok) settings = r.settings;
  });
  const defaultText = el("div", "emu-devices-default-text");
  defaultText.append(defaultLabel, defaultDesc);
  defaultRow.append(defaultText, defaultSelect);

  const listTitle = el("div", "emu-devices-list-title", "기기");
  const list = el("div", "emu-devices-list");

  root.append(statusRow, toolchain, defaultRow, listTitle, list);
  container.append(root);

  function availabilityBadgeText(a) {
    if (!a) return "확인 중…";
    return a.available ? "준비됨" : "설정 필요";
  }

  function availabilityDetail(a) {
    if (!a) return "Android SDK 와 iOS 시뮬레이터 지원을 확인하는 중입니다.";
    if (a.available) return a.devices.length === 1 ? "에뮬레이터 기기 1개 발견" : "에뮬레이터 기기 " + a.devices.length + "개 발견";
    return (a.simctl && a.simctl.message) || (a.serveSim && a.serveSim.message) || a.message || "";
  }

  function renderToolchainRow(ok, title, detail, actions) {
    const row = el("div", "emu-devices-toolchain-row");
    row.classList.toggle("emu-devices-toolchain-ok", ok);
    const icon = el("span", "emu-devices-toolchain-icon", ok ? "●" : "○");
    const body = el("div", "emu-devices-toolchain-body");
    body.append(el("div", "emu-devices-toolchain-title", title), el("div", "emu-devices-toolchain-detail", detail));
    row.append(icon, body);
    if (actions && actions.length) {
      const actionsEl = el("div", "emu-devices-toolchain-actions");
      actionsEl.append(...actions);
      row.append(actionsEl);
    }
    return row;
  }

  async function handleLocateSdk() {
    const r = await host.pickSdkFolder().catch(() => null);
    if (r && r.ok && r.path) {
      const s = await host.setSettings({ androidSdkPath: r.path }).catch(() => null);
      if (s && s.ok) settings = s.settings;
      await refresh();
    }
  }
  async function handleClearSdk() {
    const s = await host.setSettings({ androidSdkPath: null }).catch(() => null);
    if (s && s.ok) settings = s.settings;
    await refresh();
  }

  function renderToolchain(a) {
    toolchain.replaceChildren();
    if (!a) return;
    const android = a.android || { sdkFound: false, sdkPath: undefined, message: "" };
    const androidActions = [];
    if (!android.sdkFound) {
      const dl = el("button", "emu-btn", "Android Studio 다운로드");
      dl.type = "button";
      dl.addEventListener("click", () => void host.openAndroidStudioDownload());
      androidActions.push(dl);
    }
    const locate = el("button", "emu-btn", "SDK 폴더 지정");
    locate.type = "button";
    locate.addEventListener("click", () => void handleLocateSdk());
    androidActions.push(locate);
    if (settings.androidSdkPath) {
      const clear = el("button", "emu-btn", "지정 해제");
      clear.type = "button";
      clear.addEventListener("click", () => void handleClearSdk());
      androidActions.push(clear);
    }
    const androidDetail = android.sdkFound
      ? (settings.androidSdkPath ? "지정한 경로 사용 중: " : "다음 경로에서 발견: ") + (android.sdkPath || "")
      : (android.message || "찾을 수 없습니다. Android Studio 를 설치한 뒤 가상 기기를 만드세요.");
    toolchain.append(renderToolchainRow(android.sdkFound, "Android SDK", androidDetail, androidActions));

    if (a.platform === "darwin") {
      const iosOk = Boolean(a.simctl && a.simctl.ok && a.serveSim && a.serveSim.ok);
      const iosDetail = iosOk ? "준비됨" : ((a.simctl && a.simctl.message) || (a.serveSim && a.serveSim.message) || "Xcode 를 설치하고 iOS 시뮬레이터 런타임을 추가하세요.");
      toolchain.append(renderToolchainRow(iosOk, "iOS 시뮬레이터 (Xcode)", iosDetail, []));
    }
  }

  function renderDefaultDevice(a) {
    const devices = (a && a.devices) || [];
    defaultDesc.textContent = devices.length === 0
      ? "기기가 발견되면 자동으로 하나를 고릅니다."
      : "새 에뮬레이터 탭이 쓸 기본 기기입니다. 자동 선택은 이미 켜진 기기를 우선합니다.";
    defaultSelect.replaceChildren();
    const autoOpt = document.createElement("option");
    autoOpt.value = AUTOMATIC_DEVICE_VALUE; autoOpt.textContent = "자동 선택";
    defaultSelect.append(autoOpt);
    const known = devices.some((d) => d.udid === settings.mobileEmulatorDefaultDeviceUdid);
    for (const d of devices) {
      const o = document.createElement("option");
      o.value = d.udid; o.textContent = deviceLabel(d); o.disabled = d.isAvailable === false;
      defaultSelect.append(o);
    }
    defaultSelect.value = settings.mobileEmulatorDefaultDeviceUdid && known ? settings.mobileEmulatorDefaultDeviceUdid : AUTOMATIC_DEVICE_VALUE;
  }

  function renderList(a) {
    list.replaceChildren();
    const devices = (a && a.devices) || [];
    if (devices.length === 0) {
      list.append(el("div", "emu-devices-list-empty", a ? "발견된 기기가 없습니다." : "확인 중…"));
      return;
    }
    for (const d of devices) {
      const item = el("button", "emu-devices-list-item", null);
      item.type = "button";
      item.disabled = d.isAvailable === false;
      item.append(el("span", "emu-devices-list-name", deviceLabel(d)));
      if (d.runtime) item.append(el("span", "emu-devices-list-runtime", runtimeLabel(d.runtime)));
      item.addEventListener("click", () => onOpenDevice && onOpenDevice(d));
      list.append(item);
    }
  }

  function render() {
    statusDetail.textContent = availabilityDetail(availability);
    badge.textContent = availabilityBadgeText(availability);
    badge.classList.toggle("emu-devices-badge-ok", Boolean(availability && availability.available));
    badge.classList.toggle("emu-devices-badge-err", Boolean(availability && !availability.available));
    refreshBtn.disabled = refreshing;
    renderToolchain(availability);
    renderDefaultDevice(availability);
    renderList(availability);
  }

  async function refresh() {
    refreshing = true; render();
    try {
      const s = await host.getSettings();
      if (s && s.ok) settings = s.settings;
    } catch {}
    try {
      const res = await host.rpc("emulator.availability", {});
      availability = res && res.ok ? res.result : {
        platform: "", available: false, devices: [], simctl: { ok: false }, serveSim: { ok: false },
        android: { sdkFound: false, message: "" }, message: (res && res.error && res.error.message) || "에뮬레이터 사용 가능 여부를 확인하지 못했습니다.",
      };
    } catch (e) {
      availability = {
        platform: "", available: false, devices: [], simctl: { ok: false }, serveSim: { ok: false },
        android: { sdkFound: false, message: "" }, message: (e && e.message) || "에뮬레이터 사용 가능 여부를 확인하지 못했습니다.",
      };
    }
    refreshing = false;
    if (!disposed) render();
  }

  render();
  void refresh();

  return {
    dispose() { disposed = true; container.replaceChildren(); },
    refresh() { if (!disposed) void refresh(); },
  };
}
