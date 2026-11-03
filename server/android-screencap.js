const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ANDROID_MULTI_DISPLAY_WARNING = Buffer.from('[Warning] Multiple displays were found, but no display id was specified! Defaulting to the first display found, however this default is not guaranteed to be consistent across captures. A display id should be specified.\nA display ID can be specified with the [-d display-id] option.\nSee "dumpsys SurfaceFlinger --display-id" for valid display IDs.\n');

export function androidScreenshotPng(output) {
  // Samsung screencap은 이 경고를 바이너리와 같은 stdout에 쓴다.
  const bytes = output.subarray(0, ANDROID_MULTI_DISPLAY_WARNING.length).equals(ANDROID_MULTI_DISPLAY_WARNING)
    ? output.subarray(ANDROID_MULTI_DISPLAY_WARNING.length) : output;
  if (bytes.length < 24 || !bytes.subarray(0, PNG.length).equals(PNG)) {
    throw new Error("PNG 화면을 저장하지 못했습니다.");
  }
  return bytes;
}
