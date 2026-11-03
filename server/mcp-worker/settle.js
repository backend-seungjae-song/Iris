// 옛 cdp-observation.cjs settleAnimations 와 같은 순서 · 실행 중인 유한 애니메이션이 끝날 때까지만 기다림
// 원본은 ⑧에서 지움
const SETTLE_CAP_MS = 900;
const SETTLE_STEP_MS = 60;

export async function settleAnimations(send, cap, { now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const until = now() + Math.max(0, Math.min(3000, Number(cap) || SETTLE_CAP_MS));
  for (;;) {
    let running = 0;
    try {
      const result = await send("Runtime.evaluate", {
        expression: `(() => { try { return document.getAnimations().filter((a) => {
            if (a.playState !== "running") return false;
            try { const t = a.effect && a.effect.getTiming();
                  if (t && (t.iterations === Infinity || !isFinite(t.iterations))) return false; } catch (e) {}
            return true; }).length; } catch (e) { return 0; } })()`,
        returnByValue: true,
      });
      running = Number(result && result.result && result.result.value) || 0;
    } catch { return; }
    if (!running || now() >= until) return;
    await wait(SETTLE_STEP_MS);
  }
}
