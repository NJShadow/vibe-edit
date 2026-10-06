
/* ---------- Beat sync ----------
   Built on the existing onset detector (detectBeatsInBuffer — MEASURED 100% of
   beats within 3 ms on the synthetic 120/97 BPM test tracks). Two edits:
     - Cut to the beat: lay the selected clips back to back, each lasting N beats.
     - Snap cuts: move each cut between neighboring clips onto the nearest beat
       (a roll edit — nothing after it moves).
   Beats come from one music clip, mapped through its in-point and speed. */
/* Beat TRACKING (v4.6.1). The onset detector above finds strong hits, which is
   right for markers but not for "cut every N beats": on real songs it MEASURED
   only 45-71% agreement with librosa's tracker and one tempo off by 5:3. This
   is the standard dynamic-programming tracker (Ellis 2007, as in librosa):
   mel spectral-flux onset envelope -> tempo by autocorrelation with a prior
   around 120 BPM -> the beat sequence that best balances "on an onset" against
   "steady tempo". tempoFactor 0.5 / 2 picks half or double time. */
function aiBeatTrack(buf,tempoFactor){
  const sr=buf.sampleRate,N=buf.length,nch=buf.numberOfChannels,mono=new Float32Array(N);
  for(let ch=0;ch<nch;ch++){const d=buf.getChannelData(ch);for(let i=0;i<N;i++)mono[i]+=d[i]/nch;}
  const nfft=2048,hop=512,nb=nfft/2+1,nm=96,fmax=Math.min(11025,sr/2);
  // mel filterbank (triangular, area-normalized)
  const hz2m=f=>2595*Math.log10(1+f/700),m2hz=m=>700*(Math.pow(10,m/2595)-1);
  const edges=[];for(let i=0;i<nm+2;i++)edges.push(m2hz(hz2m(0)+(hz2m(fmax)-hz2m(0))*i/(nm+1)));
  const fb=[];for(let m=0;m<nm;m++){const lo=edges[m],c=edges[m+1],hi=edges[m+2];
    const k0=Math.max(0,Math.floor(lo*nfft/sr)),k1=Math.min(nb-1,Math.ceil(hi*nfft/sr)),w=new Float32Array(k1-k0+1);
    for(let k=k0;k<=k1;k++){const f=k*sr/nfft;w[k-k0]=f<lo||f>hi?0:f<=c?(f-lo)/Math.max(1e-9,c-lo):(hi-f)/Math.max(1e-9,hi-c);}
    fb.push({k0,w});}   // sparse: each filter only spans its own bins
  const win=new Float32Array(nfft);for(let i=0;i<nfft;i++)win[i]=0.5-0.5*Math.cos(2*Math.PI*i/nfft);
  const nf=Math.max(1,Math.floor(N/hop)+1),re=new Float64Array(nfft),im=new Float64Array(nfft),pw=new Float64Array(nb);
  let prev=null;const env=new Float32Array(nf);
  for(let f=0;f<nf;f++){
    const c=f*hop-nfft/2;
    for(let i=0;i<nfft;i++){const j=c+i;re[i]=(j>=0&&j<N?mono[j]:0)*win[i];im[i]=0;}
    _fftMag(re,im);
    for(let k=0;k<nb;k++)pw[k]=re[k]*re[k]+im[k]*im[k];
    const mel=new Float32Array(nm);
    for(let m=0;m<nm;m++){let s=0;const {k0,w}=fb[m];for(let k=0;k<w.length;k++)s+=w[k]*pw[k0+k];mel[m]=10*Math.log10(Math.max(1e-10,s));}
    if(prev){let s=0;for(let m=0;m<nm;m++){const d=mel[m]-prev[m];if(d>0)s+=d;}env[f]=s/nm;}
    prev=mel;
  }
  // tempo: autocorrelation over 8 s windows, each normalized, then averaged (a
  // tempogram, as librosa does) with a log-normal prior around 120 BPM. One
  // global autocorrelation MEASURED locking to half time on a 120 BPM track.
  const fps=sr/hop,W=Math.round(8*fps),lagMin=Math.round(fps*60/240),lagMax=Math.min(Math.round(fps*60/40),W-1);
  const acc=new Float64Array(lagMax+1);let nwin=0;
  for(let s0=0;s0+W<=Math.max(W,nf);s0+=Math.round(W/4)){
    const raw=env.subarray(s0,Math.min(nf,s0+W));if(raw.length<lagMax+2)break;
    // Hann-weighted like librosa's tempogram: the taper is what keeps a strong
    // two-beat pattern (snare on 2 and 4) from outvoting the beat itself
    const L=raw.length,seg=new Float32Array(L);
    for(let i=0;i<L;i++)seg[i]=raw[i]*(0.5-0.5*Math.cos(2*Math.PI*i/(L-1)));
    let a0=0;for(const v of seg)a0+=v*v;if(a0<=0)continue;
    for(let lag=lagMin;lag<=lagMax;lag++){let s=0;for(let i=lag;i<L;i++)s+=seg[i]*seg[i-lag];acc[lag]+=s/a0;}
    nwin++;
  }
  let best=-Infinity,bestLag=Math.round(fps*0.5);
  for(let lag=lagMin;lag<=lagMax;lag++){
    const bpm=60*fps/lag,prior=Math.exp(-0.5*Math.pow(Math.log2(bpm/120),2));
    if(acc[lag]*prior>best){best=acc[lag]*prior;bestLag=lag;}
  }
  const period=bestLag/(tempoFactor||1);
  // dynamic programming
  let sd=0;for(const v of env)sd+=v*v;sd=Math.sqrt(sd/nf)||1;
  const P=Math.round(period),loc=new Float32Array(nf);
  for(let i=0;i<nf;i++){let s=0;for(let n=-P;n<=P;n++){const j=i+n;if(j>=0&&j<nf)s+=env[j]/sd*Math.exp(-0.5*Math.pow(n*32/period,2));}loc[i]=s;}
  const cum=new Float32Array(nf),back=new Int32Array(nf).fill(-1),tight=100;
  for(let i=0;i<nf;i++){
    let bs=-Infinity,bj=-1;
    for(let j=i-Math.round(2*period);j<=i-Math.round(period/2);j++){
      if(j<0)continue;const sc=cum[j]-tight*Math.pow(Math.log((i-j)/period),2);
      if(sc>bs){bs=sc;bj=j;}
    }
    cum[i]=loc[i]+(bj>=0?bs:0);back[i]=bj>=0&&bs>0?bj:-1;
  }
  // last beat: the latest local maximum of the cumulative score above half their median
  const peaks=[];for(let i=1;i<nf-1;i++)if(cum[i]>cum[i-1]&&cum[i]>=cum[i+1])peaks.push(i);
  if(!peaks.length)return {beats:[],bpm:60*fps/period};
  const med=peaks.map(i=>cum[i]).sort((a,b)=>a-b)[peaks.length>>1];
  let last=peaks[peaks.length-1];for(let k=peaks.length-1;k>=0;k--)if(cum[peaks[k]]>=0.5*med){last=peaks[k];break;}
  const fr=[];for(let i=last;i>=0;i=back[i])fr.push(i);fr.reverse();
  // trim weak beats at both ends (intro / outro silence)
  let rms=0;for(const i of fr)rms+=loc[i]*loc[i];rms=Math.sqrt(rms/Math.max(1,fr.length));
  let a0=0,a1=fr.length;while(a0<a1&&loc[fr[a0]]<0.5*rms)a0++;while(a1>a0&&loc[fr[a1-1]]<0.5*rms)a1--;
  // +1 frame: flux at frame f is the rise INTO f (measured -26 ms against exact
  // beat times without it; -3 ms with it)
  return {beats:fr.slice(a0,a1).map(i=>(i+1)*hop/sr),bpm:60*fps/period};
}
const _aiBeatCache={};  // mediaId|tempo -> source-time beats
async function aiBeatsOfClip(c,tempoFactor){
  const m=aiMediaOfClip(c);if(!m)throw new Error('No media behind this clip');
  tempoFactor=tempoFactor||1;const key=m.id+'|'+tempoFactor;
  if(!_aiBeatCache[key]){
    const url=m.url;if(!url)throw new Error('This clip\u2019s media is offline');
    const arr=await (await fetch(url)).arrayBuffer();
    // decoded straight at 22.05 kHz: all the tracker needs, a quarter of the memory
    const buf=await new OfflineAudioContext(1,1,22050).decodeAudioData(arr);
    _aiBeatCache[key]=aiBeatTrack(buf,tempoFactor).beats;
  }
  const sp=(c.props.speed)||1,a=c.inPoint||0,b=a+c.duration*sp;
  return aiFillBeatGaps(_aiBeatCache[key].filter(t=>t>=a-1e-3&&t<=b+1e-3).map(t=>c.ramp?rampSrcToTl(c,t):c.start+(t-a)/sp));
}
// A breakdown or a quiet bar leaves holes; fill them from the tempo so a
// "every 4 beats" layout doesn't suddenly hold one shot for eight.
function aiFillBeatGaps(beats){
  if(beats.length<4)return beats;
  const iois=beats.slice(1).map((t,i)=>t-beats[i]).sort((a,b)=>a-b),m=iois[iois.length>>1];
  const out=[beats[0]];
  for(let i=1;i<beats.length;i++){
    const g=beats[i]-beats[i-1],k=Math.round(g/m);
    if(k>=2&&Math.abs(g-k*m)<m*0.3)for(let j=1;j<k;j++)out.push(beats[i-1]+g*j/k);
    out.push(beats[i]);
  }
  return out;
}
function aiBpm(beats){if(beats.length<3)return 0;const iois=beats.slice(1).map((t,i)=>t-beats[i]).sort((a,b)=>a-b);return 60/iois[iois.length>>1];}
// Longest a clip can run from newStart (limited by its media, if any).
function _aiMaxLen(c){
  if(c.type!=='video'&&c.type!=='audio')return Infinity;
  if(c.freeze)return Infinity;
  const m=aiMediaOfClip(c);if(!m||!(m.duration>0))return Infinity;
  const sp=(c.props.speed)||1;
  return c.props.reverse?Infinity:(m.duration-(c.inPoint||0))/sp;
}
/* Move/resize clip c to [s,e] on the timeline while every frame it still shows
   keeps its exact source frame (forward, reversed and frozen clips). Returns
   false when the media doesn't reach that far. */
