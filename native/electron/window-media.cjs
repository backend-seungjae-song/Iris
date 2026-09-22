// desktopCapturer 창 제목과 그림을 권한·용량·동시 실행 경계 안에서 읽는다.
//
// 소유 범위
//   화면 기록 권한 정규화, desktopCapturer 단일 실행 슬롯, 창 ID 결합과 PNG 응답 크기 제한.
//
// 제공 API
//   createWindowMedia(deps)가 permission()·titles({ ids })·thumbnails({ targets })를 제공한다.
//
// 의존 대상
//   주입받은 Electron desktopCapturer·systemPreferences·nativeImage에만 기대며 host 상태는 알지 못한다.
//
// 유지 조건
//   granted 전에는 getSources를 부르지 않는다. 제목과 그림은 같은 슬롯을 쓰고 source의 :0·:1 꼬리를
//   모두 받으며, 한 항목의 빈 그림·예외·용량 초과가 다른 항목과 batch 전체를 버리게 하지 않는다.

const MAX_WIDTH = 320;
const MAX_HEIGHT = 200;
const MAX_THUMBNAIL_BYTES = 256 << 10;
const MAX_RESPONSE_BYTES = 4 << 20;
const MAX_TARGETS = 200;
const SOURCE_ID_RE = /^window:(\d+):(0|1)$/;
const PERMISSIONS = new Set(["granted", "denied", "restricted", "not-determined"]);

function targetList(input) {
  const source = input && Array.isArray(input.targets) ? input.targets : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const cgId = Number(item.cgId);
    if (!Number.isInteger(cgId) || cgId <= 0 || seen.has(cgId)) continue;
    seen.add(cgId);
    out.push({ ...item, id: item.id == null ? cgId : item.id, cgId });
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

function idList(input) {
  const source = input && Array.isArray(input.ids) ? input.ids : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const cgId = Number(item);
    if (!Number.isInteger(cgId) || cgId <= 0 || seen.has(cgId)) continue;
    seen.add(cgId);
    out.push(cgId);
    if (out.length >= MAX_TARGETS) break;
  }
  return out;
}

function allMissing(targets, reason) {
  return targets.map((target) => ({ id: target.id, reason }));
}

