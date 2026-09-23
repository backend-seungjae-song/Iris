// 생성 파일. 직접 고치지 않는다. scripts/vendor-orca-emulator.mjs 로 다시 만든다.
// 원본: https://github.com/stablyai/orca @ 841d06a9690c551ec8d4f70a72376632ffa3c2e5 (렌더러, React 없는 순수 로직만)
// MIT License
//
// Copyright (c) 2026 Lovecast Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/renderer/src/components/emulator-pane/emulator-pane-types.ts
function deviceLabel(device) {
  if (!device) {
    return "Mobile Emulator";
  }
  if (typeof device === "string") {
    return device.length > 20 && device.includes("-") ? "Mobile Emulator" : device;
  }
  if ("displayName" in device && device.displayName) {
    return device.displayName;
  }
  if ("name" in device && device.name) {
    return device.name;
  }
  if ("device" in device && device.device && !device.device.includes("-")) {
    return device.device;
  }
  return "Mobile Emulator";
}
__name(deviceLabel, "deviceLabel");
function simulatorPreviewStreamUrl(info) {
  if (!info) {
    return void 0;
  }
  if (info.streamUrl) {
    return info.streamUrl;
  }
  if (info.url) {
    const base = info.url.replace(/\/$/, "");
    return `${base}/stream.mjpeg`;
  }
  return void 0;
}
__name(simulatorPreviewStreamUrl, "simulatorPreviewStreamUrl");
function pickDefaultDevice(devices) {
  const available = devices.filter((d) => d.isAvailable !== false);
  const booted = available.filter((d) => d.state === "Booted");
  const bootedIphone = booted.find((d) => /iPhone/i.test(d.name || ""));
  return bootedIphone || booted[0] || available.find((d) => /iPhone/i.test(d.name || "")) || available[0] || devices[0] || null;
}
__name(pickDefaultDevice, "pickDefaultDevice");

// src/renderer/src/components/emulator-pane/emulator-attach-target.ts
function resolveEmulatorAttachTarget({
  configuredDefaultUdid,
  devices,
  deviceTarget,
  selectedUdid
}) {
  if (deviceTarget || selectedUdid || configuredDefaultUdid) {
    return deviceTarget || selectedUdid || configuredDefaultUdid || void 0;
  }
  return devices.length > 0 ? pickDefaultDevice(devices)?.udid : void 0;
}
__name(resolveEmulatorAttachTarget, "resolveEmulatorAttachTarget");

