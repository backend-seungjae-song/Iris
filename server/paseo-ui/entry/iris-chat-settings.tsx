// Iris 설정 > 대화 화면에 띄우는 대화 목록 표시 설정(?panel=chat-settings)
// - 항목·저장·기본값은 Paseo 채팅 설정(ChatSection)과 같음. 값은 Paseo useAppSettings 로 읽고 씀(저장값이 없거나 예전 필드일 때의 기본값 계산이 Paseo 에 있음)
// - 모양은 Iris 설정 줄. 같은 출처인 부모 창의 Iris 스타일(토큰·설정 화면)을 불러 같은 클래스(km-toggle·km-seg·km-sw)로 그림
import { useEffect, useRef } from "react";
import { useAppSettings, type ChatDisplay } from "@/hooks/use-settings";

const IRIS_CSS = ["/css/00-tokens.css", "/css/01-base.css", "/css/20-keymap.css"];
const DISPLAY_OPTIONS: { value: ChatDisplay; label: string }[] = [
  { value: "full", label: "전체" },
  { value: "collapseToolCalls", label: "도구 호출 접기" },
  { value: "collapseTurns", label: "턴 접기" },
];

function useIrisLook() {
  useEffect(() => {
    for (const href of IRIS_CSS) {
      if (document.querySelector(`link[data-iris-css="${href}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.dataset.irisCss = href;
      document.head.appendChild(link);
    }
    // 바탕은 설정 화면 것을 그대로 보이게
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const parentRoot = window.parent?.document?.documentElement;
    const sync = () => {
      const theme = parentRoot?.getAttribute("data-theme");
      if (theme) document.documentElement.setAttribute("data-theme", theme);
      else document.documentElement.removeAttribute("data-theme");
    };
    sync();
    const watch = parentRoot ? new MutationObserver(sync) : null;
    watch?.observe(parentRoot!, { attributes: true, attributeFilter: ["data-theme"] });
    return () => watch?.disconnect();
  }, []);
}

function SwitchRow({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="km-toggle" style={{ paddingLeft: 0, paddingRight: 0 }}>
      <div className="km-tx">
        <div className="km-tn">{label}</div>
        <div className="km-td">{desc}</div>
      </div>
      <button type="button" className={`km-sw${value ? " on" : ""}`} role="switch" aria-checked={value} aria-label={label}
        onClick={() => onChange(!value)}><i /></button>
      <span className="km-sw-s">{value ? "켜짐" : "꺼짐"}</span>
    </div>
  );
}

export function ChatSettingsPanel({ onHeight }: { onHeight: (height: number) => void }) {
  useIrisLook();
  const { settings, isLoading, updateSettings } = useAppSettings();
  const box = useRef<HTMLDivElement>(null);
  // 부모가 iframe 높이를 내용 높이에 맞춤
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);
  if (isLoading) return <div ref={box} className="km-td">불러오는 중…</div>;
  return (
    <div ref={box}>
      <SwitchRow label="추론 항상 펼치기" desc="에이전트의 추론 블록을 처음부터 펼쳐서 표시합니다."
        value={settings.autoExpandReasoning} onChange={(v) => void updateSettings({ autoExpandReasoning: v })} />
      <div className="km-toggle" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <div className="km-tx">
          <div className="km-tn">대화 표시</div>
          <div className="km-td">끝난 턴의 도구 호출과 중간 설명을 접어서 표시할지 정합니다.</div>
        </div>
        <div className="km-seg" role="group" aria-label="대화 표시">
          {DISPLAY_OPTIONS.map((o) => (
            <button key={o.value} type="button" aria-pressed={settings.chatDisplay === o.value}
              onClick={() => void updateSettings({ chatDisplay: o.value })}>{o.label}</button>
          ))}
        </div>
      </div>
      <SwitchRow label="대화 목차" desc="보낸 글 사이를 이동하는 목차를 대화 화면 옆에 표시합니다."
        value={settings.chatOutlineEnabled} onChange={(v) => void updateSettings({ chatOutlineEnabled: v })} />
    </div>
  );
}
