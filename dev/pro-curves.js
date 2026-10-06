/* ==================== PRO: KEYFRAME CURVE EDITOR (v4.8) ====================
   A graph of each animated property over the clip: drag keys in time and
   value, double-click to add one, and pick how every segment moves — Linear,
   Smooth, Ease in, Ease out, Hold, or a Custom bezier with two handles.
   The curve type lives on the key that STARTS the segment (key.i, key.b);
   kfEval honors it, and _aiKfSlice carries it through splits and transcript
   cuts exactly. What the graph draws is sampled from kfEval itself, so the
   picture is exactly what renders. All edits in one visit = one undo step. */
const PRO_CURVE_TYPES=[
  ['linear','Linear','Constant speed from one key to the next'],
  ['smooth','Smooth','Eases out of one key and into the next (the default)'],
  ['in','Ease in','Starts slowly and arrives at full speed'],
  ['out','Ease out','Leaves at full speed and settles gently into the next key'],
  ['hold','Hold','Stays put, then jumps at the next key'],
  ['bezier','Custom','Your own curve — drag the two handles on the graph']];
const PRO_KF_NAMES={x:'Position X',y:'Position Y',scale:'Scale',rotation:'Rotation',opacity:'Opacity',volume:'Volume',pixelate:'Pixelate',
  regionW:'Region width',regionH:'Region height',cpTLx:'Corner ↖ X',cpTLy:'Corner ↖ Y',cpTRx:'Corner ↗ X',cpTRy:'Corner ↗ Y',
  cpBRx:'Corner ↘ X',cpBRy:'Corner ↘ Y',cpBLx:'Corner ↙ X',cpBLy:'Corner ↙ Y'};
const _proKfPct=k=>k==='scale'||k==='opacity'||k==='volume';
function proKfShow(k,v){return _proKfPct(k)?Math.round(v*1000)/10+'%':k==='rotation'?(+v).toFixed(1)+'°':(+v).toFixed(2).replace(/\.?0+$/,'');}
// round axis ticks (1/2/2.5/5 × 10^n in DISPLAY units — percent props are shown ×100) inside [lo,hi]
function proNiceTicks(lo,hi,unit){
  const a=lo*unit,b=hi*unit,raw=(b-a)/6;if(!(raw>0))return [lo];
  const p=Math.pow(10,Math.floor(Math.log10(raw))),st=[1,2,2.5,5,10].map(m=>m*p).find(s=>s>=raw)||10*p;
  const out=[];for(let v=Math.ceil(a/st-1e-9)*st;v<=b+1e-9;v+=st)out.push(+(v/unit).toPrecision(12));
  return out;}
function proKfProps(c){return c&&c.kf?KF_PROPS.filter(k=>c.kf[k]&&c.kf[k].length):[];}
function proKfType(c,q){return (q.e?q.e.i:q.i)||c.kfEaseMode||'smooth';}