// src/renderer/src/components/emulator-pane/emulator-device-frame-layout.ts
var clamp = /* @__PURE__ */ __name((value, min, max) => Math.min(max, Math.max(min, value)), "clamp");
var FIT_MARGIN_PX = 0.5;
function resolveDeviceFrameKind(deviceName, screenAspectRatio) {
  if (deviceName && /ipad/i.test(deviceName)) {
    return "tablet";
  }
  if (deviceName && /iphone/i.test(deviceName)) {
    return "phone";
  }
  return screenAspectRatio > 0.62 && screenAspectRatio < 1.62 ? "tablet" : "phone";
}
__name(resolveDeviceFrameKind, "resolveDeviceFrameKind");
function resolveVisualStreamGeometry(streamSize, visualOrientation) {
  const width = streamSize?.width ?? 9;
  const height = streamSize?.height ?? 19;
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const visualSize = visualOrientation === "landscape" ? { width: longSide, height: shortSide } : { width: shortSide, height: longSide };
  const streamIsLandscape = streamSize ? streamSize.width > streamSize.height : false;
  const visualIsLandscape = visualOrientation === "landscape";
  const streamRotation = streamSize && streamIsLandscape !== visualIsLandscape ? visualIsLandscape ? 90 : -90 : 0;
  return {
    aspectRatio: visualSize.width / visualSize.height,
    size: streamSize ? visualSize : null,
    streamRotation
  };
}
__name(resolveVisualStreamGeometry, "resolveVisualStreamGeometry");
function fitScreenToPane(paneSize, aspectRatio) {
  if (!paneSize || paneSize.width <= 0 || paneSize.height <= 0 || aspectRatio <= 0) {
    return null;
  }
  const paneAspectRatio = paneSize.width / paneSize.height;
  if (paneAspectRatio > aspectRatio) {
    return {
      width: Math.max(1, paneSize.height * aspectRatio),
      height: paneSize.height
    };
  }
  return {
    width: paneSize.width,
    height: Math.max(1, paneSize.width / aspectRatio)
  };
}
__name(fitScreenToPane, "fitScreenToPane");
function measureChrome(screenSize, kind) {
  const shortSide = Math.min(screenSize.width, screenSize.height);
  const bezel = kind === "phone" ? clamp(shortSide * 0.021, 7, 15) : clamp(shortSide * 0.026, 8, 22);
  const hardwareOutset = kind === "phone" ? clamp(shortSide * 0.012, 3, 7) : 0;
  const sideButtonThickness = kind === "phone" ? clamp(shortSide * 0.01, 3, 6) : 0;
  return {
    bezel,
    hardwareOutset,
    sideButtonThickness
  };
}
__name(measureChrome, "measureChrome");
function fitDeviceFrameToPane(paneSize, screenAspectRatio, kind) {
  if (!paneSize || paneSize.width <= 0 || paneSize.height <= 0 || screenAspectRatio <= 0) {
    return null;
  }
  let screenSize = fitScreenToPane(paneSize, screenAspectRatio);
  for (let index = 0; index < 4; index += 1) {
    if (!screenSize) {
      return null;
    }
    const chrome = measureChrome(screenSize, kind);
    const availableWidth = Math.max(
      1,
      paneSize.width - chrome.hardwareOutset * 2 - chrome.bezel * 2 - FIT_MARGIN_PX
    );
    const availableHeight = Math.max(1, paneSize.height - chrome.bezel * 2 - FIT_MARGIN_PX);
    screenSize = fitScreenToPane(
      {
        width: availableWidth,
        height: availableHeight
      },
      screenAspectRatio
    );
  }
  if (!screenSize) {
    return null;
  }
  const { bezel, hardwareOutset, sideButtonThickness } = measureChrome(screenSize, kind);
  const shellWidth = screenSize.width + bezel * 2;
  const shellHeight = screenSize.height + bezel * 2;
  const shortSide = Math.min(screenSize.width, screenSize.height);
  const outerRadius = kind === "phone" ? clamp(shortSide * 0.135, 44, 92) : clamp(shortSide * 0.065, 24, 56);
  const innerRadius = kind === "phone" ? clamp(outerRadius - bezel, 34, 82) : clamp(outerRadius - bezel * 0.7, 18, 48);
  return {
    kind,
    width: shellWidth + hardwareOutset * 2,
    height: shellHeight,
    shellWidth,
    shellHeight,
    hardwareOutset,
    bezel,
    outerRadius,
    innerRadius,
    sideButtonThickness
  };
}
__name(fitDeviceFrameToPane, "fitDeviceFrameToPane");

// src/renderer/src/components/emulator-pane/emulator-device-row-mapping.ts
function toSimulatorDeviceRows(raw) {
  return raw.map((device) => ({
    name: device.name,
    udid: device.id,
    state: device.state === "booted" ? "Booted" : "Shutdown",
    runtime: device.detail,
    isAvailable: device.isAvailable
  }));
}
__name(toSimulatorDeviceRows, "toSimulatorDeviceRows");

// src/renderer/src/components/emulator-pane/emulator-device-state.ts
function markSimulatorDeviceState(devices, target, state) {
  if (!target) {
    return devices;
  }
  let changed = false;
  const next = devices.map((device) => {
    if (device.udid !== target && device.name !== target) {
      return device;
    }
    if (device.state === state) {
      return device;
    }
    changed = true;
    return { ...device, state };
  });
  return changed ? next : devices;
}
__name(markSimulatorDeviceState, "markSimulatorDeviceState");
function markSimulatorDeviceBooted(devices, target) {
  return markSimulatorDeviceState(devices, target, "Booted");
}
__name(markSimulatorDeviceBooted, "markSimulatorDeviceBooted");
function markSimulatorDeviceShutdown(devices, target) {
  return markSimulatorDeviceState(devices, target, "Shutdown");
}
__name(markSimulatorDeviceShutdown, "markSimulatorDeviceShutdown");

