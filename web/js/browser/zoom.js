export function requestBrowserZoom(acHost, view, key) {
  const action = key === "0" ? "reset" : key === "-" || key === "_" ? "out" : "in";
  try { acHost?.adjustBrowserZoom?.(view.getWebContentsId(), action); } catch {}
}

export function createZoomIndicator({ badge, activeWebview, acHost, showNotice }) {
  function render(factor) {
    const percent = Math.round(factor * 100);
    badge.hidden = percent === 100;
    badge.textContent = badge.hidden ? "" : `${percent}%`;
  }

  // 백그라운드 탭에서 온 배율과 실패 알림을 거르는 WebContents ID 대조
  acHost?.onBrowserZoomChanged?.(({ wc, factor, notice }) => {
    const active = activeWebview();
    if (!active) return;
    try {
      if (active.el.getWebContentsId() !== wc) return;
      render(factor);
      if (notice) showNotice?.(notice);
    } catch {}
  });

  return function update() {
    const active = activeWebview();
    let factor = 1;
    try { if (active?.ready) factor = active.el.getZoomFactor(); } catch {}
    render(factor);
  };
}
