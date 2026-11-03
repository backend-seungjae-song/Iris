export function returnPlace(home, layoutOn) {
  return home === "stage" ? "stage" : home === "column" && layoutOn ? "column" : "tab";
}

export function phoneControls(platform) {
  if (platform === "Android") return ["back", "home", "recents", "rotate", "volume_down", "volume_up", "lock", "lang"];
  if (platform === "iOS") return ["home", "rotate", "lang"];
  return [];
}

export function pickSurface(kind, insideScreen) {
  if (insideScreen) return false;
  return kind === "tab" || kind === "column" || kind === "stage" || kind === "window";
}

// 요소 선택 중에도 지정으로 가로채지 않는 곳: 기기 화면, 툴바 조작 요소(요소 선택 끄기 단추 포함)
export const PICK_PASS = ".emu-screen-surface, .emu-toolbar :is(button, input, select, textarea, [role=button], [role=menuitem], [role=combobox])";

export function pickTargetAt(el, entries, column, stageHost) {
  if (!el?.closest || el.closest(PICK_PASS)) return null;
  const tabEl = el.closest(".ctab");
  const tabId = tabEl?.dataset?.tab;
  const entry = tabId ? entries.find((item) => item.tab.id === tabId && !item.detached)
    : entries.find((item) => !item.detached && (item.el.contains(el) || item.tools?.contains(el)))
    || entries.find((item) => !item.detached && (
      item.inColumn && !item.el.hidden && column?.contains(el) || item.inStage && !item.el.hidden && stageHost?.contains(el) || item.el.contains(el)));
  if (!entry) return null;
  const where = tabEl ? "tab" : entry.inColumn ? "column" : entry.inStage ? "stage" : "tab";
  if (!pickSurface(where, false)) return null;
  return { entry, el: tabEl || (entry.el.contains(el) ? entry.el : entry.inColumn && column || entry.inStage && stageHost || entry.el), where };
}

// 한/영 전환 대기열. 전환을 누른 뒤 친 키는 전환 응답·기기 반영을 기다렸다가 누른 순서대로 보냄
//   iOS 는 전환 뒤 약 1초 안에 온 키(특히 Space)를 버림 → 전환 프레임 뒤 settleMs 쉼
//   몰아 보낸 키는 iOS 가 빠뜨리거나 전환 상태가 꼬여서, 모은 키 묶음 사이에 keyGapMs(사람 타자 속도) 쉼
//   앞 전환 뒤 2초 안의 Ctrl+Space 는 다음 언어가 아닌 다른 키보드로 넘어가 상태가 꼬임 → 전환끼리 switchSpacingMs 띄움
//   전환 응답(switchResult)이 { frames } 가 아니면(실패) 쉬지 않고 남은 키를 보냄
export function createKeyboardQueue({ sendFrame, delay, now = () => Date.now(), settleMs = 1100, frameGapMs = 4, switchGapMs = 40, keyGapMs = 120, switchSpacingMs = 2500 }) {
  let items = [];
  let lastSwitchAt = -Infinity;
  let running = null;
  let generation = 0;
  async function pump(gen) {
    while (items.length && gen === generation) {
      const item = items.shift();
      if (item.frames) {
        for (const frame of item.frames) { if (gen !== generation) return; sendFrame(frame); await delay(frameGapMs); }
        await delay(keyGapMs);
        continue;
      }
      const result = await item.switchResult.catch(() => null);
      if (gen !== generation || !result?.frames) continue;
      const spacing = lastSwitchAt + switchSpacingMs - now();
      if (spacing > 0) { await delay(spacing); if (gen !== generation) return; }
      lastSwitchAt = now();
      for (const frame of result.frames) { sendFrame(frame); await delay(switchGapMs); }
      await delay(settleMs);
    }
  }
  function start() {
    if (running) return;
    const gen = generation;
    running = pump(gen).finally(() => { running = null; if (items.length) start(); });
  }
  return {
    enqueueFrames(frames) {
      if (!running && !items.length) return false;
      items.push({ frames });
      return true;
    },
    enqueueSwitch(switchResult) { items.push({ switchResult }); start(); },
    clear() { generation += 1; items = []; },
    async idle() { while (running) await running; },
  };
}
