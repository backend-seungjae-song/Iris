// 터미널 칸 수. 한글·한자·전각·그림 문자는 두 칸, 결합 문자는 0칸
// - 이스케이프 문자열은 세지 않음
const graphemes = new Intl.Segmenter("ko", { granularity: "grapheme" });
export function cellWidth(text) {
  let result = 0;
  for (const { segment } of graphemes.segment(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""))) {
    const point = segment.codePointAt(0);
    if (point < 32 || point >= 0x300 && point <= 0x36f || point >= 0xfe00 && point <= 0xfe0f) continue;
    result += point >= 0x1100 && point <= 0x115f || point === 0x2329 || point === 0x232a
      || point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f
      || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff
      || point >= 0xfe10 && point <= 0xfe19 || point >= 0xfe30 && point <= 0xfe6f
      || point >= 0xff00 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x1f1e6 && point <= 0x1faff || point >= 0x20000 && point <= 0x3fffd
      || segment.includes("\ufe0f") || segment.includes("\u20e3") ? 2 : 1;
  }
  return result;
}
