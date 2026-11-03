// 기기 키보드 한/영 전환(조작 줄의 한/영 버튼)
// iOS: 하드웨어 키보드 Ctrl+Space. HID 한/영 키(LANG1 0x90)는 시뮬레이터가 무시함.
//   프레임은 화면이 키 입력과 같은 대기열로 보냄(전환 전후 키 순서 유지)
// Android: KEYCODE_LANGUAGE_SWITCH. 화면이 adb 명령을 직접 보내지 못하게 여기서만 실행
const CTRL_USAGE = 224;
const SPACE_USAGE = 44;
const ANDROID_SWITCH_COMMAND = "input keyevent 204";

function iosSwitchFrames() {
  return [
    { type: "down", usage: CTRL_USAGE }, { type: "down", usage: SPACE_USAGE },
    { type: "up", usage: SPACE_USAGE }, { type: "up", usage: CTRL_USAGE },
  ];
}

// `defaults read -g AppleKeyboards` 출력 → 한국어 키보드 유무. 출력 없음(키 없음, 기기 언어 기본값)은 null
function hasKoreanKeyboard(output) {
  if (output == null) return null;
  return /"ko_[A-Z]{2}@/.test(output);
}

function emulatorError(code, message) {
  return Object.assign(new Error(message), { code });
}

// target: { device?, worktreeId? }. readKeyboards(udid) → 출력 문자열 또는 null
// 반환: iOS 는 { frames }(화면이 보냄), Android 는 {}(여기서 보냄)
async function switchInputLanguage({ bridge, target, readKeyboards }) {
  const { backend, device } = await bridge.resolveTarget(target);
  if (backend.kind === "android") {
    await bridge.exec(ANDROID_SWITCH_COMMAND, target);
    return {};
  }
  const udid = await backend.resolveDeviceId(device);
  if (hasKoreanKeyboard(await readKeyboards(udid)) === false) {
    throw emulatorError("no_korean_keyboard", "이 기기에 한국어 키보드가 없습니다. 기기의 설정 > 일반 > 키보드 > 키보드에서 한국어를 추가하세요.");
  }
  return { frames: iosSwitchFrames() };
}

module.exports = { ANDROID_SWITCH_COMMAND, iosSwitchFrames, hasKoreanKeyboard, switchInputLanguage };
