// 입력창 임시 저장: 쓰던 글·칩·첨부를 목록에 넣고 입력창을 비움, 골라서 다시 불러옴. 여러 개
// - 목록은 대화마다 하나. 글·첨부는 Paseo 초안 저장소, 목록·칩은 localStorage
// - 단추는 입력창 아래 컨텍스트 사용량 표시 옆 아이콘, 늘 보임(단축키를 몰라도 찾게). 개수는 아이콘 오른쪽 위 숫자
// - CSS 는 iris-tasks.tsx(목록 모양을 같이 씀)
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Archive, X } from "lucide-react-native";
import { useDraftStore } from "@/stores/draft-store";
import { ensureTaskStyle } from "./iris-tasks";
import { isEmptyDraft, parseStashList, pushStash, renumberForRestore, stashDraftKey, stashPreview } from "./iris-stash-model";
import type { IrisContext } from "./iris-contexts";

interface StashItem { id: string; at: number; contexts: IrisContext[]; preview: string; files: number }
// 목록은 대화마다 따로. 대화 = 그 입력창의 Paseo 초안 키
const LEGACY_KEY = "ac.agentchat.stash";
const listKey = (scope: string) => `${LEGACY_KEY}:${scope}`;
const listeners = new Set<() => void>();
const cache = new Map<string, StashItem[]>();
const NONE: StashItem[] = [];
function readList(scope: string | null): StashItem[] {
  if (!scope) return NONE;
  const hit = cache.get(scope);
  if (hit) return hit;
  let list: StashItem[] = [];
  try {
    const raw = localStorage.getItem(listKey(scope));
    // 대화마다 나누기 전의 공용 목록은 처음 여는 대화로 한 번 옮김(잃지 않게)
    const legacy = raw === null ? localStorage.getItem(LEGACY_KEY) : null;
    list = parseStashList(raw ?? legacy) as StashItem[];
    if (legacy !== null) { localStorage.setItem(listKey(scope), JSON.stringify(list)); localStorage.removeItem(LEGACY_KEY); }
  } catch {}
  cache.set(scope, list);
  return list;
}
function writeList(scope: string, next: StashItem[]) {
  cache.set(scope, next);
  try { localStorage.setItem(listKey(scope), JSON.stringify(next)); } catch {}
  for (const fn of listeners) fn();
}
// 같은 대화를 연 다른 창(같은 출처의 다른 iframe)이 바꾼 목록도 따라감
if (typeof window !== "undefined") window.addEventListener("storage", (e) => {
  if (!e.key?.startsWith(`${LEGACY_KEY}:`)) return;
  cache.delete(e.key.slice(LEGACY_KEY.length + 1));
  for (const fn of listeners) fn();
});
const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
export function useStashList(scope: string | null) { return useSyncExternalStore(subscribe, () => readList(scope)); }

// 입력창과 칩을 읽고 쓰는 곳. 진입 코드가 줌
export interface StashHost {
  draftKey: () => string | null;                     // 지금 대화 입력창의 Paseo 초안 키
  text: () => string;                                // 입력창 글상자 글. 초안 저장소 글은 화면이 그려진 뒤에야 따라옴
  setText: (text: string) => void;                   // 글상자 글 바꾸기. Paseo 입력창은 초안 저장소 글을 다시 읽지 않음
  contexts: () => IrisContext[];                     // 지금 입력창 칩
  clearContexts: () => void;                         // 부모에 칩 모두 빼기 요청
  restoreContexts: (items: { content: string; kind?: string; no: number }[]) => void;
}

function readDraft(key: string) {
  const d = useDraftStore.getState().getDraftInput(key);
  return { text: d?.text ?? "", attachments: (d?.attachments ?? []) as unknown[] };
}

// 지금 입력창을 목록 맨 앞에 넣고 비움. 비었으면 false
export function stashNow(host: StashHost): boolean {
  const key = host.draftKey();
  if (!key) return false;
  const { attachments } = readDraft(key);
  const text = host.text();
  const contexts = host.contexts();
  if (isEmptyDraft(text, attachments, contexts)) return false;
  const id = crypto.randomUUID();
  const store = useDraftStore.getState();
  store.saveDraftInput({ draftKey: stashDraftKey(id), draft: { text, attachments: attachments as any } });
  const { list, dropped } = pushStash(readList(key), { id, at: Date.now(), contexts, preview: stashPreview(text, contexts), files: attachments.length });
  for (const old of dropped) store.clearDraftInput({ draftKey: stashDraftKey(old), lifecycle: "abandoned" });
  writeList(key, list);
  store.saveDraftInput({ draftKey: key, draft: { text: "", attachments: [] } });
  host.setText("");
  if (contexts.length) host.clearContexts();
  return true;
}

// 골라 불러옴. 입력창에 쓰던 것이 있으면 먼저 목록에 넣어 잃지 않게 함
function restore(host: StashHost, id: string) {
  const key = host.draftKey();
  const item = readList(key).find((x) => x.id === id);
  if (!key || !item) return;
  const swapped = stashNow(host);
  const store = useDraftStore.getState();
  const saved = readDraft(stashDraftKey(id));
  // 방금 넣은 것이 있으면 부모 칩은 곧 비워짐. 아직 안 비워진 목록으로 번호를 매기지 않음
  const r = renumberForRestore(saved.text, item.contexts, swapped ? [] : host.contexts());
  // 글을 칩 글자까지 먼저 씀. 뒤이어 늘어나는 첨부·칩은 글에 칩 글자가 이미 있어 다시 넣지 않음
  host.setText(r.text);
  store.saveDraftInput({ draftKey: key, draft: { text: r.text, attachments: saved.attachments as any } });
  if (r.contexts.length) host.restoreContexts(r.contexts);
  store.clearDraftInput({ draftKey: stashDraftKey(id), lifecycle: "abandoned" });
  writeList(key, readList(key).filter((x) => x.id !== id));
}

