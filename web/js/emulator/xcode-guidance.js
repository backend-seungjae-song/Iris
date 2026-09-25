export function xcodeGuidance(availability) {
  const xcode = availability?.xcode;
  if (!xcode) return null;
  if (xcode.status === "missing") return {
    message: "기본 설치 경로에서 Xcode를 찾지 못했습니다. 설치하거나 다른 위치의 Xcode 앱을 선택하세요.",
    action: "download", label: "Xcode 설치", secondaryAction: "select", secondaryLabel: "설치된 Xcode 선택",
  };
  if (xcode.status === "repair") return {
    message: "Xcode는 설치되어 있지만 macOS가 시뮬레이터 도구로 선택하지 않았습니다. Mac의 개발 도구 선택을 바꾸려면 관리자 인증이 필요합니다.",
    action: "select", label: "Xcode 선택",
  };
  if (xcode.status === "choose") return {
    message: "Xcode가 여러 개 설치되어 있습니다. 사용할 앱을 고르면 Mac의 개발 도구 선택이 바뀌며 관리자 인증이 필요합니다.",
    action: "select", label: "Xcode 선택",
  };
  if (xcode.status === "incomplete") return {
    message: "Xcode의 시뮬레이터 도구가 준비되지 않았습니다. Xcode를 열어 설치를 마치세요.",
    action: "open", label: "Xcode 열기",
  };
  if (availability.simctl?.ok === false && /No iOS simulators found/i.test(availability.simctl.message || "")) return {
    message: "사용할 iOS 시뮬레이터가 없습니다. Xcode에서 iOS 런타임과 시뮬레이터를 추가하세요.",
    action: "open", label: "Xcode 열기",
  };
  if (availability.simctl?.ok === false) return {
    message: "Xcode 시뮬레이터 도구를 실행하지 못했습니다. Xcode를 열어 초기 설정을 마친 뒤 다시 확인하세요.",
    action: "open", label: "Xcode 열기",
  };
  return null;
}
