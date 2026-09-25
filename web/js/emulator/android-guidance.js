export function androidGuidance(availability) {
  const android = availability?.android;
  const setup = availability?.androidSetup;
  if (!android || !setup) return null;
  if (!android.sdkFound) {
    if (!setup.studioPath) return {
      message: "Android Studio를 설치하고 처음 실행할 때 나오는 설정을 완료하세요. 이미 설치했다면 SDK 폴더를 지정하세요.",
      action: "download", label: "Android Studio 설치", secondaryAction: "locate", secondaryLabel: "SDK 폴더 지정",
    };
    const missing = [!setup.sdkParts.adb && "플랫폼 도구", !setup.sdkParts.emulator && "에뮬레이터"].filter(Boolean).join("와 ");
    return {
      message: `Android SDK의 ${missing || "필수 도구"}가 없습니다. Android Studio의 첫 실행 설정을 마치거나 시작 화면의 More Actions → SDK Manager에서 설치하세요.`,
      action: "open", label: "Android Studio 열기", secondaryAction: "locate", secondaryLabel: "SDK 폴더 지정",
    };
  }
  const androidDevices = (availability.devices || []).filter((device) => device.runtime === "Android");
  if (androidDevices.length) return null;
  if (/No Android devices or AVDs found/i.test(android.message || "")) return {
    message: "Android 가상 기기가 없습니다. Android Studio의 More Actions → Virtual Device Manager에서 Create Virtual Device를 눌러 기기와 시스템 이미지를 선택하세요.",
    action: setup.studioPath ? "open" : "download",
    label: setup.studioPath ? "Android Studio 열기" : "Android Studio 설치",
  };
  if (android.message && android.message !== "Ready") return {
    message: "Android 기기 목록을 불러오지 못했습니다. Android Studio에서 SDK 설정을 확인한 뒤 다시 확인하세요.",
    action: setup.studioPath ? "open" : "download",
    label: setup.studioPath ? "Android Studio 열기" : "Android Studio 설치",
  };
  return null;
}
