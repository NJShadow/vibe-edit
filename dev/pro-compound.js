/* ==================== PRO: COMPOUND CLIPS (v4.7) ====================
   Select clips → Make compound clip: they become ONE clip on the timeline
   (move it, trim it, split it, fade it, scale it, like any clip) that still
   holds the original clips, editable inside at any time (double-click it).

   Model: c.type='compound', c.inner={clips:[…]} with the inner clips on their
   own tracks, in the compound's own time (0 = its first frame). c.inPoint /
   c.duration are the window of that inner time shown on the outer timeline.

   Rendering: the inner clips are composited into an offscreen frame by the
   SAME compositor (recursively — a compound may hold compounds), and that
   frame is drawn with the compound's position/scale/rotation/opacity/look.
   Playback and export: everything that plays media or mixes sound reads
   playClips() — the timeline with each compound replaced by virtual copies
   of its inner clips, shifted to outer time, trimmed to the window, on the
   compound's track (so muting that track mutes it) at the compound's volume.

   Editing inside swaps the inner clips in as the timeline (with their own
   undo history) and puts a breadcrumb over the timeline; Back folds them
   into the compound again as ONE undo step on the outer timeline. */
let _cmpDepth=0;
// Bumped whenever the CONTENT inside any compound may have changed (make, break,
// close after editing inside, undo/redo, load). Caches key on it.
let _cmpRev=0,_pcKey=null,_pcVal=null;
function proCmpTouched(){_cmpRev++;_pcKey=null;_cmpVCache.clear();}
const _cmpVCache=new Map();   // key -> virtual list (drawing)
try{CLIPGRAD.compound=['--clip-c','--clip-c2'];DOTC.compound='var(--clip-c)';}catch(e){}
const _cmpCanvases=[];
function _cmpInnerDur(c){const L=(c.inner&&c.inner.clips)||[];return L.reduce((m,x)=>Math.max(m,clipEnd(x)),0);}
// Virtual copies of a compound's inner clips on the OUTER timeline.
// forPlay: put them on the compound's track and fold its volume/mute in.
function _cmpKey(c){const P=c.props||{};return [c.id,c.start,c.duration,c.inPoint,c.track,P.volume,P.muteClip,P.fadeIn,P.fadeOut,P.speed,P.reverse,P.preservePitch,P.frameBlend,P.motionBlur,JSON.stringify((c.kf&&c.kf.volume)||0)].join(',');}
// v4.9: speed and reverse on a compound. The inner timeline window is
// [inPoint, inPoint + duration*speed]; each inner clip is re-timed onto the
// outer timeline so that what plays at outer t is exactly the inner timeline
// at inPoint + (t-start)*speed (or mirrored when reversed) — picture, keyframes,
// fades, text animation and sound alike.
const _CMP_EASE_MIRROR={in:'out',out:'in'};
function _cmpMirrorKeys(arr,dur,s,mode){
  // keys at local t → (dur-t)/s, in reverse order; each segment's easing mirrored
  const n=arr.length,out=[];
  for(let j=n-1;j>=0;j--){
    const q=arr[j],k={t:+((dur-q.t)/s).toFixed(6),v:q.v};
    const A=arr[j-1];   // the ORIGINAL segment A→q now runs q→A
    if(A){const base=A.e||{u0:0,u1:1,v0:A.v,v1:q.v,i:A.i,b:A.b},m=base.i;
      if((m||mode)==='hold'){k.i='hold';out.push(k);out.push({t:+(k.t+1e-4).toFixed(6),v:A.v,i:'hold'});continue;}   // held: the jump is now at the start
      if(A.e||m){const e={u0:1-base.u1,u1:1-base.u0,v0:base.v1,v1:base.v0};
        if(m){e.i=_CMP_EASE_MIRROR[m]||m;if(m==='bezier'&&base.b){const b=base.b;e.b=[1-b[2],1-b[3],1-b[0],1-b[1]];}}
        k.e=e;}
    }
    out.push(k);
  }
  return out;
}
function _cmpRetime(v,r0,W,s,rev,cmpStart){
  const d0=v.duration;
  v.start=cmpStart+(rev?(W-(r0+d0)):r0)/s;v.duration=d0/s;
  const P=v.props;
  if(v.type==='compound'){P.speed=(P.speed||1)*s;if(rev)P.reverse=!P.reverse;}
  else if(v.type==='video'||v.type==='audio'){
    if(!(v.freeze&&v.freezeAt!=null)){P.speed=(P.speed||1)*s;if(rev)P.reverse=!P.reverse;}
    if(v.ramp){v.ramp.pts=v.ramp.pts.map(q=>[rev?1-q[0]:q[0],q[1]*s]);if(rev){v.ramp.pts.reverse();const w=v.ramp.w||[0,1];v.ramp.w=[1-w[1],1-w[0]];}}
  }
  if(v.stab&&v.stab.fps){const st=v.stab;st.tk=(st.tk||1)*s;if(rev){st.rev=!st.rev;st.revLen=v.duration;}else if(st.rev)st.revLen/=s;}   // older stabilization data (no st.st) indexes by clip time: keep it on the same moments (fps stays the analysis rate); data with st.st indexes by source time and needs nothing
  if(v.kf)for(const k in v.kf){v.kf[k]=rev?_cmpMirrorKeys(v.kf[k],d0,s,v.kfEaseMode||'smooth'):v.kf[k].map(q=>Object.assign({},q,{t:q.t/s}));}
  if(P.fadeIn)P.fadeIn/=s;if(P.fadeOut)P.fadeOut/=s;
  if(P.transInDur)P.transInDur/=s;if(P.transOutDur)P.transOutDur/=s;
  if(v.text){if(v.text.animInDur)v.text.animInDur/=s;if(v.text.animOutDur)v.text.animOutDur/=s;}
  if(rev){[P.fadeIn,P.fadeOut]=[P.fadeOut,P.fadeIn];[P.transIn,P.transOut]=[P.transOut,P.transIn];[P.transInDur,P.transOutDur]=[P.transOutDur,P.transInDur];
    if(v.text){[v.text.animIn,v.text.animOut]=[v.text.animOut,v.text.animIn];[v.text.animInDur,v.text.animOutDur]=[v.text.animOutDur,v.text.animInDur];}}
  return v;
}
// What a compound's own timing settings mean for the clips inside it: Preserve
// pitch off and the smoothing (frame blending / motion blur) apply to them too.
function _cmpInherit(cmp,v){
  const P=cmp.props||{},q=v.props;
  if(P.preservePitch===false&&(v.type==='video'||v.type==='audio'||v.type==='compound'))q.preservePitch=false;
  if(v.type==='video'||v.type==='compound'){if(P.frameBlend)q.frameBlend=true;if(P.motionBlur>0)q.motionBlur=Math.max(q.motionBlur||0,P.motionBlur);}
  return v;
}
// Does a compound hold anything that makes sound / moving pictures (at any depth)?
function _cmpHas(c,fn){return ((c.inner&&c.inner.clips)||[]).some(x=>x.type==='compound'?_cmpHas(x,fn):fn(x));}
function proCmpHasSound(c){return _cmpHas(c,x=>(x.type==='audio'||x.type==='video')&&!!x.mediaId);}
function proCmpHasVideo(c){return _cmpHas(c,x=>x.type==='video'&&!!x.mediaId);}
function _cmpVirtual(cmp,forPlay){
  if(!forPlay){const k=_cmpRev+'|'+_cmpKey(cmp);const hit=_cmpVCache.get(k);if(hit)return hit;
    const v=_cmpVirtual0(cmp,false);if(_cmpVCache.size>64)_cmpVCache.clear();_cmpVCache.set(k,v);return v;}
  return _cmpVirtual0(cmp,true);
}
// The compound's own level over time (volume, keyframed volume, fades) as a gain
// curve sampled onto a virtual clip, so the SOUND follows a compound fade too.
function _cmpGainKeys(cmp,v){
  const P=cmp.props||{},fi=P.fadeIn||0,fo=P.fadeOut||0,kv=cmp.kf&&cmp.kf.volume&&cmp.kf.volume.length;
  if(!fi&&!fo&&!kv)return null;
  const g=t=>(kv?kfEval(cmp.kf.volume,t-cmp.start,cmp.kfEaseMode||'smooth'):(P.volume??1))*fadeFactor(cmp,t);
  const a=v.start,b=clipEnd(v),T=new Set([a,b]);
  const add=t=>{if(t>a&&t<b)T.add(+t.toFixed(4));};
  if(kv)cmp.kf.volume.forEach(k=>add(cmp.start+k.t));
  // fades are sampled densely enough to follow any fade curve closely
  const ramp=(t0,t1)=>{for(let i=0;i<=12;i++)add(t0+(t1-t0)*i/12);};
  if(fi)ramp(cmp.start,cmp.start+fi);if(fo)ramp(clipEnd(cmp)-fo,clipEnd(cmp));
  if(v.kf&&v.kf.volume)v.kf.volume.forEach(k=>add(v.start+k.t));
  const iv=t=>(v.kf&&v.kf.volume&&v.kf.volume.length)?kfEval(v.kf.volume,t-v.start,v.kfEaseMode||'smooth'):(v.props.volume??1);
  return [...T].sort((x,y)=>x-y).map(t=>({t:+(t-v.start).toFixed(4),v:+(iv(t)*g(t)).toFixed(5)}));
}
function _cmpVirtual0(cmp,forPlay){
  const inner=(cmp.inner&&cmp.inner.clips)||[];
  const s=cmp.props.speed||1,rev=!!cmp.props.reverse,a=cmp.inPoint||0,b=a+cmp.duration*s,off=cmp.start-a,out=[];
  const cv=forPlay?(cmp.props.muteClip?0:(cmp.props.volume??1)):1;
  for(const x of inner){
    if(clipEnd(x)<=a+1e-6||x.start>=b-1e-6)continue;
    const whole=x.start>=a-1e-6&&clipEnd(x)<=b+1e-6;
    const v=whole?JSON.parse(JSON.stringify(x)):aiClipSub(x,a,b);
    if(s!==1||rev)_cmpRetime(v,v.start-a,b-a,s,rev,cmp.start);else v.start+=off;
    v.id=cmp.id+'>'+x.id;v._cmp=cmp.id;_cmpInherit(cmp,v);
    if(forPlay){
      v._trk=x.track;v.track=cmp.track;   // _trk: its own inner track (same-track transitions pair by it)
      const gk=cmp.props.muteClip?null:_cmpGainKeys(cmp,v);
      if(gk){v.kf=v.kf||{};v.kf.volume=gk;v.kfEaseMode='linear';}
      else{if(v.kf&&v.kf.volume)v.kf.volume.forEach(k=>{k.v*=cv;if(k.e){k.e.v0*=cv;k.e.v1*=cv;}});v.props.volume=(v.props.volume??1)*cv;}
      if(cmp.props.muteClip)v.props.muteClip=true;
    }
    out.push(v);
  }
  return out;
}
// The timeline as the player/exporter must see it (compounds flattened).
function playClips(){
  const L=state.clips;
  if(!L.some(c=>c.type==='compound'))return L;
  const key=_cmpRev+'|'+L.length+'|'+L.map(c=>c.type==='compound'?_cmpKey(c):'').join(';');
  if(key===_pcKey&&_pcVal&&_pcVal.src===L)return _pcVal.list;
  const flat=list=>{const o=[];for(const c of list){if(c.type==='compound')o.push(...flat(_cmpVirtual(c,true)));else o.push(c);}return o;};
  const list=flat(L);
  _pcKey=key;_pcVal={src:L,list};
  return list;
}
// Draw a compound clip (called from the compositor's video loop).
function proDrawCompound(c,t,op,p){
  const W=cv.width,H=cv.height;
  let off=_cmpCanvases[_cmpDepth];
  if(!off){const k=document.createElement('canvas');off=_cmpCanvases[_cmpDepth]={canvas:k,ctx:k.getContext('2d')};}
  if(off.canvas.width!==W)off.canvas.width=W;
  if(off.canvas.height!==H)off.canvas.height=H;
  if(_cmpDepth>6)return;                                // runaway nesting guard
  const sCv=cv,sCx=cx,sClips=state.clips,sHid=state.hidden;
  cv=off.canvas;cx=off.ctx;state.clips=_cmpVirtual(c,false);state.hidden={};_cmpDepth++;
  try{_drawComposition();}
  finally{cv=sCv;cx=sCx;state.clips=sClips;state.hidden=sHid;_cmpDepth--;}
  cx.save();cx.globalAlpha=op;cx.filter=filterStr(p);
  cx.translate(W/2+p.x/100*W,H/2+p.y/100*H);
  cx.rotate((p.rotation||0)*Math.PI/180);
  if(p.flipH||p.flipV)cx.scale(p.flipH?-1:1,p.flipV?-1:1);
  cx.scale(p.scale,p.scale);
  const lg=p.lutId&&typeof proLutApply==='function'?proLutApply(off.canvas,0,0,W,H,p.lutId,(p.lutAmt??100)/100,W,H):null;   // v4.8
  cx.drawImage(lg||off.canvas,-W/2,-H/2,W,H);
  cx.restore();
}
// ---------- make / break apart ----------
function proMakeCompound(){
  const ids=selectionWithLinks();
  const sel=state.clips.filter(c=>ids.includes(c.id));
  if(!sel.length){toast('Select the clips to put in the compound clip first');return;}
  if(sel.some(c=>state.locked[c.track])){toast('One of those clips is on a locked track','err');return;}
  pushHistory();
  const t0=Math.min(...sel.map(c=>c.start)),t1=Math.max(...sel.map(clipEnd));
  // the compound sits on the highest video track among its clips (else the first track used)
  const vids=sel.filter(c=>(trackOf(c.track)||{}).kind==='video').map(c=>c.track);
  const tnum=id=>parseInt(((trackOf(id)||{}).name||'').replace(/\D/g,''))||0;
  // always a video track: the highest one the clips used, else the highest video
  // track that's free for that stretch, else the top video track
  const allV=TRACKS.filter(t=>t.kind==='video').map(t=>t.id).sort((a,b)=>tnum(b)-tnum(a));
  const inIds0=new Set(sel.map(c=>c.id));
  const free=id=>!state.clips.some(o=>!inIds0.has(o.id)&&o.track===id&&o.start<t1-1e-6&&clipEnd(o)>t0+1e-6);
  const track=vids.length?vids.sort((a,b)=>tnum(b)-tnum(a))[0]:(allV.find(free)||allV[0]||'V1');
  const inner=sel.map(c=>{const x=JSON.parse(JSON.stringify(c));x.start-=t0;return x;});
  // links/groups are kept inside; a link that points outside is dropped
  const inIds=new Set(inner.map(x=>x.id));
  inner.forEach(x=>{if(x.linkId&&!inner.some(y=>y!==x&&y.linkId===x.linkId))delete x.linkId;});
  // the lowest number no compound (at any level) is using yet
  const used=new Set();proEachClip(o=>{const m=o.type==='compound'&&/^Compound (\d+)$/.exec(o.name||'');if(m)used.add(+m[1]);});
  let n=1;while(used.has(n))n++;
  const cmp=makeClip({type:'compound',track,start:t0,duration:t1-t0,inPoint:0,name:'Compound '+n,inner:{clips:inner}});
  state.clips=state.clips.filter(c=>!inIds.has(c.id));
  // anything else already on the compound's track under it would now overlap
  const clash=state.clips.some(o=>o.track===track&&o.start<t1-1e-6&&clipEnd(o)>t0+1e-6);
  state.clips.push(cmp);proCmpTouched();
  state.selection=cmp.id;state.selExtra=[];
  renderTimeline();renderInspector();requestDraw();
  toast('Made “'+cmp.name+'” from '+sel.length+' clip'+(sel.length>1?'s':'')+' — double-click it to edit inside'+(clash?'. Heads up: it overlaps a clip already on '+((trackOf(track)||{}).name||track):''),'ok',5000);
  return cmp;
}
// Look settings a compound applies to its whole picture (the ones that draw on it).
const _CMP_LOOK=['brightness','contrast','saturate','hue','blur','grayscale','sepia','invert','warmth','tint',
  'exposure','gamma','shadows','highlights','blacks','whites','balShCol','balShAmt','balMidCol','balMidAmt','balHiCol','balHiAmt',
  'sharpen','glow','posterize','duotone','duoDark','duoLight','lutId','lutAmt','filter'];