function boundedSize(size, { maxWidth, maxHeight }) {
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  if (!(width > 0) || !(height > 0)) throw new Error("창 그림 크기가 올바르지 않다");
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

function createWindowMedia({ desktopCapturer, systemPreferences, nativeImage, log }) {
  if (!desktopCapturer || typeof desktopCapturer.getSources !== "function") {
    throw new TypeError("desktopCapturer 주입이 필요하다");
  }
  if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== "function" || !nativeImage) {
    throw new TypeError("화면 권한과 nativeImage 주입이 필요하다");
  }

  let active = null;

  function permission() {
    try {
      const value = String(systemPreferences.getMediaAccessStatus("screen") || "unknown");
      return PERMISSIONS.has(value) ? value : "unknown";
    } catch {
      return "unknown";
    }
  }

  function note(reason) {
    if (!log) return;
    try {
      if (typeof log === "function") log("window-media", { reason });
      else if (typeof log.warn === "function") log.warn("window-media", { reason });
    } catch {}
  }

  async function capture(targets, currentPermission) {
    const startedAt = Date.now();
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: MAX_WIDTH, height: MAX_HEIGHT },
        fetchWindowIcons: false,
      });
    } catch {
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      note("capture-failed");
      return { permission: currentPermission, thumbs: {}, missing: allMissing(targets, "capture-failed"), elapsedMs };
    }
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const byCgId = new Map();
    for (const source of Array.isArray(sources) ? sources : []) {
      const match = SOURCE_ID_RE.exec(String(source && source.id || ""));
      if (!match) continue;
      const cgId = Number(match[1]);
      if (!byCgId.has(cgId)) byCgId.set(cgId, source);
    }

    const thumbs = {};
    const missing = [];
    const accepted = [];
    let responseBytes = 0;
    for (const target of targets) {
      const source = byCgId.get(target.cgId);
      if (!source) {
        missing.push({ id: target.id, reason: "not-found" });
        continue;
      }
      try {
        const thumbnail = source.thumbnail;
        if (!thumbnail || typeof thumbnail.isEmpty !== "function" || thumbnail.isEmpty()) {
          missing.push({ id: target.id, reason: "empty-thumbnail" });
          continue;
        }
        const size = boundedSize(thumbnail.getSize(), { maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT });
        const resized = thumbnail.resize({ width: size.width, height: size.height, quality: "good" });
        if (!resized || typeof resized.isEmpty !== "function" || resized.isEmpty()) {
          missing.push({ id: target.id, reason: "empty-thumbnail" });
          continue;
        }
        const png = resized.toPNG();
        const data = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
        const bytes = Buffer.byteLength(data, "utf8");
        if (bytes > MAX_THUMBNAIL_BYTES || responseBytes + bytes > MAX_RESPONSE_BYTES) {
          missing.push({ id: target.id, reason: "too-large" });
          continue;
        }
        thumbs[target.id] = data;
        accepted.push(target.id);
        responseBytes += bytes;
      } catch {
        missing.push({ id: target.id, reason: "capture-failed" });
      }
    }
    while (accepted.length && Buffer.byteLength(JSON.stringify({
      permission: currentPermission, thumbs, missing, elapsedMs,
    }), "utf8") > MAX_RESPONSE_BYTES) {
      const id = accepted.pop();
      delete thumbs[id];
      missing.push({ id, reason: "too-large" });
    }
    return { permission: currentPermission, thumbs, missing, elapsedMs };
  }

  async function lookupTitles(ids) {
    const startedAt = Date.now();
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const wanted = new Set(ids);
      const titles = {};
      for (const source of Array.isArray(sources) ? sources : []) {
        const match = SOURCE_ID_RE.exec(String(source && source.id || ""));
        if (!match) continue;
        const cgId = Number(match[1]);
        if (!wanted.has(cgId)) continue;
        const key = String(cgId);
        const title = String(source && source.name || "");
        if (!Object.prototype.hasOwnProperty.call(titles, key) || titles[key] === "") titles[key] = title;
      }
      return { ok: true, titles, elapsedMs: Math.max(0, Date.now() - startedAt) };
    } catch {
      note("capture-failed");
      return {
        ok: false,
        titles: {},
        elapsedMs: Math.max(0, Date.now() - startedAt),
        reason: "capture-failed",
      };
    }
  }

  async function titles(input = {}) {
    let state = null;
    try {
      const ids = idList(input);
      const currentPermission = permission();
      if (currentPermission !== "granted") {
        return { ok: false, titles: {}, elapsedMs: 0, reason: "permission" };
      }
      if (active) return { ok: false, titles: {}, elapsedMs: 0, reason: "busy" };
      if (!ids.length) return { ok: true, titles: {}, elapsedMs: 0 };

      state = {};
      active = state;
      return await lookupTitles(ids);
    } catch {
      note("capture-failed");
      return { ok: false, titles: {}, elapsedMs: 0, reason: "capture-failed" };
    } finally {
      if (state && active === state) active = null;
    }
  }

  async function thumbnails(input = {}) {
    const targets = targetList(input);
    const currentPermission = permission();
    if (currentPermission !== "granted") {
      return { permission: currentPermission, thumbs: {}, missing: allMissing(targets, "permission"), elapsedMs: 0 };
    }
    if (active) {
      return { permission: currentPermission, thumbs: {}, missing: allMissing(targets, "busy"), elapsedMs: 0 };
    }
    if (!targets.length) return { permission: currentPermission, thumbs: {}, missing: [], elapsedMs: 0 };

    const state = {};
    active = state;
    try {
      return await capture(targets, currentPermission);
    } catch {
      note("capture-failed");
      return { permission: currentPermission, thumbs: {}, missing: allMissing(targets, "capture-failed"), elapsedMs: 0 };
    } finally {
      if (active === state) active = null;
    }
  }

  return { permission, titles, thumbnails };
}

module.exports = {
  createWindowMedia,
  MAX_WIDTH,
  MAX_HEIGHT,
  MAX_THUMBNAIL_BYTES,
  MAX_RESPONSE_BYTES,
  SOURCE_ID_RE,
};
