// worker 사본 · 원본 cdp-control.cjs 의 insertTextInChunks 묶음과 같은 텍스트 (test/mcp-worker-input-route.mjs 가 대조)
// 원본은 ⑧에서 지움
// Input.insertText 한 번에 붙여 넣기 크기의 문자열을 보내면 CDP 호출 하나가 오래 붙들려 전체 명령
// 25초 상한까지 먹는다(Orca도 64KiB로 잘라 보낸다). 바이트 상한으로 자르되 Intl.Segmenter의
// grapheme 경계를 써서 서로게이트 쌍·결합 문자·ZWJ 이모지를 반쪽으로 만들지 않는다.
const INSERT_TEXT_CHUNK_BYTES = 64 * 1024;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function* insertionGraphemes(text) {
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) yield part.segment;
    return;
  }
  // 지금 지원 Electron에는 Segmenter가 있지만, 빠진 런타임에서도 최소한 결합 부호·variation
  // selector·피부색·ZWJ 연쇄는 앞 글자와 함께 둔다. Array.from 자체가 서로게이트 쌍은 보존한다.
  let cluster = "", previous = -1;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0);
    const joinsPrevious = cluster && (/\p{Mark}/u.test(ch)
      || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
      || (cp >= 0x1f3fb && cp <= 0x1f3ff) || cp === 0x200d || previous === 0x200d);
    if (!joinsPrevious && cluster) { yield cluster; cluster = ""; }
    cluster += ch; previous = cp;
  }
  if (cluster) yield cluster;
}
function* insertionChunks(value, maxBytes = INSERT_TEXT_CHUNK_BYTES) {
  const text = String(value);
  if (!text) { yield ""; return; } // 빈 문자열도 기존처럼 한 번 보내 선택 영역 교체를 시도한다.
  let chunk = "", bytes = 0;
  for (const grapheme of insertionGraphemes(text)) {
    const nextBytes = Buffer.byteLength(grapheme, "utf8");
    if (chunk && bytes + nextBytes > maxBytes) { yield chunk; chunk = ""; bytes = 0; }
    chunk += grapheme; bytes += nextBytes;
  }
  if (chunk) yield chunk;
}
async function insertTextInChunks(send, value) {
  const chunks = insertionChunks(value);
  let next = chunks.next();
  while (!next.done) {
    await send("Input.insertText", { text: next.value });
    next = chunks.next();
    // CDP payload 사이에 메인 프로세스가 소켓·창 이벤트를 처리할 틈을 준다. 한 청크뿐이면 양보하지 않는다.
    if (!next.done) await new Promise((resolve) => setImmediate(resolve));
  }
}


export { insertTextInChunks };