function remove(scope: string, id: string) {
  useDraftStore.getState().clearDraftInput({ draftKey: stashDraftKey(id), lifecycle: "abandoned" });
  writeList(scope, readList(scope).filter((x) => x.id !== id));
}

function clock(ms: number) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date().toDateString() === d.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function meta(x: StashItem) {
  return [clock(x.at), x.contexts.length ? `칩 ${x.contexts.length}` : "", x.files ? `첨부 ${x.files}` : ""].filter(Boolean).join(" · ");
}

function StashDialog({ host, scope, onClose }: { host: StashHost; scope: string; onClose: () => void }) {
  const list = useStashList(scope);
  const firstRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    (firstRef.current || saveRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const save = () => { if (!stashNow(host)) setEmpty(true); };
  return createPortal(
    <div className="iris-ctx-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="iris-ctx-dlg" role="dialog" aria-modal="true" aria-labelledby="iris-stash-title">
        <header>
          <Archive size={18} color="currentColor" />
          <div>
            <h2 id="iris-stash-title">임시 저장</h2>
            <p>{list.length ? `${list.length}개 · ⌘⇧Enter 로 저장 · 누르면 불러옴` : "입력창에서 ⌘⇧Enter 로도 저장"}</p>
          </div>
          <button type="button" className="iris-ctx-ib" aria-label="닫기" onClick={onClose}><X size={16} color="currentColor" /></button>
        </header>
        {list.length ? null : <p className="iris-stash-empty">저장한 입력이 없습니다</p>}
        <ul className="iris-task-list" hidden={!list.length}>
          {list.map((x, n) => (
            <li key={x.id} className="iris-stash-li">
              <button ref={n === 0 ? firstRef : undefined} type="button" className="iris-task-row" data-iris-stash={x.id}
                onClick={() => { restore(host, x.id); onClose(); }}>
                <div>
                  <b>{x.preview || (x.contexts.length || x.files ? "글 없음" : "빈 항목")}</b>
                  <small>{meta(x)}</small>
                </div>
              </button>
              <button type="button" className="iris-ctx-ib" aria-label="지우기" title="지우기" onClick={() => remove(scope, x.id)}>
                <X size={15} color="currentColor" />
              </button>
            </li>
          ))}
        </ul>
        <footer>
          {empty ? <span className="iris-stash-note">입력창이 비어 있습니다</span> : null}
          <button ref={saveRef} type="button" className="iris-ctx-btn" onClick={save}>
            <Archive size={14} color="currentColor" />
            지금 입력창 저장
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// 컨텍스트 사용량 표시(Paseo 입력창 아래 줄) 바로 앞 칸. 그 표시가 없으면(에이전트 없음) null
// - Paseo 가 그 줄을 다시 그려도 따라붙게 DOM 변화마다 자리를 확인
const METER = '[data-testid="message-input-root"] [data-testid="context-window-meter"]';
// 컨텍스트 표시를 감싼 것 중 가로 줄(받아쓰기·음성 단추가 있는 줄)의 바로 아래 칸
// - 대화 칸이 좁으면 표시가 칸 안 단추 하나, 넓으면(600 이상) 마우스 올림 카드로 한 겹 더 감쌈. 감싼 겹 수에 기대지 않음
function rowChild(meter: Element | null): Element | null {
  for (let e = meter; e?.parentElement; e = e.parentElement) {
    if (getComputedStyle(e.parentElement).flexDirection === "row" && e.parentElement.childElementCount > 1) return e;
  }
  return null;
}
function useMeterSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.className = "iris-stash-slot";
    const place = () => {
      const meter = rowChild(document.querySelector(METER));
      if (!meter?.parentElement) { if (el.isConnected) el.remove(); }
      else if (el.nextElementSibling !== meter) meter.parentElement.insertBefore(el, meter);
      setSlot(el.isConnected ? el : null);
    };
    const mo = new MutationObserver(place);
    mo.observe(document.body, { childList: true, subtree: true });
    place();
    return () => { mo.disconnect(); el.remove(); };
  }, []);
  return slot;
}

// scope: 지금 대화(host.draftKey() 와 같은 값). 대화를 바꾸면 그 대화의 목록으로 다시 그림
export function StashButton({ host, scope }: { host: StashHost; scope: string | null }) {
  const list = useStashList(scope);
  const slot = useMeterSlot();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); opener.current?.focus(); }, []);
  useEffect(() => { ensureTaskStyle(); }, []);
  const label = list.length ? `임시 저장 ${list.length}개` : "임시 저장";
  return (
    <>
      {slot ? createPortal(
        <button ref={opener} type="button" className="iris-stash-ib" onClick={() => setOpen(true)} aria-label={label} title={`${label} · ⌘⇧Enter 로 저장`}>
          <Archive size={16} color="currentColor" />
          {list.length ? <span className="iris-stash-count" aria-hidden="true">{list.length > 99 ? "99+" : list.length}</span> : null}
        </button>,
        slot,
      ) : null}
      {open && scope ? <StashDialog host={host} scope={scope} onClose={close} /> : null}
    </>
  );
}
