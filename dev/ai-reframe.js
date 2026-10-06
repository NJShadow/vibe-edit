
/* ---------- Auto-reframe ----------
   Turns a landscape edit into vertical (9:16), portrait (4:5) or square (1:1)
   by keeping each shot's subject in frame. Faces come from MediaPipe's face
   detector, run locally (the model ships inside its npm package and loads from
   the same CDN as the speech engine, then is cached). The virtual camera
   follows editing convention:
     - within a shot, if the subject stays inside a comfortable zone the frame
       is LOCKED OFF (no motion at all) — the professional default;
     - only a subject that genuinely travels is followed, with a heavily
       smoothed path, so the camera glides instead of twitching;
     - at a cut inside a clip the frame JUMPS with the picture (found to the
       exact frame, like scene detection) instead of panning across the cut.
   No face in a shot: the frame holds center. Everything is ordinary x
   keyframes, so any shot can be adjusted by hand afterwards. */
const AI_FACE_LIB='https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229/';
const AI_REFRAME_TARGETS=[
  {id:'9x16',label:'Vertical 9:16',note:'Shorts, Reels, TikTok',w:1080,h:1920},
  {id:'4x5',label:'Portrait 4:5',note:'Instagram feed',w:1080,h:1350},
  {id:'1x1',label:'Square 1:1',note:'Feeds and ads',w:1080,h:1080},
];
let _aiFaceP=null;
function aiFaceDetector(){
  if(AI.faceDetector)return Promise.resolve(AI.faceDetector);    // tests may inject one
  if(_aiFaceP)return _aiFaceP;
  _aiFaceP=(async()=>{
    if(typeof FaceDetection==='undefined'){
      await new Promise((res,rej)=>{const s=document.createElement('script');s.src=AI_FACE_LIB+'face_detection.js';s.crossOrigin='anonymous';
        s.onload=res;s.onerror=()=>rej(new Error('Couldn’t download the face detector — the first run needs an internet connection'));document.head.appendChild(s);});
    }
    const fd=new FaceDetection({locateFile:f=>AI_FACE_LIB+f});
    fd.setOptions({model:'full',minDetectionConfidence:0.55});
    let last=null;fd.onResults(r=>{last=r;});
    await fd.initialize();
    return {async detect(img){last=null;await fd.send({image:img});
      return ((last&&last.detections)||[]).map(d=>{const b=d.boundingBox;return {x:b.xCenter,y:b.yCenter,w:b.width,h:b.height};});}};
  })().catch(e=>{_aiFaceP=null;throw e;});
  return _aiFaceP;
}
// How a clip must be scaled to COVER the canvas, and how far it can slide.
function aiCoverGeom(sw,sh,W,H){
  const fit=Math.min(W/sw,H/sh),cover=Math.max(W/sw,H/sh);
  const dw=sw*cover,dh=sh*cover;
  return {scale:cover/fit,dw,dh,maxX:(dw-W)/2/W*100,maxY:(dh-H)/2/H*100,cropW:W/dw,cropH:H/dh};
}
// Subject position (0..1 of the source) -> clip x/y (% of canvas), clamped so
// the picture always covers the frame.
function aiSubjectToXY(g,sx,sy,W,H){
  return {x:clamp(-(sx-0.5)*g.dw/W*100,-g.maxX,g.maxX),y:clamp(-(sy-0.5)*g.dh/H*100,-g.maxY,g.maxY)};
}
function _aiMedianFilt(v,r){return v.map((_,i)=>{const w=v.slice(Math.max(0,i-r),i+r+1).filter(x=>x!=null).sort((a,b)=>a-b);return w.length?w[w.length>>1]:null;});}
function _aiGauss(v,sigma){
  const r=Math.ceil(sigma*2.5),k=[];for(let i=-r;i<=r;i++)k.push(Math.exp(-i*i/(2*sigma*sigma)));
  return v.map((_,i)=>{let s=0,n=0;for(let j=-r;j<=r;j++){const q=v[i+j];if(q==null)continue;s+=q*k[j+r];n+=k[j+r];}return n?s/n:v[i];});
}
function _aiRdp(pts,eps){
  if(pts.length<3)return pts;
  const [a,b]=[pts[0],pts[pts.length-1]];let md=0,mi=0;
  for(let i=1;i<pts.length-1;i++){const t=(pts[i][0]-a[0])/Math.max(1e-9,b[0]-a[0]);const d=Math.abs(pts[i][1]-(a[1]+(b[1]-a[1])*t));if(d>md){md=d;mi=i;}}
  if(md<=eps)return [a,b];
  return _aiRdp(pts.slice(0,mi+1),eps).slice(0,-1).concat(_aiRdp(pts.slice(mi),eps));
}
/* Plan one shot's subject path from per-sample centers (source-normalized,
   null = no face). Returns [[t,sx]...] keys for that axis. crop = visible
   fraction of the source on that axis. */