// src/shared/emulator-keyboard-frame.ts
var SERVE_SIM_KEYBOARD_MESSAGE_TAG = 6;
var SHIFT_USAGE = 225;
var ASCII_KEY_USAGES = buildAsciiKeyUsages();
var NAMED_KEY_USAGES = {
  Backspace: 42,
  Delete: 76,
  End: 77,
  Escape: 41,
  Home: 74,
  PageDown: 78,
  PageUp: 75,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82
};
function buildAsciiKeyUsages() {
  const usages = {};
  for (let index = 0; index < 26; index += 1) {
    const usage = 4 + index;
    usages[String.fromCharCode(97 + index)] = { usage, shift: false };
    usages[String.fromCharCode(65 + index)] = { usage, shift: true };
  }
  const digits = "1234567890";
  const shiftedDigits = "!@#$%^&*()";
  for (let index = 0; index < digits.length; index += 1) {
    const usage = 30 + index;
    usages[digits[index]] = { usage, shift: false };
    usages[shiftedDigits[index]] = { usage, shift: true };
  }
  const punctuation = [
    ["-", "_", 45],
    ["=", "+", 46],
    ["[", "{", 47],
    ["]", "}", 48],
    ["\\", "|", 49],
    [";", ":", 51],
    ["'", '"', 52],
    ["`", "~", 53],
    [",", "<", 54],
    [".", ">", 55],
    ["/", "?", 56]
  ];
  for (const [plain, shifted, usage] of punctuation) {
    usages[plain] = { usage, shift: false };
    usages[shifted] = { usage, shift: true };
  }
  usages[" "] = { usage: 44, shift: false };
  usages["\n"] = { usage: 40, shift: false };
  usages["	"] = { usage: 43, shift: false };
  return usages;
}
__name(buildAsciiKeyUsages, "buildAsciiKeyUsages");
function buildUsageFrames(usage) {
  return [
    { type: "down", usage },
    { type: "up", usage }
  ];
}
__name(buildUsageFrames, "buildUsageFrames");
function buildKeyUsageFrames(key, modifiers = {}) {
  const frames = buildUsageFrames(key.usage);
  return key.shift || modifiers.shift ? [{ type: "down", usage: SHIFT_USAGE }, ...frames, { type: "up", usage: SHIFT_USAGE }] : frames;
}
__name(buildKeyUsageFrames, "buildKeyUsageFrames");
function buildServeSimKeyboardFramesForKey(key, modifiers = {}) {
  const textKey = key === "Enter" ? "\n" : key === "Tab" ? "	" : key;
  const asciiUsage = ASCII_KEY_USAGES[textKey];
  if (asciiUsage) {
    return buildKeyUsageFrames(asciiUsage, modifiers);
  }
  const namedUsage = NAMED_KEY_USAGES[key];
  return namedUsage === void 0 ? null : buildKeyUsageFrames({ shift: false, usage: namedUsage }, modifiers);
}
__name(buildServeSimKeyboardFramesForKey, "buildServeSimKeyboardFramesForKey");
function encodeServeSimKeyboardFrame(key) {
  const json = new TextEncoder().encode(JSON.stringify(key));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = SERVE_SIM_KEYBOARD_MESSAGE_TAG;
  frame.set(json, 1);
  return frame;
}
__name(encodeServeSimKeyboardFrame, "encodeServeSimKeyboardFrame");

// src/shared/utf8-byte-limits.ts
function readUtf8CodePointAt(text, index) {
  const leadUnit = text.charCodeAt(index);
  if (leadUnit < 55296 || leadUnit > 56319 || index + 1 >= text.length) {
    return leadUnit;
  }
  const trailUnit = text.charCodeAt(index + 1);
  if (trailUnit < 56320 || trailUnit > 57343) {
    return leadUnit;
  }
  return (leadUnit - 55296) * 1024 + (trailUnit - 56320) + 65536;
}
__name(readUtf8CodePointAt, "readUtf8CodePointAt");
function measureUtf8ByteLength(text, options = {}) {
  const stopAfterBytes = options.stopAfterBytes;
  let byteLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index);
    byteLength += getUtf8ByteLengthForCodePoint(codePoint);
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true };
    }
    if (codePoint > 65535) {
      index += 1;
    }
  }
  return { byteLength, exceededLimit: false };
}
__name(measureUtf8ByteLength, "measureUtf8ByteLength");
var MAX_UTF8_SCRATCH_BYTES = 1024 * 1024;
var utf8Encoder = new TextEncoder();
var utf8Scratch = new Uint8Array(0);
function getUtf8ByteLengthForCodePoint(codePoint) {
  if (codePoint <= 127) {
    return 1;
  }
  if (codePoint <= 2047) {
    return 2;
  }
  if (codePoint <= 65535) {
    return 3;
  }
  return 4;
}
__name(getUtf8ByteLengthForCodePoint, "getUtf8ByteLengthForCodePoint");

