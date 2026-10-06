/* ==================== PRO: FRAME BLENDING & MOTION BLUR (v4.9) ====================
   Smooth slow motion: when a clip plays its source slower than it was shot,
   each output frame mixes the two source frames it falls between, weighted by
   where it sits (instead of repeating frames).
   Motion blur: when a clip plays faster than it was shot, each output frame
   averages several source frames across a virtual shutter (0–360°), the way a
   camera would have blurred it.
   Both are computed in SOURCE space (the blended picture then goes through the
   clip's crop, transform, LUT and color like any frame), from a dedicated
   hidden video element per media that is seeked to exact frame centers.
   Exports (the Precise engine) render them on every frame; the preview shows
   them whenever playback is paused. */
const PRO_BLEND={maxW:1920,maxSamples:12};
// Which source frames (time, weight) make up clip c at timeline t, or null.
function proBlendPlan(c,t){
  if(c.type!=='video'||(c.freeze&&c.freezeAt!=null))return null;
  const p=c.props;if(!p.frameBlend&&!(p.motionBlur>0))return null;
  const m=state.media.find(x=>x.id===c.mediaId);if(!m)return null;
  if(!(m.srcFps>0)){_pbDetectFps(m);return null;}   // the source frame rate decides which frames to mix
  const fps=m.srcFps;
  const s=c.ramp&&typeof rampSpeedAt==='function'?rampSpeedAt(c,t):(p.speed||1);
  const src=srcTimeFor(c,t),dir=p.reverse?-1:1;
  if(p.frameBlend&&s<0.999){
    const f=src*fps-0.5,k=Math.floor(f),ph=f-k;
    if(ph<0.02)return [[(k+0.5)/fps,1]];
    if(ph>0.98)return [[(k+1.5)/fps,1]];
    return [[(k+0.5)/fps,1-ph],[(k+1.5)/fps,ph]];
  }
  if(p.motionBlur>0&&s>1.05){
    const pfps=state.project.fps||30,span=s*(p.motionBlur/360)/pfps;
    const K=Math.max(2,Math.min(PRO_BLEND.maxSamples,Math.round(span*fps)+1));
    const out=[];for(let i=0;i<K;i++){const x=src+dir*span*(i/(K-1)-0.5);out.push([(Math.round(x*fps-0.5)+0.5)/fps,1/K]);}
    // identical frames (a short span) merge their weights
    const mp=new Map();for(const [x,w] of out){const key=x.toFixed(5);mp.set(key,(mp.get(key)||0)+w);}
    return [...mp.entries()].map(([x,w])=>[+x,w]);
  }
  return null;
}
const _pbSamplers={};
// Source frame rate for media the desktop app hasn't probed (browser copy):
// play the sampler briefly and read the presented frames' media times.
const _pbFpsTried=new Set();
function _pbDetectFps(m){
  if(_pbFpsTried.has(m.id))return;_pbFpsTried.add(m.id);
  const S=_pbSampler(m.id);if(!S)return;
  S.chain=S.chain.then(async()=>{await S.ready;const v=S.v;if(typeof v.requestVideoFrameCallback!=='function'||!v.videoWidth)return;
    v.style.cssText='position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';document.body.appendChild(v);
    const ts=[];let stop=false;
    const cb=(now,md)=>{if(stop)return;ts.push(md.mediaTime);if(ts.length<14)v.requestVideoFrameCallback(cb);};
    try{v.currentTime=Math.min(1,(v.duration||2)/3);await new Promise(r=>{v.addEventListener('seeked',r,{once:true});setTimeout(r,1500);});
      v.requestVideoFrameCallback(cb);v.playbackRate=1;await v.play().catch(()=>{});
      await new Promise(r=>setTimeout(r,900));}
    finally{stop=true;try{v.pause();}catch(e){}v.remove();}
    const d=[];for(let i=1;i<ts.length;i++){const x=ts[i]-ts[i-1];if(x>0.004&&x<0.2)d.push(x);}
    if(d.length<3)return;d.sort((a,b)=>a-b);const fps=1/d[Math.floor(d.length/2)];
    const std=[23.976,24,25,29.97,30,47.952,48,50,59.94,60,100,119.88,120].find(f=>Math.abs(f-fps)/f<0.03);
    m.srcFps=std||+fps.toFixed(3);requestDraw();
  }).catch(()=>{});
}
function _pbSampler(mediaId){
  const el=els[mediaId];const url=el&&(el.currentSrc||el.src);if(!url)return null;
  let S=_pbSamplers[mediaId];
  if(S&&S.url!==url){try{S.v.removeAttribute('src');S.v.load();}catch(e){}S=null;}
  if(!S){const v=document.createElement('video');v.muted=true;v.preload='auto';v.playsInline=true;v.src=url;
    const ready=new Promise(res=>{if(v.readyState>=2)return res();v.addEventListener('loadeddata',()=>res(),{once:true});v.addEventListener('error',()=>res(),{once:true});setTimeout(res,8000);});
    S=_pbSamplers[mediaId]={url,v,ready,chain:Promise.resolve()};}
  return S;
}
// One source frame (as the element decodes it at that time) into a canvas.
function _pbGrab(S,time,cvs){
  return S.chain=S.chain.then(async()=>{
    await S.ready;const v=S.v;if(!v.videoWidth||v.readyState<1)return null;   // the sampler couldn't open this file
    await new Promise(res=>{let done=false;const fin=()=>{if(!done){done=true;v.removeEventListener('seeked',fin);res();}};
      v.addEventListener('seeked',fin);setTimeout(fin,3000);
      try{v.currentTime=clamp(time,0,Math.max(0,(v.duration||1e9)-0.001));}catch(e){fin();}});
    const W=v.videoWidth||1,H=v.videoHeight||1,k=Math.min(1,PRO_BLEND.maxW/W);
    const w=Math.round(W*k),h=Math.round(H*k);if(cvs.width!==w)cvs.width=w;if(cvs.height!==h)cvs.height=h;
    return {w,h};
  }).then(sz=>{if(!sz)return null;cvs.getContext('2d').drawImage(S.v,0,0,cvs.width,cvs.height);return sz;});
}
const _pbCache=new Map();   // key → {frame,w,h}
let _pbPending=new Set();
const _pbLatest={};   // clip id → the key it wants now (older background work is dropped)
function _pbKey(c,plan){const el=els[c.mediaId];return c.id+'|'+((el&&(el.currentSrc||el.src))||'')+'|'+plan.map(([x,w])=>x.toFixed(5)+':'+w.toFixed(4)).join(',');}
async function _pbCompute(c,plan,key){
  const S=_pbSampler(c.mediaId);if(!S)return null;
  const acc=document.createElement('canvas'),tmp=document.createElement('canvas');let sum=0,sz=null;
  for(const [x,w] of plan){
    if(key&&_pbLatest[c.id]!==key)return null;   // the playhead moved on
    sz=await _pbGrab(S,x,tmp);if(!sz)return null;
    if(acc.width!==tmp.width||acc.height!==tmp.height){acc.width=tmp.width;acc.height=tmp.height;}
    sum+=w;const g=acc.getContext('2d');g.globalAlpha=w/sum;g.drawImage(tmp,0,0);g.globalAlpha=1;   // running weighted average
  }
  return sz?{frame:acc,w:acc.width,h:acc.height}:null;
}
function _pbStore(key,v){_pbCache.set(key,v);while(_pbCache.size>24)_pbCache.delete(_pbCache.keys().next().value);}
// Called by the compositor for each video clip: the blended source frame, if ready.
function proBlendFrame(c,t){
  const plan=proBlendPlan(c,t);if(!plan||plan.length<2)return null;
  const key=_pbKey(c,plan),hit=_pbCache.get(key);if(hit)return hit;
  if(state.playing||state.exporting||_pbPending.has(key))return null;
  _pbPending.add(key);_pbLatest[c.id]=key;   // paused: work it out in the background, then redraw
  _pbCompute(c,plan,key).then(v=>{_pbPending.delete(key);if(v){_pbStore(key,v);requestDraw();}}).catch(()=>_pbPending.delete(key));
  return null;
}
// Precise export: make every blended frame for time t before the frame is drawn.
async function proBlendPrepare(t){
  const L=(typeof _playClips==='function'?_playClips():state.clips).filter(c=>c.type==='video'&&t>=c.start&&t<clipEnd(c));
  for(const c of L){const plan=proBlendPlan(c,t);if(!plan||plan.length<2)continue;
    const key=_pbKey(c,plan);if(_pbCache.has(key))continue;const v=await _pbCompute(c,plan);if(v)_pbStore(key,v);}
}
function proBlendUsed(){return (typeof _playClips==='function'?_playClips():state.clips).some(c=>c.type==='video'&&(c.props.frameBlend||c.props.motionBlur>0));}
function proBlendDrop(id){const S=_pbSamplers[id];if(S){try{S.v.removeAttribute('src');S.v.load();S.v.remove();}catch(e){}delete _pbSamplers[id];}
  for(const k of [..._pbCache.keys()])if(k.includes('|'))_pbCache.delete(k);}
function proBlendReset(){for(const id in _pbSamplers)proBlendDrop(id);_pbCache.clear();_pbPending.clear();_pbFpsTried.clear();for(const k in _pbLatest)delete _pbLatest[k];}