function aiPlanShotPath(times,vals,crop){
  const have=vals.filter(v=>v!=null);
  if(!have.length)return [[times[0],0.5]];
  // fill gaps by holding the nearest seen value
  let lastV=have[0];const f=vals.map(v=>v==null?lastV:(lastV=v));
  const m=_aiMedianFilt(f,2);
  const sorted=m.slice().sort((a,b)=>a-b),p10=sorted[Math.floor(sorted.length*0.1)],p90=sorted[Math.floor(sorted.length*0.9)];
  // locked off when the subject stays within the middle ~45% of the frame
  if(p90-p10<=crop*0.45||times.length<3)return [[times[0],sorted[sorted.length>>1]]];
  const dt=(times[times.length-1]-times[0])/Math.max(1,times.length-1)||0.25;
  const sm=_aiGauss(m,Math.max(1,0.8/dt));
  return _aiRdp(times.map((t,i)=>[t,sm[i]]),crop*0.03);
}
async function aiAnalyzeReframe(c,prog){
  const m=aiMediaOfClip(c);if(!m)return null;
  const det=await aiFaceDetector();
  if(c.type==='image'){
    const img=m.el||null;let faces=[];
    if(img){try{faces=await det.detect(img);}catch(e){}}
    const f=faces.sort((a,b)=>b.w*b.h-a.w*a.h)[0];
    return {w:m.w||1920,h:m.h||1080,shots:[{t0:0,keysX:[[0,f?f.x:0.5]],keysY:[[0,f?f.y:0.5]]}]};
  }
  const sp=(c.props.speed)||1,a=c.inPoint||0,len=c.duration*sp,b=a+len;
  const rate=Math.min(4,Math.max(1,500/Math.max(1,len)));
  const G=aiFrameGrabber(m),sw=m.w||1920,sh=m.h||1080,GW=320,GH=Math.max(2,Math.round(320*sh/sw));
  const fps=m.srcFps||state.project.fps||30;
  try{
    const T=[],FACES=[],F=[];
    const n=Math.max(2,Math.ceil(len*rate)+1);
    const want=[];for(let i=0;i<n;i++)want.push(Math.min(b-0.001,a+i*len/(n-1)));
    const addFrame=async(t,cv)=>{
      const small=document.createElement('canvas');small.width=64;small.height=36;small.getContext('2d').drawImage(cv,0,0,64,36);
      let faces=[];try{faces=await det.detect(cv);}catch(e){}
      T.push(t);F.push(_aiFeat(small));FACES.push(faces);
    };
    let exact=true;
    // Frames arrive by playing the clip through in chunks (fast), with a seek
    // per sample as the fallback for anything playback didn't deliver.
    for(let i=0;i<n;){
      if(AI.cancelled)throw new Error('cancelled');
      prog&&prog(i/n,'Finding the subject in \u201c'+c.name+'\u201d \u2014 '+Math.round(i/n*100)+'%');
      const chunk=want.slice(i,i+40);
      let got=null;try{got=G.capture?await G.capture(chunk,GW,GH):null;}catch(e){got=null;}
      if(got&&got.frames.length){
        if(!got.exact)exact=false;
        for(const f of got.frames)await addFrame(f.t,f.cv);
        const lastT=got.frames[got.frames.length-1].t;
        while(i<n&&want[i]<=lastT+0.02)i++;
      }else{await addFrame(want[i],await G.grab(want[i],GW,GH));i++;}
    }
    // shot boundaries inside the clip, pinned to the exact frame
    const cuts=[];
    const rawD=[0];for(let i=1;i<T.length;i++)rawD.push(_aiDiff(F[i-1],F[i]));
    const promD=aiSceneProminence(rawD,6),thrD=aiSceneThreshold(50);
    for(let i=1;i<T.length;i++){
      if(promD[i]<thrD)continue;
      let lo=T[i-1],hi=T[i],yl=F[i-1],yh=F[i];
      if(!exact){   // polled frames may lag their time a little: widen and re-read the ends exactly
        lo=Math.max(a,lo-0.3);hi=Math.min(b-0.001,hi+0.3);
        yl=_aiFeat(await G.grab(lo,64,36));yh=_aiFeat(await G.grab(hi,64,36));
      }
      while(hi-lo>1/fps*1.01){
        const mid=Math.round(((lo+hi)/2)*fps)/fps;if(mid<=lo+1e-6||mid>=hi-1e-6)break;
        const cv=await G.grab(mid,64,36),ym=_aiFeat(cv);
        if(_aiDiff(yl,ym)<=_aiDiff(ym,yh)){lo=mid;yl=ym;}else{hi=mid;yh=ym;}
      }
      cuts.push({i,t:hi});
    }
    const bounds=[0,...cuts.map(q=>q.i),T.length];
    const X=new Array(T.length).fill(null),Y=new Array(T.length).fill(null);
    for(let k=0;k<bounds.length-1;k++)aiPickShotSubject(FACES,bounds[k],bounds[k+1],X,Y);
    const shots=[];
    const tgt=AI.reframeTarget||{w:1080,h:1920};
    const g=aiCoverGeom(sw,sh,tgt.w,tgt.h);
    for(let k=0;k<bounds.length-1;k++){
      const i0=bounds[k],i1=bounds[k+1],ts=T.slice(i0,i1);
      const t0=k===0?a:cuts[k-1].t;
      shots.push({t0,keysX:aiPlanShotPath(ts,X.slice(i0,i1),g.cropW),keysY:aiPlanShotPath(ts,Y.slice(i0,i1),g.cropH)});
    }
    return {w:sw,h:sh,shots,samples:{T,X,Y,faces:FACES.map(f=>f.length)},cuts:cuts.map(q=>q.t)};
  }finally{G.close();}
}
/* One subject per shot. Faces are chained into tracks across the shot's samples
   (nearest face within 0.12 of the frame); the track with the most presence x
   size wins, and only its positions steer the frame. Picking per sample can
   hop between people in a group shot, and the locked-off rule would then
   center on the average of two faces — the empty space between them.
   (Checked on real footage: a crowd scene, a split-screen phone call, a
   concert, a music video — the chosen face stays in frame.) */
