// 백그라운드 셸·Monitor 줄과 창. Paseo 입력창 바로 위(칩 묶음 위)에 붙임
// - 터미널 Claude Code 의 백그라운드 작업 창과 같은 일: 목록 → 하나 골라 출력 보기, 실행 중이면 새 출력이 이어 붙음
// - 목록은 부모 창이 state.tasks 로 줌(server/agent-chat-tasks.js). 출력은 iris-chat.taskread 로 이어 읽음
// - 모양은 iris-contexts.tsx 의 칩·팝업 CSS 를 같이 씀
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, Copy, Eye, SquareTerminal, X } from "lucide-react-native";
import { cssVars, ensureStyle, useComposerSlot, type ContextColors } from "./iris-contexts";

export interface IrisTask {
  id: string; toolUseId: string; kind: "shell" | "monitor"; command: string; description: string;
  startedAt: number | null; endedAt: number | null; status: string; summary: string;
  size: number | null; tail?: string; cut?: boolean;
}
export type TaskReader = (taskId: string, from: number | null) => Promise<{ text?: string; start?: number; end?: number; size?: number; error?: string } | null>;

const STATUS: Record<string, string> = { running: "실행 중", completed: "완료", failed: "실패", killed: "중지됨", stopped: "중지됨", expired: "시간 끝남" };
const POLL_MS = 1000;
const KEEP_CHARS = 2 * 1024 * 1024;   // 창에 남기는 출력 길이. 넘으면 앞부분을 버림

