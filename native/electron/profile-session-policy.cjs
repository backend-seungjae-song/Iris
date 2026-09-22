// Iris profile partition과 session 권한·WebAuthn/HID 정책의 상태 소유자.
//
// 소유 범위
//   허용하는 partition 형식, hardened partition registry, session별 정책 설치 표식과
//   일반 권한·WebAuthn account·FIDO HID 선택 규칙.
//
// 제공 API
//   createProfileSessionPolicy(...)가 guardWebviewPartition·ensureHardened·hardenSession·purgePartition·
//   forget·forEachHardened·onSessionHardened 명령을 제공하고, 순수 partition/origin/FIDO 판정 함수도 함께 제공한다.
//   원시 Set·WeakSet이나 session 객체 registry는 제공하지 않는다.
//
// 의존 대상
//   호출자가 주입하는 base partition, partition→session 조회, browser hardening·UA 조회·오디오 입력
//   판정·systemPreferences·다운로드 hook. Electron session을 직접 require하거나 전역으로 잡지 않는다.
//
// 유지 조건
//   persist:acbrowser와 persist:acprof:<안정 id>만 통과하고 미지 partition은 base로 강제한다.
//   WebAuthn은 HTTPS 또는 localhost에서만, HID는 FIDO usage page 장치만 허용하며 오디오 입력은 막는다.
//
// 영향 범위
//   공급자는 main.cjs의 session.fromPartition·browser-hardening·cookie UA·systemPreferences와 다운로드
//   adapter이고, 양방향 소비자는 main.cjs webview attach·profile import/purge·startup hardening 및
//   storage-lifecycle이다. 판정은 프로필 격리·쿠키/DOM 수명·패스키·카메라·마이크 권한까지 번진다.

