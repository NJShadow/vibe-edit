
/* ---------- 4. Timeline transcript ----------
   Words live on source media in SOURCE seconds. The transcript the user reads
   is derived by mapping them through every audible clip, so it always matches
   the current edit: trim, move, split or ripple anything and the text follows. */
const AI_FILLERS=new Set(['um','umm','ummm','uh','uhh','uhm','uhmm','erm','er','err','ah','ahh','eh','hmm','hm','mm','mmm','mhm']);
const AI_SOFT_FILLERS=['you know','i mean','sort of','kind of','like','basically','actually','literally'];
function aiNormWord(w){return String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');}
// Does clip c contribute audible speech? Reversed clips (backwards speech),
// freeze frames, muted clips/tracks and zero-volume video (its sound was
// detached to an audio clip) don't — the audio clip carries those words.
function aiClipSpeaks(c){
  if(c.type!=='video'&&c.type!=='audio')return false;
  if(c.freeze||c.props.reverse||c.props.muteClip)return false;
  if(state.muted&&state.muted[c.track])return false;
  const kv=c.kf&&c.kf.volume&&c.kf.volume.length;
  if(!kv&&!(c.props.volume>0))return false;
  const m=aiMediaOfClip(c);return !!(m&&!m.missing);
}
function aiSrcToTl(c,src){if(c.ramp)return rampSrcToTl(c,src);return c.start+(src-(c.inPoint||0))/((c.props.speed)||1);}
function aiTlToSrc(c,t){if(c.ramp)return rampTlToSrc(c,t);return (c.inPoint||0)+(t-c.start)*((c.props.speed)||1);}
/* The timeline transcript: [{k:'w'|'s', w, t0, t1, c:clip, root, wi, filler}]
   sorted by time. 'w' = a transcribed word, 's' = an untranscribed sound (an
   "um" Whisper chose not to write down, a cough, a laugh…). */
/* Chains: clips that play one source continuously (a clip split in two and
   never moved: same track and source, same speed, the second starting exactly
   where the first ends in both timeline and source). Transcript editing treats
   a chain as one clip — a word split by the cut is cut whole, and the pause
   around such a cut is interior (review fix). Map clip -> {start,end,s0,s1}. */
function aiClipChains(clips){
  const out=new Map(),cs=clips.filter(c=>(c.type==='video'||c.type==='audio')&&!c.freeze&&!(c.props&&c.props.reverse))
    .sort((a,b)=>String(a.track).localeCompare(String(b.track))||a.start-b.start);
  const sp=c=>(c.props.speed)||1;
  let cur=null,prev=null;
  for(const c of cs){
    const ok=prev&&cur&&prev.track===c.track&&prev.mediaId===c.mediaId&&!prev.ramp&&!c.ramp&&Math.abs(sp(prev)-sp(c))<1e-9
      &&Math.abs(c.start-clipEnd(prev))<1e-3&&Math.abs((c.inPoint||0)-((prev.inPoint||0)+prev.duration*sp(prev)))<2e-3;
    if(ok){cur.end=clipEnd(c);cur.s1=(c.inPoint||0)+c.duration*sp(c);cur.clips.push(c);}
    else{cur={start:c.start,end:clipEnd(c),s0:c.inPoint||0,s1:(c.inPoint||0)+c.duration*sp(c),clips:[c]};}
    out.set(c,cur);prev=c;
  }
  return out;
}
function aiChainOf(x){return x.ch||(x.ch={start:x.c.start,end:clipEnd(x.c),s0:x.c.inPoint||0,s1:(x.c.inPoint||0)+x.c.duration*((x.c.props.speed)||1),clips:[x.c]});}
function aiTimelineWords(){
  const list=[],chains=aiClipChains(state.clips.filter(aiClipSpeaks));
  for(const c of state.clips){
    if(!aiClipSpeaks(c))continue;
    const root=aiRoot(aiMediaOfClip(c)),tr=aiTranscriptOf(root);if(!tr)continue;
    const s0=c.inPoint||0,s1=s0+c.duration*((c.props.speed)||1);
    const ch=chains.get(c),cs0=ch?ch.s0:s0,cs1=ch?ch.s1:s1;
    const ws=tr.words;
    // binary search the first word that could be inside
    let lo=0,hi=ws.length;while(lo<hi){const mid=(lo+hi)>>1;if(ws[mid][2]<=s0)lo=mid+1;else hi=mid;}
    const inClip=[];
    for(let i=lo;i<ws.length&&ws[i][1]<s1;i++){
      const w=ws[i],mid=(w[1]+w[2])/2;
      if(mid<s0||mid>=s1)continue;          // a word belongs to the clip holding its middle
      // a word straddling the cut to a contiguous neighbour covers both parts
      const a=Math.max(w[1],cs0),b=Math.min(w[2],cs1);
      inClip.push({k:w[3]?'s':'w',w:w[0],t0:aiSrcToTl(c,a),t1:aiSrcToTl(c,b),s:a,e:b,c,root,wi:i,tag:!!w[3],ch});
    }
    list.push(...inClip);
    const env=_aiEnv[root.id];
    if(env)list.push(...aiUntranscribedSounds(c,root,env,inClip).map(x=>(x.ch=ch,x)));
  }
  list.sort((x,y)=>x.t0-y.t0||x.t1-y.t1);
  // One word heard through two clips at once (a linked A/V pair where both
  // still play, multi-cam angles): keep it once.
  const out=[];
  for(const x of list){
    const dup=out.slice(-6).find(y=>y.k===x.k&&Math.abs(y.t0-x.t0)<0.12&&(x.k==='s'||aiNormWord(y.w)===aiNormWord(x.w)));
    if(!dup)out.push(x);
  }
  aiMarkFillers(out);
  return out;
}
// Voiced stretches in the clip that no word covers: 0.12 - 2.5 s long.
// Runs are measured on the SOURCE (padded 2.5 s past the clip's edges) and
// checked against every transcribed word, then clipped to the clip — so
// splitting a clip never turns one long sound, or the tail of a word that
// belongs to the neighbouring clip, into new "…" markers.
function aiUntranscribedSounds(c,root,env,inClip){
  const s0=c.inPoint||0,s1=s0+c.duration*((c.props.speed)||1),P=2.5;
  const tr=aiTranscriptOf(root),ws=tr.words||[];
  const covered=(tr.covered||[]).filter(r=>r[1]>s0-P&&r[0]<s1+P);
  const out=[];
  for(const [ca,cb] of covered){
    for(const r of aiVoicedRuns(env,Math.max(s0-P,ca),Math.min(s1+P,cb))){
      const len=r[1]-r[0];if(len<0.12||len>2.5)continue;
      const a=Math.max(r[0],s0),b=Math.min(r[1],s1);if(b-a<0.12)continue;
      let lo=0,hi=ws.length;while(lo<hi){const m=(lo+hi)>>1;if(ws[m][2]<=r[0]-0.06)lo=m+1;else hi=m;}
      if(lo<ws.length&&ws[lo][1]<r[1]+0.06)continue;   // a word (or tag) already names it
      out.push({k:'s',w:'…',t0:aiSrcToTl(c,a),t1:aiSrcToTl(c,b),s:a,e:b,c,root,wi:-1});
    }
  }
  return out;
}
// filler: 'um' (always safe to cut), 'soft' (depends on meaning), 'repeat'
// (the first of a stuttered pair: "the the").
function aiMarkFillers(list){
  for(let i=0;i<list.length;i++){
    const x=list[i];x.filler=null;if(x.k!=='w')continue;
    const n=aiNormWord(x.w);
    if(AI_FILLERS.has(n)){x.filler='um';continue;}
    const nx=list[i+1];
    if(nx&&nx.k==='w'&&aiNormWord(nx.w)===n&&n.length&&nx.t0-x.t1<0.6&&aiChainOf(nx)===aiChainOf(x)){x.filler='repeat';continue;}
  }
  for(let i=0;i<list.length;i++){
    for(const phrase of AI_SOFT_FILLERS){
      const parts=phrase.split(' ');
      if(parts.every((p,j)=>list[i+j]&&list[i+j].k==='w'&&!list[i+j].filler&&aiNormWord(list[i+j].w)===p)){
        for(let j=0;j<parts.length;j++)list[i+j].filler='soft';
        break;
      }
    }
  }
}
/* Where to cut when words i..j are deleted. The gaps on either side keep up to
   0.4 s of their pause (half the gap, whichever is less) so the edit breathes
   like natural speech, and the cut itself lands on the QUIETEST frame-aligned
   instant available — the clean cut that never clips a syllable. */
const AI_KEEP_MAX=0.4;
function aiQuietPoint(c,lo,hi,target,ch){
  const root=aiRoot(aiMediaOfClip(c)),env=root&&_aiEnv[root.id];
  const F=1/_aiFps(),cS=ch?ch.start:c.start,cE=ch?ch.end:clipEnd(c);
  lo=Math.max(lo,cS);hi=Math.min(hi,cE);
  if(!env||hi<lo)return aiFrameSnap(clamp(target,lo,hi));
  let best=null,bs=Infinity;
  const k0=Math.ceil((lo-F*0.5)/F),k1=Math.floor((hi+F*0.5)/F);
  const half=Math.max(0.03,(hi-lo)/2);
  for(let k=k0;k<=k1;k++){
    const t=k*F;if(t<cS-1e-6||t>cE+1e-6)continue;
    const d=aiDbAround(env,aiTlToSrc(c,t),0.012)+4*Math.abs(t-target)/half;
    if(d<bs){bs=d;best=t;}
  }
  return best==null?aiFrameSnap(clamp(target,lo,hi)):best;
}
function aiCutBefore(list,i){
  const x=list[i],c=x.c,p=list[i-1],ch=aiChainOf(x);
  const lo=p&&aiChainOf(p)===ch?p.t1:ch.start,hi=x.t0;
  const g=Math.max(0,hi-lo),keep=Math.min(g/2,AI_KEEP_MAX);
  const target=lo+keep;
  const span=Math.max(0.03,Math.min(g/2,0.12));
  return aiQuietPoint(c,Math.max(lo,target-span),Math.min(hi,target+span),target,ch);
}
function aiCutAfter(list,j){
  const x=list[j],c=x.c,n=list[j+1],ch=aiChainOf(x);
  const lo=x.t1,hi=n&&aiChainOf(n)===ch?n.t0:ch.end;
  const g=Math.max(0,hi-lo),keep=Math.min(g/2,AI_KEEP_MAX);
  const target=hi-keep;
  const span=Math.max(0.03,Math.min(g/2,0.12));
  return aiQuietPoint(c,Math.max(lo,target-span),Math.min(hi,target+span),target,ch);
}
// Timeline range that removes entries i..j (inclusive).
function aiRangeForWords(list,i,j){return [aiCutBefore(list,i),aiCutAfter(list,j)];}
// Ranges for a set of entry indices (contiguous runs are cut as one).
function aiRangesForEntries(list,idx){
  const s=[...new Set(idx)].sort((a,b)=>a-b),out=[];
  for(let k=0;k<s.length;){
    let e=k;while(e+1<s.length&&s[e+1]===s[e]+1&&aiChainOf(list[s[e+1]])===aiChainOf(list[s[k]]))e++;
    out.push(aiRangeForWords(list,s[k],s[e]));k=e+1;
  }
  return out;
}
// Make sure every root behind these entries has an envelope (cut refinement
// and sound detection need it; after a project reload it is rebuilt here).
async function aiEnsureEnvelopesFor(roots){
  for(const r of roots){if(!_aiEnv[r.id]){try{await aiEnsureEnvelope(r);}catch(e){}}}
}
function aiTranscriptRoots(){
  const s=new Set();
  for(const c of state.clips)if(aiClipSpeaks(c)){const r=aiRoot(aiMediaOfClip(c));if(r)s.add(r);}
  return [...s];
}
