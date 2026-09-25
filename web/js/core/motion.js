// 모션(전환·애니메이션) 켜기/끄기. 사용자가 설정 화면에서 고른 값을 렌더러 localStorage 에 두고
// body 클래스로 반영한다.
//
// 소유 범위
//   "ac.motion" localStorage 키 하나와 body 의 motion-off 클래스.
//
// 제공 API
//   motionOn() · setMotion(on) · initMotion().
//
// 의존 대상
//   localStorage 와 document.body. 저장소가 없으면(테스트 환경 등) 항상 켜짐으로 본다.
//
// 배경
//   OS 의 "동작 줄이기"를 그대로 따르면 그 설정을 켠 사용자는 이 앱에서도 모션을 볼 수 없다.
//   기본값은 그 설정과 무관하게 켜짐이고, 끄는 것은 이 앱 안의 선택이다.
//   실제로 멈추는 규칙은 web/css/01-base.css 의 `body.motion-off *` 가 갖는다.

const KEY = "ac.motion";

export function motionOn() {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v !== "0";   // 값이 없으면(첫 실행) 기본 켜짐
  } catch { return true; }
}

function applyMotionClass(on) {
  try { globalThis.document?.body?.classList.toggle("motion-off", !on); } catch {}
}

export function setMotion(on) {
  try { globalThis.localStorage?.setItem(KEY, on ? "1" : "0"); } catch {}
  applyMotionClass(on);
}

export function initMotion() {
  applyMotionClass(motionOn());
}
