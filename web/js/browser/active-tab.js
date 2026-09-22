// 이 창의 활성 탭 판정 하나만 소유한다.
//
// 소유 범위
//   창이 한 탭에 묶였을 때와 아닐 때의 활성 탭 결정, 그리고 공유 활성 탭을 써도 되는지의 판정.
//
// 제공 API
//   activeIdFor({ boundTab, spaceActive }) · mayWriteSharedActive(boundTab)
//
// 의존 대상
//   아무것도. 값만 받아 값을 돌려주며 DOM·상태·훅을 모른다. 그래서 단독으로 검사할 수 있다.
//
// 유지 조건
//   activeBySpace 는 스페이스마다 하나뿐이다. 같은 스페이스에서 뺀 창이 둘이면 그 값을 따르는
//   순간 창 둘이 같은 페이지를 표시한다. 그래서 묶인 창은 자기 탭을 본다.
//   묶인 창은 공유 활성 탭을 쓰지도 않는다. 쓰면 원래 창이 "거기서는 감춰진 탭"으로 끌려간다.
//   떨어져 나간 탭은 원래 창의 활성 탭이 될 수 없다. 탭 띠에서는 감춰졌는데 화면만 그 페이지로
//   남기 때문이다.
//   공유 값 자체는 바꾸지 않는다. 되돌아오면 그 탭이 다시 활성이 되는 것이 맞다.
//   이 판정을 부르는 자리마다 다시 적지 않는다. 세 곳에 흩어지면 언젠가 한 곳만 고쳐진다.
//
// 영향 범위
//   webview.js(활성 탭 읽기) · dock.js(렌더) · tabs.js(칩 클릭) · keynav.js(탭 순환).
//   현재 목록은 다음 명령으로 확인한다: node bin/importers.mjs web/js/browser/active-tab.js

// 이 창이 비출 탭.
//   묶인 창       그 탭
//   그 외         스페이스가 공유하는 활성 탭. 그것이 떨어져 나갔으면 옆의 안 떨어진 탭
// order 는 이 스페이스의 탭 id 를 보이는 순서로 준 것이고, hidden 은 떨어져 나간 id 들이다.
export function activeIdFor({ boundTab, spaceActive, hidden, order } = {}) {
  if (boundTab) return boundTab;
  if (!spaceActive) return null;
  if (!hidden || !hidden.has || !hidden.has(spaceActive)) return spaceActive;
  // 크롬이 탭을 뺄 때처럼 옆으로 옮긴다. 뒤를 먼저 보고 없으면 앞을 본다.
  const list = Array.isArray(order) ? order : [];
  const at = list.indexOf(spaceActive);
  if (at < 0) return list.find((id) => !hidden.has(id)) || null;
  for (let i = at + 1; i < list.length; i++) if (!hidden.has(list[i])) return list[i];
  for (let i = at - 1; i >= 0; i--) if (!hidden.has(list[i])) return list[i];
  return null;
}

// 공유 활성 탭(activeBySpace)을 옮겨도 되는 창인가. 묶인 창은 아니다.
export function mayWriteSharedActive(boundTab) {
  return !boundTab;
}
