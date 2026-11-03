// 에뮬레이터 분리 창 제목 계산
//
// 제공 API
//   emulatorWindowTitles(windows) → Map(key → 제목)
//   windows: [{ key, name, udid }]. name 은 붙은 기기의 기종 이름(없으면 기기 없음)
//
// 유지 조건
//   기기 없는 창: "Iris — 에뮬레이터"
//   기종 이름이 하나뿐: "Iris — iPhone 13". 같은 기종이 여럿이면 뒤에 1, 2, 3
//   번호 순서는 udid 순. 여는 순서는 재시작마다 달라져 창 배치 복구(제목으로 창을 짝지음)가 창을 뒤바꿈

const PREFIX = "Iris — ";
const EMPTY = PREFIX + "에뮬레이터";

function cleanName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

function emulatorWindowTitles(windows) {
  const out = new Map();
  const byName = new Map();
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!w || w.key == null) continue;
    const name = cleanName(w.name);
    if (!name) { out.set(w.key, EMPTY); continue; }
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ key: w.key, udid: String(w.udid || "") });
  }
  for (const [name, list] of byName) {
    if (list.length === 1) { out.set(list[0].key, PREFIX + name); continue; }
    list.sort((a, b) => (a.udid < b.udid ? -1 : a.udid > b.udid ? 1 : 0));
    list.forEach((w, i) => out.set(w.key, `${PREFIX}${name} ${i + 1}`));
  }
  return out;
}

module.exports = { emulatorWindowTitles, EMPTY_EMULATOR_TITLE: EMPTY };