function aiResizeClip(c,s,e){
  const end=clipEnd(c),sp=(c.props.speed)||1,m=aiMediaOfClip(c);
  const mediaDur=(m&&m.duration>0&&(c.type==='video'||c.type==='audio'))?m.duration:Infinity;
  if(e-s<1e-3)return false;
  if(s>=c.start-1e-6&&e<=end+1e-6){const p=aiClipSub(c,s,e);Object.assign(c,p,{id:c.id});if(!p.kf)delete c.kf;return true;}
  let inP=c.inPoint||0;
  if(!c.freeze&&(c.type==='video'||c.type==='audio')){   // stills, titles, colors: no source time
    inP=c.props.reverse?inP+(end-e)*sp:inP+(s-c.start)*sp;
    if(inP<-1e-6||inP+(e-s)*sp>mediaDur+1e-3)return false;
  }
  if(c.kf){const d=c.start-s;for(const k in c.kf)c.kf[k]=c.kf[k].map(q=>Object.assign({},q,{t:q.t+d})).filter(q=>q.t>=-1e-6&&q.t<=e-s+1e-6);}
  c.inPoint=Math.max(0,inP);c.start=s;c.duration=e-s;
  return true;
}
// Lay `clips` back to back from the first beat at/after the first clip, each
// `every` beats long (shorter when its media runs out). Linked partners follow.
function aiCutToBeats(clips,beats,every){
  const cs=clips.slice().sort((a,b)=>a.start-b.start);if(!cs.length||beats.length<2)return {ok:false,msg:'Not enough beats'};
  const track=cs[0].track;
  let i=beats.findIndex(t=>t>=cs[0].start-0.05);if(i<0)return {ok:false,msg:'The music ends before these clips start'};
  const plan=[],short=[];
  for(const c of cs){
    if(i>=beats.length-1)break;
    let n=Math.min(every,beats.length-1-i);
    const max=_aiMaxLen(c);
    while(n>1&&beats[i+n]-beats[i]>max+1e-6)n--;
    let s=aiFrameSnap(beats[i]),e=aiFrameSnap(beats[i+n]);
    if(e-s>max+1e-6){e=s+max;short.push(c);}
    plan.push({c,s,e});i+=n;
  }
  const moving=new Set();plan.forEach(p=>linkedPartners(p.c.id).forEach(id=>moving.add(id)));
  const lo=plan[0].s,hi=plan[plan.length-1].e;
  const blocker=state.clips.find(o=>!moving.has(o.id)&&o.track===track&&o.start<hi-1e-6&&clipEnd(o)>lo+1e-6);
  if(blocker)return {ok:false,msg:'“'+blocker.name+'” is in the way on '+((trackOf(track)||{}).name||track)+' — move it or use an empty track'};
  pushHistory();
  for(const p of plan){
    const c=p.c,ds=p.s-c.start,dd=(p.e-p.s)-c.duration;
    for(const id of linkedPartners(c.id)){if(id===c.id)continue;const o=state.clips.find(x=>x.id===id);
      if(o)aiResizeClip(o,o.start+ds,Math.max(o.start+ds+0.05,clipEnd(o)+ds+dd));}
    if(!aiResizeClip(c,p.s,p.e)){c.start=p.s;}   // can't be resized: at least land on the beat
  }
  renderTimeline();renderInspector();requestDraw();
  return {ok:true,placed:plan.length,short:short.length,unplaced:cs.length-plan.length};
}
// Move each cut between neighboring clips onto the nearest beat (within 45% of
// a beat). A roll: the left clip grows or shrinks, the right one opposite, so
// nothing downstream moves. Skipped where the media doesn't reach.
function aiSnapCutsToBeats(clips,beats){
  if(beats.length<2)return {ok:false,msg:'Not enough beats'};
  const ioi=60/Math.max(1,aiBpm(beats)),set=new Set(clips.map(c=>c.id));
  const tracks=[...new Set(clips.map(c=>c.track))];
  pushHistory();let moved=0,skipped=0;
  for(const tr of tracks){
    const cs=state.clips.filter(c=>c.track===tr&&set.has(c.id)).sort((a,b)=>a.start-b.start);
    for(let k=0;k<cs.length-1;k++){
      const A=cs[k],B=cs[k+1],x=clipEnd(A);
      if(Math.abs(B.start-x)>1e-3)continue;                 // not a cut, a gap
      let b=null,bd=Infinity;for(const t of beats){const d=Math.abs(t-x);if(d<bd){bd=d;b=t;}}
      if(b==null||bd>ioi*0.45||bd<1e-4)continue;
      b=aiFrameSnap(b);
      // linked partners (the clips' own sound) roll with them, so sync holds
      const part=(c,atEnd)=>(typeof linkedPartners==='function'?linkedPartners(c.id):[]).map(id=>state.clips.find(o=>o.id===id))
        .filter(o=>o&&o!==A&&o!==B&&!set.has(o.id)&&!state.locked[o.track]&&Math.abs((atEnd?clipEnd(o):o.start)-x)<1e-3);
      const pA=part(A,true),pB=part(B,false),all=[A,B,...pA,...pB],saved=all.map(c=>JSON.stringify(c));
      let ok=b>A.start+0.05&&b<clipEnd(B)-0.05&&aiResizeClip(A,A.start,b)&&aiResizeClip(B,b,clipEnd(B));
      if(ok)for(const o of pA)if(!(b>o.start+0.05&&aiResizeClip(o,o.start,b))){ok=false;break;}
      if(ok)for(const o of pB)if(!(b<clipEnd(o)-0.05&&aiResizeClip(o,b,clipEnd(o)))){ok=false;break;}
      if(!ok){all.forEach((c,i)=>{for(const k of Object.keys(c))delete c[k];Object.assign(c,JSON.parse(saved[i]));});skipped++;continue;}
      moved++;
    }
  }
  renderTimeline();renderInspector();requestDraw();
  return {ok:true,moved,skipped};
}
async function aiBeatSyncDialog(){
  const music=state.clips.filter(c=>c.type==='audio'||(c.type==='video'&&aiClipSpeaks(c)));
  if(!music.length){toast('Put a music clip on the timeline first');return;}
  const sel=selectedIds().map(id=>state.clips.find(c=>c.id===id)).filter(c=>c&&c.type!=='audio');
  const selA=state.clips.find(c=>c.id===state.selection&&c.type==='audio');
  // the music: prefer a clip with no transcribed speech in it (the voice is
  // usually the longest clip), then the longest
  const talky=c=>{const r=aiRoot(aiMediaOfClip(c)),tr=aiTranscriptOf(r);if(!tr)return 0;const s0=c.inPoint||0,s1=s0+c.duration*((c.props.speed)||1);
    return tr.words.filter(w=>!w[3]&&w[1]>=s0&&w[1]<s1).length/Math.max(1,c.duration);};
  let src=selA||music.slice().sort((a,b)=>(talky(a)>0.3)-(talky(b)>0.3)||b.duration-a.duration)[0];
  let tf=1,every=+(localStorage.getItem('vibe-beat-every')||2),mode=sel.length>=2?'cut':'snap';
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal aimodal" style="width:min(520px,94vw)">
    <div class="modal-head"><div><h3>Beat sync</h3><div class="sub" id="bsSub">Finding the beat…</div></div>
      <button class="mclose" id="bsX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="row2">
        <div class="field"><label>Music</label><select class="tsel" id="bsSrc" title="Which clip sets the beat">${music.map(c=>`<option value="${c.id}"${c===src?' selected':''}>${esc(c.name)} (${esc((trackOf(c.track)||{}).name||c.track)})</option>`).join('')}</select></div>
        <div class="field"><label>Cut every</label><div class="seg" id="bsEvery" title="How many beats each shot lasts">${[1,2,4,8].map(n=>`<button data-n="${n}" class="${n===every?'on':''}" title="${n} beat${n>1?'s':''} per shot">${n}</button>`).join('')}</div> <span class="bs-unit">beats</span></div>
      </div>
      <div class="ai-radio">
        <label title="${sel.length>=2?'Lay the selected shots back to back, each lasting the chosen number of beats':'Select two or more video, image or title clips first'}"><input type="radio" name="bsMode" value="cut"${mode==='cut'?' checked':''}${sel.length>=2?'':' disabled'}><span><b>Cut the selected clips to the beat</b>
          <small>${sel.length>=2?sel.length+' clips, laid back to back from the first beat, each lasting the chosen number of beats.':'Select two or more video, image or title clips first.'}</small></span></label>
        <label title="Move each cut between neighboring clips onto the nearest beat — nothing downstream moves"><input type="radio" name="bsMode" value="snap"${mode==='snap'?' checked':''}><span><b>Snap my cuts to the nearest beat</b>
          <small>Nudges each cut between neighboring clips onto the beat. Nothing else moves. ${sel.length?'Uses the selected clips.':'Uses every clip on the video tracks.'}</small></span></label>
        <label title="Only place a marker on every beat — clips snap to them while you drag"><input type="radio" name="bsMode" value="mark"${mode==='mark'?' checked':''}><span><b>Just add beat markers</b><small>Clips snap to markers while you drag them.</small></span></label>
      </div>
      <div class="field"><label>Tempo</label><div class="seg" id="bsTempo" title="If the cuts feel twice too fast or too slow, the song may be counted in half or double time">
        <button data-tf="0.5" title="Half the detected tempo — every other beat">Half</button><button data-tf="1" class="on" title="The tempo as detected">As detected</button><button data-tf="2" title="Double the detected tempo — a beat between every beat">Double</button></div></div>
    </div>
    <div class="modal-foot"><div class="note">One undo step.</div><button class="tbtn primary" id="bsGo" title="Apply" disabled>Apply</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#bsX').onclick=closeOverlay;
  let beats=[];
  const load=async()=>{
    $('#bsGo').disabled=true;$('#bsSub').textContent='Finding the beat…';
    try{beats=await aiBeatsOfClip(src,tf);}catch(e){beats=[];$('#bsSub').textContent=String(e.message||e);return;}
    const bpm=aiBpm(beats);
    $('#bsSub').textContent=beats.length?beats.length+' beats · about '+Math.round(bpm)+' BPM':'No steady beat found in this clip';
    $('#bsGo').disabled=!beats.length;
  };
  $('#bsSrc').onchange=e=>{src=state.clips.find(c=>c.id===e.target.value)||src;load();};
  $$('#bsTempo button').forEach(b=>b.onclick=()=>{tf=+b.dataset.tf;$$('#bsTempo button').forEach(x=>x.classList.toggle('on',x===b));load();});
  $$('#bsEvery button').forEach(b=>b.onclick=()=>{every=+b.dataset.n;try{localStorage.setItem('vibe-beat-every',every);}catch(e){}
    $$('#bsEvery button').forEach(x=>x.classList.toggle('on',x===b));});
  $('#bsGo').onclick=()=>{
    mode=(ov.querySelector('input[name=bsMode]:checked')||{}).value;
    if(mode==='mark'){pushHistory();beats.forEach(t=>addMarker(t,'beat'));state.markers.sort((a,b)=>a.t-b.t);closeOverlay();renderTimeline();toast(beats.length+' beat markers added','ok');return;}
    if(mode==='cut'){const r=aiCutToBeats(sel,beats,every);if(!r.ok){toast(r.msg,'err',5000);return;}closeOverlay();
      toast('Cut '+r.placed+' clip'+(r.placed>1?'s':'')+' to the beat'+(r.short?' — '+r.short+' ran out of footage early':'')+(r.unplaced?' — the music ended before '+r.unplaced+' more':''),'ok',5000);return;}
    const targets=sel.length?sel:state.clips.filter(c=>(trackOf(c.track)||{}).kind==='video');
    const r=aiSnapCutsToBeats(targets,beats);closeOverlay();
    toast(r.moved?'Moved '+r.moved+' cut'+(r.moved>1?'s':'')+' onto the beat'+(r.skipped?' ('+r.skipped+' couldn’t move — not enough footage)':''):'No cuts were close enough to a beat to move','ok',4500);
  };
  load();
}
