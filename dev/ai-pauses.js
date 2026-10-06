
/* ---------- 4b. Pause detection ----------
   Purely acoustic: a pause is a stretch where none of the chosen tracks has a
   voice. Each source is judged against its OWN automatic threshold (a quiet
   lapel mic and a loud camera mic can't share one dB number), shifted by the
   user's sensitivity offset. Only time covered by those clips is considered, so
   a silent title card is never mistaken for a pause. */
function aiSpeakingClips(tracks){
  return state.clips.filter(c=>aiClipSpeaks(c)&&(!tracks||tracks.includes(c.track)));
}
// Timeline activity at 10 ms resolution: covered[f] (a chosen clip is there),
// voiced[f] (one of them has a voice).
function aiTimelineActivity(tracks,offsetDb){
  const hop=AI_HOP,D=projDuration(),n=Math.ceil(D/hop)+1;
  const covered=new Uint8Array(n),voiced=new Uint8Array(n);
  for(const c of aiSpeakingClips(tracks)){
    const root=aiRoot(aiMediaOfClip(c)),env=_aiEnv[root.id];if(!env)continue;
    // Silence must sit near the noise floor, not merely under the speech
    // threshold: soft consonants and trailing syllables live in between, and
    // cutting them is audible. (MEASURED: with the plain speech threshold, a
    // noisy test recording lost 133 ms of a word inside a sentence.)
    const thr=aiSilenceLevel(env)+(offsetDb||0);
    const f0=Math.max(0,Math.ceil(c.start/hop)),f1=Math.min(n-1,Math.floor(clipEnd(c)/hop)-1);
    for(let f=f0;f<=f1;f++){
      covered[f]=1;
      if(aiDbAt(env,aiTlToSrc(c,f*hop))>thr)voiced[f]=1;
    }
  }
  return {covered,voiced,hop};
}
function aiSilenceLevel(env){return env.floor+(env.auto-env.floor)*0.5;}
// Silent runs as [start,end] timeline seconds. A voiced blip shorter than 60 ms
// (a click, a bump) doesn't break a pause.
function aiFindPauses(act,minPause){
  const {covered,voiced,hop}=act,out=[];let st=-1,blip=0;
  for(let f=0;f<=covered.length;f++){
    const sil=f<covered.length&&covered[f]&&!voiced[f];
    const vo=f<covered.length&&covered[f]&&voiced[f];
    if(sil){if(st<0)st=f;blip=0;continue;}
    if(vo&&st>=0&&blip<6){blip++;continue;}
    if(st>=0){const e=f-blip;if((e-st)*hop>=minPause)out.push([st*hop,e*hop]);}
    st=-1;blip=0;
  }
  return out;
}
// Cut ranges that leave `keep` seconds of each pause in place (split evenly).
function aiPauseCuts(pauses,keep){
  return pauses.map(([a,b])=>[a+keep/2,b-keep/2]).filter(r=>r[1]-r[0]>=1/_aiFps());
}
async function aiEnsureEnvelopesForTracks(tracks,prog){
  const roots=[...new Set(aiSpeakingClips(tracks).map(c=>aiRoot(aiMediaOfClip(c))))];
  const need=roots.filter(r=>!_aiEnv[r.id]);
  for(let i=0;i<need.length;i++){
    if(prog)prog(i/need.length,'Listening to “'+need[i].name+'”…');
    try{await aiEnsureEnvelope(need[i]);}catch(e){toast(String(e.message||e),'err');}
  }
  return roots;
}
const _aiPauseOpts={min:0.6,keep:0.25,off:0};
async function aiPausesDialog(){
  const tracks=[...new Set(aiSpeakingClips().map(c=>c.track))];
  if(!tracks.length){toast(typeof aiSpeechInCompound==='function'&&aiSpeechInCompound()?AI_CMP_MSG:'Put a clip with sound on the timeline first','',5000);return;}
  const ok=await aiRunJob('Analyzing audio',async prog=>{await aiEnsureEnvelopesForTracks(tracks,prog);return true;});
  if(!ok)return;
  const unlocked=tracks.filter(t=>!state.locked[t]);
  const pick=new Set(unlocked.length?unlocked:tracks);
  const o=_aiPauseOpts;
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal aimodal" style="width:min(620px,94vw)">
    <div class="modal-head"><div><h3>Remove pauses</h3>
      <div class="sub">Tighten dead air between phrases. Everything stays in sync; lock a track to leave it alone.</div></div>
      <button class="mclose" id="apX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <canvas id="apStrip" class="ap-strip" height="64" title="Your timeline’s audio. Red stretches are the pauses that will be cut."></canvas>
      <div class="ap-stats" id="apStats"></div>
      <div class="ap-grid">
        <div class="ctl" title="Only pauses at least this long are touched — short breaths between words stay"><label>Longer than</label><input type="range" id="apMin" min="0.2" max="3" step="0.05" value="${o.min}"><span class="val" id="apMinV"></span><span></span></div>
        <div class="ctl" title="How much of each pause to leave in place so speech still breathes. 0 = butt the phrases together."><label>Leave</label><input type="range" id="apKeep" min="0" max="1" step="0.05" value="${o.keep}"><span class="val" id="apKeepV"></span><span></span></div>
        <div class="ctl" title="How quiet counts as silence, relative to the automatic level measured for each clip. Raise it if background noise hides the pauses; lower it if soft words are being treated as silence."><label>Silence level</label><input type="range" id="apOff" min="-12" max="12" step="1" value="${o.off}"><span class="val" id="apOffV"></span><span></span></div>
      </div>
      <div class="ap-tracks"><span class="ap-lab">Listen to</span>${tracks.map(t=>`<label class="rv-opt" title="${state.locked[t]?'Locked — this track is never cut, but you can still listen to it':'Detect pauses from this track’s sound. Untick music beds — they would hide the pauses.'}"><input type="checkbox" data-trk="${t}"${pick.has(t)?' checked':''}> ${esc((trackOf(t)||{}).name||t)}${state.locked[t]?' (locked)':''}</label>`).join('')}</div>
    </div>
    <div class="modal-foot"><div class="note">One undo step. Locked tracks keep their timing.</div>
      <button class="tbtn" id="apPlay" title="Listen to the first pause that will be cut, with a second either side">Hear first pause</button>
      <button class="tbtn primary" id="apGo" title="Cut the red stretches out of the timeline">Remove pauses</button></div></div>`;
  setOverlayDismiss(closeOverlay);
  $('#apX').onclick=closeOverlay;
  let cuts=[];
  const redraw=()=>{
    if(!$('#apMin'))return;   // closed before a queued redraw ran
    o.min=+$('#apMin').value;o.keep=Math.max(0,Math.min(+$('#apKeep').value,o.min-0.05));o.off=+$('#apOff').value;
    if(Math.abs(+$('#apKeep').value-o.keep)>1e-9)$('#apKeep').value=o.keep;   // the slider shows what is really used
    $('#apMinV').textContent=o.min.toFixed(2)+'s';$('#apKeepV').textContent=Math.max(0,o.keep).toFixed(2)+'s';
    $('#apOffV').textContent=o.off?'Auto '+(o.off>0?'+':'−')+Math.abs(o.off)+' dB':'Auto';
    const trs=[...pick];
    const act=aiTimelineActivity(trs,o.off);
    const pauses=aiFindPauses(act,o.min);
    cuts=aiNormalizeRanges(aiPauseCuts(pauses,Math.max(0,o.keep)));
    const removed=cuts.reduce((a,r)=>a+r[1]-r[0],0),D=projDuration()||1;
    $('#apStats').innerHTML=cuts.length?`<b>${cuts.length}</b> pause${cuts.length>1?'s':''} · <b>${removed.toFixed(1)} s</b> shorter (${Math.round(removed/D*100)}%) → new length <b>${fmtDur(D-removed)}</b>`:'No pauses that long — try a shorter minimum or raise the silence level';
    $('#apGo').disabled=!cuts.length;$('#apPlay').disabled=!cuts.length;
    const cv=$('#apStrip'),W=cv.width=cv.clientWidth*devicePixelRatio,H=cv.height=64*devicePixelRatio,g=cv.getContext('2d');
    g.clearRect(0,0,W,H);
    const css=getComputedStyle(document.body),acc=css.getPropertyValue('--accent').trim()||'#ffb454',fnt=css.getPropertyValue('--faint').trim()||'#666';
    const cols=W,step=act.covered.length/cols;
    for(let x=0;x<cols;x++){
      let cov=0,vo=0;const a=Math.floor(x*step),b=Math.max(a+1,Math.floor((x+1)*step));
      for(let f=a;f<b&&f<act.covered.length;f++){cov+=act.covered[f];vo+=act.voiced[f];}
      if(!cov)continue;const k=vo/(b-a);
      g.fillStyle=k>0?acc:fnt;g.globalAlpha=k>0?0.9:0.35;
      const h=k>0?Math.max(3,k*H*0.8):2;g.fillRect(x,(H-h)/2,1,h);
    }
    g.globalAlpha=0.28;g.fillStyle='#ff4d5e';
    for(const [a,b] of cuts){const x0=a/D*W,x1=b/D*W;g.fillRect(x0,0,Math.max(1,x1-x0),H);}
    g.globalAlpha=1;
  };
  ['#apMin','#apKeep','#apOff'].forEach(s=>$(s).oninput=redraw);
  $$('#overlay [data-trk]').forEach(cb=>cb.onchange=()=>{if(cb.checked)pick.add(cb.dataset.trk);else pick.delete(cb.dataset.trk);redraw();});
  // Preview with the dialog still open, so none of its settings are lost.
  $('#apPlay').onclick=()=>{
    if(state.playing){setPlaying(false);$('#apPlay').textContent='Hear first pause';return;}
    if(!cuts.length)return;const [a,b]=cuts[0];aiPlayRange(Math.max(0,a-1),b+1);
    $('#apPlay').textContent='Stop';
    const done=()=>{const bt=$('#apPlay');if(!bt)return;if(state.playing)return requestAnimationFrame(done);bt.textContent='Hear first pause';};
    requestAnimationFrame(done);};
  $('#apGo').onclick=()=>{const n=cuts.length;setPlaying(false);closeOverlay();const res=aiCutFollowCaptions(cuts);
    if(res)toast('Removed '+n+' pause'+(n>1?'s':'')+' — '+res.removed.toFixed(1)+' s shorter. Ctrl+Z to undo','ok',4200);};
  requestAnimationFrame(redraw);
}
