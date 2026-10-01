function assertUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("짝이 없는 UTF-16 surrogate는 JCS로 만들 수 없습니다.");
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("짝이 없는 UTF-16 surrogate는 JCS로 만들 수 없습니다.");
    }
  }
}

function serialize(value, stack) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("유한한 숫자만 JCS로 만들 수 있습니다.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("JSON 값만 JCS로 만들 수 있습니다.");
  if (stack.has(value)) throw new TypeError("순환 객체는 JCS로 만들 수 없습니다.");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const values = value.map((item) => {
        if (item === undefined || typeof item === "function" || typeof item === "symbol") {
          throw new TypeError("배열의 모든 항목은 JSON 값이어야 합니다.");
        }
        return serialize(item, stack);
      });
      return `[${values.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("일반 객체만 JCS로 만들 수 있습니다.");
    }
    const keys = Object.keys(value).sort();
    const fields = [];
    for (const key of keys) {
      assertUnicode(key);
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        throw new TypeError("객체의 모든 필드는 JSON 값이어야 합니다.");
      }
      fields.push(`${JSON.stringify(key)}:${serialize(item, stack)}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function canonicalize(value) {
  return serialize(value, new Set());
}

export function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), "utf8");
}
