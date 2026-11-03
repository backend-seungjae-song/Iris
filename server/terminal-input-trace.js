// 터미널에 들어간 휠·포커스 입력 기록. 쉬는 에이전트 화면이 혼자 스크롤될 때 그 시각에 들어간 입력을
// server.log 에서 대조하기 위한 것. 휠은 한 번 쓸 때 수십 번 오므로 1초 단위로 모아 한 줄로 남김.

// SGR 마우스 휠(64 위, 65 아래)과 포커스 보고(ESC[I 들어옴, ESC[O 나감)의 개수
export function countTerminalInput(data) {
  const out = { wheelUp: 0, wheelDown: 0, focusIn: 0, focusOut: 0 };
  if (typeof data !== "string" || !data.includes("\x1b[")) return out;
  for (const m of data.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]|\x1b\[([IO])/g)) {
    if (m[2] === "I") out.focusIn++;
    else if (m[2] === "O") out.focusOut++;
    else {
      // 수식키 비트(4·8·16)를 뺀 버튼 번호
      const button = Number(m[1]) & ~28;
      if (button === 64) out.wheelUp++;
      else if (button === 65) out.wheelDown++;
    }
  }
  return out;
}

export function hasTerminalInput(counts) {
  return counts.wheelUp + counts.wheelDown + counts.focusIn + counts.focusOut > 0;
}

export function formatTerminalInputLine(at, source, counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
  return `[term-input] ${new Date(at).toISOString()} ${source} ${parts.join(" ")}`;
}

// 출처별로 1초 동안 모은 뒤 한 줄로 남기는 기록기
export function createTerminalInputTrace({ log = console.log, now = Date.now, setTimer = setTimeout } = {}) {
  const pending = new Map();
  function flush(source) {
    const entry = pending.get(source);
    pending.delete(source);
    if (entry) log(formatTerminalInputLine(entry.at, source, entry.counts));
  }
  // source 는 글자 또는 글자를 돌려주는 함수. 함수는 휠·포커스 입력일 때만 부름
  return function note(source, data) {
    const counts = countTerminalInput(data);
    if (!hasTerminalInput(counts)) return;
    if (typeof source === "function") source = source();
    const entry = pending.get(source);
    if (entry) {
      for (const k of Object.keys(counts)) entry.counts[k] += counts[k];
      return;
    }
    pending.set(source, { at: now(), counts });
    const timer = setTimer(() => flush(source), 1000);
    timer?.unref?.();
  };
}
