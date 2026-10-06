/* ================= AI EDITING (v4.6) =================
   Transcript editing, pause & filler removal, scene detection, beat cutting and
   auto-reframe. Everything runs on this machine.

   Layering (each layer only calls the ones above it):
     1. Ripple-cut engine   — removes timeline ranges across every unlocked
                              track at once. Pure state surgery, frame-snapped.
     2. Audio analysis      — decode to 16 kHz mono once, keep a 10 ms energy
                              envelope per source (the audio itself is dropped).
     3. Speech engine       — Whisper in a Web Worker, fed app-planned windows
                              that split at pauses (see WHY below).
     4. Timeline transcript — source-time words mapped through every clip, so
                              the transcript always matches the current edit.
     5. Features & UI       — built only on 1-4.

   WHY app-side windowing: transformers.js 3.0.2's own long-form mode
   (chunk_length_s + word timestamps) was MEASURED dropping whole chunks — on a
   46 s test it returned 38 of 116 words and lost everything before 30 s. Short
   windows that end in real pauses sidestep that bug entirely, never split a
   word, let us skip silent stretches (where Whisper hallucinates "Thanks for
   watching"), and give honest progress plus a working Cancel.
*/

/* ---------- 1. Ripple-cut engine ---------- */
function _aiFps(){return Math.max(1,(state.project&&state.project.fps)||30);}
function aiFrameSnap(t){const f=_aiFps();return Math.round(t*f)/f;}
// Sort, frame-snap, merge overlapping/touching ranges; drop anything under a frame.
function aiNormalizeRanges(ranges){
  const fr=1/_aiFps();
  const rs=(ranges||[])
    .map(r=>[aiFrameSnap(Math.max(0,Math.min(r[0],r[1]))),aiFrameSnap(Math.max(r[0],r[1]))])
    .filter(r=>r[1]-r[0]>=fr-1e-6)
    .sort((a,b)=>a[0]-b[0]);
  const out=[];
  for(const r of rs){
    const last=out[out.length-1];
    if(last&&r[0]<=last[1]+1e-6)last[1]=Math.max(last[1],r[1]);
    else out.push([r[0],r[1]]);
  }
  return out;
}
// Keyframes re-based onto the sub-span [off, off+dur] of a clip. Every segment of
// the new curve is tagged with the stretch of the ORIGINAL segment it covers
// (key.e — see kfEval), so a fragment animates exactly as that part of the
// uncut clip did, in any ease mode, and fragments of fragments compose.
function _aiKfSlice(kf,off,dur,mode){
  if(!kf)return undefined;
  const out={},x0=off,x1=off+dur;
  for(const k in kf){
    const arr=kf[k];if(!arr||!arr.length)continue;
    const inner=arr.filter(q=>q.t>x0+1e-9&&q.t<x1-1e-9);
    // Wholly before the first key or after the last: the value is constant.
    if(!inner.length&&(x1<=arr[0].t+1e-9||x0>=arr[arr.length-1].t-1e-9)){
      out[k]=[{t:0,v:kfEval(arr,kfModeAt(arr,x0,mode)==='hold'?x0+1e-7:x0,mode)}];continue;}
    const times=[x0,...inner.map(q=>q.t),x1];
    const res=[];
    for(let i=0;i<times.length;i++){
      // Inner keys keep their own value; the start boundary takes the value just
      // AFTER x0 (in hold mode a key's value begins immediately after its time).
      const t=times[i],key={t:t-x0,v:i===0?kfEval(arr,kfModeAt(arr,t,mode)==='hold'?t+1e-7:t,mode):i<times.length-1?inner[i-1].v:kfEval(arr,t,mode)};
      if(i<times.length-1){
        const t2=times[i+1],mid=(t+t2)/2;
        let j=arr.findIndex((q,n)=>n+1<arr.length&&q.t<=mid&&arr[n+1].t>=mid);
        if(j>=0){
          const A=arr[j],B=arr[j+1],L=Math.max(1e-9,B.t-A.t);
          const p0=(t-A.t)/L,p1=(t2-A.t)/L;
          const base=A.e||{u0:0,u1:1,v0:A.v,v1:B.v,i:A.i,b:A.b};
          if(A.e||p0>1e-9||p1<1-1e-9){
            key.e={u0:base.u0+(base.u1-base.u0)*p0,u1:base.u0+(base.u1-base.u0)*p1,v0:base.v0,v1:base.v1};
            if(base.i){key.e.i=base.i;if(base.b)key.e.b=base.b.slice();}   // v4.8 per-key curve
          }else if(A.i){key.i=A.i;if(A.b)key.b=A.b.slice();}
        }
      }
      res.push(key);
    }
    out[k]=res;
  }
  return Object.keys(out).length?out:undefined;
}
// A copy of clip c restricted to the timeline window [a,b) — WITHOUT moving it.
// Source mapping mirrors srcTimeFor exactly: forward, reversed and frozen clips.
function aiClipSub(c,a,b){
  const end=clipEnd(c);
  a=Math.max(a,c.start);b=Math.min(b,end);
  const p=JSON.parse(JSON.stringify(c));
  const sp=(c.props&&c.props.speed)||1;
  if(c.freeze&&c.freezeAt!=null){/* one held frame: in-point is irrelevant */}
  else if(c.props&&c.props.reverse)p.inPoint=(c.inPoint||0)+(end-b)*sp;
  else p.inPoint=(c.inPoint||0)+(a-c.start)*sp;
  if(c.ramp&&!(c.freeze&&c.freezeAt!=null)){   // v4.8: the piece plays exactly its stretch of the ramp
    const pa=rampPAt(c,(a-c.start)/c.duration),pb=rampPAt(c,(b-c.start)/c.duration),span=c.duration*sp,w=c.ramp.w||[0,1];
    p.inPoint=(c.inPoint||0)+(c.props.reverse?1-pb:pa)*span;
    p.ramp.w=[w[0]+(w[1]-w[0])*pa,w[0]+(w[1]-w[0])*pb];
    p.props.speed=(pb-pa)*span/Math.max(1e-9,b-a);
  }
  p.start=a;p.duration=b-a;
  const keepsIn=Math.abs(a-c.start)<1e-6, keepsOut=Math.abs(b-end)<1e-6;
  if(!keepsIn){p.props.fadeIn=0;p.props.transIn='none';if(p.text)p.text.animIn='none';}
  if(!keepsOut){p.props.fadeOut=0;p.props.transOut='none';if(p.text)p.text.animOut='none';}
  if(c.kf){const s=_aiKfSlice(c.kf,a-c.start,b-a,c.kfEaseMode||'smooth');if(s)p.kf=s;else delete p.kf;}
  return p;
}
function aiRemovedBefore(ranges,t){let s=0;for(const r of ranges){if(r[1]<=t+1e-6)s+=r[1]-r[0];else break;}return s;}
// Map a timeline time through a set of removed ranges (for markers, playhead, in/out).
function aiMapTime(ranges,t){
  for(const r of ranges){if(t>=r[0]-1e-6&&t<r[1]-1e-6)return r[0]-aiRemovedBefore(ranges,r[0]);}
  return t-aiRemovedBefore(ranges,t);
}
/* Remove every range from the timeline and close the gaps — on all UNLOCKED
   tracks together, so picture, sound, titles and captions stay in sync. Locked
   tracks are left exactly as they are (lock a music bed to keep it continuous).
   One undo step. Returns {removed, ranges, pieces} or null when nothing to do. */