function _cmpLookKeys(p){
  const d=defaultProps();
  return _CMP_LOOK.filter(k=>{if(k==='filter'||k==='lutAmt')return false;if(k==='lutId')return !!p.lutId;
    const def=k in GRADE_DEFAULTS?GRADE_DEFAULTS[k]:d[k],v=p[k];
    return v!=null&&v!==def&&!(!v&&!def);});
}
function proBreakCompound(c){
  if(!c||c.type!=='compound')return;
  if(state.locked[c.track]){toast('“'+c.name+'” is on a locked track — unlock it to break it apart','err');return;}
  const s=c.props.speed||1,rev=!!c.props.reverse,a=c.inPoint||0,b=a+c.duration*s,off=c.start-a,out=[];
  for(const x of (c.inner.clips||[])){
    if(clipEnd(x)<=a+1e-6||x.start>=b-1e-6)continue;
    const whole=x.start>=a-1e-6&&clipEnd(x)<=b+1e-6;
    const v=whole?JSON.parse(JSON.stringify(x)):aiClipSub(x,a,b);
    if(s!==1||rev)_cmpRetime(v,v.start-a,b-a,s,rev,c.start);else v.start+=off;   // v4.9: keeps the speed/reverse
    v.id=uid();_cmpInherit(c,v);
    out.push(v);
  }
  const lockedT=[...new Set(out.filter(v=>state.locked[v.track]).map(v=>(trackOf(v.track)||{}).name||v.track))];
  if(lockedT.length){toast('Can’t break “'+c.name+'” apart: its clips go on '+lockedT.join(', ')+', which '+(lockedT.length>1?'are':'is')+' locked','err',5000);return;}
  pushHistory();
  // Fold the compound's own settings into its clips where they map one-to-one;
  // anything that can't be carried over is named in the message.
  const P=c.props,dropped=new Set(),cm=c.kfEaseMode||'smooth',ck=c.kf||{};
  const look=_cmpLookKeys(P),lookKf=Object.keys(ck).filter(k=>_CMP_LOOK.includes(k)&&ck[k].length);
  const mapKf=(v,k,mul)=>{   // the compound's keys for k, cut to v's stretch (outer time), times mul
    const sl=typeof _aiKfSlice==='function'?_aiKfSlice({[k]:ck[k]},v.start-c.start,v.duration,cm):null,arr=sl&&sl[k];if(!arr)return false;
    if(!v.kf||!Object.keys(v.kf).length){v.kf={};if(c.kfEaseMode)v.kfEaseMode=c.kfEaseMode;}
    const own=v.kfEaseMode||'smooth';
    arr.forEach(q=>{q.v*=mul;if(q.e){q.e.v0*=mul;q.e.v1*=mul;}if(own!==cm){if(q.e){if(!q.e.i)q.e.i=cm;}else if(!q.i)q.i=cm;}});
    v.kf[k]=arr;return true;};
  const scaleKf=(v,k,mul)=>{if(mul!==1)v.kf[k].forEach(q=>{q.v*=mul;if(q.e){q.e.v0*=mul;q.e.v1*=mul;}});};
  const has=(v,k)=>!!(v.kf&&v.kf[k]&&v.kf[k].length);
  const SOUND=v=>v.type==='audio'||v.type==='video',LOOKS=v=>['video','image','color','compound'].includes(v.type),LUTS=v=>v.type!=='color';   // color clips draw no LUT
  const fi=P.fadeIn||0,fo=P.fadeOut||0,cEnd=clipEnd(c);
  for(const v of out){
    const q=v.props,op0=q.opacity??1,vol0=q.volume??1;
    if(v.type!=='audio'){
      if(has(c,'opacity')){if(has(v,'opacity'))dropped.add('opacity keyframes');else mapKf(v,'opacity',op0);}
      else{q.opacity=op0*(P.opacity??1);if(has(v,'opacity'))scaleKf(v,'opacity',P.opacity??1);}
      if(look.length||lookKf.length){
        if(!LOOKS(v))dropped.add('its color/look on '+(v.type==='text'?'titles':'effects'));
        else if(_cmpLookKeys(q).length||lookKf.some(k=>has(v,k)))dropped.add('its color/look on clips that have their own');
        else{for(const k of look)if(k!=='lutId'||LUTS(v))q[k]=P[k];if(P.lutId&&LUTS(v))q.lutAmt=P.lutAmt??100;if(P.filter)q.filter=P.filter;lookKf.forEach(k=>mapKf(v,k,1));
          if(P.lutId&&!LUTS(v))dropped.add('its LUT on color clips');}
      }
    }
    if(SOUND(v)){
      if(has(c,'volume')){if(has(v,'volume'))dropped.add('volume keyframes');else mapKf(v,'volume',vol0);}
      else{q.volume=vol0*(P.volume??1);if(has(v,'volume'))scaleKf(v,'volume',P.volume??1);}
      if(P.muteClip)q.muteClip=true;
    }
    // fades: onto the clips that start / end with the compound
    if(fi>0&&v.start<c.start+fi-1e-3){
      if(Math.abs(v.start-c.start)<1e-3&&!(q.fadeIn>0))q.fadeIn=Math.min(fi,v.duration);
      else if(!(Math.abs(v.start-c.start)<1e-3&&Math.abs((q.fadeIn||0)-fi)<1e-3))dropped.add('fade in');}
    if(fo>0&&clipEnd(v)>cEnd-fo+1e-3){
      if(Math.abs(clipEnd(v)-cEnd)<1e-3&&!(q.fadeOut>0))q.fadeOut=Math.min(fo,v.duration);
      else if(!(Math.abs(clipEnd(v)-cEnd)<1e-3&&Math.abs((q.fadeOut||0)-fo)<1e-3))dropped.add('fade out');}
  }
  for(const k in ck)if(ck[k]&&ck[k].length&&!['opacity','volume','x','y','scale','rotation'].includes(k)&&!_CMP_LOOK.includes(k))dropped.add(k+' keyframes');
  // re-link pairs that were linked inside (fresh ids, same pairing)
  const lm={};out.forEach(v=>{if(v.linkId){lm[v.linkId]=lm[v.linkId]||uid();v.linkId=lm[v.linkId];}});
  state.clips=state.clips.filter(x=>x!==c).concat(out);proCmpTouched();
  const clash=out.some(v=>state.clips.some(o=>o!==v&&!out.includes(o)&&o.track===v.track&&o.start<clipEnd(v)-1e-6&&clipEnd(o)>v.start+1e-6));
  state.selection=out[0]?out[0].id:null;
  renderTimeline();renderInspector();requestDraw();
  const moved=Math.abs(P.x||0)+Math.abs(P.y||0)+Math.abs((P.scale??1)-1)+Math.abs(P.rotation||0)>1e-6||P.flipH||P.flipV
    ||['x','y','scale','rotation'].some(k=>ck[k]&&ck[k].length);
  toast('Broke “'+c.name+'” apart into '+out.length+' clip'+(out.length!==1?'s':'')
    +(moved?' — its position/scale/rotation/flip don’t carry over; set them on the clips':'')
    +(dropped.size?' — couldn’t carry over '+[...dropped].join(', '):'')
    +(clash?' — some now overlap clips on the same tracks':''),clash||moved||dropped.size?'err':'ok',7000);
  return out;
}
// ---------- edit inside ----------
const _cmpStack=[];      // [{id, clips, history, hIndex, time, name}]
function proInsideCompound(){return _cmpStack.length>0;}
function proOpenCompound(c){
  if(!c||c.type!=='compound')return;
  if(state.locked[c.track]){toast('“'+c.name+'” is on a locked track — unlock it to edit inside','err');return;}
  setPlaying(false);
  _cmpStack.push({id:c.id,clips:state.clips,history:state.history,hIndex:state.hIndex,time:state.time,name:c.name,
    rangeIn:state.rangeIn,rangeOut:state.rangeOut});
  state.clips=JSON.parse(JSON.stringify(c.inner.clips||[]));
  state.history=[];state.hIndex=-1;pushHistory();
  state.selection=null;state.rangeIn=null;state.rangeOut=null;
  {const sp=c.props.speed||1,lt=clamp(state.time-c.start,0,c.duration);
   setTime(clamp((c.inPoint||0)+(c.props.reverse?(c.duration-lt):lt)*sp,0,Math.max(0,_cmpInnerDur(c))));}
  _cmpCrumb();renderTimeline();renderInspector();requestDraw();
  toast('Editing inside “'+c.name+'” — press Back (above the timeline) when you’re done','ok',4000);
}
function proCloseCompound(){
  const fr=_cmpStack.pop();if(!fr)return;
  setPlaying(false);
  const inner=state.clips;
  state.clips=fr.clips;state.history=fr.history;state.hIndex=fr.hIndex;
  state.rangeIn=fr.rangeIn;state.rangeOut=fr.rangeOut;
  const c=state.clips.find(x=>x.id===fr.id);
  if(c){
    const before=JSON.stringify(c.inner.clips);
    if(JSON.stringify(inner)!==before){
        pushHistory();                                      // one undo step: everything done inside
      c.inner.clips=inner;proCmpTouched();
      // keep the window inside the new content
      const D=_cmpInnerDur(c),sp=c.props.speed||1;   // the window spans duration×speed inner seconds
      if((c.inPoint||0)>=D)c.inPoint=Math.max(0,D-c.duration*sp);
      if((c.inPoint||0)+c.duration*sp>D+1e-6)c.duration=Math.max(0.1,(D-(c.inPoint||0))/sp);
    }
    state.selection=c.id;
  }
  setTime(fr.time);
  _cmpCrumb();renderTimeline();renderInspector();requestDraw();
}
// The OUTER timeline's playhead and In/Out range while editing inside (a save
// writes the outer timeline, so it must write these too). null when outside.
function proRootFrame(){if(!_cmpStack.length)return null;const f=_cmpStack[0];return {time:f.time,rangeIn:f.rangeIn??null,rangeOut:f.rangeOut??null};}
// Leave every open compound (folding the edits back), e.g. before an export.
function proLeaveAllCompounds(){let n=0;while(_cmpStack.length&&n<64){proCloseCompound();n++;}return n;}
// A different project replaces everything: leave any compound without folding back.
function proResetCompound(){_cmpStack.length=0;proCmpTouched();_cmpCrumb();}
// Every clip at every level — the timeline, inside every compound, and the
// outer timelines saved while editing inside one. For media re-linking/removal.
function proEachClip(fn){
  const walk=list=>{for(const c of list){fn(c,list);if(c.type==='compound'&&c.inner&&c.inner.clips)walk(c.inner.clips);}};
  walk(state.clips);for(const f of _cmpStack)walk(f.clips);
}
function proAnyClipUses(mediaId){let hit=false;proEachClip(c=>{if(c.mediaId===mediaId)hit=true;});return hit;}
// Remove every clip (at any depth) that uses a media item.
function proRemoveClipsOf(mediaId){
  const strip=list=>list.filter(c=>c.mediaId!==mediaId).map(c=>{if(c.type==='compound'&&c.inner)c.inner.clips=strip(c.inner.clips||[]);return c;});
  state.clips=strip(state.clips);for(const f of _cmpStack)f.clips=strip(f.clips);proCmpTouched();
}
// Every save (project file, autosave) writes the OUTER timeline, even while inside.
function proRootClips(){
  if(!_cmpStack.length)return state.clips;
  let cur=JSON.parse(JSON.stringify(state.clips));
  for(let i=_cmpStack.length-1;i>=0;i--){
    const fr=_cmpStack[i],outer=JSON.parse(JSON.stringify(fr.clips));
    const c=outer.find(x=>x.id===fr.id);if(c)c.inner.clips=cur;
    cur=outer;
  }
  return cur;
}
function _cmpCrumb(){
  let bar=document.getElementById('cmpCrumb');
  if(!_cmpStack.length){if(bar)bar.remove();document.body.classList.remove('in-compound');return;}
  if(!bar){bar=document.createElement('div');bar.id='cmpCrumb';bar.className='cmp-crumb';
    const host=document.getElementById('tlWrap');if(host)host.parentNode.insertBefore(bar,host);else document.body.prepend(bar);}
  document.body.classList.add('in-compound');
  bar.innerHTML=`<button class="tbtn" id="cmpBack" title="Finish editing inside and go back out (Esc)">← Back</button>
    <span class="cmp-path"><span>Main timeline</span>${_cmpStack.map(f=>' › <b>'+esc(f.name)+'</b>').join('')}</span>
    <span class="cmp-note">You’re editing inside a compound clip — the viewer shows only what’s in it.</span>`;
  bar.querySelector('#cmpBack').onclick=()=>proCloseCompound();
}
// Esc leaves the compound only when it isn't closing something else. Decided in
// the window CAPTURE phase — before the dialog/menu/field handlers act on it.
window.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||!_cmpStack.length)return;
  const busy=document.querySelector('#overlay.show')||document.querySelector('#ctxMenu.show')
    ||/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'')
    ||(typeof projCrop!=='undefined'&&projCrop)||(typeof TX!=='undefined'&&(TX.sel||TX.pauseSel!=null)&&document.activeElement&&document.activeElement.closest&&document.activeElement.closest('#txBody'));
  if(!busy)setTimeout(proCloseCompound,0);
},true);
function proCompoundMenuItems(c){
  const items=[];
  if(c&&c.type==='compound'){
    items.push({label:'Edit inside compound clip',tip:'Open it to change the clips inside (double-click does the same)',fn:()=>proOpenCompound(c)});
    items.push({label:'Break apart compound clip',tip:'Put the clips inside back on the timeline, where they are now',fn:()=>proBreakCompound(c)});
  }else{
    const n=selectionWithLinks().length;
    if(n)items.push({label:'Make compound clip'+(n>1?' ('+n+' clips)':''),kbd:'Ctrl Alt G',tip:'Wrap the selected clips into one clip you can move, trim and animate as a unit — and still edit inside',fn:proMakeCompound});
  }
  return items;
}
addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.altKey&&e.key.toLowerCase()==='g'&&!/INPUT|TEXTAREA|SELECT/.test((document.activeElement||{}).tagName||'')){
    e.preventDefault();const c=state.clips.find(x=>x.id===state.selection);
    if(c&&c.type==='compound')proBreakCompound(c);else proMakeCompound();}
});
