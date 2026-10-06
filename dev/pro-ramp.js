/* ==================== PRO: SPEED RAMPS (v4.8) ====================
   A clip's speed can follow a curve — fast into a slow-motion moment and back
   out, a flash at the start, a jump in the middle. The math (c.ramp, the
   progress table, srcTimeFor/rampSrcToTl) lives in the core next to
   srcTimeFor; this block is the presets, the curve editor in the inspector,
   the sound (rendered straight onto the timeline, pitch-preserved or
   record-style), and the timeline badge.
   Editing a ramp keeps the clip's SOURCE the same and changes its length,
   like the speed slider does. */
const PRO_RAMPS=[
  {id:'montage',n:'Montage',d:'Fast, slow, fast, slow — energetic cuts',pts:[[0,2.4],[0.22,0.6],[0.45,2.4],[0.7,0.6],[1,2.2]]},
  {id:'hero',n:'Hero moment',d:'Normal speed, a slow-motion moment, then back — centered on the playhead when it’s over the clip',pts:[[0,1.4],[0.36,1.4],[0.5,0.25],[0.64,1.4],[1,1.4]],center:true},
  {id:'bullet',n:'Bullet time',d:'Races in, nearly freezes, races out — centered on the playhead when it’s over the clip',pts:[[0,3],[0.38,3],[0.5,0.12],[0.62,3],[1,3]],center:true},
  {id:'flashIn',n:'Flash in',d:'Starts very fast and settles to normal speed',pts:[[0,5],[0.35,1],[1,1]]},
  {id:'flashOut',n:'Flash out',d:'Normal speed that speeds away at the end',pts:[[0,1],[0.65,1],[1,5]]},
  {id:'jump',n:'Jump',d:'A sudden burst of speed in the middle — centered on the playhead when it’s over the clip',pts:[[0,0.9],[0.44,0.9],[0.5,6],[0.56,0.9],[1,0.9]],center:true},
];
const PRO_RAMP_MIN=0.1,PRO_RAMP_MAX=10;
function proRampCanUse(c){return !!c&&(c.type==='video'||c.type==='audio')&&!(c.freeze&&c.freezeAt!=null);}
// Change a ramp while keeping the clip's source span: its length follows.
function proRampEdit(c,fn){
  const span=c.duration*(c.props.speed||1);
  fn();
  if(!c.ramp)return;
  for(const q of c.ramp.pts){q[0]=clamp(q[0],0,1);q[1]=clamp(q[1],PRO_RAMP_MIN,PRO_RAMP_MAX);}
  c.ramp.pts.sort((a,b)=>a[0]-b[0]);
  const T=rampTable(c).T[RAMP_N];
  c.props.speed=1/T;c.duration=Math.max(0.05,span*T);
}
// A split piece plays a window of its curve; hand edits start from a fresh
// curve that looks the same over the piece.
function _proRampWindowed(c){const w=c.ramp.w;return !!w&&(w[0]!==0||w[1]!==1);}
function _proRampPts(c){   // the points as this clip sees them (0..1 over its own window)
  const r=c.ramp,w=r.w||[0,1];if(!_proRampWindowed(c))return r.pts;
  const pts=[[0,rampS(r.pts,w[0])]];
  for(const q of r.pts)if(q[0]>w[0]+1e-6&&q[0]<w[1]-1e-6)pts.push([(q[0]-w[0])/(w[1]-w[0]),q[1]]);
  pts.push([1,rampS(r.pts,w[1])]);
  return pts.map(q=>[+q[0].toFixed(4),+q[1].toFixed(4)]);
}
function _proRampBake(c){if(_proRampWindowed(c))c.ramp={pts:_proRampPts(c)};}
function proRampApply(c,id){
  if(!proRampCanUse(c))return false;
  const P=PRO_RAMPS.find(x=>x.id===id);
  proRampLinked(c,()=>proRampEdit(c,()=>{
    if(!P){delete c.ramp;return;}
    let pts=P.pts.map(q=>q.slice());
    // centered presets put their slow (or fast) moment at the playhead
    const lt=state.time-c.start;
    if(P.center&&lt>c.duration*0.08&&lt<c.duration*0.92){
      const q0=c.ramp?(rampPAt(c,lt/c.duration)):lt/c.duration,m=clamp(q0,0.2,0.8);
      pts=pts.map(([q,s])=>[q<=0.5?q/0.5*m:m+(q-0.5)/0.5*(1-m),s]);
    }
    const sp=c.props.speed||1;             // presets are shapes around the clip's current speed
    c.ramp={pts:pts.map(([q,s])=>[+q.toFixed(4),+(s*sp).toFixed(4)]),preset:P.id};
  }));
  return true;
}
function proRampRemove(c){proRampLinked(c,()=>{delete c.ramp;});}   // the average speed stays, so the length is unchanged

