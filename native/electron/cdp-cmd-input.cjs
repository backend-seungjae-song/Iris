// 사람이 쓰는 입력 경로를 보존하는 CDP command handler.
//
// 소유 범위
//   click·dblclick·type·bulkfill·key·hover·focus·clear·check·select·fill·scroll·scrollto의 실행 순서와 응답.
//
// 제공 API
//   createInputCommands(ctx)가 명령 이름별 async handler 표를 준다. 원시 상태 컨테이너는 내주지 않는다.
//
// 의존 대상
//   조립부가 주입하는 withLayout·nodeFromArgs·insertTextInChunks·isTabShown·run·webContentsMod 접근자와
//   명령마다 넘기는 CDP send·Electron webContents. Electron이나 cdp-control.cjs를 직접 require하지 않는다.
//
// 유지 조건
//   click·dblclick·hover의 임시 layout, 좌표/요소 사람 경로, bulkfill 가시성, key의 탭 내부 입력과
//   fill의 입력→눌러서 입력→직접 설정 후퇴 및 via 문자열을 그대로 보존한다.
//
// 영향 범위
//   공급자는 cdp-control.cjs의 ref/프레임/텍스트 chunk/dispatcher 포트다. 양방향 소비자는
//   cdp-control.cjs handler 표·default 안내, hidden viewport·observation 분류와 CLI/MCP 입력 명령이다.