// src/shared/clipboard-text.ts
var CLIPBOARD_TEXT_READ_MAX_BYTES = 16 * 1024 * 1024;
var CLIPBOARD_TEXT_WRITE_MAX_BYTES = 16 * 1024 * 1024;
var CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS = 256 * 1024;
function measureClipboardTextByteLength(text, options = {}) {
  return measureUtf8ByteLength(text, options);
}
__name(measureClipboardTextByteLength, "measureClipboardTextByteLength");

// src/renderer/src/components/emulator-pane/emulator-keyboard-paste.ts
var EMULATOR_KEYBOARD_PASTE_MAX_BYTES = 4 * 1024;
var EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK = 48;
var EMULATOR_KEYBOARD_PASTE_FRAME_DELAY_MS = 4;
function validateEmulatorKeyboardPasteText(text, maxBytes) {
  const byteLimit = getPositiveIntegerLimit(maxBytes, EMULATOR_KEYBOARD_PASTE_MAX_BYTES);
  const byteLengthMeasurement = measureClipboardTextByteLength(text, { stopAfterBytes: byteLimit });
  if (byteLengthMeasurement.exceededLimit) {
    return { byteLength: byteLengthMeasurement.byteLength, reason: "too-large", status: "rejected" };
  }
  const { byteLength } = byteLengthMeasurement;
  let hasFrames = false;
  for (const char of text) {
    if (char === "\r") {
      continue;
    }
    const charFrames = buildServeSimKeyboardFramesForKey(char);
    if (!charFrames) {
      return { byteLength, reason: "unsupported-text", status: "rejected" };
    }
    if (charFrames.length > 0) {
      hasFrames = true;
    }
  }
  return hasFrames ? { byteLength, status: "accepted" } : { byteLength, reason: "empty", status: "rejected" };
}
__name(validateEmulatorKeyboardPasteText, "validateEmulatorKeyboardPasteText");
function* iterateEmulatorKeyboardPasteChunks(text, maxFramesPerChunk = EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK) {
  const normalizedMaxFramesPerChunk = getPositiveIntegerLimit(
    maxFramesPerChunk,
    EMULATOR_KEYBOARD_PASTE_MAX_FRAMES_PER_CHUNK
  );
  let currentChunk = [];
  for (const char of text) {
    if (char === "\r") {
      continue;
    }
    const charFrames = buildServeSimKeyboardFramesForKey(char);
    if (!charFrames) {
      return;
    }
    if (currentChunk.length > 0 && currentChunk.length + charFrames.length > normalizedMaxFramesPerChunk) {
      yield currentChunk;
      currentChunk = [];
    }
    currentChunk.push(...charFrames);
  }
  if (currentChunk.length > 0) {
    yield currentChunk;
  }
}
__name(iterateEmulatorKeyboardPasteChunks, "iterateEmulatorKeyboardPasteChunks");
async function pasteTextIntoEmulatorKeyboard({
  frameDelayMs = EMULATOR_KEYBOARD_PASTE_FRAME_DELAY_MS,
  isCancelled,
  maxBytes,
  maxFramesPerChunk,
  sendKeyboardFrames,
  text
}) {
  const validation = validateEmulatorKeyboardPasteText(text, maxBytes);
  if (validation.status === "rejected") {
    return validation;
  }
  const chunks = iterateEmulatorKeyboardPasteChunks(text, maxFramesPerChunk);
  let chunk = chunks.next();
  let chunkCount = 0;
  while (!chunk.done) {
    if (isCancelled?.()) {
      return { byteLength: validation.byteLength, reason: "cancelled", status: "cancelled" };
    }
    if (!sendKeyboardFrames(chunk.value)) {
      return {
        byteLength: validation.byteLength,
        reason: "target-unavailable",
        status: "rejected"
      };
    }
    chunkCount += 1;
    const sentFrameCount = chunk.value.length;
    chunk = chunks.next();
    if (!chunk.done) {
      await waitForEmulatorKeyboardChunk(sentFrameCount, frameDelayMs);
    }
  }
  return { byteLength: validation.byteLength, chunkCount, status: "sent" };
}
__name(pasteTextIntoEmulatorKeyboard, "pasteTextIntoEmulatorKeyboard");
function getPositiveIntegerLimit(value, fallback) {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value ?? fallback) : fallback;
}
__name(getPositiveIntegerLimit, "getPositiveIntegerLimit");
function waitForEmulatorKeyboardChunk(frameCount, frameDelayMs) {
  const delayMs = Math.max(frameDelayMs, frameCount * frameDelayMs);
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}
__name(waitForEmulatorKeyboardChunk, "waitForEmulatorKeyboardChunk");