function aiPickShotSubject(FACES,i0,i1,X,Y){
  const tracks=[];
  for(let i=i0;i<i1;i++){
    const used=new Set();
    for(const f of FACES[i]||[]){
      let best=null,bd=0.12;
      for(const tr of tracks){if(used.has(tr))continue;const l=tr.pts[tr.pts.length-1];if(i-l.i>8)continue;
        const d=Math.hypot(f.x-l.x,(f.y-l.y)*0.6);if(d<bd){bd=d;best=tr;}}
      if(!best){best={pts:[],score:0};tracks.push(best);}
      used.add(best);best.pts.push({i,x:f.x,y:f.y});best.score+=f.w*f.h;
    }
  }
  if(!tracks.length)return;
  const win=tracks.reduce((p,q)=>q.score>p.score?q:p);
  for(const p of win.pts){X[p.i]=p.x;Y[p.i]=p.y;}
}
// Write the plan onto the clip as x/y keyframes (clip-local time).
function aiApplyReframe(c,plan,W,H){
  const g=aiCoverGeom(plan.w,plan.h,W,H),sp=(c.props.speed)||1,a=c.inPoint||0,F=1/_aiFps();
  const toLocal=src=>c.ramp?rampSrcToTl(c,src)-c.start:c.props.reverse?(a+c.duration*sp-src)/sp:(src-a)/sp;
  c.props.scale=+g.scale.toFixed(4);
  c.kf=c.kf||{};delete c.kf.x;delete c.kf.y;delete c.kf.scale;
  const kx=[],ky=[];
  // Each shot's span and keys in CLIP-LOCAL (timeline) time, then laid down in
  // timeline order — on a reversed clip the last shot of the source plays first.
  const srcEnd=a+c.duration*sp;
  const shots=plan.shots.map((sh,si)=>{
    const u0=toLocal(sh.t0),u1=toLocal(si+1<plan.shots.length?plan.shots[si+1].t0:srcEnd);
    const loc=keys=>keys.map(k=>[toLocal(k[0]),k[1]]).sort((p,q)=>p[0]-q[0]);
    return {start:Math.max(0,Math.min(u0,u1)),kx:loc(sh.keysX),ky:loc(sh.keysY)};
  }).sort((p,q)=>p.start-q.start);
  shots.forEach((sh,si)=>{
    const add=(arr,keys,axis)=>{
      const xy=v=>axis==='x'?aiSubjectToXY(g,v,0.5,W,H).x:aiSubjectToXY(g,0.5,v,W,H).y;
      if(si>0){const t=sh.start;const before=arr.length?arr[arr.length-1].v:xy(keys[0][1]);
        if(t-F>0)arr.push({t:+(t-F).toFixed(4),v:before});arr.push({t:+t.toFixed(4),v:+xy(keys[0][1]).toFixed(3)});}
      else arr.push({t:0,v:+xy(keys[0][1]).toFixed(3)});
      for(let j=1;j<keys.length;j++)arr.push({t:+Math.max(sh.start,keys[j][0]).toFixed(4),v:+xy(keys[j][1]).toFixed(3)});
    };
    add(kx,sh.kx,'x');add(ky,sh.ky,'y');
  });
  const clean=arr=>{arr.sort((p,q)=>p.t-q.t);const out=[];for(const q of arr){if(q.t<0||q.t>c.duration+1e-6)continue;
    const l=out[out.length-1];if(l&&Math.abs(l.t-q.t)<1e-4)l.v=q.v;else out.push(q);}return out;};
  const X=clean(kx),Y=clean(ky);
  const moves=a=>a.length>1&&a.some(q=>Math.abs(q.v-a[0].v)>1e-3);
  if(moves(X))c.kf.x=X;else c.props.x=X.length?X[0].v:0;
  if(moves(Y))c.kf.y=Y;else c.props.y=Y.length?Y[0].v:0;
  if(!Object.keys(c.kf).length)delete c.kf;
  if(c.kf)c.kfEaseMode='linear';
}
async function aiReframeDialog(){
  const vids=state.clips.filter(c=>(c.type==='video'||c.type==='image')&&!state.locked[c.track]);
  if(!vids.length){toast('Put some video on the timeline first');return;}
  const sel=selectedIds().map(id=>state.clips.find(c=>c.id===id)).filter(c=>c&&vids.includes(c));
  let target=AI_REFRAME_TARGETS.find(t=>t.id===localStorage.getItem('vibe-reframe'))||AI_REFRAME_TARGETS[0];
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal aimodal" style="width:min(520px,94vw)">
    <div class="modal-head"><div><h3>Auto-reframe</h3><div class="sub">Re-cut a landscape video for vertical or square screens, keeping each shot’s subject in frame.</div></div>
      <button class="mclose" id="rfX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="ai-radio" id="rfT">${AI_REFRAME_TARGETS.map(t=>`<label title="Reframe to ${t.w}×${t.h} — ${t.note}"><input type="radio" name="rfT" value="${t.id}"${t===target?' checked':''}><span><b>${t.label} · ${t.w}×${t.h}</b><small>${t.note}</small></span></label>`).join('')}</div>
      <div class="ai-radio"><label title="${sel.length?'Reframe only the '+sel.length+' selected clip'+(sel.length>1?'s':'')+', leaving the rest as they are':'Select clips on the timeline to limit the reframe to them'}"><input type="checkbox" id="rfSel"${sel.length?'':' disabled'}><span><b>Only the selected clips</b><small>${sel.length?sel.length+' selected':'Otherwise every video and image clip is reframed'}</small></span></label></div>
      <p class="viznote">Each shot holds still unless the person really moves, and cuts inside a clip are followed exactly. The result is ordinary position keyframes — nudge any shot by hand afterwards. Replaces those clips’ existing position keyframes. The first run downloads a small face detector.</p>
    </div>
    <div class="modal-foot"><div class="note">One undo step. Titles and captions aren’t moved.</div><button class="tbtn primary" id="rfGo" title="Analyze the footage and reframe it">Reframe</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#rfX').onclick=closeOverlay;
  $('#rfGo').onclick=async()=>{
    target=AI_REFRAME_TARGETS.find(t=>t.id===(ov.querySelector('input[name=rfT]:checked')||{}).value)||target;
    try{localStorage.setItem('vibe-reframe',target.id);}catch(e){}
    const clips=($('#rfSel').checked?sel:vids);
    closeOverlay();
    AI.reframeTarget=target;
    const plans=await aiRunJob('Reframing',async prog=>{
      const out=[];
      for(let i=0;i<clips.length;i++){
        const p=await aiAnalyzeReframe(clips[i],(f,msg)=>prog((i+f)/clips.length,msg));
        out.push([clips[i],p]);
      }
      return out;
    });
    if(!plans)return;
    pushHistory();
    const pj=state.project;pj.w=target.w;pj.h=target.h;cv.width=pj.w;cv.height=pj.h;
    let n=0;for(const [c,p] of plans){if(p&&state.clips.includes(c)){aiApplyReframe(c,p,target.w,target.h);n++;}}
    syncProjectInputs();renderTimeline();renderInspector();requestDraw();
    const moving=plans.filter(([c])=>c.kf&&(c.kf.x||c.kf.y)).length;
    toast('Reframed '+n+' clip'+(n>1?'s':'')+' to '+target.label+(moving?' — '+moving+' follow a moving subject':'')+'. Ctrl+Z to undo','ok',5000);
  };
}