// ---------- editing primitives (the dialog and the tests both use these) ----------
// Keys cut from a longer move (splits, transcript cuts) carry e = their stretch of
// the original segment, so they play exactly as before. Only the segments an
// edit actually touches become plain segments; the rest stay exact.
function _proKfArr(c,k){return (c.kf&&c.kf[k])||null;}
function _proUnfrag(a,...idx){for(const n of idx)if(a[n])kfUnfrag(a[n]);}
// Curve type of the segment that starts at key #idx (all keys when idx<0).
function proCurveSetType(c,k,idx,type,b){
  const a=_proKfArr(c,k);if(!a)return;
  for(const [n,q] of a.entries()){if(idx>=0&&n!==idx)continue;
    kfUnfrag(q);q.i=type;if(type==='bezier')q.b=(b||q.b||[0.33,0,0.67,1]).slice(0,4);else delete q.b;}
}
// Move key #idx; time stays between its neighbors. Returns the (possibly new) index.
function proCurveMoveKey(c,k,idx,t,v){
  const a=_proKfArr(c,k);if(!a||!a[idx])return idx;
  _proUnfrag(a,idx-1,idx);   // the two segments that meet at this key
  const lo=idx>0?a[idx-1].t+KF_EPS:0,hi=idx<a.length-1?a[idx+1].t-KF_EPS:c.duration;
  if(t!=null)a[idx].t=+clamp(t,Math.min(lo,hi),Math.max(lo,hi)).toFixed(3);
  if(v!=null&&isFinite(v))a[idx].v=+(+v).toFixed(5);
  return idx;
}
// A key at local time t, ON the curve as it is now: the segment it lands in is
// split into two exact halves of the same move, so the motion doesn't change.
function proCurveAddKey(c,k,t){
  const a=_proKfArr(c,k);if(!a)return -1;
  t=+clamp(t,0,c.duration).toFixed(3);
  if(a.some(q=>Math.abs(q.t-t)<KF_EPS))return a.findIndex(q=>Math.abs(q.t-t)<KF_EPS);
  const mode=c.kfEaseMode||'smooth',v=kfEval(a,t,mode);
  const j=a.findIndex((q,n)=>n+1<a.length&&q.t<t&&a[n+1].t>t);
  const q={t,v};
  if(j>=0){
    const A=a[j],B=a[j+1],u=(t-A.t)/Math.max(1e-9,B.t-A.t);
    const base=A.e||{u0:0,u1:1,v0:A.v,v1:B.v,i:A.i,b:A.b},um=base.u0+(base.u1-base.u0)*u;
    const mk=(u0,u1)=>{const e={u0,u1,v0:base.v0,v1:base.v1};if(base.i){e.i=base.i;if(base.b)e.b=base.b.slice();}return e;};
    A.e=mk(base.u0,um);q.e=mk(um,base.u1);
  }
  a.push(q);a.sort((x,y)=>x.t-y.t);return a.indexOf(q);
}
// Remove key #idx; removing the only key ends the animation at its value.
function proCurveDeleteKey(c,k,idx){
  const a=_proKfArr(c,k);if(!a||!a[idx])return;
  if(a.length===1){c.props[k]=a[0].v;delete c.kf[k];if(!Object.keys(c.kf).length)delete c.kf;return;}
  _proUnfrag(a,idx-1,idx);a.splice(idx,1);
}