// Linked picture + sound (merge-sync, Ctrl+L) covering the same span carry the
// same ramp — otherwise the sound drifts from the picture as soon as the curve
// differs. Partners are found BEFORE the change (same start, length, speed and
// direction), then get an exact copy of the result. The caller's pushHistory
// covers them: one undo step.
function _proRampPartners(c){
  if(typeof _linkedSpeedPartners!=='function')return [];
  const sp=c.props.speed||1;
  return _linkedSpeedPartners(c).filter(x=>proRampCanUse(x)&&Math.abs(x.start-c.start)<1e-3&&Math.abs(x.duration-c.duration)<1e-3
    &&Math.abs((x.props.speed||1)-sp)<1e-6&&!!x.props.reverse===!!c.props.reverse);
}
// Every ramp change (presets, remove, curve drags) passes through here, so it is
// also where keyframes are re-timed to stay on their source moments (v4.10.2 —
// kfSpeedSnap/kfSpeedRetime in the core; removing a ramp keeps the length but
// moves every source moment, so its keys move too).
function proRampLinked(c,fn){
  const xs=_proRampPartners(c),all=[c,...xs],snaps=all.map(x=>kfSpeedSnap(x));
  const r=fn();
  for(const x of xs){
    if(c.ramp)x.ramp=JSON.parse(JSON.stringify(c.ramp));else delete x.ramp;   // (the cached table is not copied)
    x.props.speed=c.props.speed;x.duration=c.duration;x.start=c.start;
  }
  all.forEach((x,i)=>kfSpeedRetime(x,snaps[i]));
  return r;
}

// ---------- sound ----------
// The clip's audio laid straight onto the timeline: for every output sample the
// source time comes from the same mapping the picture uses. Pitch-preserved
// uses WSOLA with the analysis position taken from that mapping (never
// accumulated, so it cannot drift); record-style resamples directly.
function proRampBuffer(ctx,c,buf){
  const SR=buf.sampleRate,n=Math.max(1,Math.round(c.duration*SR)),chs=buf.numberOfChannels;
  const out=ctx.createBuffer(chs,n,SR);
  const G=64,M=new Float64Array(Math.ceil(n/G)+2);   // source sample at every 64th output sample
  for(let j=0;j<M.length;j++)M[j]=rampTlToSrc(c,c.start+Math.min(n,j*G)/SR)*SR;
  const at=i=>{const f=i/G,j=Math.min(M.length-2,Math.floor(f));return M[j]+(M[j+1]-M[j])*(f-j);};
  const preserve=c.props.preservePitch!==false&&!c.props.reverse;
  for(let ch=0;ch<chs;ch++){
    const inp=buf.getChannelData(ch),o=out.getChannelData(ch),L=inp.length;
    if(!preserve){
      for(let i=0;i<n;i++){const x=at(i),k=Math.floor(x);if(k<0||k+1>=L)continue;const f=x-k;o[i]=inp[k]*(1-f)+inp[k+1]*f;}
      continue;
    }
    const frame=Math.round(SR*0.06),ov=Math.round(frame*0.5),hop=frame-ov,seek=Math.round(SR*0.01);
    const win=new Float32Array(frame);for(let i=0;i<frame;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(frame-1));
    const norm=new Float32Array(n);let prev=-1;
    for(let syn=0;syn<n;syn+=hop){
      let ana=Math.round(at(syn)),best=0;
      if(prev>=0){let bd=-Infinity;const tail=prev+hop;
        for(let d=-seek;d<=seek;d++){const a=ana+d;if(a<0||a+ov>=L||tail+ov>=L)continue;let dot=0;for(let i=0;i<ov;i+=2)dot+=inp[a+i]*inp[tail+i];if(dot>bd){bd=dot;best=d;}}}
      const st=Math.max(0,ana+best);
      for(let i=0;i<frame;i++){const si=st+i,oi=syn+i;if(si>=L||oi>=n)break;o[oi]+=inp[si]*win[i];norm[oi]+=win[i];}
      prev=st;
    }
    for(let i=0;i<n;i++)if(norm[i]>1e-6)o[i]/=norm[i];
  }
  return out;
}

