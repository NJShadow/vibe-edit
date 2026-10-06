/* ==================== PRO: AUTO-DUCKING (v4.7) ====================
   Music dips under speech. The result is ordinary volume keyframes on the
   music clips, so it previews, exports and can be hand-tuned like any other
   keyframe. Re-running replaces the previous ducking instead of stacking on
   it, as long as the keys haven't been hand-edited since (c.duck.sig).

   Speech comes from the transcript when the voice clip has one (words only,
   not sound tags — a cough shouldn't pump the music), otherwise from the
   audio itself (above that clip's automatic speech level). */
const _proDuckOpts={db:-12,down:0.25,up:0.6,hold:0.5,pre:0.08};

// Timeline intervals [a,b] where one of the voice tracks is speaking.
function proSpeechIntervals(voiceTracks,o){
  o=o||_proDuckOpts;const iv=[];
  // playClips(): speech inside compound clips counts too (v4.7)
  const src=(typeof playClips==='function'?playClips():state.clips).filter(c=>aiClipSpeaks(c)&&voiceTracks.includes(c.track));
  for(const c of src){
    const root=aiRoot(aiMediaOfClip(c));if(!root)continue;
    const s0=c.inPoint||0,s1=s0+c.duration*((c.props.speed)||1);
    const tr=aiTranscriptOf(root);
    const cov=tr&&(tr.covered||[]).reduce((n,r)=>n+Math.max(0,Math.min(r[1],s1)-Math.max(r[0],s0)),0);
    if(tr&&cov>=(s1-s0)*0.9){
      for(const w of tr.words){
        if(w[3]||w[2]<=s0||w[1]>=s1)continue;
        iv.push([aiSrcToTl(c,Math.max(w[1],s0)),aiSrcToTl(c,Math.min(w[2],s1))]);
      }
      continue;
    }
    const env=_aiEnv[root.id];if(!env)continue;
    const thr=env.auto+(o.off||0),hop=env.hop;
    let st=-1,gap=0;const f0=Math.floor(s0/hop),f1=Math.ceil(s1/hop);
    for(let f=f0;f<=f1+1;f++){
      const on=f<=f1&&aiDbAt(env,f*hop)>thr;
      if(on){if(st<0)st=f;gap=0;continue;}
      if(st>=0&&++gap>15){const e=f-gap+1;if((e-st)*hop>=0.12)iv.push([aiSrcToTl(c,Math.max(st*hop,s0)),aiSrcToTl(c,Math.min(e*hop,s1))]);st=-1;gap=0;}
    }
    if(st>=0){const e=f1;if((e-st)*hop>=0.12)iv.push([aiSrcToTl(c,st*hop),aiSrcToTl(c,Math.min(e*hop,s1))]);}
  }
  // Merge: gaps shorter than `hold`, or too short to fade up and back down,
  // stay ducked — the music never pumps between words.
  iv.sort((a,b)=>a[0]-b[0]);
  const bridge=Math.max(o.hold,o.down+o.up+o.pre),out=[];
  for(const r of iv){const l=out[out.length-1];if(l&&r[0]-l[1]<bridge)l[1]=Math.max(l[1],r[1]);else out.push([r[0],r[1]]);}
  return out;
}
// Duck gain (0..1 multiplier) at timeline time t for the given intervals.
function proDuckGain(iv,t,o){
  o=o||_proDuckOpts;const d=Math.pow(10,o.db/20);let g=1;
  for(const [a0,b] of iv){const a=a0-o.pre;
    if(t<a-o.down||t>b+o.up)continue;
    let x;
    if(t<a)x=1-(t-(a-o.down))/o.down*(1-d);
    else if(t<=b)x=d;
    else x=d+(t-b)/o.up*(1-d);
    g=Math.min(g,x);
  }
  return g;
}
function _proVolSig(c){return JSON.stringify((c.kf&&c.kf.volume)||null);}
// v4.10.2: a speed change re-times the volume keys (kfSpeedRetime). When they are
// still exactly ours, re-time the record with them so Remove ducking still
// recognizes them and restores the clip's own (re-timed) keys.
function proDuckOwned(c){return !!(c.duck&&_proVolSig(c)===c.duck.sig);}
function proDuckRetime(c,map){
  const d=c.duck;if(!d)return;
  const rt=a=>{if(Array.isArray(a))for(const q of a)q.t=map(q.t);};
  rt(d.keys);rt(d.prev);
  d.sig=_proVolSig(c);d.in0=c.inPoint||0;d.sp=(c.props.speed)||1;d.dur=c.duration;d.ramp=c.ramp?JSON.parse(JSON.stringify(c.ramp)):undefined;
}
// Put a clip's volume back to what it was before our ducking (if untouched).
// A split or trim slices the keys but copies c.duck as it was, so compare
// against OUR keys cut to this clip's part of the original (in0 = the ducked
// clip's in-point) before deciding the keys are still ours.
function _proDuckPart(c,keys){
  const d=c.duck;let off=((c.inPoint||0)-(d.in0||0))/((d.sp)||1);
  if(d.ramp&&c.ramp&&typeof rampSrcToTl==='function'){   // v4.9: a speed-ramped music clip that was split since
    const whole={start:0,duration:d.dur,inPoint:d.in0||0,props:{speed:d.sp||1,reverse:!!(c.props&&c.props.reverse)},ramp:d.ramp};
    off=rampSrcToTl(whole,rampTlToSrc(c,c.start));
  }
  if(!keys)return null;
  if(Math.abs(off)<1e-6&&Math.abs(c.duration-(d.dur||c.duration))<1e-6)return keys;
  if(off<-1e-6||typeof _aiKfSlice!=='function')return undefined;
  const s=_aiKfSlice({volume:keys},off,c.duration,c.kfEaseMode||'smooth');
  return s&&s.volume?s.volume:null;
}
function _proSameKeys(a,b){
  if(!a||!b||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(Math.abs(a[i].t-b[i].t)>2e-3||Math.abs(a[i].v-b[i].v)>2e-3)return false;
  return true;
}
function proUnduckClip(c){
  if(!c.duck)return false;
  const cur=c.kf&&c.kf.volume;
  let mine=_proVolSig(c)===c.duck.sig,prev=c.duck.prev;
  if(!mine&&c.duck.keys){const exp=_proDuckPart(c,c.duck.keys);
    if(exp&&_proSameKeys(exp,cur)){mine=true;prev=prev?_proDuckPart(c,prev):null;}}
  if(mine){
    c.kf=c.kf||{};
    if(prev&&prev.length)c.kf.volume=JSON.parse(JSON.stringify(prev));
    else{delete c.kf.volume;if(!Object.keys(c.kf).length)delete c.kf;}
  }
  delete c.duck;return mine;
}
// A compound clip with sound counts as music too: its dips are written as volume
// keys on the compound itself, which fold into everything it plays (_cmpGainKeys).
function proMusicClips(musicTracks){
  return state.clips.filter(c=>(c.type==='audio'||c.type==='video'||c.type==='compound'&&typeof proCmpHasSound==='function'&&proCmpHasSound(c))
    &&musicTracks.includes(c.track)&&!state.locked[c.track]);
}
// Apply ducking. Returns {clips, dips, seconds}.
function proApplyDucking(voiceTracks,musicTracks,o){
  o=Object.assign({},_proDuckOpts,o||{});
  const iv=proSpeechIntervals(voiceTracks,o);
  let clips=0,secs=0;const hit=new Set();
  for(const c of proMusicClips(musicTracks)){
    proUnduckClip(c);
    const t0=c.start,t1=clipEnd(c);
    const mine=iv.filter(([a,b])=>b+o.up>t0&&a-o.pre-o.down<t1);
    if(!mine.length)continue;
    const prev=c.kf&&c.kf.volume&&c.kf.volume.length?JSON.parse(JSON.stringify(c.kf.volume)):null;
    const mode=c.kfEaseMode||'smooth';
    const base=lt=>prev?kfEval(prev,lt,mode):(c.props.volume??1);
    const T=new Set([0,+c.duration.toFixed(3)]);
    for(const [a,b] of mine)for(const t of [a-o.pre-o.down,a-o.pre,b,b+o.up]){const lt=t-t0;if(lt>0&&lt<c.duration)T.add(+lt.toFixed(3));}
    if(prev)for(const q of prev)if(q.t>=0&&q.t<=c.duration)T.add(+q.t.toFixed(3));
    const keys=[...T].sort((a,b)=>a-b).filter((t,i,A)=>i===0||t-A[i-1]>=KF_EPS)
      .map(lt=>({t:lt,v:+(base(lt)*proDuckGain(mine,t0+lt,o)).toFixed(4)}));
    // drop keys that sit on a straight run (same value both sides)
    const lean=keys.filter((k,i)=>i===0||i===keys.length-1||!(keys[i-1].v===k.v&&keys[i+1].v===k.v));
    c.kf=c.kf||{};c.kf.volume=lean;
    c.duck={prev,sig:_proVolSig(c),db:o.db,keys:JSON.parse(JSON.stringify(lean)),in0:c.inPoint||0,sp:(c.props.speed)||1,dur:c.duration,ramp:c.ramp?JSON.parse(JSON.stringify(c.ramp)):undefined};
    clips++;mine.forEach(r=>hit.add(r));secs+=mine.reduce((s,[a,b])=>s+Math.max(0,Math.min(b,t1)-Math.max(a,t0)),0);
  }
  return {clips,dips:hit.size,seconds:secs,intervals:iv};
}
// Which tracks sound like voice vs music, as a starting point for the dialog.
function proGuessRoles(){
  const roles={};
  for(const t of TRACKS){if(t.kind==='text')continue;
    const cs=(typeof playClips==='function'?playClips():state.clips).filter(c=>c.track===t.id&&(c.type==='audio'||c.type==='video'));
    if(!cs.length)continue;
    const talks=cs.some(c=>{const r=aiRoot(aiMediaOfClip(c));const tr=aiTranscriptOf(r);return tr&&tr.words.filter(w=>!w[3]).length>=5;});
    // camera sound (a video clip, loose or inside a compound) is usually dialogue;
    // a compound on a video track holding only audio clips is guessed from what's in it
    roles[t.id]=talks||cs.some(c=>c.type==='video')?'voice':'music';
  }
  // no voice at all (e.g. two audio tracks): the first audio track with its own clips talks
  const ids=Object.keys(roles);
  if(ids.length>1&&!ids.some(k=>roles[k]==='voice')){
    const own=ids.find(k=>(trackOf(k)||{}).kind==='audio'&&state.clips.some(c=>c.track===k&&c.type==='audio'));
    roles[own||ids[0]]='voice';}
  return roles;
}
async function proDuckDialog(){
  const roles=proGuessRoles();const ids=Object.keys(roles);
  if(ids.length<2){toast('Ducking needs speech on one track and music on another');return;}
  const voiceOf=()=>ids.filter(k=>roles[k]==='voice'),musicOf=()=>ids.filter(k=>roles[k]==='music');
  const ok=await aiRunJob('Listening for speech',async prog=>{
    const roots=[...new Set((typeof playClips==='function'?playClips():state.clips).filter(c=>aiClipSpeaks(c)&&ids.includes(c.track)).map(c=>aiRoot(aiMediaOfClip(c))))].filter(r=>r&&!_aiEnv[r.id]);
    for(let i=0;i<roots.length;i++){prog(i/roots.length,'Listening to \u201c'+roots[i].name+'\u201d\u2026');try{await aiEnsureEnvelope(roots[i]);}catch(e){toast(String(e.message||e),'err');}}
    return true;});
  if(!ok)return;
  const o=_proDuckOpts;
  const ov=$('#overlay');ov.classList.add('show');
  const trackRow=k=>`<div class="dk-row"><span class="dk-name">${esc((trackOf(k)||{}).name||k)}${state.locked[k]?' <i title="Locked tracks are never changed">(locked)</i>':''}</span>
    <div class="seg dk-seg" data-dk="${k}">
      <button data-role="voice" title="Speech on this track makes the music dip">Voice</button>
      <button data-role="music" title="This track dips while someone speaks">Music</button>
      <button data-role="off" title="Leave this track out">Ignore</button></div></div>`;
  ov.innerHTML=`<div class="modal aimodal" style="width:min(660px,94vw)">
    <div class="modal-head"><div><h3>Auto-duck music</h3>
      <div class="sub">Music dips smoothly while someone speaks and comes back up in the pauses. The dips are ordinary volume keyframes you can fine-tune.</div></div>
      <button class="mclose" id="dkX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <canvas id="dkStrip" class="ap-strip" height="72" title="Speech (bars) and the music level it produces (line)"></canvas>
      <div class="ap-stats" id="dkStats"></div>
      <div class="dk-tracks">${ids.map(trackRow).join('')}</div>
      <div class="ap-grid">
        <div class="ctl" title="How far the music drops under speech. −12 dB is about a quarter of the loudness; −18 dB sits well under a voice."><label>Duck by</label><input type="range" id="dkDb" min="-30" max="-3" step="1" value="${o.db}"><span class="val" id="dkDbV"></span><span></span></div>
        <div class="ctl" title="How quickly the music fades down before speech starts"><label>Fade down</label><input type="range" id="dkDown" min="0.05" max="1.5" step="0.05" value="${o.down}"><span class="val" id="dkDownV"></span><span></span></div>
        <div class="ctl" title="How gently the music comes back after speech ends"><label>Fade up</label><input type="range" id="dkUp" min="0.1" max="3" step="0.05" value="${o.up}"><span class="val" id="dkUpV"></span><span></span></div>
        <div class="ctl" title="Pauses shorter than this stay ducked, so the music doesn't pump between sentences"><label>Hold through</label><input type="range" id="dkHold" min="0" max="3" step="0.1" value="${o.hold}"><span class="val" id="dkHoldV"></span><span></span></div>
      </div>
    </div>
    <div class="modal-foot"><div class="note">One undo step. Running it again replaces the previous ducking.</div>
      <button class="tbtn" id="dkUndo" title="Remove the ducking keyframes this tool added (clips you've edited by hand are left alone)">Remove ducking</button>
      <button class="tbtn" id="dkPlay" title="Listen to the first dip, with two seconds either side">Hear first dip</button>
      <button class="tbtn primary" id="dkGo" title="Add the ducking keyframes to the music clips">Duck music</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#dkX').onclick=closeOverlay;
  const anyDucked=()=>state.clips.some(c=>c.duck);
  let iv=[];
  const redraw=()=>{
    if(!$('#dkDb'))return;   // the dialog was closed before a queued redraw ran
    o.db=+$('#dkDb').value;o.down=+$('#dkDown').value;o.up=+$('#dkUp').value;o.hold=+$('#dkHold').value;
    $('#dkDbV').textContent=o.db+' dB';$('#dkDownV').textContent=o.down.toFixed(2)+'s';$('#dkUpV').textContent=o.up.toFixed(2)+'s';$('#dkHoldV').textContent=o.hold.toFixed(1)+'s';
    $$('#overlay [data-dk]').forEach(sg=>sg.querySelectorAll('button').forEach(b=>b.classList.toggle('on',roles[sg.dataset.dk]===b.dataset.role)));
    const V=voiceOf(),M=musicOf();
    iv=V.length?proSpeechIntervals(V,o):[];
    const music=proMusicClips(M),D=projDuration()||1;
    const ducked=iv.filter(([a,b])=>music.some(c=>b>c.start&&a<clipEnd(c)));
    const secs=ducked.reduce((s,[a,b])=>s+b-a,0);
    $('#dkStats').innerHTML=!V.length?'Pick at least one Voice track':!M.length?'Pick at least one Music track':
      ducked.length?`<b>${ducked.length}</b> dip${ducked.length>1?'s':''} · music lowered for <b>${secs.toFixed(1)} s</b> of ${fmtDur(D)}`:'No speech found under the music';
    $('#dkGo').disabled=!ducked.length;$('#dkPlay').disabled=!ducked.length;$('#dkUndo').disabled=!anyDucked();
    const cv=$('#dkStrip'),W=cv.width=cv.clientWidth*devicePixelRatio,H=cv.height=72*devicePixelRatio,g=cv.getContext('2d');
    g.clearRect(0,0,W,H);
    const css=getComputedStyle(document.body),acc=css.getPropertyValue('--accent').trim()||'#ffb454',txt=css.getPropertyValue('--text').trim()||'#fff',fnt=css.getPropertyValue('--faint').trim()||'#666';
    g.fillStyle=fnt;g.globalAlpha=0.25;for(const c of music)g.fillRect(c.start/D*W,H*0.15,(clipEnd(c)-c.start)/D*W,H*0.7);
    g.globalAlpha=0.85;g.fillStyle=acc;for(const [a,b] of iv)g.fillRect(a/D*W,H*0.62,Math.max(1,(b-a)/D*W),H*0.23);
    g.globalAlpha=1;g.strokeStyle=txt;g.lineWidth=1.5*devicePixelRatio;g.beginPath();
    for(let x=0;x<=W;x+=2){const t=x/W*D,inM=music.some(c=>t>=c.start&&t<clipEnd(c));const y=H*0.15+(1-proDuckGain(iv,t,o))*H*0.4;
      if(!inM){g.stroke();g.beginPath();continue;}x===0?g.moveTo(x,y):g.lineTo(x,y);}
    g.stroke();
  };
  ['#dkDb','#dkDown','#dkUp','#dkHold'].forEach(s=>$(s).oninput=redraw);
  $$('#overlay [data-dk] button').forEach(b=>b.onclick=()=>{roles[b.closest('[data-dk]').dataset.dk]=b.dataset.role;redraw();});
  $('#dkPlay').onclick=()=>{const M=musicOf(),music=proMusicClips(M);
    const f=iv.find(([a,b])=>music.some(c=>b>c.start&&a<clipEnd(c)));if(!f)return;
    closeOverlay();pushHistory();const res=proApplyDucking(voiceOf(),M,o);renderTimeline();
    aiPlayRange(Math.max(0,f[0]-2),Math.min(projDuration(),f[1]+2));
    toast('Playing the first dip — Ctrl+Z to take the ducking off again','ok',4200);};
  $('#dkUndo').onclick=()=>{pushHistory();let n=0;for(const c of state.clips)if(c.duck&&proUnduckClip(c))n++;
    closeOverlay();renderTimeline();renderInspector();requestDraw();toast(n?'Removed ducking from '+n+' clip'+(n>1?'s':''):'Nothing to remove (hand-edited clips are left alone)','ok');};
  $('#dkGo').onclick=()=>{closeOverlay();pushHistory();const r=proApplyDucking(voiceOf(),musicOf(),o);
    renderTimeline();renderInspector();requestDraw();
    toast(r.clips?`Ducked ${r.clips} music clip${r.clips>1?'s':''} under ${r.dips} stretch${r.dips>1?'es':''} of speech. Ctrl+Z to undo`:'No music overlaps the speech','ok',4200);};
  requestAnimationFrame(redraw);
}