// ---------- the dialog ----------
function _proCurveIcon(type,b){
  const P=[];for(let i=0;i<=16;i++){const u=i/16,y=kfEase(u,type,b||[0.33,0,0.67,1]);P.push((2+u*24).toFixed(1)+','+(17-y*14).toFixed(1));}
  if(type==='hold')return `<svg viewBox="0 0 28 20" class="cv-ico"><path d="M2 17H26V3" /></svg>`;
  return `<svg viewBox="0 0 28 20" class="cv-ico"><polyline points="${P.join(' ')}"/></svg>`;
}
function proCurvesOpen(c,prop){
  c=c||state.clips.find(x=>x.id===state.selection);
  const props=proKfProps(c);
  if(!props.length){toast('This clip has no keyframes yet — click a ◇ next to a slider to add one','err',5000);return;}
  let k=props.includes(prop)?prop:props[0],sel=0,pushed=false,range=null,drag=null;
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal aimodal cv-modal" style="width:min(940px,96vw)">
    <div class="modal-head"><div><h3>Keyframe curves — ${esc(c.name)}</h3>
      <div class="sub">Drag a key to change its time and value. Double-click the graph to add a key; Delete removes the selected one. Pick how each move eases below.</div></div>
      <button class="mclose" id="cvX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body cv-body">
      <div class="cv-props" id="cvProps"></div>
      <div class="cv-main">
        <canvas id="cvGraph" class="cv-graph" title="Drag keys to change them. Double-click to add a key. Drag in the time strip at the top to move the playhead."></canvas>
        <div class="cv-key" id="cvKey"></div>
      </div>
    </div>
    <div class="modal-foot"><div class="note">Every change here is one undo step. The preview updates as you drag.</div>
      <button class="tbtn" id="cvReset" title="Put every segment of this property back on the clip’s easing setting">Reset curves</button>
      <button class="tbtn primary" id="cvDone" title="Close the curve editor">Done</button></div></div>`;
  const cv=$('#cvGraph'),g=cv.getContext('2d');
  const touch=()=>{if(!pushed){pushHistory();pushed=true;}requestDraw();};
  const arr=()=>(c.kf&&c.kf[k])||[];
  const PADL=54,PADR=14,PADT=24,PADB=22;
  let W=0,H=0;
  // layout size: getBoundingClientRect is scaled while the dialog's opening animation runs
  const size=()=>{const d=window.devicePixelRatio||1;W=Math.max(200,cv.clientWidth);H=Math.max(160,cv.clientHeight);
    cv.width=Math.round(W*d);cv.height=Math.round(H*d);g.setTransform(d,0,0,d,0,0);};
  const calcRange=()=>{const a=arr();let lo=Infinity,hi=-Infinity;
    for(const q of a){lo=Math.min(lo,q.v);hi=Math.max(hi,q.v);}
    for(let i=0;i<=200;i++){const v=kfEval(a,c.duration*i/200,c.kfEaseMode||'smooth');if(v!==undefined){lo=Math.min(lo,v);hi=Math.max(hi,v);}}
    if(!(hi-lo>1e-9)){const m=Math.abs(lo)*0.2||(_proKfPct(k)?0.2:10);lo-=m;hi+=m;}
    const p=(hi-lo)*0.14;range={lo:lo-p,hi:hi+p};};
  const X=t=>PADL+t/Math.max(1e-9,c.duration)*(W-PADL-PADR),T=x=>(x-PADL)/(W-PADL-PADR)*c.duration;
  const Y=v=>PADT+(1-(v-range.lo)/(range.hi-range.lo))*(H-PADT-PADB),V=y=>range.lo+(1-(y-PADT)/(H-PADT-PADB))*(range.hi-range.lo);
  const css=n=>getComputedStyle(document.body).getPropertyValue(n).trim();
  const handles=()=>{const a=arr(),q=a[sel],r=a[sel+1];if(!q||!r||q.e||q.i!=='bezier'||!q.b)return null;
    const dv=(r.v-q.v)||((range.hi-range.lo)*0.25);
    return [[q.t+q.b[0]*(r.t-q.t),q.v+q.b[1]*dv],[q.t+q.b[2]*(r.t-q.t),q.v+q.b[3]*dv],dv];};
  const draw=()=>{
    if(!cv.isConnected)return;if(!range)calcRange();
    const acc=css('--accent')||'#7c6cff',tx=css('--text')||'#ddd',mu=css('--muted')||'#888',bd=css('--border')||'#333';
    g.clearRect(0,0,W,H);g.font='11px system-ui,sans-serif';g.lineWidth=1;
    // time strip + grid
    g.fillStyle='rgba(127,127,127,.08)';g.fillRect(PADL,0,W-PADL-PADR,PADT-6);
    const step=[0.1,0.25,0.5,1,2,5,10,30,60].find(s=>c.duration/s<=10)||120;
    g.strokeStyle=bd;g.fillStyle=mu;g.textAlign='center';
    for(let t=0;t<=c.duration+1e-9;t+=step){const x=X(t);g.beginPath();g.moveTo(x,PADT-6);g.lineTo(x,H-PADB);g.stroke();g.fillText((+t.toFixed(2))+'s',x,H-6);}
    g.textAlign='right';
    for(const v of proNiceTicks(range.lo,range.hi,_proKfPct(k)?100:1)){const y=Y(v);g.beginPath();g.moveTo(PADL,y);g.lineTo(W-PADR,y);g.stroke();g.fillText(proKfShow(k,v),PADL-6,y+4);}
    // playhead
    const lt=state.time-c.start;
    if(lt>=0&&lt<=c.duration){g.strokeStyle=css('--danger')||'#e55';g.beginPath();g.moveTo(X(lt),0);g.lineTo(X(lt),H-PADB);g.stroke();}
    // the curve, sampled from kfEval (exactly what renders)
    const a=arr(),mode=c.kfEaseMode||'smooth';
    g.strokeStyle=acc;g.lineWidth=2;g.beginPath();
    for(let x=PADL;x<=W-PADR;x++){const v=kfEval(a,T(x),mode);x===PADL?g.moveTo(x,Y(v)):g.lineTo(x,Y(v));}
    g.stroke();g.lineWidth=1;
    // bezier handles
    const h=handles();
    if(h){g.strokeStyle=mu;g.fillStyle=tx;const q=a[sel],r=a[sel+1];
      for(const [[ht,hv],[kt,kv]] of [[h[0],[q.t,q.v]],[h[1],[r.t,r.v]]]){g.beginPath();g.moveTo(X(kt),Y(kv));g.lineTo(X(ht),Y(hv));g.stroke();g.beginPath();g.arc(X(ht),Y(hv),5,0,7);g.fill();}}
    // keys
    a.forEach((q,n)=>{const x=X(q.t),y=Y(q.v);g.save();g.translate(x,y);g.rotate(Math.PI/4);
      g.fillStyle=n===sel?acc:tx;g.strokeStyle=n===sel?tx:acc;g.fillRect(-5,-5,10,10);g.strokeRect(-5,-5,10,10);g.restore();});
  };
  const renderProps=()=>{
    $('#cvProps').innerHTML=proKfProps(c).map(p=>`<button class="cv-prop${p===k?' on':''}" data-p="${p}" title="Show the ${esc(PRO_KF_NAMES[p]||p)} curve">${esc(PRO_KF_NAMES[p]||p)}<span>${c.kf[p].length}</span></button>`).join('');
    $('#cvProps').querySelectorAll('.cv-prop').forEach(b=>b.onclick=()=>{k=b.dataset.p;sel=0;range=null;renderAll();});
  };
  const renderKey=()=>{
    const a=arr(),q=a[sel],host=$('#cvKey');
    if(!q){host.innerHTML='';return;}
    const last=sel===a.length-1,ty=proKfType(c,q),pct=_proKfPct(k);
    host.innerHTML=`<div class="cv-fields">
        <label title="When this key happens, in seconds from the start of the clip">Time <input type="number" id="cvT" step="0.01" min="0" max="${c.duration.toFixed(3)}" value="${q.t.toFixed(2)}"></label>
        <label title="The value at this key${pct?' (in percent)':''}">Value <input type="number" id="cvV" step="${pct?1:0.1}" value="${+(pct?q.v*100:q.v).toFixed(2)}"></label>
        <span class="cv-idx">Key ${sel+1} of ${a.length}</span>
        <button class="tbtn" id="cvDel" title="Delete this key (Delete)">Delete key</button></div>
      <div class="cv-types${last?' dis':''}"><span class="cv-lbl">${last?'Last key — nothing after it to ease into':'Move to the next key'}</span>
        ${PRO_CURVE_TYPES.map(([id,n,tip])=>`<button class="cv-type${ty===id?' on':''}" id="cvType_${id}" data-ty="${id}" title="${tip}"${last?' disabled':''}>${_proCurveIcon(id,q.b)}<span>${n}</span></button>`).join('')}
        <button class="tbtn cv-all" id="cvAll" title="Use this key’s curve type for every key of this property"${last?' disabled':''}>Apply to all</button></div>`;
    $('#cvT').onchange=e=>{touch();sel=proCurveMoveKey(c,k,sel,+e.target.value,null);renderAll();};
    $('#cvV').onchange=e=>{touch();proCurveMoveKey(c,k,sel,null,pct?+e.target.value/100:+e.target.value);range=null;renderAll();};
    $('#cvDel').onclick=()=>delKey();
    host.querySelectorAll('.cv-type').forEach(b=>b.onclick=()=>{touch();proCurveSetType(c,k,sel,b.dataset.ty);range=null;renderAll();});
    $('#cvAll').onclick=()=>{const q2=arr()[sel];touch();proCurveSetType(c,k,-1,q2.i||proKfType(c,q2),q2.b);range=null;renderAll();};
  };
  const renderAll=()=>{renderProps();renderKey();draw();};
  const delKey=()=>{if(!arr()[sel])return;touch();proCurveDeleteKey(c,k,sel);
    if(!proKfProps(c).length){close();return;}
    if(!proKfProps(c).includes(k))k=proKfProps(c)[0];sel=Math.max(0,Math.min(sel,arr().length-1));range=null;renderAll();};
  // pointer: keys, handles, the time strip
  // screen → drawing coordinates; re-measure first in case the ResizeObserver hasn't caught up (see pro-ramp.js)
  const pos=e=>{if(cv.clientWidth&&(Math.max(200,cv.clientWidth)!==W||Math.max(160,cv.clientHeight)!==H)){size();draw();}
    const r=cv.getBoundingClientRect(),k=r.width/Math.max(1,cv.offsetWidth||r.width);
    return [(e.clientX-r.left-cv.clientLeft*k)*W/Math.max(1,cv.clientWidth*k),(e.clientY-r.top-cv.clientTop*k)*H/Math.max(1,cv.clientHeight*k)];};
  cv.onpointerdown=e=>{
    const [x,y]=pos(e),a=arr();
    if(y<PADT-6){drag={kind:'time'};setTime(clamp(c.start+T(x),c.start,clipEnd(c)));draw();cv.setPointerCapture(e.pointerId);return;}
    const h=handles();
    if(h){for(const hn of [0,1])if(Math.hypot(X(h[hn][0])-x,Y(h[hn][1])-y)<8){drag={kind:'h',n:hn,dv:h[2]};cv.setPointerCapture(e.pointerId);return;}}
    const n=a.findIndex(q=>Math.hypot(X(q.t)-x,Y(q.v)-y)<8);
    if(n>=0){sel=n;drag={kind:'key',x0:x,y0:y,t0:a[n].t,v0:a[n].v,moved:false};cv.setPointerCapture(e.pointerId);renderKey();draw();}
  };
  cv.onpointermove=e=>{
    if(!drag)return;const [x,y]=pos(e);
    if(drag.kind==='time'){setTime(clamp(c.start+T(x),c.start,clipEnd(c)));draw();return;}
    if(drag.kind==='h'){const a=arr(),q=a[sel],r=a[sel+1];touch();
      const u=clamp((T(x)-q.t)/Math.max(1e-9,r.t-q.t),0,1),w=clamp((V(y)-q.v)/drag.dv,-1,2);
      q.b[drag.n*2]=+u.toFixed(3);q.b[drag.n*2+1]=+w.toFixed(3);draw();renderKeyIcons();return;}
    if(!drag.moved&&Math.hypot(x-drag.x0,y-drag.y0)<3)return;
    drag.moved=true;touch();
    let t=drag.t0+(T(x)-T(drag.x0));
    const lt=state.time-c.start;if(Math.abs(X(t)-X(lt))<6)t=lt;          // snap to the playhead
    if(e.shiftKey)t=drag.t0;                                              // Shift: value only
    const v=e.altKey?drag.v0:drag.v0+(V(y)-V(drag.y0));                   // Alt: time only
    sel=proCurveMoveKey(c,k,sel,t,v);draw();
    const tt=$('#cvT'),vv=$('#cvV'),q=arr()[sel];if(tt&&q){tt.value=q.t.toFixed(2);vv.value=+(_proKfPct(k)?q.v*100:q.v).toFixed(2);}
  };
  const renderKeyIcons=()=>{const q=arr()[sel];const b=document.getElementById('cvType_bezier');if(b&&q)b.querySelector('svg').outerHTML=_proCurveIcon('bezier',q.b);};
  cv.onpointerup=()=>{if(drag&&drag.kind!=='time'){range=null;renderAll();}drag=null;};
  cv.ondblclick=e=>{const [x,y]=pos(e);if(y<PADT-6)return;touch();sel=proCurveAddKey(c,k,T(x));range=null;renderAll();};
  const onKey=e=>{
    if(!cv.isConnected){document.removeEventListener('keydown',onKey,true);return;}
    if(e.target.closest&&e.target.closest('input,select,textarea'))return;
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();e.stopPropagation();delKey();}
    else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();sel=clamp(sel+(e.key==='ArrowLeft'?-1:1),0,arr().length-1);renderKey();draw();}
  };
  document.addEventListener('keydown',onKey,true);
  const ro=new ResizeObserver(()=>{size();draw();});ro.observe(cv);
  function close(){document.removeEventListener('keydown',onKey,true);ro.disconnect();closeOverlay();
    renderInspector();renderTimeline();requestDraw();}
  setOverlayDismiss(close);$('#cvX').onclick=close;$('#cvDone').onclick=close;
  $('#cvReset').onclick=()=>{touch();const a=_proKfArr(c,k);a.forEach(q=>{kfUnfrag(q);delete q.i;delete q.b;});range=null;renderAll();};
  size();renderAll();
  // (tests) where key #n is on screen right now
  const keyAt=n=>{const q=arr()[n],r=cv.getBoundingClientRect();if(!q)return null;if(!range)calcRange();
    return [r.left+X(q.t)*r.width/W,r.top+Y(q.v)*r.height/H];};
  return {close,keyAt,get key(){return k;},get sel(){return sel;}};
}
// Inspector: a "Curves…" button on the keyframe row
function proCurvesBind(c){
  const er=document.querySelector('#inspBody .kfEaseRow');if(!er||er.querySelector('#kfCurves'))return;
  const b=document.createElement('button');b.className='tbtn';b.id='kfCurves';b.textContent='Curves…';
  b.title='Open the curve editor: drag keys on a graph and choose how each move eases';
  b.onclick=()=>proCurvesOpen(c);er.appendChild(b);
}