// src/renderer/src/components/emulator-pane/emulator-pane-error-message.ts
function emulatorPaneErrorMessage(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}
__name(emulatorPaneErrorMessage, "emulatorPaneErrorMessage");

// src/renderer/src/components/emulator-pane/emulator-pane-session-view.ts
function buildEmulatorPaneSessionView({
  devices,
  selectedUdid,
  session
}) {
  const selectedDevice = devices.find((device) => device.udid === selectedUdid) ?? null;
  const sessionDisplayName = session?.info?.displayName;
  const hasSpecificSessionDisplayName = sessionDisplayName && sessionDisplayName !== "Simulator" && sessionDisplayName !== "Mobile Emulator";
  const previewUrl = simulatorPreviewStreamUrl(session?.info);
  return {
    displayName: hasSpecificSessionDisplayName ? sessionDisplayName : selectedDevice?.name || sessionDisplayName || "Mobile Emulator",
    previewUrl,
    wsUrl: session?.info?.wsUrl,
    isLive: Boolean(previewUrl && session?.attached),
    selectedDevice
  };
}
__name(buildEmulatorPaneSessionView, "buildEmulatorPaneSessionView");

// src/renderer/src/components/emulator-pane/emulator-prelaunched-session.ts
function buildPrelaunchedEmulatorSessionState(info, configuredDefaultUdid) {
  const liveTarget = info?.deviceUdid || info?.device || null;
  return {
    selectedUdid: liveTarget || configuredDefaultUdid,
    session: info ? {
      attached: true,
      info: {
        ...info,
        displayName: deviceLabel(info),
        state: "Booted"
      }
    } : null,
    streamKey: info && simulatorPreviewStreamUrl(info) ? String(Date.now()) : null,
    liveTarget
  };
}
__name(buildPrelaunchedEmulatorSessionState, "buildPrelaunchedEmulatorSessionState");