const PROFILE_PARTITION_RE = /^persist:acbrowser$|^persist:acprof:[A-Za-z0-9%._~!*'()-]+$/;
const FIDO_HID_USAGE_PAGE = 0xf1d0;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
// 허용하면 화면과 커서 제어권을 넘기는 요청. 사용자가 직접 눌렀을 때만 허용한다.
const SCREEN_TAKING = new Set(["fullscreen", "pointerLock"]);
const AUTO_GRANT = new Set([
  "fullscreen",
  "clipboard-read", "clipboard-sanitized-write",
  "notifications", "persistent-storage",
  "pointerLock",
]);

function isProfilePartition(partition) {
  return PROFILE_PARTITION_RE.test(String(partition || ""));
}

function isSecureWebAuthnOrigin(raw) {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

function isFidoHidDevice(device) {
  return !!(device && typeof device === "object" && Array.isArray(device.collections)
    && device.collections.some((collection) => collection && typeof collection === "object"
      && collection.usagePage === FIDO_HID_USAGE_PAGE));
}

function allowsFileSystemRead(permission, requestingOrigin, details) {
  if (permission !== "fileSystem" || details?.fileAccessType !== "readable") return false;
  if (details.isDirectory !== false || typeof details.filePath !== "string" || !details.filePath) return false;
  return isSecureWebAuthnOrigin(details.requestingUrl || requestingOrigin);
}

function onSelectHidDevice(event, details, callback) {
  event.preventDefault();
  if (!isSecureWebAuthnOrigin(details && details.frame && details.frame.url)) {
    callback(undefined);
    return;
  }
  const device = (details.deviceList || []).find(isFidoHidDevice);
  callback(device ? device.deviceId : undefined);
}

async function onSelectWebauthnAccount(event, details, callback, chooseAccount) {
  event.preventDefault();
  let selected = null;
  try {
    const accounts = (details && details.accounts) || [];
    if (!isSecureWebAuthnOrigin(details?.frame?.url)) return;
    if (accounts.length === 1) selected = accounts[0].credentialId;
    else if (accounts.length && chooseAccount) {
      const candidate = await chooseAccount(details);
      if (accounts.some((account) => account.credentialId === candidate)) selected = candidate;
    }
  } finally { callback(selected); }
}

function createProfileSessionPolicy({
  basePartition,
  fromPartition,
  hardenBrowserSession,
  userAgentForPartition,
  audioInputPermission,
  systemPreferences,
  platform,
  installSessionHook,
  aiDriving = () => false,
  chooseWebauthnAccount,
}) {
  const selectWebauthnAccount = (event, details, callback) => {
    void onSelectWebauthnAccount(event, details, callback, chooseWebauthnAccount).catch(() => {});
  };
  const hardenedPartitions = new Set();
  const hardenedListeners = new Set();
  const configuredSessions = new WeakSet();
  const sessionPartitions = new WeakMap();

  function noteHardened(sess, partition) {
    sessionPartitions.set(sess, partition);
    const first = !hardenedPartitions.has(partition);
    hardenedPartitions.add(partition);
    if (!first) return;
    for (const listener of hardenedListeners) {
      try { listener(partition, sess); } catch {}
    }
  }

  function installWebAuthnAccess(sess) {
    try {
      sess.setDevicePermissionHandler((details) => !!details && details.deviceType === "hid"
        && isSecureWebAuthnOrigin(details.origin) && isFidoHidDevice(details.device));
      sess.removeListener("select-hid-device", onSelectHidDevice);
      sess.on("select-hid-device", onSelectHidDevice);
      sess.removeListener("select-webauthn-account", selectWebauthnAccount);
      sess.on("select-webauthn-account", selectWebauthnAccount);
    } catch {}
  }

  function hardenSession(sess, partition = basePartition) {
    hardenBrowserSession(sess, userAgentForPartition(partition));
    if (!sess) return;
    if (configuredSessions.has(sess)) {
      noteHardened(sess, partition);
      return;
    }
    configuredSessions.add(sess);

    const macCamOK = () => platform !== "darwin"
      || systemPreferences.getMediaAccessStatus("camera") === "granted";
    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
      // 드롭·파일 선택으로 사용자가 건넨 파일은 읽을 수 있어야 한다. 디렉터리와 쓰기 권한은
      // 별도 사용자 결정 없이 파일시스템 범위를 넓히므로 계속 거절한다.
      if (permission === "fileSystem") {
        callback(allowsFileSystemRead(permission, details?.requestingUrl, details));
        return;
      }
      if (permission === "media") {
        if (audioInputPermission(permission, details)) { callback(false); return; }
        if (platform !== "darwin") { callback(true); return; }
        // 카메라를 처음 요청하면 macOS 권한 창이 뜨고 사용자가 응답할 때까지 조작이 막힌다.
        // 자동화가 실행하다 발생한 요청은 묻지 않고 거절한다. 사용자가 자리에 없을 수 있고,
        // 카메라를 여는 결정은 사용자가 한다. 사용자가 누른 요청은 그대로 확인창을 띄운다.
        if (_wc && !_wc.isDestroyed() && aiDriving(_wc.id)) { callback(false); return; }
        systemPreferences.askForMediaAccess("camera")
          .then((ok) => callback(!!ok), () => callback(false));
        return;
      }
      if (permission === "hid") {
        callback(isSecureWebAuthnOrigin(details && details.securityOrigin));
        return;
      }
      // 전체화면·포인터 잠금은 화면과 커서를 점유한다. 자동화가 실행하다 발생한 요청은 거절한다.
      // 사용자가 자리에 없을 수 있고, 화면 제어권을 넘기는 결정은 사용자가 한다.
      if (SCREEN_TAKING.has(permission) && _wc && !_wc.isDestroyed() && aiDriving(_wc.id)) { callback(false); return; }
      callback(AUTO_GRANT.has(permission));
    });
    sess.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      if (permission === "fileSystem") return allowsFileSystemRead(permission, _origin, details);
      if (permission === "media") return !audioInputPermission(permission, details) && macCamOK();
      if (permission === "hid") return isSecureWebAuthnOrigin(details && details.securityOrigin);
      return AUTO_GRANT.has(permission);
    });
    try {
      sess.setDisplayMediaRequestHandler((_request, callback) => callback({ video: undefined, audio: undefined }));
    } catch {}
    installWebAuthnAccess(sess);
    installSessionHook(sess);
    noteHardened(sess, partition);
  }

  function ensureHardened(partition) {
    const value = String(partition || "");
    if (!isProfilePartition(value)) return false;
    if (hardenedPartitions.has(value)) return true;
    hardenSession(fromPartition(value), value);
    return hardenedPartitions.has(value);
  }

  function guardWebviewPartition(webPreferences) {
    const partition = String((webPreferences && webPreferences.partition) || "");
    if (!partition) return;
    if (partition === basePartition) {
      hardenSession(fromPartition(partition), partition);
      return;
    }
    if (!isProfilePartition(partition)) {
      webPreferences.partition = basePartition;
      return;
    }
    ensureHardened(partition);
  }

  function forget(partition) {
    hardenedPartitions.delete(partition);
  }

  async function purgePartition(partition) {
    const sess = fromPartition(partition);
    await sess.clearStorageData();
    try { await sess.clearCache(); } catch {}
    try { await sess.clearAuthCache(); } catch {}
    try { await sess.clearHostResolverCache(); } catch {}
    try { sess.flushStorageData(); } catch {}
    forget(partition);
  }

  async function forEachHardened(callback) {
    for (const partition of hardenedPartitions) await callback(partition);
  }

  function onSessionHardened(listener) {
    if (typeof listener !== "function") return () => {};
    hardenedListeners.add(listener);
    return () => hardenedListeners.delete(listener);
  }

  return {
    ownsSession: (sess) => isProfilePartition(sessionPartitions.get(sess))
      && hardenedPartitions.has(sessionPartitions.get(sess)),
    guardWebviewPartition,
    ensureHardened,
    hardenSession,
    purgePartition,
    forget,
    forEachHardened,
    onSessionHardened,
  };
}

module.exports = {
  createProfileSessionPolicy,
  isProfilePartition,
  isSecureWebAuthnOrigin,
  isFidoHidDevice,
  allowsFileSystemRead,
};
