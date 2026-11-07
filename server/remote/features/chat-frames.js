// 대화 프레임을 원격 상한(64 KiB) 안으로 나누는 순수 함수
//
// 제공 API
//   fitMessage(message, maxBytes) → 상한 안에 들어가는 메시지(큰 문자열은 잘라 표시)
//   chunkMessages(messages, maxBytes) → 각 묶음이 상한 안에 드는 메시지 배열의 배열

const CUT_MARK = "\n…(길어서 잘림)";

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// 문자열 필드를 length 글자까지 자른 사본
function shrink(value, length) {
  if (typeof value === "string") return value.length > length ? value.slice(0, length) + CUT_MARK : value;
  if (Array.isArray(value)) return value.map((item) => shrink(item, length));
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = shrink(item, length);
    return copy;
  }
  return value;
}

// 문자열 값마다 redact 를 적용한 사본. skipKeys 의 값은 구조 이름이라 그대로 둠
export function redactStrings(value, redact, skipKeys = new Set(["type", "id"])) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact, skipKeys));
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = skipKeys.has(key) ? item : redactStrings(item, redact, skipKeys);
    return copy;
  }
  return value;
}

// 폰에 보내는 메시지. 본문의 Mac 경로·세션 식별자를 가린다(폰에는 경로와 UUID 를 주지 않는 원칙)
export function publicMessage(message, redact) {
  return { ...message, blocks: redactStrings(message.blocks, redact) };
}

export function fitMessage(message, maxBytes) {
  if (bytes(message) <= maxBytes) return message;
  for (let length = 16_000; length >= 250; length = Math.floor(length / 2)) {
    const smaller = shrink(message, length);
    if (bytes(smaller) <= maxBytes) return smaller;
  }
  // 블록이 너무 많은 메시지는 자리표시 한 줄로 바꿈
  return { id: message.id, role: message.role, ts: message.ts, blocks: [{ type: "text", text: "(메시지가 너무 커서 폰에서 표시하지 않음)" }] };
}

export function chunkMessages(messages, maxBytes) {
  const groups = [];
  let current = [];
  let size = 2;
  for (const original of messages) {
    const message = fitMessage(original, maxBytes - 2);
    const cost = bytes(message) + 1;
    if (current.length && size + cost > maxBytes) { groups.push(current); current = []; size = 2; }
    current.push(message);
    size += cost;
  }
  if (current.length) groups.push(current);
  return groups;
}