function createInputCommands({ withLayout, nodeFromArgs, insertTextInChunks, isTabShown, run, webContentsMod }) {
  async function clickTarget(send, wc, args, clickCount) {
    return await withLayout(send, async (applied) => {
      const ref = args.ref || args.sel;
      const { backendNodeId, sid } = await nodeFromArgs(send, wc, args); // ref면 세대 결속 검증, 선택자면 즉시 해석
      const s = send.on(sid); // 요소를 찾은 프레임에서만 다룬다
      await s("DOM.enable");
      try { await s("DOM.scrollIntoViewIfNeeded", { backendNodeId }); } catch {} // offscreen 요소를 viewport로 옮긴다. 좌표가 화면 밖이면 클릭이 빗나간다
      let cx = 0, cy = 0;
      try {
        const box = await s("DOM.getBoxModel", { backendNodeId });
        const q = box.model.content;
        cx = (q[0] + q[2] + q[4] + q[6]) / 4; cy = (q[1] + q[3] + q[5] + q[7]) / 4;
      } catch (e) { if (!sid) throw e; }   // 프레임 안 요소는 좌표가 필요 없다(아래 요소 직접 경로)
      // 화면에 그려지지 않는 탭(사용자가 보고 있지 않은 탭)은 위젯이 0×0이라 좌표 입력이 어디에도
      // 도달하지 않는다. 명령은 성공으로 돌아오지만 페이지에서는 아무 일도 일어나지 않는다
      // (확인 결과: mousedown조차 들어오지 않음). 레이아웃을 씌워도 마찬가지다. 씌운 것은 CSS
      // 뷰포트이고 히트테스트는 실제 표면에서 하기 때문이다. 그런 탭은 요소를 직접 누른다.
      // 교차 출처 프레임 안의 요소는 좌표로 누를 수 없다. DOM.getBoxModel이 주는 값은 그 프레임의
      // 좌표계이고, Input 이벤트는 창 좌표계라 그대로 쓰면 다른 위치를 누른다. 그런 요소는 언제나
      // 요소를 직접 누른다.
      if (applied || sid) {
        const r = await s("DOM.resolveNode", { backendNodeId });
        const objectId = r && r.object && r.object.objectId;
        if (objectId) {
          await s("Runtime.callFunctionOn", {
            objectId, awaitPromise: false, userGesture: true,   // userGesture=팝업·파일선택이 막히지 않게
            functionDeclaration: `function(n){
              const o = { bubbles:true, cancelable:true, view:window, button:0, buttons:1, detail:n };
              this.dispatchEvent(new PointerEvent("pointerdown", o));
              this.dispatchEvent(new MouseEvent("mousedown", o));
              this.dispatchEvent(new PointerEvent("pointerup", o));
              this.dispatchEvent(new MouseEvent("mouseup", o));
              if (typeof this.focus === "function") { try { this.focus(); } catch(e){} }
              this.click();
              if (n === 2) this.dispatchEvent(new MouseEvent("dblclick", o));
            }`,
            arguments: [{ value: clickCount }],
          });
          return { ok: true, ref, at: { x: Math.round(cx), y: Math.round(cy) }, via: "element", frame: sid ? "iframe" : undefined };
        }
      }
      // 여기까지 왔는데 프레임 안 요소면 누를 방법이 없다. 좌표로 내려가면 창 좌표계로 잘못
      // 계산돼 다른 곳을 누르고 성공으로 보고하므로 더 나쁘다.
      if (sid) throw new Error("iframe 안 요소를 잡았지만 다룰 수 없습니다(프레임이 사라졌을 수 있음): " + ref);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount });
      return { ok: true, ref, at: { x: Math.round(cx), y: Math.round(cy) }, via: "input" };
    });
  }

  return {
    async click(send, wc, args) {
      return await clickTarget(send, wc, args, 1);
    },
    async dblclick(send, wc, args) {
      return await clickTarget(send, wc, args, 2);
    },
    // 현재 포커스에 텍스트 삽입(키 이벤트 없이)
    async type(send, _wc, args) {
      await send("Input.insertText", { text: args.text || "" });
      return { ok: true };
    },
    // 되돌리기 어려운 자리에 쓰이므로 두 가지를 지킨다. 보이는 탭에서만 입력한다(아무도 보지 못하는
    // 화면을 대량으로 고치지 않는다). 그리고 중간에 실패하면 그 자리에서 멈추고 몇 칸이
    // 들어갔는지 돌려준다. 반쯤 입력된 표를 성공으로 보고하는 것이 가장 위험하다.
    async bulkfill(send, wc, args) {
      // 값 묶음을 지금 커서 위치에서부터 한 칸씩 입력한다. 보이는 탭에서만 실행하고 실패한 칸에서 멈춘다.
      // 입력은 페이지 안에서 만든다. OS 입력(Input.dispatchKeyEvent)은 이 앱에서 쓸 수 없다.
      // webview 게스트 문서는 임베더가 그 태그에 포커스를 줘야 hasFocus가 참이 되고, 그렇지
      // 않으면 크로미움이 키 입력을 버린다(확인 결과: 편집기가 열린 채 5칸을 입력했는데
      // 한 글자도 들어가지 않았다). key·fill 이 페이지 안에서 이벤트를 만드는 이유도 같다.
      //
      // 되돌리기 어려운 자리에 쓰이므로 두 가지를 지킨다. 보이는 탭에서만 입력한다. 그리고 입력 뒤
      // 화면을 다시 읽어, 실제로 달라졌을 때만 성공으로 보고한다.
      // 값 묶음을 지금 커서 위치에서부터 한 칸씩 입력한다. 한 칸을 입력하고 이동키를 눌러 다음 칸으로
      // 가는 것을 반복하므로 사람이 하는 것과 같은 경로이며, 왕복만 이 명령으로 묶었다.
      //
      // 입력은 페이지 안에서 만든다. OS 입력(Input.dispatchKeyEvent)은 이 앱에서 쓸 수 없다.
      // webview 게스트 문서는 임베더가 그 태그에 포커스를 줘야 hasFocus가 참이 되고, 그렇지
      // 않으면 크로미움이 키 입력을 버린다(확인 결과: 편집기가 열린 채 5칸을 입력했는데
      // 한 글자도 들어가지 않았다). key·fill 이 페이지 안에서 이벤트를 만드는 이유도 같다.
      //
      // 되돌리기 어려운 자리에 쓰이므로 두 가지를 지킨다. 보이는 탭에서만 입력한다. 그리고 입력 뒤
      // 화면을 다시 읽어, 실제로 달라졌을 때만 성공으로 보고한다.
      const values = Array.isArray(args.values) ? args.values : [];
      if (!values.length) throw new Error("넣을 값이 없습니다");
      if (!isTabShown(wc.id)) {
        throw new Error("보이지 않는 탭에는 대량으로 넣지 않습니다 — 그 탭을 먼저 띄우세요.");
      }
      // 이동키는 넷뿐이다. 대량 입력 경로가 임의의 단축키를 누를 수 있으면 다른 도구가 된다.
      const MOVE = { Enter: ["Enter", 13], Tab: ["Tab", 9],
                     ArrowDown: ["ArrowDown", 40], ArrowRight: ["ArrowRight", 39] };
      const advance = String(args.advance || "Enter");
      if (!MOVE[advance]) throw new Error(`이동키는 Enter·Tab·ArrowDown·ArrowRight 중 하나여야 합니다: "${advance}"`);
      const [mkey, mvk] = MOVE[advance];
      const gap = Math.min(200, Math.max(0, Number(args.pauseMs) || 0));

      const textOf = async () => {
        try {
          const r = await send("Runtime.evaluate", {
            expression: "(document.body ? document.body.innerText : '')", returnByValue: true });
          return String((r && r.result && r.result.value) || "");
        } catch { return null; }
      };
      const before = await textOf();

      // 한 칸: 글자를 넣고 이동키를 누른다. 전부 페이지 안에서 일어난다.
      const one = async (text) => {
        const r = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
          const t = ${JSON.stringify(String(text))};
          const key = ${JSON.stringify(mkey)}, vk = ${mvk};
          let el = document.activeElement;
          if (!el || el === document.body) return { ok: false, why: "커서가 어디에도 없습니다" };
          let via = null;
          if (el.isContentEditable) {
            try { el.focus(); } catch (e) {}
            el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: t, inputType: "insertText" }));
            let put = false;
            try { put = document.execCommand("insertText", false, t); } catch (e) { put = false; }
            if (!put) { el.textContent = (el.textContent || "") + t; }
            el.dispatchEvent(new InputEvent("input", { bubbles: true, data: t, inputType: "insertText" }));
            via = put ? "편집영역" : "편집영역(직접)";
          } else if ("value" in el) {
            const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (set && set.set) set.set.call(el, t); else el.value = t;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            via = "입력칸";
          } else {
            return { ok: false, why: "글을 넣을 수 없는 요소입니다: " + el.tagName };
          }
          const init = { key, code: key, keyCode: vk, which: vk, bubbles: true, cancelable: true, composed: true };
          el.dispatchEvent(new KeyboardEvent("keydown", init));
          el.dispatchEvent(new KeyboardEvent("keyup", init));
          return { ok: true, via };
        })()` });
        const v = r && r.result && r.result.value;
        if (!v || !v.ok) throw new Error((v && v.why) || "글을 넣지 못했습니다");
        return v.via;
      };

      let done = 0, via = null, failed = null;
      for (let i = 0; i < values.length; i++) {
        try {
          via = await one(values[i]);
          done = i + 1;
          if (gap) await new Promise((r) => setTimeout(r, gap));
        } catch (e) {
          failed = { at: i + 1, value: values[i], error: String((e && e.message) || e) };
          break;
        }
      }
      if (failed) {
        return { ok: false, typed: done, total: values.length, advance, stoppedAt: failed.at,
          error: `${failed.at}번째("${String(failed.value).slice(0, 20)}")에서 멈췄습니다: ${failed.error} — 앞 ${done}칸은 이미 들어갔습니다.` };
      }
      // 마지막 값이 화면 글에서 보이면 확인된 것이다. 보이지 않더라도 화면이 달라졌으면 들어갔을
      // 수 있으므로(가상 스크롤·캔버스) 단정하지 않고 확인 못 함으로 돌려준다. 글이 한 글자도
      // 달라지지 않았으면 아무 일도 일어나지 않은 것이므로 성공으로 보고하지 않는다.
      const after = await textOf();
      const last = values[values.length - 1];
      const seen = after != null && last && after.includes(last);
      const changed = before != null && after != null && before !== after;
      if (before != null && after != null && !changed && !seen) {
        let why = null;
        try {
          const r = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
            const a = document.activeElement;
            return { active: a ? (a.tagName + (a.id ? "#" + a.id : "") + (a.isContentEditable ? " [편집가능]" : "")) : null,
                     focus: document.hasFocus() };
          })()` });
          why = r && r.result && r.result.value;
        } catch {}
        return { ok: false, typed: done, total: values.length, advance, landed: false, via, why,
          error: `${done}칸을 쳤지만 화면이 한 글자도 달라지지 않았습니다 — 실제로는 들어가지 않았습니다.`
            + (why ? ` (커서 ${why.active || "없음"} · 문서 포커스 ${why.focus})` : "") };
      }
      return { ok: true, typed: done, total: values.length, advance, via,
        landed: seen ? "확인됨" : "확인 못 함",
        ...(seen ? {} : { note: "화면은 달라졌지만 마지막 값을 글에서 찾지 못했습니다 — 눈으로 한 번 보세요." }) };
    },
    // 키 하나. 수식키는 "Shift+Enter"처럼 앞에 붙여 한 인자로 준다.
    async key(send, _wc, args) {
      // 키는 이 탭 안에서만 끝나도록 페이지 안에서 이벤트와 편집을 함께 만든다.
      // wc.sendInputEvent는 창의 입력 경로를 타므로 대상 탭 밖으로 나갈 수 있고, CDP의
      // Input.dispatchKeyEvent는 화면에 없는 webview에는 성공을 돌려주고도 도달하지 않는다
      // (확인 결과: 명령은 ok인데 페이지의 keydown 기록이 비어 있었다).
      // 그래서 페이지 안에서 이벤트를 만들고 그 자리에서 편집까지 해 탭 밖으로 나가지 않게 한다.
      //
      // 한계는 분명히 둔다: 이렇게 만든 이벤트는 isTrusted가 거짓이라, 브라우저 자체 단축키
      // (Cmd+T 같은 것)와 신뢰된 이벤트만 받는 페이지에는 동작하지 않는다.
      // 키는 이 탭 안에서만 끝나야 한다. wc.sendInputEvent는 창의 입력 경로를 타므로 대상 탭
      // 밖으로 나갈 수 있고, CDP의 Input.dispatchKeyEvent는 화면에 없는 webview에는 성공을
      // 돌려주고도 도달하지 않는다(확인 결과: 명령은 ok인데 페이지의 keydown 기록이 비어 있었다).
      // 그래서 페이지 안에서 이벤트를 만들고 그 자리에서 편집까지 해 탭 밖으로 나가지 않게 한다.
      //
      // 한계는 분명히 둔다: 이렇게 만든 이벤트는 isTrusted가 거짓이라, 브라우저 자체 단축키
      // (Cmd+T 같은 것)와 신뢰된 이벤트만 받는 페이지에는 동작하지 않는다.
      const parts = String(args.key || "Enter").split("+").map((s) => s.trim()).filter(Boolean);
      const name = parts.pop();
      if (!name) throw new Error(`누를 키가 없습니다: "${args.key}"`);
      const bit = { shift: "shiftKey", ctrl: "ctrlKey", control: "ctrlKey", alt: "altKey",
                    option: "altKey", meta: "metaKey", cmd: "metaKey", command: "metaKey" };
      const mods = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
      for (const m of parts) {
        const b = bit[m.toLowerCase()];
        if (!b) throw new Error(`모르는 수식키: "${m}" — shift·ctrl·alt·meta(cmd)만 됩니다`);
        mods[b] = true;
      }
      // 이름이 있는 키만 표를 쓴다. 글자·숫자·한글은 글자 자체에서 뽑는다. 표가 커지면 표에
      // 없는 키가 조용히 동작하지 않는 상태로 남는다.
      const NAMED = {
        enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27],
        esc: ["Escape", "Escape", 27], backspace: ["Backspace", "Backspace", 8],
        delete: ["Delete", "Delete", 46], space: [" ", "Space", 32],
        arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
        arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
        home: ["Home", "Home", 36], end: ["End", "End", 35],
        pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
      };
      const lower = name.toLowerCase();
      const fkey = /^f([1-9]|1[0-2])$/.exec(lower);
      let key, code, vk;
      if (NAMED[lower]) [key, code, vk] = NAMED[lower];
      else if (fkey) { key = code = "F" + fkey[1]; vk = 111 + Number(fkey[1]); }
      else if ([...name].length === 1) {
        key = name;
        code = /^[a-zA-Z]$/.test(name) ? "Key" + name.toUpperCase()
             : /^[0-9]$/.test(name) ? "Digit" + name : "";
        vk = /^[a-zA-Z0-9]$/.test(name) ? name.toUpperCase().charCodeAt(0) : 0;
        // 대문자에서 shift를 유추하는 것은 수식키가 없을 때만이다. "Ctrl+A"는 관례상
        // ctrl+a이고, 여기서 shift를 얹으면 Ctrl+Shift+A라는 다른 단축키가 된다.
        if (/^[A-Z]$/.test(name) && !parts.length) mods.shiftKey = true;
      } else {
        throw new Error(`모르는 키: "${name}" — Enter·Tab·Escape·화살표·F1~F12·글자 하나 중 하나여야 합니다`);
      }
      const r = await send("Runtime.evaluate", {
        expression: `(() => {
          const key = ${JSON.stringify(key)}, code = ${JSON.stringify(code)}, vk = ${vk};
          const M = ${JSON.stringify(mods)};
          const el = document.activeElement && document.activeElement !== document.body
            ? document.activeElement : (document.body || document.documentElement);
          const init = { key, code, keyCode: vk, which: vk, bubbles: true, cancelable: true,
                         composed: true, ...M };
          const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
          let did = "이벤트만";
          const editable = el.matches && el.matches("input,textarea") ? "field"
            : (el.isContentEditable ? "ce" : null);
          const typed = !M.ctrlKey && !M.metaKey && [...key].length === 1 ? key
                      : (!M.ctrlKey && !M.metaKey && key === "Enter" && el.tagName === "TEXTAREA") ? "\\n" : null;
          if (down && editable === "field") {
            const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
            if (typed != null) {
              el.value = el.value.slice(0, s) + typed + el.value.slice(e);
              el.selectionStart = el.selectionEnd = s + typed.length;
              did = "입력";
            } else if (key === "Backspace") {
              const from = s === e ? Math.max(0, s - 1) : s;
              el.value = el.value.slice(0, from) + el.value.slice(e);
              el.selectionStart = el.selectionEnd = from; did = "지움";
            } else if (key === "Delete") {
              const to = s === e ? e + 1 : e;
              el.value = el.value.slice(0, s) + el.value.slice(to);
              el.selectionStart = el.selectionEnd = s; did = "지움";
            }
            if (did !== "이벤트만") {
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } else if (down && editable === "ce" && typed != null) {
            document.execCommand("insertText", false, typed); did = "입력";
          }
          if (down && key === "Tab") {
            // 포커스 이동은 브라우저가 해 주지 않으므로 여기서 옮긴다. 그러지 않으면 Tab이
            // 이벤트만 전달되고 아무 일도 일어나지 않는 상태가 된다.
            const all = [...document.querySelectorAll(
              'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')]
              .filter((x) => !x.disabled && x.offsetParent !== null);
            const i = all.indexOf(el);
            const next = all[(i + (M.shiftKey ? -1 : 1) + all.length) % (all.length || 1)];
            if (next) { next.focus(); did = "포커스 이동"; }
          }
          if (down && key === "Enter" && el.form && el.tagName === "INPUT") {
            // submit 이벤트만 보내면 브라우저의 기본 제출은 일어나지 않고, 페이지가 그 이벤트를
            // 듣고 있을 때만 동작한다. requestSubmit은 검증까지 거쳐 실제로 제출한다.
            if (typeof el.form.requestSubmit === "function") { el.form.requestSubmit(); did = "폼 보냄"; }
            else { el.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); did = "폼 보냄(이벤트만)"; }
          }
          el.dispatchEvent(new KeyboardEvent("keyup", init));
          return JSON.stringify({ did, prevented: !down,
            on: (el.getAttribute && el.getAttribute("data-testid")) || el.tagName });
        })()`, returnByValue: true,
      });
      let v; try { v = JSON.parse(r.result.value); } catch { v = {}; }
      return { ok: true, key, code, modifiers: Object.keys(mods).filter((k) => mods[k]),
               did: v.did, prevented: !!v.prevented, on: v.on };
    },
    // 절대 위치로 이동. 녹화 재현은 절대 y를 기록하므로 상대 scroll로는 재생이 밀린다.
    async scrollto(send, _wc, args) {
      const y = Number(args.y || 0), x = Number(args.x || 0);
      const r = await send("Runtime.evaluate", { expression: `(()=>{scrollTo(${x},${y});return {y:Math.round(scrollY),x:Math.round(scrollX)};})()`, returnByValue: true });
      return { ok: true, ...(r.result && r.result.value ? r.result.value : {}) };
    },
    // 방향(up/down/top/bottom) 또는 픽셀 수. 기본 down 한 화면(85%).
    async scroll(send, _wc, args) {
      const a = String(args.amount != null ? args.amount : "down").trim();
      let expr;
      if (a === "top") expr = "scrollTo(0,0)";
      else if (a === "bottom") expr = "scrollTo(0, document.body.scrollHeight)";
      else if (a === "up") expr = "scrollBy(0, -Math.round(innerHeight*0.85))";
      else if (/^-?\d+$/.test(a)) expr = `scrollBy(0, ${Number(a)})`;
      else expr = "scrollBy(0, Math.round(innerHeight*0.85))"; // down 포함 기본
      const r = await send("Runtime.evaluate", { expression: `(()=>{${expr};return {y:Math.round(scrollY),h:document.body.scrollHeight,vh:innerHeight};})()`, returnByValue: true });
      return { ok: true, scrolled: a, ...(r.result && r.result.value ? r.result.value : {}) };
    },
    // ref 요소 위로 마우스만 이동(press 없음). hover 메뉴 펼침 등에 쓴다.
    async hover(send, wc, args) {
      return await withLayout(send, async () => {
        const { backendNodeId, sid } = await nodeFromArgs(send, wc, args); // ref 또는 CSS 선택자
        const s = send.on(sid);
        await s("DOM.enable");
        try { await s("DOM.scrollIntoViewIfNeeded", { backendNodeId }); } catch {}
        // 프레임 안 요소는 좌표가 창 좌표계가 아니므로, 마우스 이동 대신 그 요소에 직접 이벤트를 낸다.
        if (sid) {
          const r = await s("DOM.resolveNode", { backendNodeId });
          const objectId = r && r.object && r.object.objectId;
          if (!objectId) throw new Error("iframe 안 요소를 다룰 수 없습니다");
          await s("Runtime.callFunctionOn", { objectId, functionDeclaration:
            `function(){ const o={bubbles:true,cancelable:true,view:window};
              this.dispatchEvent(new PointerEvent("pointerover",o)); this.dispatchEvent(new MouseEvent("mouseover",o));
              this.dispatchEvent(new PointerEvent("pointermove",o)); this.dispatchEvent(new MouseEvent("mousemove",o)); }` });
          return { ok: true, ref: args.ref, frame: "iframe" };
        }
        const box = await s("DOM.getBoxModel", { backendNodeId });
        const q = box.model.content;
        const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
        return { ok: true, ref: args.ref, at: { x: Math.round(cx), y: Math.round(cy) } };
      });
    },
    // 포커스만 준다. 자동완성 목록·달력처럼 칸에 들어가야 열리는 것들이 있는데, fill 은 글까지
    // 넣어 버려 그 상태를 만들 수 없다. 누르기(click)로 대신하면 목록 밖을 눌러 닫히거나
    // 다른 것이 열린다.
    async focus(send, wc, args) {
      const { backendNodeId, sid } = await nodeFromArgs(send, wc, args);
      const s = send.on(sid);
      const { object } = await s("DOM.resolveNode", { backendNodeId });
      if (!object || !object.objectId) throw new Error("요소 해석 실패");
      const r = await s("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true, userGesture: true,
        functionDeclaration: "function(){ var el=this; if(el.scrollIntoView)el.scrollIntoView({block:'center'}); if(!el.focus) return {ok:false,err:'포커스를 줄 수 없는 요소입니다'}; el.focus(); return {ok: document.activeElement===el, tag: el.tagName.toLowerCase()}; }",
      });
      const v = (r.result && r.result.value) || {};
      if (v.ok === false) throw new Error(v.err || "포커스 실패");
      return { ok: true, ref: args.ref, focused: !!v.ok, tag: v.tag || null };
    },
    // 내용을 비우기만 한다. fill 로 빈 문자열을 넣는 것과 다르다. 그 경로는 새 값이 들어갔는지
    // 검사해서 빈 값이면 실패로 본다. 지우고 그대로 두는 것이 목적인 자리가 따로 있다.
    async clear(send, wc, args) {
      const { backendNodeId, sid } = await nodeFromArgs(send, wc, args);
      const s = send.on(sid);
      const { object } = await s("DOM.resolveNode", { backendNodeId });
      if (!object || !object.objectId) throw new Error("요소 해석 실패");
      const r = await s("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true, userGesture: true,
        functionDeclaration: `function(){ var el=this; if(el.focus)el.focus();
          if (el.isContentEditable) { el.innerHTML=''; }
          else if ('value' in el) {
            var p = Object.getPrototypeOf(el), d = Object.getOwnPropertyDescriptor(p,'value');
            if (d && d.set) d.set.call(el,''); else el.value='';
          } else return {ok:false,err:'비울 수 있는 요소가 아닙니다'};
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return {ok:true, left: el.isContentEditable ? (el.textContent||'').length : String(el.value||'').length}; }`,
      });
      const v = (r.result && r.result.value) || {};
      if (v.ok === false) throw new Error(v.err || "비우기 실패");
      if (v.left) throw new Error("비운 뒤에도 내용이 남아 있습니다(" + v.left + "자) — 페이지가 값을 되돌립니다.");
      return { ok: true, ref: args.ref, cleared: true };
    },
    // 체크박스·라디오를 원하는 상태로 맞춘다. 누르기로 하면 현재 상태를 모르는 채 뒤집는 것이라,
    // 같은 명령을 두 번 실행하면 두 번째에 오히려 풀린다(재현 스크립트가 매번 다른 결과를 낸다).
    async check(send, wc, args) {
      const { backendNodeId, sid } = await nodeFromArgs(send, wc, args);
      const s = send.on(sid);
      const want = args.value === false || args.value === "false" || args.value === "off" ? false : true;
      const { object } = await s("DOM.resolveNode", { backendNodeId });
      if (!object || !object.objectId) throw new Error("요소 해석 실패");
      const r = await s("Runtime.callFunctionOn", {
        objectId: object.objectId, returnByValue: true, userGesture: true,
        arguments: [{ value: want }],
        functionDeclaration: `function(want){ var el=this;
          var t=(el.getAttribute&&(el.getAttribute('type')||'')).toLowerCase();
          if (el.tagName!=='INPUT'||(t!=='checkbox'&&t!=='radio')) {
            // aria 로만 표현한 토글도 흔하므로, 현재 상태를 읽고 필요할 때만 누른다.
            var a=el.getAttribute&&el.getAttribute('aria-checked');
            if (a==null) return {ok:false,err:'체크박스·라디오가 아닙니다'};
            var cur=(a==='true');
            if (cur!==want) el.click();
            // 누른 뒤의 값을 다시 읽는다. 요청값을 그대로 돌려주면 "그대로 뒀다"와 "바꿨다"를
            // 구별할 수 없고, 페이지가 되돌린 경우까지 성공으로 보고한다.
            var now=(el.getAttribute('aria-checked')==='true');
            return {ok: now===want, was:cur, now:now, via:'aria'};
          }
          if (t==='radio' && !want) return {ok:false,err:'라디오는 끌 수 없습니다 — 다른 항목을 켜세요'};
          var was=!!el.checked;
          if (was!==want) { el.click(); }
          if (!!el.checked!==want) { el.checked=want; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
          return {ok: !!el.checked===want, was:was, now:!!el.checked, via:'input'}; }`,
      });
      const v = (r.result && r.result.value) || {};
      if (v.ok === false) throw new Error(v.err || "상태 지정 실패");
      if (!v.ok) throw new Error("원하는 상태로 바뀌지 않았습니다(지금 " + (v.now ? "켜짐" : "꺼짐") + ") — 페이지가 되돌립니다.");
      return { ok: true, ref: args.ref, was: v.was, now: v.now, via: v.via };
    },
    // <select> 드롭다운에서 옵션을 value 또는 표시 텍스트로 선택 + change 발화.
    async select(send, wc, args) {
      const { backendNodeId, sid } = await nodeFromArgs(send, wc, args);
      const s = send.on(sid);
      const val = args.value != null ? String(args.value) : "";
      const { object } = await s("DOM.resolveNode", { backendNodeId });
      if (!object || !object.objectId) throw new Error("요소 해석 실패");
      const r = await s("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function(val){ var el=this,sel=null,opt=null; if(el.tagName==='SELECT'){sel=el;} else if(el.tagName==='OPTION'){opt=el; sel=el.closest('select');} if(!sel) return {ok:false,err:'<select>/option 요소가 아닙니다'}; if(!opt){ var opts=Array.from(sel.options); opt=opts.find(function(o){return o.value===val||o.textContent.trim()===val;}); } if(!opt) return {ok:false,err:'옵션을 찾을 수 없음: '+val}; sel.value=opt.value; sel.dispatchEvent(new Event('input',{bubbles:true})); sel.dispatchEvent(new Event('change',{bubbles:true})); return {ok:true,selected:opt.textContent.trim(),value:opt.value}; }",
        arguments: [{ value: val }],
        returnByValue: true,
      });
      const v = r.result && r.result.value;
      if (v && v.ok === false) throw new Error(v.err);
      return { ok: true, ref: args.ref, ...(v || {}) };
    },
    // 입력창을 ref로 지목해 포커스+기존내용 전체선택+새 텍스트 대체(click과 동일 결속).
    async fill(send, wc, args) {
      const { backendNodeId: fillNodeId, sid: fillSid } = await nodeFromArgs(send, wc, args);
      const entry = { backendDOMNodeId: fillNodeId };
      // 프레임 안 입력칸은 Input.insertText 로 채울 수 없다. 그 명령은 창 단위라 최상위 문서의
      // 포커스로 들어가서, 성공으로 돌아오는데 정작 iframe 칸은 비어 있고 엉뚱한 칸이 채워진다.
      // 그래서 그 요소를 직접 잡아 값을 넣고 프레임워크가 듣는 이벤트를 함께 낸다.
      if (fillSid) {
        const fs = send.on(fillSid);
        await fs("DOM.enable");
        try { await fs("DOM.scrollIntoViewIfNeeded", { backendNodeId: fillNodeId }); } catch {}
        const rn = await fs("DOM.resolveNode", { backendNodeId: fillNodeId });
        const oid = rn && rn.object && rn.object.objectId;
        if (!oid) throw new Error("iframe 안 입력칸을 다룰 수 없습니다");
        const fr = await fs("Runtime.callFunctionOn", {
          objectId: oid, returnByValue: true, awaitPromise: false, userGesture: true,
          functionDeclaration: `function(t){ const el=this;
            try { el.focus(); } catch(e) {}
            if (el.isContentEditable) {
              const doc=el.ownerDocument, sel=doc.getSelection(), range=doc.createRange();
              range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
              let inserted=false; try { inserted=doc.execCommand("insertText",false,t); } catch(e) {}
              // execCommand는 리치 편집기의 입력 파이프라인·undo를 살리는 첫 길이다. 구현이 없거나
              // 편집기가 값을 바꾸면 마지막에 DOM을 정확히 맞추고 input을 알린다.
              if (!inserted || (el.textContent || "") !== t) {
                el.textContent=t; const end=doc.createRange(); end.selectNodeContents(el); end.collapse(false);
                sel.removeAllRanges(); sel.addRange(end); el.dispatchEvent(new Event("input",{bubbles:true}));
              }
            } else if (el.value !== undefined) {
              const p=Object.getPrototypeOf(el), d=Object.getOwnPropertyDescriptor(p,"value");
              if (d && d.set) d.set.call(el, t); else el.value = t;
              el.dispatchEvent(new Event("input",{bubbles:true}));
            } else { el.textContent = t; el.dispatchEvent(new Event("input",{bubbles:true})); }
            el.dispatchEvent(new Event("change",{bubbles:true}));
            const v = (el.value !== undefined ? el.value : el.textContent) || "";
            return { ok: v === t, got: String(v).slice(0,200), contenteditable: !!el.isContentEditable }; }`,
          arguments: [{ value: String(args.text == null ? "" : args.text) }],
        });
        const fvv = (fr && fr.result && fr.result.value) || {};
        if (!fvv.ok) throw new Error("iframe 안 입력이 반영되지 않았습니다" + (fvv.got !== undefined ? ` (현재 값: ${fvv.got})` : ""));
        if (fvv.contenteditable) return { ok: true, ref: args.ref, via: "리치 편집기 직접 설정", frame: "iframe" };
        return { ok: true, ref: args.ref, via: "값 직접 설정", frame: "iframe" };
      }

      await send("DOM.enable");
      try { await send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendDOMNodeId }); } catch {}
      await send("DOM.focus", { backendNodeId: entry.backendDOMNodeId });
      await send("Runtime.evaluate", { expression: `(()=>{const el=document.activeElement; if(!el)return;
        if(el.isContentEditable){const r=document.createRange(),s=getSelection();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);}
        else if(el.select)el.select(); else if(document.execCommand)document.execCommand("selectAll");})()`, returnByValue: true });
      const want = String(args.text == null ? "" : args.text);
      await insertTextInChunks(send, want); // 첫 청크가 선택 영역을 교체하고, 뒤 청크는 이어진 caret에 붙는다.
      // 넣었다고 보고하기 전에 들어갔는지 확인한다(아래 verify). 포커스가 없는 문서에서는 이 명령이
      // 조용히 사라지므로, 포커스 에뮬레이션이 통하지 않는 페이지에서도 빈 칸을 ok 로 보고하지 않는다.
      const verify = await send("Runtime.evaluate", { returnByValue: true, expression:
        `(()=>{const el=document.activeElement; if(!el) return {ok:false}; const v=(el.value!==undefined?el.value:el.textContent)||""; return {ok:v===${JSON.stringify(want)}, got:String(v).slice(0,200), contenteditable:!!el.isContentEditable};})()` });
      const vv = (verify && verify.result && verify.result.value) || {};
      if (vv.ok) {
        if (vv.contenteditable) return { ok: true, ref: args.ref, via: "리치 편집기 입력" };
        return { ok: true, ref: args.ref, via: "입력" };
      }
      // DOM.focus는 activeElement만 바꾼다. 위젯 포커스가 없으면 텍스트가 사라지므로, 사람이 하듯 눌러
      // 실제 포커스를 준 다음 다시 입력한다(값 직접 설정은 이것까지 실패했을 때만).
      try {
        await run(send, wc, "click", { ref: args.ref, sel: args.sel }, webContentsMod(wc));
        await send("Runtime.evaluate", { expression: `(()=>{const el=document.activeElement; if(!el)return;
          if(el.isContentEditable){const r=document.createRange(),s=getSelection();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);}
          else if(el.select)el.select(); else if(document.execCommand)document.execCommand("selectAll");})()`, returnByValue: true });
        await insertTextInChunks(send, want);
        const again = await send("Runtime.evaluate", { returnByValue: true, expression:
          `(()=>{const el=document.activeElement; if(!el) return {ok:false}; const v=(el.value!==undefined?el.value:el.textContent)||""; return {ok:v===${JSON.stringify(want)}, got:String(v).slice(0,200), contenteditable:!!el.isContentEditable};})()` });
        const av = (again && again.result && again.result.value) || {};
        if (av.ok) {
          if (av.contenteditable) return { ok: true, ref: args.ref, via: "눌러서 리치 편집기 입력" };
          return { ok: true, ref: args.ref, via: "눌러서 입력" };
        }
      } catch {}
      // 마지막 수단: 값을 직접 넣고 프레임워크가 알아듣는 이벤트를 같이 낸다(React 등은 네이티브 setter를 봐야 반응한다).
      const forced = await send("Runtime.evaluate", { returnByValue: true, expression:
        `(()=>{const el=document.activeElement; if(!el) return {ok:false,err:"입력칸에 포커스가 없습니다"};
          const t=${JSON.stringify(want)};
          if(el.isContentEditable){const s=getSelection(),r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r);
            let inserted=false;try{inserted=document.execCommand("insertText",false,t);}catch(e){}
            if(!inserted||(el.textContent||"")!==t){el.textContent=t;const end=document.createRange();end.selectNodeContents(el);end.collapse(false);
              s.removeAllRanges();s.addRange(end);el.dispatchEvent(new Event("input",{bubbles:true}));}}
          else if(el.value!==undefined){const p=Object.getPrototypeOf(el);const d=Object.getOwnPropertyDescriptor(p,"value");
            if(d&&d.set)d.set.call(el,t); else el.value=t;el.dispatchEvent(new Event("input",{bubbles:true}));}
          else{el.textContent=t;el.dispatchEvent(new Event("input",{bubbles:true}));}
          el.dispatchEvent(new Event("change",{bubbles:true}));
          const v=(el.value!==undefined?el.value:el.textContent)||""; return {ok:v===t, got:String(v).slice(0,200), contenteditable:!!el.isContentEditable};})()` });
      const fv = (forced && forced.result && forced.result.value) || {};
      if (!fv.ok) throw new Error("입력이 반영되지 않았습니다" + (fv.err ? " — " + fv.err : "") + (fv.got !== undefined ? ` (현재 값: ${fv.got})` : ""));
      if (fv.contenteditable) return { ok: true, ref: args.ref, via: "리치 편집기 직접 설정" };
      return { ok: true, ref: args.ref, via: "값 직접 설정" };
    },
  };
}

module.exports = { createInputCommands };