// ---------- timeline badge ----------
function proRampDecorate(c,d){
  const w=Math.max(8,c.duration*state.pps);if(w<40)return;
  const N=Math.min(120,Math.round(w/4)),h=14,ls=v=>Math.log(v);
  const lo=ls(PRO_RAMP_MIN),hi=ls(PRO_RAMP_MAX);
  const P=[];for(let i=0;i<=N;i++){const s=rampSpeedAt(c,c.start+c.duration*i/N);P.push((i/N*100).toFixed(2)+','+(h-1-(ls(clamp(s,PRO_RAMP_MIN,PRO_RAMP_MAX))-lo)/(hi-lo)*(h-2)).toFixed(2));}
  d.insertAdjacentHTML('beforeend',`<svg class="ramp-line" viewBox="0 0 100 ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${P.join(' ')}"/></svg>`);
  const nm=d.querySelector('.cname');if(nm)nm.insertAdjacentHTML('afterbegin','<span class="ramp-tag" title="Speed ramp">⇝</span>');
}

// ---------- inspector ----------
function _proRampIcon(pts){
  const ls=Math.log,lo=ls(PRO_RAMP_MIN),hi=ls(PRO_RAMP_MAX),P=[];
  for(let i=0;i<=24;i++){const s=rampS(pts,i/24);P.push((2+i)+','+(17-(ls(s)-lo)/(hi-lo)*15).toFixed(1));}
  return `<svg viewBox="0 0 28 20" class="cv-ico"><polyline points="${P.join(' ')}"/></svg>`;
}
function proRampSectionHTML(c,p){
  if(!proRampCanUse(c))return '';
  const r=c.ramp,span=c.duration*(p.speed||1);
  return `<div class="sec"><h4>Speed ramp${r?' <span class="reset" data-rampreset="1" title="Remove the ramp (the clip keeps its average speed)">reset</span>':''}</h4>
    <div class="ramp-presets">
      <button class="cv-type${r?'':' on'}" id="rampNone" title="Constant speed (the Speed slider above)">${_proRampIcon([[0,1],[1,1]])}<span>None</span></button>
      ${PRO_RAMPS.map(P=>`<button class="cv-type${r&&r.preset===P.id?' on':''}" id="ramp_${P.id}" data-ramp="${P.id}" title="${P.d}">${_proRampIcon(P.pts)}<span>${P.n}</span></button>`).join('')}
    </div>
    ${r?`<canvas id="rampGraph" class="ramp-graph" title="Drag a point up for faster, down for slower, or sideways to move it. Double-click to add a point; right-click a point to remove it."></canvas>
    <div class="lut-note" id="rampNote">Plays ${span.toFixed(2)} s of the source in ${c.duration.toFixed(2)} s (average ${(p.speed||1).toFixed(2)}×). Drag points to shape it; double-click adds one.</div>`
    :`<div class="lut-note">Pick a shape to vary the speed over the clip. The source stays the same; the clip gets longer or shorter.</div>`}
    ${c.type==='video'?`<div class="gsub">Smoothing</div>
    <label class="ckrow ramp-ck" title="When this clip plays slower than it was shot, mix neighboring frames instead of repeating them — smoother slow motion"><input type="checkbox" id="pFrameBlend" ${p.frameBlend?'checked':''}> Smooth slow motion (frame blending)</label>
    ${slider('motionBlur','Motion blur',p.motionBlur||0,0,360,15,v=>v+'°')}
    <div class="lut-note">Motion blur applies where the clip plays faster than it was shot (like a camera shutter: 180° is natural). Both show in the preview when paused and in Precise exports.</div>`:''}
  </div>`;
}
function proRampBind(c){
  const host=document.getElementById('inspBody');if(!host)return;
  const done=()=>{renderTimeline();renderInspector();requestDraw();syncMediaPlayback();};
  host.querySelectorAll('[data-ramp]').forEach(b=>b.onclick=()=>{pushHistory();proRampApply(c,b.dataset.ramp);done();});
  const none=document.getElementById('rampNone');if(none)none.onclick=()=>{if(!c.ramp)return;pushHistory();proRampRemove(c);done();};
  const rs=host.querySelector('[data-rampreset]');if(rs)rs.onclick=()=>{pushHistory();proRampRemove(c);done();};
  const fb=document.getElementById('pFrameBlend');if(fb)fb.onchange=()=>{pushHistory();c.props.frameBlend=fb.checked;requestDraw();};
  const cv=document.getElementById('rampGraph');if(!cv||!c.ramp)return;
  const g=cv.getContext('2d'),PAD=[40,8,8,14];   // left, right, top, bottom
  let W=0,H=0,drag=null;
  const lo=Math.log(PRO_RAMP_MIN),hi=Math.log(PRO_RAMP_MAX);
  const X=q=>PAD[0]+q*(W-PAD[0]-PAD[1]),Q=x=>clamp((x-PAD[0])/(W-PAD[0]-PAD[1]),0,1);
  const Y=s=>PAD[2]+(1-(Math.log(s)-lo)/(hi-lo))*(H-PAD[2]-PAD[3]),S=y=>Math.exp(lo+(1-(y-PAD[2])/(H-PAD[2]-PAD[3]))*(hi-lo));
  const css=n=>getComputedStyle(document.body).getPropertyValue(n).trim();
  // layout size: getBoundingClientRect is scaled while the dialog's opening animation runs
  const size=()=>{const d=window.devicePixelRatio||1;W=Math.max(120,cv.clientWidth);H=Math.max(80,cv.clientHeight);cv.width=Math.round(W*d);cv.height=Math.round(H*d);g.setTransform(d,0,0,d,0,0);};
  const draw=()=>{
    if(!cv.isConnected||!c.ramp)return;
    const r=c.ramp,w=r.w||[0,1],acc=css('--accent')||'#7c6cff',mu=css('--faint')||'#777',bd=css('--border')||'#333';
    g.clearRect(0,0,W,H);g.font='9.5px system-ui,sans-serif';g.textAlign='right';g.lineWidth=1;
    for(const s of [0.25,1,4]){const y=Y(s);g.strokeStyle=bd;g.setLineDash(s===1?[]:[3,3]);g.beginPath();g.moveTo(PAD[0],y);g.lineTo(W-PAD[1],y);g.stroke();g.fillStyle=mu;g.fillText(s+'×',PAD[0]-4,y+3);}
    g.setLineDash([]);
    // playhead (as progress through the source)
    const lt=state.time-c.start;
    if(lt>=0&&lt<=c.duration){const q=rampPAt(c,lt/c.duration);g.strokeStyle=css('--danger')||'#e55';g.beginPath();g.moveTo(X(q),PAD[2]);g.lineTo(X(q),H-PAD[3]);g.stroke();}
    // the curve this clip plays, over its own length (a split piece plays a window of its curve)
    g.strokeStyle=acc;g.lineWidth=2;g.beginPath();
    for(let x=PAD[0];x<=W-PAD[1];x++){const s=rampS(r.pts,w[0]+(w[1]-w[0])*Q(x));x===PAD[0]?g.moveTo(x,Y(s)):g.lineTo(x,Y(s));}
    g.stroke();g.lineWidth=1;
    _proRampPts(c).forEach((q,n)=>{g.fillStyle=drag&&drag.n===n?acc:css('--text')||'#ddd';g.strokeStyle=acc;g.beginPath();g.arc(X(q[0]),Y(q[1]),4.5,0,7);g.fill();g.stroke();});
    const note=document.getElementById('rampNote');
    if(note)note.textContent=`Plays ${(c.duration*(c.props.speed||1)).toFixed(2)} s of the source in ${c.duration.toFixed(2)} s (average ${(c.props.speed||1).toFixed(2)}×)${drag&&drag.n!=null?' · point: '+c.ramp.pts[drag.n][1].toFixed(2)+'×':''}.`;
  };
  // screen → drawing coordinates. Re-measure first: the ResizeObserver callback can
  // lag a click that lands while the section or inspector column is still animating
  // open, and a stale W/H misplaces every point. Border excluded (clientLeft/Top).
  const pos=e=>{if(cv.clientWidth&&(Math.max(120,cv.clientWidth)!==W||Math.max(80,cv.clientHeight)!==H)){size();draw();}
    const r=cv.getBoundingClientRect(),k=r.width/Math.max(1,cv.offsetWidth||r.width);   // k: any CSS scale (opening animation)
    return [(e.clientX-r.left-cv.clientLeft*k)*W/Math.max(1,cv.clientWidth*k),(e.clientY-r.top-cv.clientTop*k)*H/Math.max(1,cv.clientHeight*k)];};
  const hit=(x,y)=>_proRampPts(c).findIndex(q=>Math.hypot(X(q[0])-x,Y(q[1])-y)<8);
  let pushed=false,tl=0;
  const edit=fn=>{if(!pushed){pushHistory();pushed=true;}proRampLinked(c,()=>{_proRampBake(c);delete c.ramp.preset;proRampEdit(c,fn);});requestDraw();
    const now=performance.now();if(now-tl>80){tl=now;renderTimeline();}};
  cv.onpointerdown=e=>{if(e.button!==0)return;const [x,y]=pos(e),n=hit(x,y);if(n<0)return;pushed=false;
    drag={n};cv.setPointerCapture(e.pointerId);draw();};
  cv.onpointermove=e=>{if(!drag)return;const [x,y]=pos(e),n=drag.n;
    edit(()=>{const pts=c.ramp.pts,last=pts.length-1,P=pts[n];
      if(n>0&&n<last)P[0]=+clamp(Q(x),pts[n-1][0]+0.02,pts[n+1][0]-0.02).toFixed(4);
      P[1]=+clamp(Math.abs(S(y)-1)<0.04?1:S(y),PRO_RAMP_MIN,PRO_RAMP_MAX).toFixed(3);});   // snaps to 1×
    draw();};
  cv.onpointerup=()=>{if(drag){drag=null;renderTimeline();renderInspector();syncMediaPlayback();}};
  cv.ondblclick=e=>{const [x,y]=pos(e),q=Q(x);if(hit(x,y)>=0||_proRampPts(c).some(p=>Math.abs(p[0]-q)<0.02))return;pushed=false;
    edit(()=>{c.ramp.pts.push([+q.toFixed(4),+rampS(c.ramp.pts,q).toFixed(3)]);});
    renderTimeline();renderInspector();};
  cv.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();const [x,y]=pos(e),n=hit(x,y);
    if(n<=0||n>=_proRampPts(c).length-1)return;pushed=false;edit(()=>c.ramp.pts.splice(n,1));renderTimeline();renderInspector();};
  const ro=new ResizeObserver(()=>{if(!cv.isConnected){ro.disconnect();return;}size();draw();});ro.observe(cv);
  size();draw();
}