// src/renderer/src/components/emulator-pane/emulator-screen-gesture.ts
var DOM_DELTA_LINE = 1;
var DOM_DELTA_PAGE = 2;
var HID_EDGE_BOTTOM = 3;
var HOME_INDICATOR_BAND_NORM = 0.93;
function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}
__name(clampUnit, "clampUnit");
function clampEmulatorScreenPoint(point) {
  return { x: clampUnit(point.x), y: clampUnit(point.y) };
}
__name(clampEmulatorScreenPoint, "clampEmulatorScreenPoint");
function resolveEmulatorHomeIndicatorEdge(point) {
  return point.y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : void 0;
}
__name(resolveEmulatorHomeIndicatorEdge, "resolveEmulatorHomeIndicatorEdge");
function buildEmulatorGesturePoint(point, type, edge) {
  return edge === void 0 ? { ...point, type } : { ...point, type, edge };
}
__name(buildEmulatorGesturePoint, "buildEmulatorGesturePoint");
function resolveSimulatorScreenContentRect(rect, streamSize) {
  let contentLeft = rect.left;
  let contentTop = rect.top;
  let contentWidth = rect.width;
  let contentHeight = rect.height;
  if (streamSize) {
    const frameAspect = rect.width / rect.height;
    const streamAspect = streamSize.width / streamSize.height;
    if (frameAspect > streamAspect) {
      contentWidth = rect.height * streamAspect;
      contentLeft += (rect.width - contentWidth) / 2;
    } else if (frameAspect < streamAspect) {
      contentHeight = rect.width / streamAspect;
      contentTop += (rect.height - contentHeight) / 2;
    }
  }
  return { left: contentLeft, top: contentTop, width: contentWidth, height: contentHeight };
}
__name(resolveSimulatorScreenContentRect, "resolveSimulatorScreenContentRect");
function normalizeWheelDelta(delta, deltaMode, pageSize) {
  if (deltaMode === DOM_DELTA_LINE) {
    return delta * 16;
  }
  if (deltaMode === DOM_DELTA_PAGE) {
    return delta * pageSize;
  }
  return delta;
}
__name(normalizeWheelDelta, "normalizeWheelDelta");
function mapClientPointToSimulatorScreen(sample, rect, streamSize) {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const {
    left: contentLeft,
    top: contentTop,
    width: contentWidth,
    height: contentHeight
  } = resolveSimulatorScreenContentRect(rect, streamSize);
  const x = (sample.clientX - contentLeft) / contentWidth;
  const y = (sample.clientY - contentTop) / contentHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    return null;
  }
  return { x, y };
}
__name(mapClientPointToSimulatorScreen, "mapClientPointToSimulatorScreen");
function resolveEmulatorPointerAction(samples, rect, streamSize, dragThresholdPx = 8) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) {
    return null;
  }
  const firstPoint = mapClientPointToSimulatorScreen(first, rect, streamSize);
  const lastPoint = mapClientPointToSimulatorScreen(last, rect, streamSize);
  if (!firstPoint || !lastPoint) {
    return null;
  }
  const maxDistance = samples.reduce((max, sample) => {
    const dx = sample.clientX - first.clientX;
    const dy = sample.clientY - first.clientY;
    return Math.max(max, Math.hypot(dx, dy));
  }, 0);
  if (maxDistance < dragThresholdPx) {
    return { kind: "tap", point: lastPoint };
  }
  const edge = resolveEmulatorHomeIndicatorEdge(firstPoint);
  const middle = samples.slice(1, -1);
  const points = [buildEmulatorGesturePoint(firstPoint, "begin", edge)];
  for (const sample of middle) {
    const point = mapClientPointToSimulatorScreen(sample, rect, streamSize);
    if (point) {
      points.push(buildEmulatorGesturePoint(point, "move", edge));
    }
  }
  points.push(buildEmulatorGesturePoint(lastPoint, "end", edge));
  return { kind: "gesture", points };
}
__name(resolveEmulatorPointerAction, "resolveEmulatorPointerAction");
function resolveEmulatorWheelDelta(sample, rect, streamSize, sensitivity = 1.2) {
  const start = mapClientPointToSimulatorScreen(sample, rect, streamSize);
  if (!start) {
    return null;
  }
  const contentRect = resolveSimulatorScreenContentRect(rect, streamSize);
  if (contentRect.width <= 0 || contentRect.height <= 0) {
    return null;
  }
  const deltaX = normalizeWheelDelta(sample.deltaX, sample.deltaMode, contentRect.width);
  const deltaY = normalizeWheelDelta(sample.deltaY, sample.deltaMode, contentRect.height);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    return null;
  }
  return {
    start,
    // Why: wheel deltas describe content scroll direction, while iOS HID input
    // needs the opposite finger movement that produces that scroll.
    delta: {
      x: -deltaX / contentRect.width * sensitivity,
      y: -deltaY / contentRect.height * sensitivity
    }
  };
}
__name(resolveEmulatorWheelDelta, "resolveEmulatorWheelDelta");
function buildWheelGesturePoints(start, end, minDistance = 0.01) {
  const clampedEnd = clampEmulatorScreenPoint(end);
  if (Math.hypot(clampedEnd.x - start.x, clampedEnd.y - start.y) < minDistance) {
    return null;
  }
  return [
    { ...start, type: "begin" },
    { x: (start.x + clampedEnd.x) / 2, y: (start.y + clampedEnd.y) / 2, type: "move" },
    { ...clampedEnd, type: "end" }
  ];
}
__name(buildWheelGesturePoints, "buildWheelGesturePoints");

// src/shared/emulator-touch-frame.ts
var SERVE_SIM_TOUCH_MESSAGE_TAG = 3;
function encodeServeSimTouchFrame(touch) {
  const json = new TextEncoder().encode(JSON.stringify(touch));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = SERVE_SIM_TOUCH_MESSAGE_TAG;
  frame.set(json, 1);
  return frame;
}
__name(encodeServeSimTouchFrame, "encodeServeSimTouchFrame");
export {
  buildEmulatorGesturePoint,
  buildEmulatorPaneSessionView,
  buildPrelaunchedEmulatorSessionState,
  buildServeSimKeyboardFramesForKey,
  buildWheelGesturePoints,
  clampEmulatorScreenPoint,
  deviceLabel,
  emulatorPaneErrorMessage,
  encodeServeSimKeyboardFrame,
  encodeServeSimTouchFrame,
  fitDeviceFrameToPane,
  mapClientPointToSimulatorScreen,
  markSimulatorDeviceBooted,
  markSimulatorDeviceShutdown,
  pasteTextIntoEmulatorKeyboard,
  pickDefaultDevice,
  resolveDeviceFrameKind,
  resolveEmulatorAttachTarget,
  resolveEmulatorHomeIndicatorEdge,
  resolveEmulatorPointerAction,
  resolveEmulatorWheelDelta,
  resolveVisualStreamGeometry,
  simulatorPreviewStreamUrl,
  toSimulatorDeviceRows
};
