// Iris profile partition과 session 권한·WebAuthn/HID 정책의 상태 소유자.
//
// 소유 범위
//   허용하는 partition 형식, hardened partition registry, session별 정책 설치 표식과
//   일반 권한·WebAuthn account·FIDO HID 선택 규칙.
//
// 제공 API
//   createProfileSessionPolicy(...)가 guardWebviewPartition·ensureHardened·hardenSession·purgePartition·
//   forget·forEachHardened·onSessionHardened·requestExternalOpen 명령과 ownsSession·partitionForSession 조회를 제공하고,
//   순수 partition/origin/FIDO 판정 함수도 함께 제공한다.
//   원시 Set·WeakSet이나 session 객체 registry는 제공하지 않는다.
//
// 의존 대상
//   호출자가 주입하는 base partition, partition→session 조회, browser hardening·UA 조회·오디오 입력
//   판정·systemPreferences·다운로드 hook. Electron session을 직접 require하거나 전역으로 잡지 않는다.
//
// 유지 조건
//   persist:acbrowser와 persist:acprof:<안정 id>만 통과하고 미지 partition은 base로 강제한다.
//   WebAuthn은 HTTPS 또는 localhost에서만, HID는 FIDO usage page 장치만 허용한다. 위치·화면 공유·마이크·파일 쓰기는
//   사용을 켠 기능에서 사람이 허용한 보안 문맥 사이트만 받는다.
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
// 앱 열기로 넘기지 않는 주소 형식. 브라우저가 스스로 여는 것과 크롬이 막는 것(kDeniedSchemes).
const BROWSER_SCHEMES = new Set(["http:", "https:", "file:", "ftp:", "ws:", "wss:", "data:", "blob:", "javascript:",
  "about:", "filesystem:", "chrome:", "chrome-extension:", "devtools:", "view-source:",
  "afp:", "applescript:", "disk:", "disks:", "hcp:", "ie.http:", "mk:", "ms-help:", "nntp:", "res:", "shell:",
  "vbscript:", "vnd.ms.radio:"]);
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

// figma:// 처럼 설치된 앱이 등록한 주소인가.
function isAppSchemeUrl(raw) {
  try { return !BROWSER_SCHEMES.has(new URL(String(raw || "")).protocol); } catch { return false; }
}

