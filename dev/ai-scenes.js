
/* ---------- Frames for analysis ----------
   A DEDICATED hidden <video> per job (never the live preview element — see the
   handoff invariants). grab(t,w,h) seeks, waits until the sought frame is really
   presented (rVFC, as the exporter does), and returns a small canvas.
   AI.frameSource may be replaced (tests feed synthetic frames through it). */
function aiFrameGrabber(m){
  if(AI.frameSource)return AI.frameSource(m);
  const v=document.createElement('video');
  v.muted=true;v.preload='auto';v.playsInline=true;v.crossOrigin='anonymous';v.src=m.url;
  const cv=document.createElement('canvas'),g=cv.getContext('2d',{willReadFrequently:true});
  const ready=new Promise((res,rej)=>{
    if(v.readyState>=1)return res();
    v.addEventListener('loadedmetadata',()=>res(),{once:true});
    v.addEventListener('error',()=>rej(new Error('This video can’t be read for analysis')),{once:true});
    setTimeout(()=>res(),8000);
  });
  // After 'seeked', wait for the new frame to be presented when the browser
  // reports it (requestVideoFrameCallback). An element that isn't on screen
  // may never report frames; the first time that happens we stop asking, so
  // every later seek costs only the decode instead of a 250 ms timeout.
  let rvfc=typeof v.requestVideoFrameCallback==='function'?null:false;
  const seek=t=>new Promise(res=>{
    let done=false;const fin=()=>{if(done)return;done=true;v.removeEventListener('seeked',onS);res();};
    const onS=()=>{
      if(rvfc===false)return fin();
      try{v.requestVideoFrameCallback(()=>{if(!done){rvfc=true;fin();}});}catch(e){rvfc=false;return fin();}
      setTimeout(()=>{if(!done&&rvfc===null)rvfc=false;fin();},250);
    };
    v.addEventListener('seeked',onS);setTimeout(fin,2500);
    try{v.currentTime=clamp(t,0,Math.max(0,(v.duration||1e9)-0.001));}catch(e){fin();}
  });
  /* Play-through capture: one seek, then the video PLAYS (muted, sped up) and a
     frame is copied each time playback passes the next sample time. Seeking to
     every sample costs a keyframe decode each time; this decodes the stretch
     once, several times faster. Uses requestVideoFrameCallback for the exact
     presented frame time when the browser reports frames, else polls
     currentTime. Resolves {frames:[{t,cv}], exact} — `exact` false when the
     times came from polling (a frame may be a hair older than its time).
     Returns null when playback can't start, so callers fall back to grab(). */
  async function capture(times,w,h){
    await ready;if(!times.length)return {frames:[],exact:true};
    const host=document.body;v.style.cssText='position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    host.appendChild(v);
    const out=[];let k=0,exact=true,last=performance.now(),stop=false;
    const rate=Math.min(8,Math.max(1,(times[times.length-1]-times[0])/1.5));
    const take=(mt)=>{
      while(k<times.length&&mt>=times[k]-0.02){
        // one presented frame can stand for several close samples; copy once
        const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(v,0,0,w,h);
        out.push({t:mt,cv:c});k++;last=performance.now();
        while(k<times.length&&times[k]<=mt+0.02)k++;
      }
    };
    try{
      await seek(Math.max(0,times[0]-0.05));
      v.playbackRate=rate;v.defaultPlaybackRate=rate;
      try{await v.play();}catch(e){return null;}
      await new Promise(res=>{
        const end=()=>{if(stop)return;stop=true;try{v.pause();}catch(e){}res();};
        const useRvfc=typeof v.requestVideoFrameCallback==='function';
        let seen=false;
        const onFrame=(now,md)=>{if(stop)return;seen=true;take(md.mediaTime);if(k>=times.length||AI.cancelled)return end();v.requestVideoFrameCallback(onFrame);};
        if(useRvfc)v.requestVideoFrameCallback(onFrame);
        const poll=()=>{if(stop)return;
          if(!seen&&(!useRvfc||performance.now()-last>300)){exact=false;take(v.currentTime);}
          if(k>=times.length||v.ended||AI.cancelled||performance.now()-last>4000)return end();
          setTimeout(poll,15);};
        setTimeout(poll,15);
        v.addEventListener('ended',()=>{take(v.duration);end();},{once:true});
      });
    }finally{try{v.pause();v.playbackRate=1;v.defaultPlaybackRate=1;}catch(e){}v.remove();}
    return {frames:out,exact};
  }
  return {
    async grab(t,w,h){await ready;await seek(t);cv.width=w;cv.height=h;g.drawImage(v,0,0,w,h);return cv;},
    capture,
    duration:()=>v.duration||m.duration||0,
    close(){try{v.removeAttribute('src');v.load();}catch(e){}}
  };
}
// Frame signature: the pixels (RGB) plus a 4x4x4 color histogram.
function _aiFeat(cv,mask){
  const d=cv.getContext('2d',{willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data,n=d.length/4;
  const px=new Uint8Array(n*3),h=new Float32Array(64);let cnt=0;
  for(let i=0;i<n;i++){const r=d[i*4],g=d[i*4+1],b=d[i*4+2];px[i*3]=r;px[i*3+1]=g;px[i*3+2]=b;
    if(!mask||mask[i]){h[(r>>6)*16+(g>>6)*4+(b>>6)]++;cnt++;}}
  for(let k=0;k<64;k++)h[k]/=Math.max(1,cnt);
  return {px,h,mask};
}
// 0..1 change between two frames. A cut changes BOTH the pixels and the color
// distribution; a pan or a moving subject changes pixels but keeps the
// distribution, so the geometric mean stays low for motion.
function _aiPix(a,b){
  const m=a.mask;let s=0,n=0;
  for(let i=0;i<a.px.length;i+=3){if(m&&!m[i/3])continue;s+=Math.abs(a.px[i]-b.px[i])+Math.abs(a.px[i+1]-b.px[i+1])+Math.abs(a.px[i+2]-b.px[i+2]);n+=3;}
  return s/Math.max(1,n)/255;
}
function _aiDiff(a,b){
  const pix=Math.min(1,_aiPix(a,b)*3);
  let hd=0;for(let i=0;i<64;i++)hd+=Math.abs(a.h[i]-b.h[i]);hd*=0.5;
  return Math.sqrt(pix*hd);
}
// Picture area of letterboxed footage: pixels that are ever brighter than
// near-black. Static bars otherwise dilute every change (MEASURED: a vertical
// video's hard cuts scored like camera motion elsewhere).
function _aiPictureMask(cvs){
  const n=cvs[0].width*cvs[0].height,mx=new Uint8Array(n);
  for(const cv of cvs){const d=cv.getContext('2d',{willReadFrequently:true}).getImageData(0,0,cv.width,cv.height).data;
    for(let i=0;i<n;i++){const v=Math.max(d[i*4],d[i*4+1],d[i*4+2]);if(v>mx[i])mx[i]=v;}}
  const m=new Uint8Array(n);let on=0;for(let i=0;i<n;i++){m[i]=mx[i]>24?1:0;on+=m[i];}
  return on<n*0.2?null:m;
}
/* ---------- Scene detection ----------
   Scores follow FFmpeg's scene metric (0..1: how much of the picture changed,
   discounting steady motion) so one sensitivity scale serves both engines:
   the desktop app asks FFmpeg to score every frame in one fast decode; the
   browser samples 4 frames a second and binary-searches each candidate down to
   the exact frame. */
const _aiSceneCache={};   // mediaId -> {a,b,scores:[[t,s]...],engine}
function aiFilePathFor(m){
  const toPath=u=>{try{let p=decodeURIComponent(String(u).replace(/^file:\/\//,''));if(/^\/[A-Za-z]:/.test(p))p=p.slice(1);return p;}catch(e){return null;}};
  if(m.proxyPath&&/^file:/i.test(m.proxyPath))return {path:toPath(m.proxyPath),off:0};
  const p=_mediaPath(m);if(p)return {path:p,off:(m.trim&&+m.trim.start)||0};
  return null;
}
async function aiSceneScores(m,a,b,prog){
  const hit=_aiSceneCache[m.id];
  if(hit&&hit.a<=a+1e-6&&hit.b>=b-1e-6)return hit;
  let res=null;
  const fp=window.vibeNative&&vibeNative.sceneScores&&!AI.frameSource?aiFilePathFor(m):null;
  if(fp&&fp.path&&(await ffReady().catch(()=>false))){
    const jobId='scn'+uid();let off=null;
    const fpsGuess=m.srcFps||state.project.fps||30;
    if(vibeNative.onSceneProgress)off=vibeNative.onSceneProgress(d=>{if(!d||d.jobId!==jobId)return;
      const done=d.frames!=null?d.frames/fpsGuess:(d.t-fp.off-a);
      prog(clamp(done/Math.max(0.1,b-a),0,1),'Finding scene cuts \u2014 '+fmtDur(Math.max(0,done))+' of '+fmtDur(b-a));});
    AI.cancelHook=()=>vibeNative.cancelScenes&&vibeNative.cancelScenes(jobId);
    try{
      const r=await vibeNative.sceneScores({input:fp.path,start:fp.off+a,end:fp.off+b,jobId});
      if(AI.cancelled||(r&&r.cancelled))throw new Error('cancelled');
      if(r&&r.ok&&r.metric)res={a,b,engine:'ffmpeg',scores:r.scores.map(([t,s])=>[t-fp.off,s])};
    }finally{if(off)off();AI.cancelHook=null;}
  }
  if(!res)res=await aiSceneScoresBrowser(m,a,b,prog);
  _aiSceneCache[m.id]=res;return res;
}
async function aiSceneScoresBrowser(m,a,b,prog){
  const G=aiFrameGrabber(m),W=64,H=36,step=0.25;
  const fps=(m.srcFps||state.project.fps||30);
  try{
    // picture area from 24 frames spread across the clip
    const probe=[];for(let i=0;i<24;i++){const cv=await G.grab(a+(b-a)*(i+0.5)/24,W,H);const c2=document.createElement('canvas');c2.width=W;c2.height=H;c2.getContext('2d').drawImage(cv,0,0);probe.push(c2);}
    const mask=_aiPictureMask(probe);
    const times=[];for(let t=a;t<=b+1e-6;t+=step)times.push(Math.min(t,b));
    const Y=[];
    for(let i=0;i<times.length;i++){
      if(AI.cancelled)throw new Error('cancelled');
      if(i%8===0)prog(0.8*i/times.length,'Finding scene cuts — '+fmtDur(times[i]-a)+' of '+fmtDur(b-a));
      Y.push(_aiFeat(await G.grab(times[i],W,H),mask));
    }
    const raw=[0];for(let i=1;i<Y.length;i++)raw.push(_aiDiff(Y[i-1],Y[i]));
    // at 4 samples a second neighboring cuts are only a few samples apart, so the
    // background here is the 60th percentile of the window, not its runner-up
    // (tuned on the same six labelled videos; the one-frame 'share' test below
    // then removes the motion that a looser reference lets through)
    const prom=aiSceneProminence(raw,6,0.6);
    // refine each candidate to the exact frame by bisection
    const scores=[];let k=0;
    const cand=[];for(let i=1;i<Y.length;i++)if(prom[i]>=0.03&&raw[i]>=raw[i-1]&&(i+1>=raw.length||raw[i]>=raw[i+1]))cand.push(i);
    for(const i of cand){
      if(AI.cancelled)throw new Error('cancelled');
      prog(0.8+0.2*(k++)/Math.max(1,cand.length),'Pinning each cut to its exact frame…');
      let lo=times[i-1],hi=times[i],yl=Y[i-1],yh=Y[i];
      while(hi-lo>1/fps*1.01){
        const mid=Math.round(((lo+hi)/2)*fps)/fps;if(mid<=lo+1e-6||mid>=hi-1e-6)break;
        const ym=_aiFeat(await G.grab(mid,W,H),mask);
        if(_aiDiff(yl,ym)<=_aiDiff(ym,yh)){lo=mid;yl=ym;}else{hi=mid;yh=ym;}
      }
      // a real cut lands in ONE frame step; a fade or a fast move spreads the
      // change over the whole interval, so weigh by how much of it the final
      // step holds
      const share=Math.min(1,_aiDiff(yl,yh)/Math.max(1e-6,raw[i]));
      scores.push([hi,prom[i]*share]);
    }
    return {a,b,engine:'browser',kind:'cuts',scores};
  }finally{G.close();}
}
/* How far each score stands above its neighbors: s[i] minus the second-largest
   score within W steps either side (skipping the immediate neighbors). Cuts are
   isolated spikes; motion keeps producing similar values, so it cancels out.
   MEASURED on six real videos (60 hand-labelled cuts: films, a concert, a music
   video, a letterboxed vertical video): cuts >= 0.141, everything else <= 0.049. */
function aiSceneProminence(v,W,q){
  W=W||10;const out=new Float32Array(v.length);
  for(let i=0;i<v.length;i++){
    if(q!=null){
      const w=[];for(let j=Math.max(0,i-W);j<=Math.min(v.length-1,i+W);j++)if(Math.abs(j-i)>1)w.push(v[j]);
      w.sort((a,b)=>a-b);out[i]=v[i]-(w.length?w[Math.min(w.length-1,Math.floor(w.length*q))]:0);continue;
    }
    let m1=0,m2=0;
    for(let j=Math.max(0,i-W);j<=Math.min(v.length-1,i+W);j++){
      if(Math.abs(j-i)<=1)continue;const x=v[j];
      if(x>m1){m2=m1;m1=x;}else if(x>m2)m2=x;
    }
    out[i]=v[i]-m2;
  }
  return out;
}
// Sensitivity 0..100 -> prominence threshold 0.20 .. 0.04 (50 -> ~0.10, in the
// middle of the measured gap between cuts and motion).
function aiSceneThreshold(sens){return 0.04+Math.pow(1-clamp(sens,0,100)/100,1.5)*0.16;}
// Cut times from engine output; at least 0.4 s apart, strongest first.
function aiPickScenes(data,sensitivity){
  const thr=aiSceneThreshold(sensitivity);
  let c;
  if(data.kind==='cuts')c=data.scores.filter(x=>x[1]>=thr);
  else{
    const sc=data.scores,p=aiSceneProminence(sc.map(x=>x[1]),10);
    c=sc.map((x,i)=>[x[0],p[i]]).filter(x=>x[1]>=thr);
  }
  c.sort((x,y)=>y[1]-x[1]);const out=[];
  for(const [t] of c){if(out.every(o=>Math.abs(o-t)>=0.4))out.push(t);}
  return out.sort((x,y)=>x-y);
}
// Split clips at timeline times — a clip and its linked partners together, one
// undo step, links kept per piece (the same rule as the ripple cutter).
function aiSplitAt(clips,times,opts={}){
  const ts=[...new Set(times.map(aiFrameSnap))].sort((a,b)=>a-b);
  const set=new Set();clips.forEach(c=>linkedPartners(c.id).forEach(id=>set.add(id)));
  const targets=state.clips.filter(c=>set.has(c.id)&&!state.locked[c.track]);
  const cuts=ts.filter(t=>targets.some(c=>t>c.start+1e-3&&t<clipEnd(c)-1e-3));
  if(!cuts.length)return 0;
  if(!opts.noHistory)pushHistory();
  const linkMap={};let made=0;
  const others=state.clips.filter(c=>!targets.includes(c));
  const out=[...others];
  for(const c of targets){
    const pts=[c.start,...cuts.filter(t=>t>c.start+1e-3&&t<clipEnd(c)-1e-3),clipEnd(c)];
    for(let i=0;i<pts.length-1;i++){
      const p=aiClipSub(c,pts[i],pts[i+1]);if(i>0){p.id=uid();made++;}
      if(p.linkId&&i>0){const key=p.linkId+'|'+pts[i].toFixed(4);p.linkId=linkMap[key]||(linkMap[key]='lk'+uid());}
      out.push(p);
    }
  }
  state.clips=out;
  if(!opts.noRender){renderTimeline();renderInspector();requestDraw();}
  return cuts.length;
}
// The clip Detect scenes works on: the selected video clip, else the one under
// the playhead, else the only video clip on the timeline.
function aiPickVideoClip(){
  const sel=state.clips.find(x=>x.id===state.selection);
  if(sel&&sel.type==='video')return sel;
  const vids=state.clips.filter(x=>x.type==='video');
  const under=vids.filter(x=>state.time>=x.start&&state.time<clipEnd(x));
  if(under.length===1)return under[0];
  return vids.length===1?vids[0]:null;
}
async function aiScenesDialog(c){
  c=c&&c.type==='video'?c:aiPickVideoClip();
  if(!c){toast('Select the video clip to scan first');return;}
  const m=aiMediaOfClip(c);if(!m||m.missing){toast('This clip’s media is offline — relink it first','err');return;}
  const sp=(c.props.speed)||1,a=c.inPoint||0,b=a+c.duration*sp;
  const data=await aiRunJob('Detecting scenes',prog=>aiSceneScores(m,a,b,prog));
  if(!data)return;
  const toTl=src=>c.ramp?rampSrcToTl(c,src):c.props.reverse?c.start+(a+c.duration*sp-src)/sp:c.start+(src-a)/sp;
  let sens=+(localStorage.getItem('vibe-scene-sens')||50);
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal aimodal" style="width:min(600px,94vw)">
    <div class="modal-head"><div><h3>Scenes in “${esc(c.name)}”</h3>
      <div class="sub" id="scSub"></div></div>
      <button class="mclose" id="scX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="ctl" title="Higher finds subtler changes (and risks splitting on fast motion or flashes); lower keeps only hard cuts"><label>Sensitivity</label><input type="range" id="scSens" min="0" max="100" step="1" value="${sens}"><span class="val" id="scSensV"></span><span></span></div>
      <div class="sc-list" id="scList"></div>
    </div>
    <div class="modal-foot"><div class="note">${data.engine==='ffmpeg'?'Every frame was checked.':'Checked 4 times a second, then each cut pinned to its exact frame.'}</div>
      <button class="tbtn" id="scMark" title="Drop a marker at every cut — nothing is split; clips snap to markers">Add markers</button>
      <button class="tbtn primary" id="scSplit" title="Cut the clip (and its linked audio) into one clip per scene">Split into scenes</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#scX').onclick=closeOverlay;
  let cuts=[],thumbTok=0;
  const G=aiFrameGrabber(m);
  const refresh=async()=>{
    sens=+$('#scSens').value;$('#scSensV').textContent=sens+'%';
    try{localStorage.setItem('vibe-scene-sens',String(sens));}catch(e){}
    cuts=aiPickScenes(data,sens).filter(t=>t>a+1e-3&&t<b-1e-3);
    $('#scSub').textContent=(cuts.length+1)+' scene'+(cuts.length?'s':'')+' — '+cuts.length+' cut'+(cuts.length!==1?'s':'');
    $('#scSplit').disabled=$('#scMark').disabled=!cuts.length;
    const starts=[a,...cuts].slice(0,48),tok=++thumbTok;
    $('#scList').innerHTML=starts.map((t,i)=>`<div class="sc-thumb" data-i="${i}" title="Scene ${i+1} starts at ${fmtTC(toTl(t))} on the timeline"><img alt=""><span>${fmtDur(toTl(t))}</span></div>`).join('');
    for(let i=0;i<starts.length;i++){
      if(tok!==thumbTok||!$('#scList'))return;
      try{const cv=await G.grab(Math.min(b-0.01,starts[i]+0.05),160,90);if(tok!==thumbTok)return;
        const img=$(`#scList .sc-thumb[data-i="${i}"] img`);if(img)img.src=cv.toDataURL('image/jpeg',0.7);}catch(e){}
    }
  };
  $('#scSens').oninput=refresh;
  const finish=()=>{thumbTok++;G.close();closeOverlay();};
  setOverlayDismiss(finish);$('#scX').onclick=finish;
  $('#scMark').onclick=()=>{pushHistory();cuts.forEach(t=>addMarker(toTl(t),'scene'));state.markers.sort((x,y)=>x.t-y.t);finish();renderTimeline();
    toast(cuts.length+' scene marker'+(cuts.length>1?'s':'')+' added','ok');};
  $('#scSplit').onclick=()=>{const n=aiSplitAt([c],cuts.map(toTl));finish();
    toast(n?'Split into '+(n+1)+' scenes — Ctrl+Z to undo':'Nothing to split','ok');};
  refresh();
}
