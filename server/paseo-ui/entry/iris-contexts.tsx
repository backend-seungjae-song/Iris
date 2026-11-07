// Iris 요소 선택 칩 묶음과 내용 팝업. Paseo 입력창 바로 위에 붙임
// - Iris 기능이라 Paseo 컴포넌트가 아니라 이 파일이 그림. 모양 기준은 폰 앱 mobile/lib/design/pasted_context.dart
// - 칩 목록의 정본은 부모 창(web/js/agentchat/boot.js). 여기서는 그리고 빼기 요청만 보냄
// - Paseo 가 입력창을 다시 그려도 붙는 곳을 다시 찾음(MutationObserver)
import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { AppWindow, Bot, Check, Clipboard, Copy, FileText, Layers, Link2, ListOrdered, MessageSquare, MousePointerClick, PenLine, Smartphone, Table2, X } from "lucide-react-native";
import { describeContext } from "./iris-inline-tokens";

export interface IrisContext { id: string; content: string; no?: number; kind?: string }
export interface ContextColors { background: string; foreground: string; raised: string; control: string; border: string; accent: string; mutedForeground: string; ring: string }

const ICONS: Record<string, ComponentType<{ size?: number; color?: string }>> = {
  element: MousePointerClick, app: Smartphone, sketch: PenLine, record: ListOrdered, session: Bot, doc: FileText,
  cell: Table2, tab: AppWindow, group: Layers, device: Smartphone, site: Link2, paste: Clipboard, chat: MessageSquare, other: FileText,
};

const STYLE_ID = "iris-ctx-style";
// - 칩 등장·누름·팝업 열림만 움직임(Emil design engineering: 자주 보는 조작은 짧게, 들어올 때 ease-out)
// - OS 동작 줄이기 설정으로 끄지 않음(사용자 기본값 2026-09-21)
const CSS = `
.iris-ctx { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px 8px; }
.iris-ctx-chip { display: inline-flex; align-items: center; max-width: 280px; height: 30px; border-radius: 15px;
  background: var(--ictx-control); color: var(--ictx-fg); border: 1px solid var(--ictx-border);
  font: 600 12.5px/1 system-ui, -apple-system, sans-serif; transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms ease;
  @starting-style { opacity: 0; transform: scale(0.95); } }
.iris-ctx-open { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 4px 0 10px;
  background: none; border: 0; color: inherit; font: inherit; cursor: pointer; border-radius: 15px 0 0 15px; }
.iris-ctx-open span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-ctx-open .k { color: var(--ictx-muted); font-weight: 500; }
.iris-ctx-chip:has(.iris-ctx-open:active) { transform: scale(0.97); }
.iris-ctx-chip:hover { background: color-mix(in srgb, var(--ictx-control) 82%, var(--ictx-fg)); }
.iris-ctx-x { display: inline-grid; place-items: center; width: 26px; height: 100%; padding: 0 4px 0 0; background: none; border: 0;
  color: var(--ictx-muted); cursor: pointer; border-radius: 0 15px 15px 0; }
.iris-ctx-x:hover { color: var(--ictx-fg); }
.iris-ctx-clear { height: 30px; padding: 0 8px; background: none; border: 0; border-radius: 8px; color: var(--ictx-muted);
  font: 500 12px/1 system-ui, -apple-system, sans-serif; cursor: pointer; }
.iris-ctx-clear:hover { color: var(--ictx-fg); background: var(--ictx-control); }
.iris-ctx :focus-visible, .iris-ctx-dlg :focus-visible { outline: 2px solid var(--ictx-ring); outline-offset: 1px; }
.iris-ctx-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 24px;
  grid-template-columns: minmax(0, 720px); justify-content: center;
  background: rgba(3, 10, 16, 0.55); transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1); @starting-style { opacity: 0; } }
.iris-ctx-dlg { display: flex; flex-direction: column; width: 100%; min-width: 0; max-height: min(78vh, 720px); border-radius: 14px;
  background: var(--ictx-bg); color: var(--ictx-fg); border: 1px solid var(--ictx-border); box-shadow: 0 18px 48px rgba(0,0,0,.35);
  transition: transform 200ms cubic-bezier(0.23, 1, 0.32, 1), opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
  @starting-style { opacity: 0; transform: scale(0.96); } }
.iris-ctx-dlg header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px 18px; }
.iris-ctx-dlg h2 { margin: 0; font: 700 15px/1.3 system-ui, -apple-system, sans-serif; }
.iris-ctx-dlg header p { margin: 2px 0 0; color: var(--ictx-muted); font: 400 12.5px/1.3 system-ui, -apple-system, sans-serif;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-ctx-dlg header > div { flex: 1; min-width: 0; }
.iris-ctx-dlg pre { flex: 1; min-height: 0; margin: 0 14px; padding: 12px 14px; overflow: auto; border-radius: 10px;
  background: var(--ictx-raised); border: 1px solid var(--ictx-border); color: var(--ictx-fg);
  font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; user-select: text; }
.iris-ctx-dlg footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 14px 14px; }
.iris-ctx-btn { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--ictx-border); background: var(--ictx-control); color: var(--ictx-fg); font: 600 12.5px/1 system-ui, -apple-system, sans-serif;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
.iris-ctx-btn:active, .iris-ctx-ib:active { transform: scale(0.97); }
.iris-ctx-ib { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; border: 0; background: none;
  color: var(--ictx-muted); cursor: pointer; }
.iris-ctx-ib:hover { color: var(--ictx-fg); background: var(--ictx-control); }
`;

