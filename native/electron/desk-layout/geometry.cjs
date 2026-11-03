// 창 레이아웃(desklayout) 순수 계산: 모니터 자리 이름, 비율 변환, 창 짝짓기, 서명.
//
// 소유 범위
//   좌표·이름·짝짓기 계산 전부. macOS·Electron·파일시스템을 몰라야 하는 부분만 여기 둔다.
//
// 제공 API
//   monitorSlots(displays) · matchMonitorSlots(savedSlots, currentSlots) ·
//   rectToRatio(rect, area) · ratioToRect(ratio, area) ·
//   pairAppWindows(saved, current) · layoutSignature(windows).
//
// 의존 대상
//   없다. Electron·fs·osascript를 require하지 않는다(설계 1절 "geometry.cjs는 순수 함수").
//
// 유지 조건
//   모든 함수는 입력을 바꾸지 않고 새 값을 반환한다. 부팅·시각·권한처럼 매번 달라지는 값을
//   읽지 않는다. 그래야 mac.cjs·store.cjs·host.cjs의 실측 없이 단위 검사로 확인할 수 있다.
//
// 영향 범위
//   store.cjs(저장 서명·가져오기 변환)·mac.cjs(복원 좌표 계산)·host.cjs(모니터 변경 판정)가 이 파일을 쓴다.
//   현재 목록 확인: node bin/importers.mjs native/electron/desk-layout/geometry.cjs

function center(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

// 메인 모니터 중심 기준 상대 위치로 나머지 모니터에 자리 이름을 붙인다(설계 2절).
// displays: [{ id, bounds:{x,y,width,height}, primary }]. primary 가 하나도 없으면 첫 항목을 메인으로 본다.
function monitorSlots(displays) {
  const list = Array.isArray(displays) ? displays : [];
  if (!list.length) return [];
  const main = list.find((d) => d && d.primary) || list[0];
  const mainCenter = center(main.bounds);
  const out = [{ id: main.id, slot: "main" }];
  const groups = new Map(); // direction -> [{id, dist}]
  for (const d of list) {
    if (d === main) continue;
    const c = center(d.bounds);
    const dx = c.x - mainCenter.x;
    const dy = c.y - mainCenter.y;
    const dist = Math.hypot(dx, dy);
    let dir;
    if (Math.abs(dx) > Math.abs(dy)) dir = dx < 0 ? "left" : "right";
    else dir = dy < 0 ? "above" : "below";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ id: d.id, dist });
  }
  for (const [dir, entries] of groups) {
    entries.sort((a, b) => a.dist - b.dist);
    entries.forEach((entry, i) => out.push({ id: entry.id, slot: `${dir}-${i + 1}` }));
  }
  return out;
}

// 저장본의 자리 이름을 지금 연결된 모니터에 짝짓는다(설계 2절: 같은 이름 → 남은 것과 순서대로 → main).
// savedSlots/currentSlots: [{ id, slot }]. 반환: Map(savedSlot -> currentId).
function matchMonitorSlots(savedSlots, currentSlots) {
  const saved = Array.isArray(savedSlots) ? savedSlots : [];
  const current = Array.isArray(currentSlots) ? currentSlots : [];
  const mainCurrent = current.find((c) => c.slot === "main");
  const result = new Map();
  const usedCurrent = new Set();
  const remainingSaved = [];
  for (const s of saved) {
    const hit = current.find((c) => c.slot === s.slot && !usedCurrent.has(c.id));
    if (hit) { result.set(s.slot, hit.id); usedCurrent.add(hit.id); }
    else remainingSaved.push(s);
  }
  const leftoverCurrent = current.filter((c) => !usedCurrent.has(c.id));
  for (let i = 0; i < remainingSaved.length; i += 1) {
    const s = remainingSaved[i];
    if (i < leftoverCurrent.length) {
      result.set(s.slot, leftoverCurrent[i].id);
      usedCurrent.add(leftoverCurrent[i].id);
    } else if (mainCurrent) {
      result.set(s.slot, mainCurrent.id);
    }
  }
  return result;
}

// workArea 대비 0..1 비율로 바꾼다(설계 3절).
function rectToRatio(rect, area) {
  if (!area || !area.width || !area.height) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: (rect.x - area.x) / area.width,
    y: (rect.y - area.y) / area.height,
    w: rect.width / area.width,
    h: rect.height / area.height,
  };
}

// 네 변을 각각 반올림한다. 같은 workArea 면 저장 px 가 그대로 나오고, 다른 크기의 workArea 에서도 비율 합이 1인
// 변(모서리에 붙은 창)은 모서리에 정확히 닿는다. x 와 width 를 따로 반올림하면 오른쪽 변이 1px 넘칠 수 있다.
function ratioToRect(ratio, area) {
  const x = Math.round(area.x + ratio.x * area.width);
  const y = Math.round(area.y + ratio.y * area.height);
  const right = Math.round(area.x + (ratio.x + ratio.w) * area.width);
  const bottom = Math.round(area.y + (ratio.y + ratio.h) * area.height);
  return { x, y, width: right - x, height: bottom - y };
}