// 확인 창에 보여 줄 요청 사이트. http(s) 문서만 origin 을 믿고, about·data·opaque 는 빈 값(거절).
function requestingSite(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : "";
  } catch { return ""; }
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
  confirmExternalOpen = async () => false,
  // 위치·화면 공유·마이크·파일 쓰기. 기능이 꺼져 있거나 사이트가 허용되지 않으면 거절한다(site-permissions.cjs).
  sitePermissions = { decision: () => undefined, ask: async () => false },
  // 화면 공유로 넘길 화면 하나를 고른다. 없으면 null. 요청 프레임이 자동화 실행 중인 탭이면 true.
  pickDisplaySource = async () => null,
  // 요청한 프레임이 든 탭(webContents). 모르면 null.
  frameWebContents = () => null,
}) {
  const selectWebauthnAccount = (event, details, callback) => {
    void onSelectWebauthnAccount(event, details, callback, chooseWebauthnAccount).catch(() => {});
  };
  // 앱 열기 확인 창이 떠 있는 탭, 거절한 뒤 다음 최상위 이동 전까지 묻지 않을 탭.
  // 사이트는 사용자 동작 없이도 요청을 되풀이할 수 있어서(Electron 은 gesture 를 넘기지 않는다) 탭마다 한 번만 묻는다.
  const externalAsking = new Set();
  const externalRefused = new WeakSet();
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

  // 앱 주소 열기 허용 판정. 권한 요청(이동)과 새 창 요청(target=_blank·window.open)이 같이 쓴다.
  // unsure: 요청한 프레임을 몰라 탭 주소로 대신했고 탭 안에 다른 출처 프레임이 있음. 확인 창 문구가 달라진다.
  function requestExternalOpen(_wc, externalURL, requestingUrl, { unsure = false } = {}) {
    const url = String(externalURL || "");
    const site = requestingSite(requestingUrl);
    const wc = _wc && !_wc.isDestroyed() ? _wc : null;
    if (!wc || !site || !isAppSchemeUrl(url) || aiDriving(wc.id) || externalAsking.has(wc.id) || externalRefused.has(wc)) {
      return Promise.resolve(false);
    }
    externalAsking.add(wc.id);
    return Promise.resolve()
      .then(() => confirmExternalOpen({ url, site, unsure: !!unsure }))
      .then((ok) => ok === true && !wc.isDestroyed() && !aiDriving(wc.id), () => false)
      .then((ok) => {
        externalAsking.delete(wc.id);
        if (!ok && !wc.isDestroyed()) {
          externalRefused.add(wc);
          wc.once("did-navigate", () => externalRefused.delete(wc));
        }
        return ok;
      });
  }

  function hardenSession(sess, partition = basePartition) {
    hardenBrowserSession(sess, userAgentForPartition(partition));
    if (!sess) return;
    if (configuredSessions.has(sess)) {
      noteHardened(sess, partition);
      return;
    }
    configuredSessions.add(sess);

    const macStatusOK = (kind) => platform !== "darwin"
      || systemPreferences.getMediaAccessStatus(kind) === "granted";
    // 카메라를 처음 요청하면 macOS 권한 창이 뜨고 사용자가 응답할 때까지 조작이 막힌다.
    // 자동화가 실행하다 발생한 요청은 묻지 않고 거절한다. 사용자가 자리에 없을 수 있고,
    // 카메라를 여는 결정은 사용자가 한다. 사용자가 누른 요청은 그대로 확인창을 띄운다.
    const askCamera = (wc, callback) => {
      if (platform !== "darwin") { callback(true); return; }
      if (wc && !wc.isDestroyed() && aiDriving(wc.id)) { callback(false); return; }
      systemPreferences.askForMediaAccess("camera")
        .then((ok) => callback(!!ok), () => callback(false));
    };
    // 사이트별로 묻는 권한. 보안 문맥(https·localhost)의 문서만, 자동화가 조작 중이면 묻지 않고 거절한다.
    // 요청한 프레임이 탭의 최상위 문서와 같은 출처일 때만 받는다. 다른 출처 iframe 은 최상위 사이트가 위임한 것인지 알 수 없다.
    const siteOf = (wc, raw) => {
      const site = requestingSite(raw);
      if (!site || !isSecureWebAuthnOrigin(site) || !wc || wc.isDestroyed()) return "";
      let top = "";
      try { top = requestingSite(wc.getURL()); } catch {}
      return top === site ? site : "";
    };
    // 사이트는 사용자 동작 없이도 요청을 되풀이할 수 있어서 탭마다 창 하나만 띄우고, 사람이 허용하지 않으면 다음 최상위 이동까지 묻지 않는다.
    const siteAsking = new Set();
    const siteRefused = new WeakSet();
    const askSite = (kind, wc, requestingUrl) => {
      const site = siteOf(wc, requestingUrl);
      if (!site || aiDriving(wc.id) || siteAsking.has(wc.id) || siteRefused.has(wc)) return Promise.resolve(false);
      siteAsking.add(wc.id);
      return Promise.resolve().then(() => sitePermissions.ask(kind, site, partition)).then((ok) => ok === true, () => false)
        .then((ok) => {
          siteAsking.delete(wc.id);
          if (!ok && !wc.isDestroyed()) { siteRefused.add(wc); wc.once("did-navigate", () => siteRefused.delete(wc)); }
          return ok;
        });
    };
    // 이미 허용한 사이트인지만 본다(동기). 묻지 않는다.
    const allowedSite = (kind, wc, raw) => {
      const site = siteOf(wc, raw);
      return !!site && sitePermissions.decision(kind, site, partition) === true;
    };
    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
      // 드롭·파일 선택으로 사용자가 건넨 파일은 읽을 수 있어야 한다. 디렉터리와 쓰기 권한은
      // 파일시스템 범위를 넓히므로 사용을 켜 둔 사이트에서 사람이 허용한 것만 받는다.
      if (permission === "fileSystem") {
        if (allowsFileSystemRead(permission, details?.requestingUrl, details)) { callback(true); return; }
        askSite("fileWrite", _wc, details?.requestingUrl).then(callback);
        return;
      }
      if (permission === "geolocation") {
        askSite("geolocation", _wc, details?.requestingUrl).then(callback);
        return;
      }
      if (permission === "media") {
        const wantsAudio = audioInputPermission(permission, details);
        const wantsVideo = !Array.isArray(details && details.mediaTypes) || details.mediaTypes.includes("video");
        const micOk = !wantsAudio ? Promise.resolve(true)
          : askSite("microphone", _wc, details?.requestingUrl)
            .then((ok) => ok && (platform !== "darwin" || systemPreferences.askForMediaAccess("microphone")))
            .then((ok) => !!ok, () => false);
        micOk.then((ok) => {
          if (!ok) { callback(false); return; }
          if (!wantsVideo) { callback(true); return; }
          askCamera(_wc, callback);
        });
        return;
      }
      if (permission === "hid") {
        callback(isSecureWebAuthnOrigin(details && details.securityOrigin));
        return;
      }
      // 사이트가 앱 주소(figma:// 등)로 설치된 앱을 열려는 요청. Figma 데스크톱 로그인은 이 주소로 결과를 넘긴다.
      // 크롬처럼 사람에게 묻는다. 자동화가 조작 중이면 사람이 모르는 사이 앱이 실행되므로 묻지 않고 거절한다.
      if (permission === "openExternal") {
        requestExternalOpen(_wc, details && details.externalURL, details && details.requestingUrl).then(callback);
        return;
      }
      // 전체화면·포인터 잠금은 화면과 커서를 점유한다. 자동화가 실행하다 발생한 요청은 거절한다.
      // 사용자가 자리에 없을 수 있고, 화면 제어권을 넘기는 결정은 사용자가 한다.
      if (SCREEN_TAKING.has(permission) && _wc && !_wc.isDestroyed() && aiDriving(_wc.id)) { callback(false); return; }
      callback(AUTO_GRANT.has(permission));
    });
    sess.setPermissionCheckHandler((_wc, permission, _origin, details) => {
      const from = (details && details.requestingUrl) || _origin;
      if (permission === "fileSystem") return allowsFileSystemRead(permission, _origin, details) || allowedSite("fileWrite", _wc, from);
      if (permission === "geolocation") return allowedSite("geolocation", _wc, from);
      if (permission === "media") {
        return audioInputPermission(permission, details) ? allowedSite("microphone", _wc, from) && macStatusOK("microphone") : macStatusOK("camera");
      }
      if (permission === "hid") return isSecureWebAuthnOrigin(details && details.securityOrigin);
      return AUTO_GRANT.has(permission);
    });
    try {
      // 시스템 선택창(useSystemPicker)은 이 핸들러를 건너뛰어 사이트별 허용을 받을 수 없어 쓰지 않는다.
      sess.setDisplayMediaRequestHandler((request, callback) => {
        const frame = request && request.frame;
        const wc = frameWebContents(frame);
        Promise.resolve()
          .then(() => askSite("display", wc, frame && frame.url))
          // 허용 기록이 있어도 공유할 때마다 화면을 사람이 고른다(크롬과 같음).
          .then((ok) => (ok === true ? pickDisplaySource({ site: requestingSite(frame.url) }) : null))
          .then((source) => callback(source ? { video: source } : { video: undefined, audio: undefined }),
            () => callback({ video: undefined, audio: undefined }));
      });
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

  // 이 정책이 설치한 프로필 session 의 partition. 모르는 session 이면 null 이다.
  function partitionForSession(sess) {
    const partition = sess ? sessionPartitions.get(sess) : undefined;
    return isProfilePartition(partition) && hardenedPartitions.has(partition) ? partition : null;
  }

  return {
    ownsSession: (sess) => partitionForSession(sess) !== null,
    partitionForSession,
    guardWebviewPartition,
    ensureHardened,
    hardenSession,
    purgePartition,
    forget,
    forEachHardened,
    onSessionHardened,
    requestExternalOpen,
  };
}

module.exports = {
  createProfileSessionPolicy,
  isAppSchemeUrl,
  requestingSite,
  isProfilePartition,
  isSecureWebAuthnOrigin,
  isFidoHidDevice,
  allowsFileSystemRead,
};
