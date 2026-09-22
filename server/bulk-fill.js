// 대량 기입 판정만 모아 둔다. 실제 입력은 cdp-control이 하고, 여기서는 이 묶음을 입력해도
// 되는지만 결정한다. 순수 함수라 smoke 검사가 조건을 바꿔 가며 확인할 수 있다.
//
// 기준은 개수가 아니라 되돌릴 수 있는지다. 로컬이고 비용이 없으면
// 잘못돼도 다시 만들 수 있어 그대로 진행하고, 원격·공유 데이터는 한 번 덮으면 다른 사람의
// 기록이 사라지므로 사용자가 확인하고 승인한 것만 보낸다.

// 로컬로 판정할 주소. 여기 없는 주소는 모두 원격으로 처리한다. 확실하지 않으면 제한하는 쪽이 기본이다.
// 판정은 server/local-origin.cjs 가 소유한다. 대량 기입과 로컬 로그인이 같은 판정을
// 쓰므로, 각각 구현하면 한쪽만 넓어져 원격에 값을 입력하거나 자격증명을 노출할 수 있다.
import { isLocalOrigin } from "./local-origin.cjs";

export const isLocalTarget = isLocalOrigin;

// 셀 경계를 넘겨 표를 어긋나게 만드는 값과, 시트가 계산식·명령으로 읽는 값을 막는다.
// 한 칸이 두 칸이 되면 아래 항목이 전부 한 칸씩 밀리고, 이것이 대량 기입의 주된 오염 경로다.
const FORMULA_LEAD = ["=", "+", "-", "@", "\t", "\r"];

export function checkValues(values, opts = {}) {
  if (!Array.isArray(values)) return { ok: false, error: "values 는 문자열 배열이어야 합니다." };
  if (!values.length) return { ok: false, error: "넣을 값이 없습니다." };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "string") return { ok: false, error: `${i + 1}번째 값이 문자열이 아닙니다.` };
    if (/[\n\r\t]/.test(v)) {
      return { ok: false, error: `${i + 1}번째 값에 줄바꿈·탭이 있습니다 — 칸 경계를 넘어 그 아래 전부가 밀립니다.` };
    }
    if (!opts.allowFormula && FORMULA_LEAD.some((c) => v.startsWith(c))) {
      return { ok: false, error: `${i + 1}번째 값이 "${v.slice(0, 8)}"로 시작합니다 — 시트가 계산식으로 읽습니다. 정말 수식이면 allowFormula를 켜세요.` };
    }
  }
  return { ok: true };
}

// 원장의 표면 표기와 같은 규칙(접두 일치)으로 본다.
export function inDeclaredSurface(where, surfaces) {
  if (!where || !Array.isArray(surfaces) || !surfaces.length) return false;
  return surfaces.some((s) => s && (where === s || where.startsWith(s)));
}

// 한 번에 입력할 수 있는 상한. 로컬 상한은 정책이 아니라 과도한 실행을 막기 위한 값이다.
export const CAP_LOCAL = 5000;
export const CAP_REMOTE = 300;

// mode: "free"(그대로 입력) · "confirm"(사용자 승인 뒤에만) · "deny"(입력하지 않음)
export function bulkPolicy({ url, values, where, surfaces, approved, allowFormula }) {
  const v = checkValues(values, { allowFormula });
  if (!v.ok) return { mode: "deny", reason: v.error };

  // 확인 대상 화면을 대량으로 채우는 것은 확인이 아니다. 판정 대상은 한 칸씩 입력한다.
  if (inDeclaredSurface(where, surfaces)) {
    return { mode: "deny",
      reason: `${where} 는 이 회차가 확인하기로 선언한 표면입니다 — 판정하는 화면은 대량으로 채우지 않습니다. 기입 대상 표면에서만 쓰세요.` };
  }

  const local = isLocalTarget(url);
  const cap = local ? CAP_LOCAL : CAP_REMOTE;
  if (values.length > cap) {
    return { mode: "deny", reason: `한 번에 ${cap}개까지입니다(${values.length}개 요청). 나눠서 부르세요.` };
  }
  if (local) return { mode: "free", reason: "로컬이라 되돌릴 수 있습니다.", cap };
  if (approved) return { mode: "free", reason: "사람이 승인했습니다.", cap, wasRemote: true };
  return { mode: "confirm", cap, wasRemote: true,
    reason: `${(() => { try { return new URL(url).host; } catch { return String(url); } })()} 는 원격입니다 — 덮으면 남의 기록이 사라집니다. 사람에게 보여 주고 승인받은 뒤에 칩니다.` };
}