export function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function cssVars(c: ContextColors) {
  const root = document.documentElement.style;
  root.setProperty("--ictx-bg", c.background);
  root.setProperty("--ictx-fg", c.foreground);
  root.setProperty("--ictx-raised", c.raised);
  root.setProperty("--ictx-control", c.control);
  root.setProperty("--ictx-border", c.border);
  root.setProperty("--ictx-muted", c.mutedForeground);
  root.setProperty("--ictx-ring", c.ring);
  root.setProperty("--ictx-accent", c.accent);
}

// Paseo 입력창 바로 앞의 Iris 자리(칩 묶음·백그라운드 작업 줄이 나눠 씀). 입력창이 없으면 null
// - 바깥 자리 하나를 입력창 앞에 붙이고 쓰는 쪽마다 그 안에 칸을 만듦. 둘이 따로 붙으면 서로 앞자리를 다툼
// - order 가 작은 칸이 위
interface SharedSlot { el: HTMLElement; users: number; listeners: Set<() => void>; mo: MutationObserver }
let shared: SharedSlot | null = null;
function acquireSlot(): SharedSlot {
  if (shared) { shared.users++; return shared; }
  const el = document.createElement("div");
  el.className = "iris-ctx-slot";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  const listeners = new Set<() => void>();
  const place = () => {
    const root = document.querySelector('[data-testid="message-input-root"]');
    const was = el.isConnected;
    if (!root?.parentElement) { if (was) el.remove(); }
    else if (el.nextElementSibling !== root) root.parentElement.insertBefore(el, root);
    if (was !== el.isConnected) for (const fn of listeners) fn();
  };
  const mo = new MutationObserver(place);
  mo.observe(document.body, { childList: true, subtree: true });
  shared = { el, users: 1, listeners, mo };
  place();
  return shared;
}
function releaseSlot(s: SharedSlot) {
  if (--s.users > 0) return;
  s.mo.disconnect();
  s.el.remove();
  if (shared === s) shared = null;
}
export function useComposerSlot(enabled: boolean, order: number) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) { setSlot(null); return; }
    const s = acquireSlot();
    const mine = document.createElement("div");
    mine.style.order = String(order);
    s.el.appendChild(mine);
    const update = () => setSlot(s.el.isConnected ? mine : null);
    s.listeners.add(update);
    update();
    return () => { s.listeners.delete(update); mine.remove(); releaseSlot(s); setSlot(null); };
  }, [enabled, order]);
  return slot;
}

function ContextDialog({ item, onClose }: { item: IrisContext; onClose: () => void }) {
  const info = describeContext(item);
  const Icon = ICONS[info.kind] || FileText;
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(item.content); setCopied(true); } catch { setCopied(false); }
  };
  return createPortal(
    <div className="iris-ctx-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="iris-ctx-dlg" role="dialog" aria-modal="true" aria-labelledby="iris-ctx-title">
        <header>
          <Icon size={18} color="currentColor" />
          <div>
            <h2 id="iris-ctx-title">{info.label}</h2>
            <p>{info.summary}</p>
          </div>
          <button ref={closeRef} type="button" className="iris-ctx-ib" aria-label="닫기" onClick={onClose}><X size={16} color="currentColor" /></button>
        </header>
        <pre>{item.content}</pre>
        <footer>
          <button type="button" className="iris-ctx-btn" onClick={copy}>
            {copied ? <Check size={14} color="currentColor" /> : <Copy size={14} color="currentColor" />}
            {copied ? "복사됨" : "복사"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// 글 속 칩을 눌렀을 때 그 요소의 내용 팝업(iris-inline-chips.ts)
let openRequest: ((id: string) => void) | null = null;
export function openContextDialog(id: string) { openRequest?.(id); }

export function ContextChips({ items, colors, onRemove }: { items: IrisContext[]; colors: ContextColors; onRemove: (ids: string[] | null) => void }) {
  const slot = useComposerSlot(items.length > 0, 2);
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => { ensureStyle(); }, []);
  useEffect(() => {
    openRequest = (id) => { opener.current = document.activeElement as HTMLElement | null; setOpenId(id); };
    return () => { openRequest = null; };
  }, []);
  useEffect(() => { cssVars(colors); }, [colors]);
  // 열린 칩이 빠지면(보냄·지움) 팝업도 닫음
  useEffect(() => { if (openId && !items.some((c) => c.id === openId)) setOpenId(null); }, [items, openId]);
  const open = items.find((c) => c.id === openId) || null;
  const close = () => { setOpenId(null); opener.current?.focus(); };
  if (!slot) return null;
  return (
    <>
      {createPortal(
        <div className="iris-ctx" role="list" aria-label="붙인 요소">
          {items.map((c) => {
            const info = describeContext(c);
            const Icon = ICONS[info.kind] || FileText;
            return (
              <div key={c.id} className="iris-ctx-chip" role="listitem">
                <button type="button" className="iris-ctx-open" title={`${info.label} · ${info.summary}`}
                  onClick={(e) => { opener.current = e.currentTarget; setOpenId(c.id); }}>
                  <Icon size={14} color="currentColor" />
                  <span><span className="k">{info.label}</span> · {info.summary}</span>
                </button>
                <button type="button" className="iris-ctx-x" aria-label={`${info.label} 빼기`} title="빼기" onClick={() => onRemove([c.id])}>
                  <X size={13} color="currentColor" />
                </button>
              </div>
            );
          })}
          {items.length > 1 ? <button type="button" className="iris-ctx-clear" onClick={() => onRemove(null)}>모두 지우기</button> : null}
        </div>,
        slot,
      )}
      {open ? <ContextDialog item={open} onClose={close} /> : null}
    </>
  );
}
