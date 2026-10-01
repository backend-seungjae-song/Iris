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
//   currentUdid() · deviceLocation(udid) · onMoveDevice(device, location) · onStopDevice(device).
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
  refresh: SVG('<path d="M20 12a8 8 0 1 0-2.3 5.7"/><path d="M20 5v7h-7"/>'),
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

export function deviceRunnable(device) {
  return device.isAvailable !== false && device.runnable !== false && device.runtimeInstalled !== false;
}

export function deviceReadiness(device) {
  if (device.runtimeInstalled === false) return "런타임 설치 필요";
  if (!deviceRunnable(device)) return "도구 설정 필요";
  return /^(booted|booting)$/i.test(device.state || "") ? "실행 중 · 설치됨" : "설치됨 · 실행 가능";
}

export function mountDevicePanel(container, opts) {
  const { host, onOpenDevice, onMoveDevice, onStopDevice, deviceLocation, headTools, currentUdid } = opts;
  let disposed = false;
  let availability = null;
  let refreshing = false;
  let xcodeBusy = false;
  let androidBusy = false;
  let busyLabel = "";
  let setupError = "";
  let settings = { mobileEmulatorDefaultDeviceUdid: null, androidSdkPath: null };
  let deviceBusy = false;
  const rowDropdowns = [];
  const dialogs = new Set();

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
    items: [{ value: AUTOMATIC_DEVICE_VALUE, label: "iPhone 13", sub: "기본" }],
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
    const devices = ((a && a.devices) || []).filter(deviceRunnable);
    defDesc.textContent = devices.length === 0
      ? "iPhone 13이 없으면 처음 열 때 새 기기를 추가합니다. 지원하는 iOS 런타임이 필요합니다."
      : settings.mobileEmulatorDefaultDeviceUdid ? "새로 여는 기기 화면이 이 기기로 시작합니다." : "iPhone 13이 없으면 처음 열 때 추가합니다. 설치된 iOS 런타임을 공유합니다.";
    defaultDropdown.setItems([
      { value: AUTOMATIC_DEVICE_VALUE, label: "iPhone 13", sub: "기본" },
      ...devices.map((d) => ({ value: d.persistentId || d.udid, label: deviceLabel(d), sub: runtimeLabel(d.runtime) })),
      ...(settings.mobileEmulatorDefaultDeviceUdid && !devices.some(d => d.udid === settings.mobileEmulatorDefaultDeviceUdid || d.persistentId === settings.mobileEmulatorDefaultDeviceUdid)
        ? [{ value: settings.mobileEmulatorDefaultDeviceUdid, label: "저장된 기본 기기", sub: "현재 실행 불가" }] : []),
    ]);
    const want = settings.mobileEmulatorDefaultDeviceUdid;
    const savedDevice = devices.find(d => d.udid === want || d.persistentId === want);
    defaultDropdown.setValue(savedDevice ? savedDevice.persistentId || savedDevice.udid : want || AUTOMATIC_DEVICE_VALUE);
  }

  async function deviceAction(label, action) {
    if (deviceBusy || disposed) return;
    deviceBusy = true; busyLabel = label; setupError = ""; render();
    try {
      const result = await action();
      if (result?.ok === false) throw new Error(result.error?.message || result.error || "기기 작업을 마치지 못했습니다.");
      await refresh();
    } catch (error) { setupError = error?.message || "기기 작업을 마치지 못했습니다."; }
    finally { deviceBusy = false; busyLabel = ""; render(); }
  }

  function makeDialog(title) {
    const dialog = el("dialog", "emu-device-dialog");
    dialog.append(el("h3", "emu-dp-h3", title));
    document.body.append(dialog);
    dialogs.add(dialog);
    dialog.addEventListener("close", () => { dialogs.delete(dialog); dialog.remove(); });
    dialog.showModal();
    return dialog;
  }

  function showInstall(device) {
    const android = devicePlatform(device) === "android";
    const dialog = makeDialog(android ? "Android 시스템 이미지 설치" : "iOS 런타임 설치");
    const runtime = runtimeLabel(device.runtime);
    dialog.append(el("p", "emu-dp-desc", android
      ? "Android Studio의 Device Manager에서 이 기기의 시스템 이미지를 설치한 뒤 목록을 새로 고침하세요."
      : `${runtime}을 Xcode 설정의 Components에서 설치한 뒤 목록을 새로 고침하세요.`));
    dialog.append(el("p", "emu-dp-desc", "같은 버전은 설치 파일을 공유합니다. 앱과 데이터는 기기마다 따로 저장됩니다."));
    const actions = el("div", "emu-dp-tacts");
    const open = button("emu-btn", android ? "Android Studio 열기" : "Xcode 열기");
    open.addEventListener("click", () => { dialog.close(); void deviceAction("설치 도구 여는 중…", () => android ? host.androidAction("open") : host.xcodeAction("open")); });
    const close = button("emu-btn emu-btn-ghost", "닫기");
    close.addEventListener("click", () => dialog.close());
    actions.append(open, close); dialog.append(actions);
  }

  function duplicate(device) {
    void deviceAction("같은 기종의 기기 추가 중…", () => host.createDevice({ platform: devicePlatform(device), sourceDevice: device.udid, sourceName: device.name }));
  }

  async function showAdd(platform) {
    if (!host.deviceCatalog || deviceBusy) return;
    const dialog = makeDialog("기종 추가");
    const body = el("div", "emu-device-form"); dialog.append(body);
    body.append(el("p", "emu-dp-desc", "설치된 기종과 런타임 확인 중…"));
    const close = button("emu-btn emu-btn-ghost", "취소"); close.addEventListener("click", () => dialog.close()); dialog.append(close);
    try {
      const res = await host.deviceCatalog();
      if (!dialog.isConnected || disposed) return;
      if (!res?.ok) throw new Error(res?.error || "기종 목록을 읽지 못했습니다.");
      const data = res.catalog[platform];
      const models = data.models || [];
      const versions = platform === "ios" ? data.runtimes || [] : data.images || [];
      body.replaceChildren();
      if (!models.length || !versions.length) {
        body.append(el("p", "emu-dp-desc", data.error || "설치된 런타임이나 기종이 없습니다. 설치 도구에서 추가한 뒤 다시 확인하세요."));
        const install = button("emu-btn", "설치 안내");
        install.addEventListener("click", () => { dialog.close(); showInstall({ runtime: platform === "android" ? "Android" : "iOS" }); });
        body.append(install); return;
      }
      let modelId = models.find(m => m.name === "iPhone 13")?.id || models[0].id;
      let versionId = versions.find(v => v.installed)?.id || versions[0].id;
      const modelPicker = createDropdown({ items: models.map(m => ({ value: m.id, label: m.name })), value: modelId, ariaLabel: "추가할 기종", className: "emu-dp-dd", onChange: v => { modelId = v; update(); } });
      const versionPicker = createDropdown({ items: versions.map(v => ({ value: v.id, label: v.name, sub: v.installed ? "설치됨 · 추가 다운로드 없음" : "설치 필요" })), value: versionId, ariaLabel: platform === "ios" ? "iOS 버전" : "Android 시스템 이미지", className: "emu-dp-dd", showSub: true, onChange: v => { versionId = v; update(); } });
      dialog.addEventListener("close", () => { modelPicker.destroy(); versionPicker.destroy(); });
      const note = el("p", "emu-dp-desc");
      const add = button("emu-btn", "기기 추가");
      function supportsVersion() {
        if (platform !== "ios") return true;
        const model = models.find(m => m.id === modelId);
        const version = versions.find(v => v.id === versionId);
        const parts = version?.version?.split(".").map(Number);
        if (!parts) return true;
        const packed = parts[0] * 65536 + (parts[1] || 0) * 256 + (parts[2] || 0);
        return (model?.minRuntimeVersion == null || packed >= model.minRuntimeVersion)
          && (model?.maxRuntimeVersion == null || packed <= model.maxRuntimeVersion);
      }
      function update() {
        const version = versions.find(v => v.id === versionId);
        const incompatible = version?.installed && !supportsVersion();
        note.textContent = incompatible ? "선택한 기종은 이 iOS 버전을 지원하지 않습니다. 지원하는 버전을 선택하세요."
          : version?.installed ? "추가 다운로드 없이 새 기기 데이터를 생성합니다. 기기는 꺼진 상태로 추가됩니다." : "이 버전을 설치한 뒤 기기를 추가할 수 있습니다.";
        add.disabled = Boolean(incompatible);
        add.textContent = version?.installed ? "기기 추가" : "설치 안내";
      }
      add.addEventListener("click", async () => {
        const version = versions.find(v => v.id === versionId);
        if (!version?.installed) { dialog.close(); showInstall({ runtime: version?.id }); return; }
        if (!supportsVersion()) { update(); return; }
        add.disabled = true; close.disabled = true;
        note.textContent = "기기 추가 중…";
        const args = { platform, modelId, ...(platform === "ios" ? { runtimeId: versionId } : { imageId: versionId }) };
        try {
          const result = await host.createDevice(args);
          if (!result?.ok) throw new Error(result?.error || "기기를 추가하지 못했습니다.");
          dialog.close(); await refresh();
        } catch (error) { note.textContent = error?.message || "기기를 추가하지 못했습니다."; await refresh(); }
        finally { add.disabled = false; close.disabled = false; }
      });
      body.append(modelPicker.el, versionPicker.el, note, add); update();
    } catch (error) { body.replaceChildren(el("p", "emu-dp-desc", error?.message || "기종 목록을 읽지 못했습니다.")); }
  }

  function deviceRow(d, selectedUdid) {
    const wrap = el("div", "emu-dp-device");
    wrap.dataset.device = d.udid;
    const row = el("button", "emu-dp-row");
    row.type = "button";
    row.disabled = !deviceRunnable(d) || deviceBusy;
    row.classList.toggle("on", !!selectedUdid && d.udid === selectedUdid);
    const booted = (d.state || "").toLowerCase() === "booted";
    row.append(
      el("span", "emu-dotst " + (booted ? "emu-dotst-work" : "emu-dotst-idle")),
      el("span", "emu-dp-name", deviceLabel(d).replace(/ \(Booted\)$/i, "")),
      el("span", "emu-dp-rt", runtimeLabel(d.runtime)),
    );
    if (booted) row.title = "켜져 있음";
    row.addEventListener("click", () => void deviceAction("기기 여는 중…", () => onOpenDevice?.(d)));
    const readiness = el("div", "emu-dp-readiness", deviceReadiness(d));
    readiness.classList.toggle("needs-install", !deviceRunnable(d));
    if (d.missingReason) readiness.title = d.missingReason;
    wrap.append(row, readiness);
    const actions = el("div", "emu-dp-actions");
    if (!deviceRunnable(d)) {
      const install = button("emu-btn", "설치 안내");
      install.addEventListener("click", () => showInstall(d)); actions.append(install);
    } else {
      const currentPlace = deviceLocation?.(d.udid);
      const placement = createDropdown({ ariaLabel: `${d.name} 표시 위치`, className: "emu-dp-placement", value: currentPlace || "column", items: [
        { value: "column", label: "같은 열의 탭" }, { value: "split", label: "새 세로 열" }, { value: "external", label: "외부 창" },
      ], onChange: value => void deviceAction("기기 위치 바꾸는 중…", () => onMoveDevice?.(d, value)) });
      placement.el.querySelector("button").disabled = deviceBusy || !onMoveDevice;
      rowDropdowns.push(placement);
      const power = button("emu-btn", booted ? "끄기" : "켜기");
      power.disabled = deviceBusy || (booted ? !onStopDevice : !onOpenDevice);
      power.addEventListener("click", () => void deviceAction(booted ? "기기 끄는 중…" : "기기 켜는 중…", () => booted ? onStopDevice?.(d) : onOpenDevice?.(d)));
      const plus = button("emu-btn", "한 대 더");
      plus.disabled = deviceBusy || !host.createDevice || d.canDuplicate === false;
      if (d.canDuplicate === false) plus.title = "이 기기의 원본 기종과 설치된 런타임을 확인할 수 없습니다.";
      plus.addEventListener("click", () => duplicate(d));
      actions.append(placement.el, power, plus);
    }
    wrap.append(actions);
    return wrap;
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
    for (const dropdown of rowDropdowns.splice(0)) dropdown.destroy();
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
    if (host.createDevice && host.deviceCatalog) {
      const add = el("div", "emu-dp-add");
      for (const [platform, label] of [["ios", "+ iOS 기종"], ["android", "+ Android 기종"]]) {
        if (platform === "ios" && !showsIos(a)) continue;
        const btn = button("emu-btn", label); btn.disabled = deviceBusy || !a;
        btn.addEventListener("click", () => void showAdd(platform)); add.append(btn);
      }
      add.append(el("div", "emu-dp-desc", "같은 버전은 설치 파일을 공유합니다. 앱과 데이터는 기기마다 저장됩니다."));
      groupsEl.append(add);
    }
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
    dispose() { disposed = true; for (const dialog of dialogs) dialog.close(); for (const dropdown of rowDropdowns.splice(0)) dropdown.destroy(); defaultDropdown.destroy(); container.replaceChildren(); for (const n of headParts) n.remove(); },
    refresh() { if (!disposed) return refresh(); },
    render,
  };
}