// 창 기록의 좌표는 rect 안에 있다(저장본은 비율, 지금 창은 전역 px). 두 목록은 각자 안에서만 정렬하므로 단위가 달라도 된다.
function orderKeySaved(w) { const r = w.rect || {}; return [w.slot || "", r.y || 0, r.x || 0]; }
function orderKeyCurrent(w) { const r = w.rect || {}; return [r.y || 0, r.x || 0]; }
function compareTuples(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// 앱(bundle) 하나 안에서 저장된 창과 지금 창을 짝짓는다(설계 5.2, 3단계).
// saved/current 원소: { pid, cgId, title, slot, y, x, ... }.
function pairAppWindows(saved, current) {
  const savedList = Array.isArray(saved) ? saved.slice() : [];
  const currentList = Array.isArray(current) ? current.slice() : [];
  const usedCurrent = new Set();
  const pairs = [];

  // 1단계: pid + cgId 가 같은 창.
  const afterTier1 = [];
  for (const s of savedList) {
    const idx = currentList.findIndex((c, i) => !usedCurrent.has(i)
      && s.pid === c.pid && s.cgId != null && c.cgId != null && s.cgId === c.cgId);
    if (idx >= 0) { pairs.push({ saved: s, current: currentList[idx] }); usedCurrent.add(idx); }
    else afterTier1.push(s);
  }

  // 2단계: 제목이 같고, 그 제목의 후보가 저장·현재 양쪽에서 하나뿐인 것.
  const afterTier2 = [];
  for (const s of afterTier1) {
    const savedSameTitle = afterTier1.filter((x) => x.title === s.title).length;
    const currentMatches = [];
    currentList.forEach((c, i) => { if (!usedCurrent.has(i) && c.title === s.title) currentMatches.push(i); });
    if (savedSameTitle === 1 && currentMatches.length === 1) {
      pairs.push({ saved: s, current: currentList[currentMatches[0]] });
      usedCurrent.add(currentMatches[0]);
    } else {
      afterTier2.push(s);
    }
  }

  // 3단계: 저장 순서(slot, y, x)와 지금 순서(y, x)를 나란히 짝짓는다.
  // Iris 자기 창은 제목이 창마다 고정이라, 같은 제목끼리만 짝지음(제목이 다르면 다른 창).
  // 앱을 막 켜서 일부 창이 아직 없을 때 남은 자리를 제목이 다른 창이 차지해 창끼리 자리가 바뀜
  const titled = (w) => !!(w && w.own && w.title);
  const unmatchedSaved = [];
  const pairInOrder = (savedPart, currentIdx) => {
    const orderedSaved = savedPart.slice().sort((a, b) => compareTuples(orderKeySaved(a), orderKeySaved(b)));
    const orderedIdx = currentIdx.slice()
      .sort((a, b) => compareTuples(orderKeyCurrent(currentList[a]), orderKeyCurrent(currentList[b])));
    for (let i = 0; i < orderedSaved.length; i += 1) {
      if (i < orderedIdx.length) {
        pairs.push({ saved: orderedSaved[i], current: currentList[orderedIdx[i]] });
        usedCurrent.add(orderedIdx[i]);
      } else {
        unmatchedSaved.push(orderedSaved[i]);
      }
    }
  };
  const leftoverIdx = () => currentList.map((c, i) => i).filter((i) => !usedCurrent.has(i));
  for (const title of new Set(afterTier2.filter(titled).map((w) => w.title))) {
    pairInOrder(afterTier2.filter((w) => titled(w) && w.title === title),
      leftoverIdx().filter((i) => titled(currentList[i]) && currentList[i].title === title));
  }
  pairInOrder(afterTier2.filter((w) => !titled(w)), leftoverIdx().filter((i) => !titled(currentList[i])));
  const unmatchedCurrent = currentList.filter((c, i) => !usedCurrent.has(i));
  return { pairs, unmatchedSaved, unmatchedCurrent };
}

// 저장본이 직전과 같은지 비교하는 서명(설계 4절: "서명이 직전 저장본과 같음"이면 저장 생략).
// bundle·slot·비율(소수 3자리)·desktop 만 본다. pid·cgId·title은 세션마다 바뀔 수 있어 뺀다.
function layoutSignature(windows) {
  const rows = (Array.isArray(windows) ? windows : []).map((w) => [
    w.bundle || "",
    w.slot || "",
    Math.round((w.rect ? w.rect.x : 0) * 1000) / 1000,
    Math.round((w.rect ? w.rect.y : 0) * 1000) / 1000,
    Math.round((w.rect ? w.rect.w : 0) * 1000) / 1000,
    Math.round((w.rect ? w.rect.h : 0) * 1000) / 1000,
    w.desktop || 0,
  ].join("\u001f"));
  rows.sort();
  return rows.join("\u001e");
}

module.exports = {
  monitorSlots,
  matchMonitorSlots,
  rectToRatio,
  ratioToRect,
  pairAppWindows,
  layoutSignature,
};
