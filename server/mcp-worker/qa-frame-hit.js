// iframe 안의 요소에 대해 탭 좌표로 히트 테스트
export async function inspectFrameHit(send, { frameId, backendNodeId, x, y }) {
  const located = await send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y),
    includeUserAgentShadowDOM: false }).catch(() => null);
  const resolve = async (id) => (await send("DOM.resolveNode", { backendNodeId: id })).object?.objectId;
  const objectId = await resolve(backendNodeId);
  if (!objectId) return null;

  let topId;
  try {
    if (located?.backendNodeId) {
      topId = located.backendNodeId === backendNodeId ? objectId : await resolve(located.backendNodeId);
    }
    // 다른 문서에서 잡힌 노드는 대상의 실행 컨텍스트에 전달할 수 없음
    const sameFrame = located?.frameId === frameId;
    const out = await send("Runtime.callFunctionOn", { objectId, returnByValue: true,
      arguments: [sameFrame && topId ? { objectId: topId } : { value: null }],
      functionDeclaration: `function(top){
        const el=this.nodeType===3?this.parentElement:this;
        const doc=el.ownerDocument,r=el.getBoundingClientRect(),s=getComputedStyle(el);
        const x=r.left+r.width/2,y=r.top+r.height/2;
        const sel=n=>n?.id?'#'+CSS.escape(n.id):n?.localName||null;
        const inside=!!top&&(el===top||el.contains(top));
        return { inside, disabled:el.matches(':disabled')||el.closest('[inert],[aria-disabled="true"]')!=null,
          displayed:r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden',
          offscreen:y<0?'위':y>=innerHeight?'아래':x<0?'왼쪽':x>=innerWidth?'오른쪽':null,
          occluded:!inside&&!(top?.contains(el)&&(el.disabled===true||s.pointerEvents==='none')),
          inert:s.pointerEvents==='none'&&el.disabled!==true&&(top===doc.documentElement||top===doc.body),
          sel:sel(el), blocker:top?{sel:sel(top),text:String(top.innerText||top.textContent||'').trim().slice(0,1000)}:null };
      }` });
    const inspected = out.result?.value;
    if (!inspected) return null;
    if (inspected.occluded && topId && !sameFrame) {
      const cover = await send("Runtime.callFunctionOn", { objectId: topId, returnByValue: true,
        functionDeclaration: `function(){return {sel:this.id?'#'+CSS.escape(this.id):this.localName||null,
          text:String(this.innerText||this.textContent||'').trim().slice(0,1000)};}` });
      inspected.blocker = cover.result?.value || null;
    }
    return { ...inspected, located };
  } finally {
    if (topId && topId !== objectId) await send("Runtime.releaseObject", { objectId: topId });
    await send("Runtime.releaseObject", { objectId });
  }
}
