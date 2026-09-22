// 저장된 창 위치를 현재 화면에 배치할 수 있는지 판정한다.
//
// 이 판정이 창 배치를 결정한다. 참이면 종료 시점의 위치로 복원하고, 거짓이면 기본 위치를 쓴다.
// 거짓이 나오는 가장 흔한 원인은 외장 모니터가 아직 연결되지 않은 것이다. 로그인이나 절전 해제
// 직후에는 외장 모니터가 몇 초 뒤에 나타난다. 그 사이에 뜬 창은 한 화면에 겹쳐 쌓이고,
// 그 임시 위치가 저장되어 원래 위치를 덮어쓴다.
//
// electron을 require 하지 않는 별도 파일로 둔 이유는 이 판정만 따로 시험하기 위해서다.
// 창 배치는 화면으로 확인하기 전에는 오류를 알기 어려워, 판정만이라도 검사로 강제한다.
function boundsVisible(b, displays) {
  if (!b) return false;
  for (const k of ["x", "y", "width", "height"]) if (typeof b[k] !== "number" || !Number.isFinite(b[k])) return false;
  if (b.width < 200 || b.height < 150) return false; // 비정상 소형 방어
  if (!Array.isArray(displays)) return false;
  // 1px 걸침이 아니라 충분히 겹칠 때만 복원(모니터 분리·재배치 시 화면 밖 복원 방지).
  return displays.some((d) => {
    const a = d && d.workArea;
    if (!a) return false;
    const ox = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const oy = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return ox >= 200 && oy >= 100;
  });
}

module.exports = { boundsVisible };