function aiRippleCut(ranges,opts={}){
  const rs=aiNormalizeRanges(ranges);
  if(!rs.length)return null;
  if(!opts.noHistory)pushHistory();
  const fr=1/_aiFps();
  const out=[];let pieces=0;
  // Linked A/V pairs stay linked PER ISLAND (the stretch between two cuts):
  // pieces on the far side of a cut get a fresh link id shared only with their
  // own partners there. Island 0 (before the first cut) keeps the original id.
  const linkMap={};
  const relink=(p,at)=>{
    if(!p.linkId)return;
    const island=rs.filter(r=>r[1]<=at+1e-6).length;
    if(island===0)return;
    const key=p.linkId+'|'+island;
    p.linkId=linkMap[key]||(linkMap[key]='lk'+uid());
  };
  for(const c of state.clips){
    if(state.locked[c.track]){out.push(c);continue;}
    const s=c.start,e=clipEnd(c);
    const hit=rs.filter(r=>r[0]<e-1e-6&&r[1]>s+1e-6);
    if(!hit.length){relink(c,s);c.start=s-aiRemovedBefore(rs,s);out.push(c);continue;}
    // kept intervals = clip span minus the ranges
    const keep=[];let cur=s;
    for(const r of hit){if(r[0]>cur+1e-6)keep.push([cur,Math.min(r[0],e)]);cur=Math.max(cur,r[1]);}
    if(cur<e-1e-6)keep.push([cur,e]);
    let first=true;
    for(const k of keep){
      if(k[1]-k[0]<fr*0.5)continue;             // sub-frame sliver of an off-grid clip
      const p=aiClipSub(c,k[0],k[1]);
      if(!(first&&Math.abs(k[0]-s)<1e-6))p.id=uid(); // the untouched head keeps its identity
      first=false;
      relink(p,k[0]);
      p.start=k[0]-aiRemovedBefore(rs,k[0]);
      out.push(p);pieces++;
    }
  }
  state.clips=out;
  state.markers=(state.markers||[]).filter(m=>!rs.some(r=>m.t>=r[0]-1e-6&&m.t<r[1]-1e-6)).map(m=>Object.assign(m,{t:aiMapTime(rs,m.t)}));
  if(state.rangeIn!=null)state.rangeIn=aiMapTime(rs,state.rangeIn);
  if(state.rangeOut!=null)state.rangeOut=aiMapTime(rs,state.rangeOut);
  if(state.selection&&!state.clips.some(c=>c.id===state.selection))state.selection=null;
  state.selExtra=(state.selExtra||[]).filter(id=>state.clips.some(c=>c.id===id));
  const removed=rs.reduce((a,r)=>a+r[1]-r[0],0);
  if(!opts.noRender){
    state.time=clamp(aiMapTime(rs,state.time),0,projDuration());
    renderTimeline();renderInspector();syncMediaSeek();requestDraw();
  }
  return {removed,ranges:rs,pieces};
}