const STYLE_ID = "iris-task-style";
const CSS = `
.iris-task-bar { display: flex; padding: 0 2px 8px; }
.iris-task-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px; cursor: pointer;
  border: 1px solid var(--ictx-border); background: var(--ictx-control); color: var(--ictx-muted);
  font: 600 12px/1 system-ui, -apple-system, sans-serif; transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms ease; }
.iris-task-btn.on { color: var(--ictx-fg); }
.iris-task-btn:hover { background: color-mix(in srgb, var(--ictx-control) 82%, var(--ictx-fg)); }
.iris-task-btn:active { transform: scale(0.97); }
.iris-task-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ictx-accent); }
.iris-task-list { flex: 1; min-height: 0; overflow: auto; margin: 0 14px 14px; padding: 0; list-style: none;
  border: 1px solid var(--ictx-border); border-radius: 10px; }
.iris-task-list li + li { border-top: 1px solid var(--ictx-border); }
.iris-task-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 0; background: none; cursor: pointer;
  color: var(--ictx-fg); text-align: left; font: 500 13px/1.35 system-ui, -apple-system, sans-serif; }
.iris-task-row:hover { background: var(--ictx-control); }
.iris-task-row > div { flex: 1; min-width: 0; }
.iris-task-row b, .iris-task-row small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.iris-task-row b { font-weight: 600; }
.iris-task-row small { color: var(--ictx-muted); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.iris-task-st { flex: none; color: var(--ictx-muted); font-size: 12px; }
.iris-task-st.running { color: var(--ictx-accent); font-weight: 600; }
.iris-task-cmd { margin: 0 14px 8px; color: var(--ictx-muted); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap; word-break: break-word; max-height: 6.5em; overflow: auto; user-select: text; }
.iris-task-note { margin: 8px 14px 0; color: var(--ictx-muted); font: 12px/1.4 system-ui, -apple-system, sans-serif; }
.iris-stash-li { display: flex; align-items: center; padding-right: 8px; }
.iris-stash-li .iris-task-row { flex: 1; min-width: 0; }
.iris-stash-note { align-self: center; margin-right: auto; color: var(--ictx-muted); font: 12px/1.4 system-ui, -apple-system, sans-serif; }
.iris-stash-empty { margin: 4px 16px 12px; color: var(--ictx-muted); font: 13px/1.5 system-ui, -apple-system, sans-serif; }
.iris-stash-slot { width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
.iris-stash-ib { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--ictx-muted);
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms ease; }
.iris-stash-ib:hover { background: var(--ictx-control); color: var(--ictx-fg); }
.iris-stash-ib:active { transform: scale(0.94); }
.iris-stash-ib:focus-visible { outline: 2px solid var(--ictx-ring); outline-offset: -2px; }
.iris-stash-count { position: absolute; top: 0; right: 0; min-width: 14px; height: 14px; padding: 0 3px; box-sizing: border-box; border-radius: 7px;
  background: var(--ictx-accent); color: var(--ictx-bg); font: 700 9px/14px system-ui, -apple-system, sans-serif; text-align: center; pointer-events: none; }
.iris-task-bar :focus-visible, .iris-task-list :focus-visible { outline: 2px solid var(--ictx-ring); outline-offset: -2px; }
`;
export function ensureTaskStyle() {
  ensureStyle();
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function statusLabel(status: string) { return STATUS[status] || status; }

export function taskTitle(t: IrisTask) {
  return t.description || t.command.split("\n")[0] || t.id;
}

// 터미널 제어 글자 정리: 색 코드 지움, 줄 안의 \r 은 마지막에 덮어쓴 글만
export function cleanOutput(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n").map((line) => { const i = line.lastIndexOf("\r"); return i >= 0 ? line.slice(i + 1) : line; }).join("\n");
}

function clock(ms: number | null) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function took(t: IrisTask) {
  if (!t.startedAt || !t.endedAt) return "";
  const s = Math.max(0, Math.round((t.endedAt - t.startedAt) / 1000));
  return s < 60 ? `${s}초` : s < 3600 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}
function when(t: IrisTask) {
  return [clock(t.startedAt) && `${clock(t.startedAt)} 시작`, took(t)].filter(Boolean).join(" · ");
}
function kindLabel(t: IrisTask) { return t.kind === "monitor" ? "Monitor" : "셸"; }

function KindIcon({ kind }: { kind: string }) {
  return kind === "monitor" ? <Eye size={16} color="currentColor" /> : <SquareTerminal size={16} color="currentColor" />;
}

// 출력 이어 읽기. 끝난 작업은 파일 끝까지 읽으면 멈춤
function useTaskOutput(task: IrisTask, read: TaskReader) {
  const [out, setOut] = useState({ text: "", error: "", skipped: false, loading: true });
  const running = task.status === "running";
  useEffect(() => {
    let stop = false;
    let end: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = async () => {
      const r = await read(task.id, end);
      if (stop) return;
      if (!r || r.error) {
        setOut((o) => ({ ...o, loading: false, error: r?.error || "출력을 읽지 못했습니다" }));
      } else {
        const restart = end === null || r.start !== end;
        const skipped = restart && (r.start ?? 0) > 0;
        end = r.end ?? end;
        const add = r.text || "";
        setOut((o) => {
          let text = restart ? add : o.text + add;
          const cut = text.length > KEEP_CHARS;
          if (cut) text = text.slice(text.length - KEEP_CHARS);
          return { text, error: "", skipped: skipped || cut || (!restart && o.skipped), loading: false };
        });
        // 한 번에 다 못 읽었으면 바로 이어 읽음
        if ((r.size ?? 0) > (end ?? 0)) { timer = setTimeout(step, 0); return; }
      }
      if (running) timer = setTimeout(step, POLL_MS);
    };
    void step();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [task.id, running, read]);
  return out;
}

function TaskOutput({ task, read, onBack, onClose }: { task: IrisTask; read: TaskReader; onBack: () => void; onClose: () => void }) {
  const out = useTaskOutput(task, read);
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const backRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const text = cleanOutput(out.text);
  useEffect(() => { backRef.current?.focus(); }, []);
  // 맨 아래를 보고 있을 때만 새 출력을 따라 내려감
  useEffect(() => {
    const el = pre.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  const body = out.loading ? "출력을 읽는 중…" : out.error ? out.error
    : text || (task.status === "running" ? "아직 출력이 없습니다" : "출력이 없습니다");
  return (
    <>
      <header>
        <button ref={backRef} type="button" className="iris-ctx-ib" aria-label="목록으로" title="목록으로" onClick={onBack}><ChevronLeft size={16} color="currentColor" /></button>
        <KindIcon kind={task.kind} />
        <div>
          <h2 id="iris-task-title">{taskTitle(task)}</h2>
          <p>{[kindLabel(task), statusLabel(task.status), when(task), task.summary].filter(Boolean).join(" · ")}</p>
        </div>
        <button type="button" className="iris-ctx-ib" aria-label="닫기" onClick={onClose}><X size={16} color="currentColor" /></button>
      </header>
      {task.command ? <div className="iris-task-cmd">$ {task.command}</div> : null}
      <pre ref={pre} data-iris-task-output={task.id}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>{body}</pre>
      {out.skipped ? <p className="iris-task-note">출력이 길어 끝부분만 보여 줍니다</p> : null}
      <footer>
        <button type="button" className="iris-ctx-btn" onClick={copy} disabled={!text}>
          {copied ? <Check size={14} color="currentColor" /> : <Copy size={14} color="currentColor" />}
          {copied ? "복사됨" : "출력 복사"}
        </button>
      </footer>
    </>
  );
}

function TaskDialog({ tasks, read, onClose }: { tasks: IrisTask[]; read: TaskReader; onClose: () => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const lastPick = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // 목록으로 돌아오면 보던 줄에 포커스
  useEffect(() => {
    if (pick) return;
    const back = lastPick.current ? document.querySelector<HTMLButtonElement>(`[data-iris-task="${lastPick.current}"]`) : null;
    (back || firstRef.current)?.focus();
  }, [pick]);
  const task = pick ? tasks.find((t) => t.id === pick) || null : null;
  const running = tasks.filter((t) => t.status === "running").length;
  return createPortal(
    <div className="iris-ctx-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="iris-ctx-dlg" role="dialog" aria-modal="true" aria-labelledby="iris-task-title">
        {task ? <TaskOutput key={task.id} task={task} read={read} onBack={() => setPick(null)} onClose={onClose} /> : (
          <>
            <header>
              <SquareTerminal size={18} color="currentColor" />
              <div>
                <h2 id="iris-task-title">백그라운드 작업</h2>
                <p>{`셸·Monitor ${tasks.length}개 · 실행 중 ${running}개`}</p>
              </div>
              <button type="button" className="iris-ctx-ib" aria-label="닫기" onClick={onClose}><X size={16} color="currentColor" /></button>
            </header>
            <ul className="iris-task-list">
              {tasks.map((t, n) => (
                <li key={t.id}>
                  <button ref={n === 0 ? firstRef : undefined} type="button" className="iris-task-row" data-iris-task={t.id}
                    onClick={() => { lastPick.current = t.id; setPick(t.id); }}>
                    <KindIcon kind={t.kind} />
                    <div>
                      <b>{taskTitle(t)}</b>
                      <small>{[kindLabel(t), when(t), t.description ? t.command.split("\n")[0] : ""].filter(Boolean).join(" · ")}</small>
                    </div>
                    <span className={`iris-task-st ${t.status}`}>{statusLabel(t.status)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function TaskBar({ tasks, colors, read }: { tasks: IrisTask[]; colors: ContextColors; read: TaskReader }) {
  const slot = useComposerSlot(tasks.length > 0, 1);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { ensureTaskStyle(); }, []);
  useEffect(() => { cssVars(colors); }, [colors]);
  const close = useCallback(() => { setOpen(false); opener.current?.focus(); }, []);
  useEffect(() => { if (!tasks.length) setOpen(false); }, [tasks.length]);
  const running = tasks.filter((t) => t.status === "running").length;
  return (
    <>
      {slot ? createPortal(
        <div className="iris-task-bar">
          <button ref={opener} type="button" className={`iris-task-btn${running ? " on" : ""}`} onClick={() => setOpen(true)}
            title="백그라운드 셸·Monitor 목록과 출력">
            {running ? <span className="iris-task-dot" /> : <SquareTerminal size={14} color="currentColor" />}
            {running ? `백그라운드 작업 ${running}개 실행 중` : `백그라운드 작업 ${tasks.length}개`}
          </button>
        </div>,
        slot,
      ) : null}
      {open ? <TaskDialog tasks={tasks} read={read} onClose={close} /> : null}
    </>
  );
}
