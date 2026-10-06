
/* ---------- 5. UI: background jobs ----------
   One job at a time (they share the speech worker). A small card shows what is
   happening with a real progress bar and a Cancel that actually stops the work;
   the editor stays fully usable meanwhile. */
function aiJobCard(){
  let el=$('#aiJob');
  if(!el){el=document.createElement('div');el.id='aiJob';el.className='aijob';el.hidden=true;
    el.innerHTML=`<div class="aijob-row"><span class="aijob-spin"></span><span class="aijob-msg" id="aiJobMsg"></span>
      <button class="aijob-x" id="aiJobCancel" title="Stop this task — nothing on your timeline changes">Cancel</button></div>
      <div class="aijob-bar"><i id="aiJobFill"></i></div>`;
    document.body.appendChild(el);
    $('#aiJobCancel').onclick=aiCancelJob;}
  return el;
}
function aiJobProgress(f,msg){
  const el=aiJobCard();el.hidden=false;
  if(msg!=null)$('#aiJobMsg').textContent=msg;
  $('#aiJobFill').style.width=Math.round(clamp(f||0,0,1)*100)+'%';
  if(typeof aiTxOnJob==='function')aiTxOnJob(f,msg);
}
function aiCancelJob(){if(!AI.job)return;AI.cancelled=true;if(AI.cancelHook){try{AI.cancelHook();}catch(e){}}aiStopWorker();}
async function aiRunJob(name,fn){
  if(AI.job){toast('Please wait — “'+AI.job+'” is still running','err');return null;}
  AI.job=name;AI.cancelled=false;aiJobProgress(0,name+'…');
  try{return await fn(aiJobProgress);}
  catch(err){
    const m=String(err&&err.message||err);
    if(AI.cancelled||/cancelled/.test(m))toast(name+' stopped');
    else if(/Failed to fetch|NetworkError|dynamically imported|Load failed/i.test(m))
      toast('Couldn’t download the speech model — the first run needs an internet connection (afterwards it works offline)','err',6000);
    else toast(name+' failed: '+m,'err',6000);
    return null;
  }finally{AI.job=null;AI.cancelled=false;const el=$('#aiJob');if(el)el.hidden=true;
    if(typeof aiTxOnJob==='function')aiTxOnJob(null,null);}
}
// Transcribe everything the timeline needs (only uncovered spans).
async function aiTranscribeTimeline(roots){
  roots=roots||aiTranscriptRoots();
  if(!roots.length){toast('Put a video or audio clip with speech on the timeline first');return null;}
  return aiRunJob('Transcribing',async prog=>{
    let added=0;
    for(let i=0;i<roots.length;i++){
      const r=roots[i],span=aiUsedSpans(r);
      const res=await aiTranscribe(r,span,(f,msg)=>prog((i+f)/roots.length,msg));
      added+=res.added||0;
    }
    aiTxRebuild(true);
    toast(added?'Transcript ready — '+added+' words. Edit the text to edit the video.':'Transcript is up to date','ok',4200);
    return added;
  });
}
function aiNeedsTranscription(){
  return aiTranscriptRoots().some(r=>aiSpanSubtract(aiUsedSpans(r),(aiTranscriptOf(r)||{}).covered||[]).length>0);
}

/* ---------- 5b. UI: transcript panel ---------- */
const TX={list:[],visible:false,sel:null,anchor:null,now:-1,dirty:true,hits:[],hitAt:-1,userScrollAt:0,review:null,jobMsg:null,sig:null,rev:0,paraStarts:new Set(),lastPtr:null};
// Stable key of a transcript entry (survives rebuilds, cuts elsewhere, undo):
// the source + the word's start in SOURCE seconds.
function aiTxKey(x){
  if(!x)return null;
  const tr=x.wi>=0&&aiTranscriptOf(x.root),w=tr&&tr.words[x.wi];
  return ((x.root&&x.root.id)||'')+'|'+x.k+'|'+(w?w[1]:'~'+(+x.s).toFixed(2));
}
// What the timeline transcript depends on. Rebuilding (and losing the
// selection) only when this changes keeps a selection alive through playback,
// clip selection and unrelated edits — and is much cheaper on long transcripts.
const _aiObjIds=new WeakMap();let _aiObjN=0;
function _aiObjId(o){let v=_aiObjIds.get(o);if(!v){v=++_aiObjN;_aiObjIds.set(o,v);}return v;}
function aiTxSig(){
  const parts=[TX.rev,AI.job||''];
  for(const c of state.clips){
    if(!aiClipSpeaks(c))continue;
    const root=aiRoot(aiMediaOfClip(c)),tr=aiTranscriptOf(root);
    parts.push([_aiObjId(c),c.track,c.start,c.duration,c.inPoint,c.props.speed,c.ramp?JSON.stringify(c.ramp):'',root.id,
      tr?_aiObjId(tr)+'/'+tr.words.length+'/'+(tr.covered||[]).length+'/'+(tr.speakers?_aiObjId(tr.speakers)+':'+tr.speakers.n:''):'-',_aiEnv[root.id]?1:0].join(','));
  }
  return parts.join(';');
}
// After a project is reopened the loudness envelopes are gone; the unwritten
// "ums" and clean cut points need them. Rebuild them quietly in the background.
let _aiEnvBg=null;
function aiTxEnvInBackground(){
  if(_aiEnvBg)return _aiEnvBg;
  const need=aiTranscriptRoots().filter(r=>!_aiEnv[r.id]&&aiTranscriptOf(r)&&!r.missing);
  if(!need.length)return null;
  _aiEnvBg=aiEnsureEnvelopesFor(need).then(()=>{_aiEnvBg=null;TX.dirty=true;if(TX.visible)aiTxRebuild(true);else aiTxCountFillers();});
  return _aiEnvBg;
}
// Is speech hidden inside a compound clip (the transcript can't reach it)?
function aiSpeechInCompound(clips){
  return (clips||state.clips).some(c=>c.type==='compound'&&c.inner&&(c.inner.clips||[]).some(q=>((q.type==='video'||q.type==='audio')&&q.mediaId)||q.type==='compound'&&aiSpeechInCompound([q])));
}
const AI_CMP_MSG='The speech is inside a compound clip — open it to edit by text';
function aiBuildBinTabs(){
  const bin=$('#bin');if(!bin||$('#binTabs'))return;
  const head=bin.querySelector('.panel-head');
  const media=document.createElement('div');media.id='binMedia';media.className='bin-pane';
  [...bin.children].filter(ch=>ch!==head).forEach(ch=>media.appendChild(ch));
  const tabs=document.createElement('div');tabs.id='binTabs';tabs.className='ptabs';tabs.setAttribute('role','tablist');
  tabs.innerHTML=`<button class="ptab on" id="tabMedia" role="tab" title="Your imported media">Media <span class="count" id="binCountTab"></span></button>
    <button class="ptab" id="tabTx" role="tab" title="Transcript — read your edit as text. Delete words to cut them from the video, remove fillers and pauses, make captions.">Transcript</button>
    <i class="ptab-ink"></i>`;
  head.replaceWith(tabs);
  tabs.after(media);
  // the original count label keeps its id (other code writes to it) but lives in the tab now
  const cnt=head.querySelector('#binCount');if(cnt){cnt.className='count';$('#binCountTab').replaceWith(cnt);}
  const tx=document.createElement('div');tx.id='binTx';tx.className='bin-pane';tx.hidden=true;
  tx.innerHTML=`<div class="tx-head">
      <div class="tx-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/></svg>
        <input id="txSearch" placeholder="Search the transcript" spellcheck="false" autocomplete="off" title="Find words in the transcript — Enter jumps to the next match, Shift+Enter to the previous">
        <span id="txFind" class="tx-find"></span></div>
      <div class="tx-tools">
        <button class="txchip" id="txFillers" title="Find filler words (um, uh), stutters (“the the”) and sounds Whisper didn’t write down — review them, then remove them in one step">Fillers <b id="txFillN">0</b></button>
        <button class="txchip" id="txPauses" title="Shorten or remove the silent pauses between phrases — works from the audio itself, no transcript needed">Pauses…</button>
        <button class="txchip" id="txCaps" title="Turn the transcript into on-screen captions that follow your edit">Captions…</button>
        <button class="txchip txmore" id="txMore" title="More: export the transcript as subtitles (.srt) or text, choose the speech model, re-transcribe" aria-label="More transcript options">⋯</button>
      </div></div>
    <div id="txReview" class="tx-review" hidden></div>
    <div id="txBody" class="tx-body" tabindex="0" aria-label="Transcript — select words and press Delete to cut them"></div>
    <div id="txSelBar" class="tx-selbar" hidden><span id="txSelInfo"></span>
      <button class="tbtn" id="txPlaySel" title="Play just the selected words">▶ Play</button>
      <button class="tbtn danger" id="txDelSel" title="Cut the selected words out of the video (Delete). The gap closes on every unlocked track so picture, sound and titles stay in sync.">Delete</button>
      <button class="tbtn" id="txClearSel" title="Clear the selection (Esc)" aria-label="Clear selection">✕</button></div>`;
  bin.appendChild(tx);
  $('#tabMedia').onclick=()=>aiShowTab('media');
  $('#tabTx').onclick=()=>aiShowTab('tx');
  aiWireTranscript();
  aiInkTabs();
}
function aiInkTabs(){
  const on=$('#binTabs .ptab.on'),ink=$('#binTabs .ptab-ink');if(!on||!ink)return;
  ink.style.left=on.offsetLeft+'px';ink.style.width=on.offsetWidth+'px';
}
function aiShowTab(which){
  const tx=which==='tx';
  $('#tabMedia').classList.toggle('on',!tx);$('#tabTx').classList.toggle('on',tx);
  $('#binMedia').hidden=tx;$('#binTx').hidden=!tx;
  $('#main').classList.toggle('tx-wide',tx);
  TX.visible=tx;aiInkTabs();
  try{localStorage.setItem('vibe-bin-tab',which);}catch(e){}
  if(tx){TX.dirty=true;aiTxRebuild();aiTxEnvInBackground();}
  // the preview area changes size with the wider panel
  setTimeout(()=>{try{fitPreview();layoutGuides();updateGizmo();}catch(e){}},260);
}
function aiAfterTimeline(){
  if(!TX.dirty&&TX.sig!=null&&aiTxSig()===TX.sig)return;   // nothing the transcript depends on changed
  TX.dirty=true;if(TX.visible)aiTxRebuildSoon();else aiTxCountFillers();
}
let _aiTxT=0;
function aiTxRebuildSoon(){if(_aiTxT)return;_aiTxT=requestAnimationFrame(()=>{_aiTxT=0;aiTxRebuild();});}
function aiTxCountFillers(){
  const n=$('#txFillN');if(!n)return;
  const L=TX.list||[];n.textContent=L.filter(x=>x.filler==='um'||x.filler==='repeat').length||'';   // real fillers only
}
function _aiFmtClock(t){const m=Math.floor(t/60),s=Math.floor(t%60);return m+':'+String(s).padStart(2,'0');}
function aiTxRebuild(force){
  if(!force&&!TX.dirty)return;TX.dirty=false;
  const body=$('#txBody');if(!body)return;
  // remember the selection by stable keys, restore it after the rebuild
  const L0=TX.list||[],kept={sel:TX.sel?[aiTxKey(L0[TX.sel[0]]),aiTxKey(L0[TX.sel[1]])]:null,
    set:TX.selSet?[...TX.selSet].map(i=>aiTxKey(L0[i])):null,anchor:aiTxKey(L0[TX.anchor]),pause:TX.pauseSel!=null?aiTxKey(L0[TX.pauseSel]):null};
  const L=TX.list=aiTimelineWords();TX.sig=aiTxSig();
  TX.sel=null;TX.selSet=null;TX.anchor=null;TX.pauseSel=null;TX.now=-1;aiTxSelBar();
  TX.paraStarts=new Set();
  aiTxCountFillers();
  if(!L.length){body.innerHTML=aiTxEmptyHTML();aiWireEmpty();return;}
  const roots=aiTranscriptRoots(),missing=aiNeedsTranscription();
  let html=missing?`<div class="tx-note">Some of your timeline isn’t transcribed yet. <button class="linkbtn" id="txMoreTr" title="Transcribe the new parts — only what isn’t covered yet">Transcribe the rest</button></div>`:'';
  let para=false,spk=null;
  const hasSpk=typeof proSpeakerOf==='function'&&proHasSpeakers();
  for(let i=0;i<L.length;i++){
    const x=L[i],p=L[i-1];
    const gap=p?x.t0-p.t1:0;
    // v4.7: a new speaker always starts a new paragraph, headed by their name
    const sp=hasSpk&&x.k==='w'?proSpeakerOf(x):null;
    const spkChange=sp&&(!spk||sp.root!==spk.root||sp.i!==spk.i);
    if(!p||gap>=1.5||spkChange){
      if(para)html+='</p>';TX.paraStarts.add(i);
      if(sp)spk=sp;
      html+=`<p class="tx-p"><span class="tx-ts" data-t="${x.t0}" title="Jump here">${_aiFmtClock(x.t0)}</span>`
        +(hasSpk&&spk?`<button class="tx-spk" data-i="${i}" style="--spk:${spk.color}" title="${esc(spk.name)} \u2014 click to rename, merge or relabel">${esc(spk.name)}</button>`:'');para=true;
    }else if(gap>=0.5){
      html+=`<span class="tx-pause" data-gap="${i}" title="A ${gap.toFixed(1)} s pause — click to select it, Delete to shorten it">${gap.toFixed(1)}s</span> `;
    }
    const cls='tw'+(x.k==='s'?' tsound':'')+(x.filler?' f-'+x.filler:'');
    const text=x.k==='s'?(x.tag?esc(x.w.toLowerCase()):'…'):esc(x.w);
    html+=`<span class="${cls}" data-i="${i}"${x.k==='s'?(x.tag?' title="A sound, not speech — click to jump here, select and Delete to cut it"':' title="A sound nobody wrote down — often an “um”, a breath or a laugh"'):''}>${text}</span> `;
  }
  if(para)html+='</p>';
  body.innerHTML=html;
  $$('#txBody .tx-spk').forEach(b=>b.onclick=e=>{e.stopPropagation();proSpeakerChipMenu(b);});
  if($('#txMoreTr'))$('#txMoreTr').onclick=()=>aiTranscribeTimeline();
  if(TX.review)aiTxApplyReview();
  aiTxSearch(false);
  // restore the selection where those words still exist
  const at=new Map();L.forEach((x,i)=>{const k=aiTxKey(x);if(!at.has(k))at.set(k,i);});
  if(kept.sel){const a=at.get(kept.sel[0]),b=at.get(kept.sel[1]);
    if(a!=null&&b!=null&&a<=b){TX.sel=[a,b];
      if(kept.set){const ss=new Set(kept.set.map(k=>at.get(k)).filter(i=>i!=null));TX.selSet=ss.size?ss:null;}
      TX.anchor=at.has(kept.anchor)?at.get(kept.anchor):a;}}
  if(kept.pause!=null&&at.has(kept.pause)&&body.querySelector(`.tx-pause[data-gap="${at.get(kept.pause)}"]`))TX.pauseSel=at.get(kept.pause);
  aiTxPaint();
  aiTxTick(true);
}
function aiTxEmptyHTML(){
  if(AI.job==='Transcribing')return `<div class="tx-empty"><div class="tx-orb"></div><h4>Transcribing…</h4><p id="txJobMsg">${esc(TX.jobMsg||'')}</p></div>`;
  const roots=aiTranscriptRoots();
  if(!roots.length&&aiSpeechInCompound())return `<div class="tx-empty"><div class="tx-orb idle"></div><h4>Edit video by editing text</h4>
    <p>${AI_CMP_MSG}.</p></div>`;
  if(!roots.length)return `<div class="tx-empty"><div class="tx-orb idle"></div><h4>Edit video by editing text</h4>
    <p>Put a clip with speech on the timeline, then transcribe it. Delete words here and they’re cut from the video — picture, sound and titles stay in sync.</p></div>`;
  const cur=aiModelId();
  return `<div class="tx-empty"><div class="tx-orb idle"></div><h4>Edit video by editing text</h4>
    <p>Transcribe the speech on your timeline (${roots.length} source${roots.length>1?'s':''}). Then delete words to cut them, remove “ums” and long pauses in one click, and make captions that follow your edit.</p>
    <div class="seg tx-model" role="radiogroup" title="Speech model — both run on this computer">${AI_MODELS.map(m=>`<button data-model="${m.id}" class="${m.id===cur?'on':''}" title="${esc(m.label+' — '+m.note)}">${m.label}</button>`).join('')}</div>
    <button class="tbtn primary tx-go" id="txGo" title="Transcribe the parts of your clips the timeline uses">Transcribe</button>
    <p class="tx-fine">Runs entirely on this computer — nothing is uploaded. The first run downloads the speech model once, then works offline. English speech.</p></div>`;
}
function aiWireEmpty(){
  $$('#txBody .tx-model button').forEach(b=>b.onclick=()=>{aiSetModel(b.dataset.model);AI.model=null;
    $$('#txBody .tx-model button').forEach(x=>x.classList.toggle('on',x===b));});
  if($('#txGo'))$('#txGo').onclick=()=>aiTranscribeTimeline();
}
function aiTxOnJob(f,msg){
  TX.jobMsg=msg;
  const el=$('#txJobMsg');if(el&&msg!=null)el.textContent=msg;
  if(f===null){TX.dirty=true;if(TX.visible)aiTxRebuild();}
  else if(TX.visible&&!TX.list.length&&!$('#txJobMsg'))aiTxRebuild(true);
}
// ---- live highlight of the word under the playhead ----
function aiTxIndexAt(t){
  const L=TX.list;let lo=0,hi=L.length-1,ans=-1;
  while(lo<=hi){const m=(lo+hi)>>1;if(L[m].t0<=t+1e-6){ans=m;lo=m+1;}else hi=m-1;}
  if(ans>=0&&t>L[ans].t1+0.25)return -1;
  return ans;
}
function aiTxTick(force){
  if(!TX.visible||!TX.list.length)return;
  const i=aiTxIndexAt(state.time);
  if(i===TX.now&&!force)return;
  const body=$('#txBody');
  const old=body.querySelector('.tw.now');if(old)old.classList.remove('now');
  TX.now=i;if(i<0)return;
  const el=body.querySelector(`.tw[data-i="${i}"]`);if(!el)return;
  el.classList.add('now');
  if(state.playing&&performance.now()-TX.userScrollAt>2500){
    const r=el.getBoundingClientRect(),br=body.getBoundingClientRect();
    if(r.top<br.top+30||r.bottom>br.bottom-30)body.scrollTop+=r.top-br.top-br.height*0.35;
  }
}
(function aiLoop(){aiTxTick(false);requestAnimationFrame(aiLoop);})();
// ---- selection ----
function aiTxSetSel(a,b){
  TX.selSet=null;   // a speaker selection (v4.7) is replaced by any ordinary one
  if(a==null){TX.sel=null;}else TX.sel=[Math.min(a,b),Math.max(a,b)];
  aiTxPaint();
}
function aiTxPaint(){
  $$('#txBody .tw.sel,#txBody .tx-pause.sel').forEach(e=>e.classList.remove('sel'));
  if(TX.sel){
    for(let i=TX.sel[0];i<=TX.sel[1];i++){if(TX.selSet&&!TX.selSet.has(i))continue;const e=$(`#txBody .tw[data-i="${i}"]`);if(e)e.classList.add('sel');}
    if(!TX.selSet)$$('#txBody .tx-pause').forEach(p=>{const g=+p.dataset.gap;if(g>TX.sel[0]&&g<=TX.sel[1])p.classList.add('sel');});
  }
  if(TX.pauseSel!=null){const pz=$(`#txBody .tx-pause[data-gap="${TX.pauseSel}"]`);if(pz)pz.classList.add('sel');}
  aiTxSelBar();
}
// Delete/Backspace pressed outside the transcript body (a selection-bar button
// or a menu has focus): the transcript selection is what the user means,
// unless they have since clicked on the timeline.
function aiTxWantsDelete(){
  if(!TX.visible||(!TX.sel&&TX.pauseSel==null)||TX.lastPtr==='timeline')return false;
  const el=$('#binTx');return !!el&&el.getBoundingClientRect().height>0;
}
function aiTxFocus(){const b=$('#txBody');if(b)b.focus({preventScroll:true});}
function aiTxSelBar(){
  const bar=$('#txSelBar');if(!bar)return;
  if(!TX.sel&&TX.pauseSel==null){bar.hidden=true;return;}
  bar.hidden=false;
  if(TX.pauseSel!=null){$('#txSelInfo').textContent='Pause selected';return;}
  const L=TX.list,n=TX.selSet?TX.selSet.size:TX.sel[1]-TX.sel[0]+1,d=L[TX.sel[1]].t1-L[TX.sel[0]].t0;
  $('#txSelInfo').textContent=n+' word'+(n>1?'s':'')+' · '+d.toFixed(1)+' s';
}
function aiWireTranscript(){
  const body=$('#txBody');
  let dragging=false;
  body.addEventListener('pointerdown',e=>{
    const ts=e.target.closest('.tx-ts');
    if(ts){setPlaying(false);setTime(+ts.dataset.t);return;}
    const pz=e.target.closest('.tx-pause');
    if(pz){TX.sel=null;TX.pauseSel=+pz.dataset.gap;aiTxSetSel(null);body.focus();return;}
    const w=e.target.closest('.tw');if(!w||e.button!==0)return;
    e.preventDefault();body.focus();TX.pauseSel=null;
    const i=+w.dataset.i;
    if(TX.review&&TX.review.idx.has(i)&&!e.shiftKey){aiTxToggleReview(i);return;}
    if(e.shiftKey&&TX.anchor!=null){aiTxSetSel(TX.anchor,i);return;}
    TX.anchor=i;dragging=true;TX.dragMoved=false;
    const move=ev=>{const el=document.elementFromPoint(ev.clientX,ev.clientY);const t=el&&el.closest&&el.closest('#txBody .tw');
      if(t){const j=+t.dataset.i;if(j!==TX.anchor||TX.dragMoved){TX.dragMoved=true;aiTxSetSel(TX.anchor,j);}}};
    const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up);dragging=false;
      if(!TX.dragMoved){aiTxSetSel(i,i);setPlaying(false);setTime(TX.list[i].t0+1e-3);}};
    addEventListener('pointermove',move);addEventListener('pointerup',up);
  });
  body.addEventListener('dblclick',e=>{const w=e.target.closest('.tw');if(!w)return;const i=+w.dataset.i;
    // (the two clicks of a double-click already toggled keep/remove twice: net unchanged)
    if(TX.review&&TX.review.idx.has(i)){const x=TX.list[i];aiPlayRange(Math.max(0,x.t0-0.7),x.t1+0.7);return;}
    TX.anchor=i;aiTxSetSel(i,i);});
  body.addEventListener('wheel',()=>{TX.userScrollAt=performance.now();},{passive:true});
  body.addEventListener('keydown',e=>{
    if(e.key==='Delete'||e.key==='Backspace'){
      if(TX.sel||TX.pauseSel!=null){e.preventDefault();e.stopPropagation();aiTxDeleteSelection();}
      else{e.preventDefault();e.stopPropagation();}   // never fall through to deleting timeline clips
      return;}
    if(e.shiftKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')&&TX.sel&&TX.list.length){
      e.preventDefault();e.stopPropagation();
      const anc=(TX.anchor===TX.sel[0]||TX.anchor===TX.sel[1])?TX.anchor:TX.sel[0],end=anc===TX.sel[0]?TX.sel[1]:TX.sel[0];
      const ne=clamp(end+(e.key==='ArrowLeft'?-1:1),0,TX.list.length-1);
      TX.anchor=anc;aiTxSetSel(anc,ne);
      const el=$(`#txBody .tw[data-i="${ne}"]`);if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});
      return;}
    if(e.key==='Enter'&&TX.hits.length){e.preventDefault();e.stopPropagation();aiTxFindStep(e.shiftKey?-1:1);return;}
    if(e.key==='Escape'&&(TX.sel||TX.pauseSel!=null)){e.stopPropagation();TX.pauseSel=null;aiTxSetSel(null);return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();e.stopPropagation();$('#txSearch').focus();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();e.stopPropagation();if(TX.list.length){TX.anchor=0;aiTxSetSel(0,TX.list.length-1);}return;}
  });
  $('#txDelSel').onclick=aiTxDeleteSelection;
  $('#txClearSel').onclick=()=>{TX.pauseSel=null;aiTxSetSel(null);aiTxFocus();};
  $('#txPlaySel').onclick=()=>{if(!TX.sel)return;const L=TX.list;aiPlayRange(L[TX.sel[0]].t0,L[TX.sel[1]].t1);aiTxFocus();};
  const s=$('#txSearch');
  s.oninput=()=>aiTxSearch(true);
  // Enter selects the match and hands the keyboard to the transcript: Delete
  // then cuts it, Enter / Shift+Enter keep stepping through the matches.
  s.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();if(TX.hits.length){aiTxFindStep(e.shiftKey?-1:1);aiTxFocus();}}
    if(e.key==='Escape'){e.stopPropagation();s.value='';aiTxSearch(true);aiTxFocus();}};
  $('#txFillers').onclick=()=>TX.review?aiTxEndReview():aiTxStartReview();
  $('#txPauses').onclick=()=>aiPausesDialog();
  $('#txCaps').onclick=()=>aiCaptionsDialog();
  $('#txMore').onclick=e=>{const r=e.currentTarget.getBoundingClientRect();aiTxMoreMenu(r.left,r.bottom+4);};
}
// Play [a,b) once, then stop.
let _aiPlayStop=null;
function aiPlayRange(a,b){
  setPlaying(false);setTime(a);setPlaying(true);
  if(_aiPlayStop)cancelAnimationFrame(_aiPlayStop);
  const chk=()=>{if(!state.playing)return;if(state.time>=b){setPlaying(false);return;}_aiPlayStop=requestAnimationFrame(chk);};
  _aiPlayStop=requestAnimationFrame(chk);
}
async function aiTxDeleteSelection(){
  if(TX.sel||TX.pauseSel!=null)aiTxRebuild();   // never cut from a stale list
  const L=TX.list;let ranges=[],what='',ents=[];
  if(TX.pauseSel!=null){
    const i=TX.pauseSel,p=L[i-1],x=L[i];if(!p||!x)return;
    await aiEnsureEnvelopesFor([p.root,x.root]);ents=[p,x];
    const keep=0.3,a=p.t1+keep/2,b=x.t0-keep/2,chP=aiChainOf(p),chX=aiChainOf(x);
    if(chP===chX){
      if(b-a>0.05)ranges=[[aiQuietPoint(p.c,a-0.05,a+0.05,a,chP),aiQuietPoint(x.c,b-0.05,b+0.05,b,chX)]];}
    else{
      // across a cut between two clips: the tail of the first, any empty gap
      // and the head of the next go together, so the whole gap closes
      const pa=Math.min(a,chP.end),xb=Math.max(b,chX.start);
      if(xb-pa>0.05)ranges=[[pa<chP.end-0.05?aiQuietPoint(p.c,pa-0.05,pa+0.05,pa,chP):pa,xb>chX.start+0.05?aiQuietPoint(x.c,xb-0.05,xb+0.05,xb,chX):xb]].filter(r=>r[1]>r[0]);
    }
    what='pause';
  }else if(TX.sel){
    const idx=[];for(let i=TX.sel[0];i<=TX.sel[1];i++)if(!TX.selSet||TX.selSet.has(i))idx.push(i);
    await aiEnsureEnvelopesFor([...new Set(idx.map(i=>L[i].root))]);
    ents=idx.map(i=>L[i]);
    ranges=aiRangesForEntries(L,idx);what=idx.length+' word'+(idx.length>1?'s':'');
  }
  const lk=aiTxLockedBlock(ents,ranges);
  if(lk){toast('“'+lk.name+'” is on a locked track ('+((trackOf(lk.track)||{}).name||lk.track)+') — unlock it to cut these words, otherwise picture and sound would slip out of sync','err',6000);aiTxFocus();return;}
  TX.pauseSel=null;TX.selSet=null;
  const res=aiCutFollowCaptions(ranges);
  if(!res){toast('Nothing to cut there');aiTxSetSel(null);return;}
  toast('Cut '+what+' ('+res.removed.toFixed(1)+' s) — Ctrl+Z to undo','ok');
  aiTxFocus();
}
// A cut through words on a LOCKED track (or whose linked partner is locked)
// would leave that track uncut while everything else ripples: refuse.
function aiTxLockedBlock(ents,ranges){
  const rs=aiNormalizeRanges(ranges);if(!rs.length)return null;
  const hit=c=>rs.some(r=>r[0]<clipEnd(c)-1e-6&&r[1]>c.start+1e-6);
  const cand=new Set();
  for(const x of ents)for(const c of aiChainOf(x).clips)cand.add(c);
  for(const c of [...cand]){
    if(typeof linkedPartners==='function')for(const id of linkedPartners(c.id)){const o=state.clips.find(q=>q.id===id);if(o)cand.add(o);}
    if(c.linkId)state.clips.forEach(o=>{if(o.linkId===c.linkId)cand.add(o);});
  }
  for(const c of cand)if(state.locked[c.track]&&hit(c))return c;
  return null;
}
/* A ripple cut whose burned-in captions follow the words: caption pieces that
   the cut split are joined again, and every caption the cut touched is
   rewritten from the words it now covers (dropped when none are left). One
   undo step. Returns aiRippleCut's result. */
function aiCutFollowCaptions(ranges){
  if(!aiNormalizeRanges(ranges).length)return null;
  pushHistory();
  const caps=state.clips.filter(c=>c.isCaption&&c.type==='text'&&!state.locked[c.track]);
  caps.forEach(c=>{c._capO=c.id;c._capD=c.duration;});
  let res=null;
  try{res=aiRippleCut(ranges,{noHistory:true});
    if(res&&caps.length){aiCaptionsReflow();renderTimeline();requestDraw();}}
  finally{state.clips.forEach(c=>{delete c._capO;delete c._capD;});}
  return res;
}
function aiCaptionsReflow(){
  const groups=new Map();
  for(const c of state.clips)if(c._capO){if(!groups.has(c._capO))groups.set(c._capO,[]);groups.get(c._capO).push(c);}
  const L=aiTimelineWords().filter(x=>x.k==='w'),drop=new Set();
  for(const [id,ps] of groups){
    if(!(ps.length>1||ps.some(c=>c.id!==id||Math.abs(c.duration-c._capD)>1e-6)))continue;   // untouched
    ps.sort((a,b)=>a.start-b.start);
    const merged=[];
    for(const c of ps){const l=merged[merged.length-1];
      if(l&&Math.abs(c.start-clipEnd(l))<1e-3){l.duration=clipEnd(c)-l.start;l.props.fadeOut=c.props.fadeOut;l.props.transOut=c.props.transOut;if(l.text&&c.text)l.text.animOut=c.text.animOut;drop.add(c);}
      else merged.push(c);}
    for(const c of merged){
      const ws=L.filter(x=>{const m=(x.t0+x.t1)/2;return m>=c.start-1e-6&&m<clipEnd(c)-1e-6;});
      if(!ws.length){drop.add(c);continue;}
      let t='';for(const x of ws)t+=(t&&!/^[.,!?;:]/.test(x.w)?' ':'')+x.w;
      if(c.capWho)t=c.capWho+': '+t;
      if(c.text)c.text.content=t;c.name=t.slice(0,24)||'Caption';
    }
  }
  if(drop.size)state.clips=state.clips.filter(c=>!drop.has(c));
}
// ---- search ----
function aiTxSearch(jump){
  const q=($('#txSearch')&&$('#txSearch').value||'').trim().toLowerCase();
  $$('#txBody .tw.hit').forEach(e=>e.classList.remove('hit','hitcur'));
  TX.hits=[];TX.hitAt=-1;
  if(!q){$('#txFind').textContent='';return;}
  const toks=q.split(/\s+/).map(aiNormWord).filter(Boolean),L=TX.list;
  for(let i=0;i<L.length;i++){
    if(L[i].k!=='w')continue;let ok=true,j=i,n=0;
    for(const t of toks){while(L[j]&&L[j].k!=='w')j++;if(!L[j]||!aiNormWord(L[j].w).startsWith(t)){ok=false;break;}j++;n++;}
    if(ok)TX.hits.push([i,j-1]);
  }
  TX.hits.forEach(([a,b])=>{for(let i=a;i<=b;i++){const e=$(`#txBody .tw[data-i="${i}"]`);if(e)e.classList.add('hit');}});
  $('#txFind').textContent=TX.hits.length?'0/'+TX.hits.length:'none';
  if(jump&&TX.hits.length)aiTxFindStep(1);
}
function aiTxFindStep(d){
  if(!TX.hits.length)return;
  TX.hitAt=(TX.hitAt+d+TX.hits.length)%TX.hits.length;
  $$('#txBody .tw.hitcur').forEach(e=>e.classList.remove('hitcur'));
  const [a,b]=TX.hits[TX.hitAt];
  for(let i=a;i<=b;i++){const e=$(`#txBody .tw[data-i="${i}"]`);if(e)e.classList.add('hitcur');}
  const el=$(`#txBody .tw[data-i="${a}"]`);if(el)el.scrollIntoView({block:'center'});
  $('#txFind').textContent=(TX.hitAt+1)+'/'+TX.hits.length;
  TX.anchor=a;TX.pauseSel=null;aiTxSetSel(a,b);setTime(TX.list[a].t0+1e-3);
}
// ---- filler review ----
function aiTxStartReview(){
  if(!TX.list.length){toast('Transcribe your timeline first — open the Transcript tab');return;}
  // Whisper usually leaves “um” out of the text, so the unwritten sounds are in by default — review makes them visible.
  // Unwritten sounds are off by default: they include breaths, laughs and [music].
  // `off` holds the stable keys (aiTxKey) of items the user chose to keep.
  TX.review={soft:false,sounds:false,idx:new Set(),off:new Set()};
  aiTxApplyReview();$('#txFillers').classList.add('on');
  aiTxEnvInBackground();   // after a reopen: find the unwritten ums too
}
function aiTxEndReview(){
  TX.review=null;$('#txFillers').classList.remove('on');
  $$('#txBody .tw.rv,#txBody .tw.rvoff').forEach(e=>e.classList.remove('rv','rvoff'));
  $('#txReview').hidden=true;
}
function aiTxApplyReview(){
  const R=TX.review,L=TX.list;
  R.idx=new Set(L.map((x,i)=>[x,i]).filter(([x])=>x.filler==='um'||x.filler==='repeat'||(R.soft&&x.filler==='soft')||(R.sounds&&x.k==='s')).map(p=>p[1]));
  $$('#txBody .tw.rv,#txBody .tw.rvoff').forEach(e=>e.classList.remove('rv','rvoff'));
  const kept=i=>R.off.has(aiTxKey(L[i]));
  R.idx.forEach(i=>{const e=$(`#txBody .tw[data-i="${i}"]`);if(e)e.classList.add(kept(i)?'rvoff':'rv');});
  const n=[...R.idx].filter(i=>!kept(i)).length;
  const soft=L.filter(x=>x.filler==='soft').length,snd=L.filter(x=>x.k==='s').length;
  const box=$('#txReview');box.hidden=false;
  box.innerHTML=`<div class="rv-top"><b>${n}</b> to remove <span class="rv-sub">— click one to keep it, double-click to hear it</span></div>
    <label class="rv-opt" title="“like”, “you know”, “I mean”, “basically”… — sometimes they matter, so check each one"><input type="checkbox" id="rvSoft"${R.soft?' checked':''}> Also “like”, “you know”… (${soft})</label>
    <label class="rv-opt" title="Voice the transcript has no words for. Whisper often leaves out “um” and “uh”, so these catch the ones it skipped — and also breaths and laughs, so review them"><input type="checkbox" id="rvSnd"${R.sounds?' checked':''}> Also unwritten sounds (${snd})</label>
    <div class="rv-btns"><button class="tbtn" id="rvDone" title="Close the review without removing anything">Done</button>
      <button class="tbtn primary" id="rvGo" title="Cut every highlighted item from the video in one step (one undo)"${n?'':' disabled'}>Remove ${n}</button></div>`;
  $('#rvSoft').onchange=e=>{R.soft=e.target.checked;aiTxApplyReview();};
  $('#rvSnd').onchange=e=>{R.sounds=e.target.checked;aiTxApplyReview();};
  $('#rvDone').onclick=aiTxEndReview;
  $('#rvGo').onclick=aiTxRemoveReviewed;
  $('#txFillN').textContent=n||'';
}
function aiTxToggleReview(i){const R=TX.review,k=aiTxKey(TX.list[i]);if(R.off.has(k))R.off.delete(k);else R.off.add(k);aiTxApplyReview();}
async function aiTxRemoveReviewed(){
  aiTxRebuild();
  const R=TX.review,L=TX.list;const idx=[...R.idx].filter(i=>!R.off.has(aiTxKey(L[i])));
  if(!idx.length)return;
  await aiEnsureEnvelopesFor([...new Set(idx.map(i=>L[i].root))]);
  const ranges=aiRangesForEntries(L,idx);
  const lk=aiTxLockedBlock(idx.map(i=>L[i]),ranges);
  if(lk){toast('“'+lk.name+'” is on a locked track ('+((trackOf(lk.track)||{}).name||lk.track)+') — unlock it to remove these fillers, otherwise picture and sound would slip out of sync','err',6000);return;}
  const res=aiCutFollowCaptions(ranges);
  aiTxEndReview();
  if(res)toast('Removed '+idx.length+' filler'+(idx.length>1?'s':'')+' ('+res.removed.toFixed(1)+' s) — Ctrl+Z to undo','ok',4200);
}
// ---- more menu: export / model / redo ----
function aiTxMoreMenu(x,y){
  const cur=aiModelId();
  showCtx(x,y,[
    {label:'Export subtitles (.srt)…',tip:'Timed subtitles that match your edit — for YouTube, players and other editors',fn:()=>aiExportSubs('srt')},
    {label:'Export subtitles (.vtt)…',tip:'WebVTT subtitles for web players',fn:()=>aiExportSubs('vtt')},
    {label:'Export transcript (.txt)…',tip:'Plain text of everything said in your edit, with timestamps per paragraph',fn:()=>aiExportSubs('txt')},
    {sep:true},
    {label:'Label speakers…',tip:'Tell the voices apart and mark who says what',fn:()=>proSpeakersDialog()},
    {sep:true},
    ...AI_MODELS.map(m=>({label:(m.id===cur?'✓ ':' ')+'Speech model: '+m.label,tip:m.note,fn:()=>{aiSetModel(m.id);AI.model=null;toast('Speech model: '+m.label+' — used for the next transcription');}})),
    {label:'Re-transcribe everything…',tip:'Throw away the current transcript and transcribe again — for example with the Accurate model',fn:()=>{
      const roots=aiTranscriptRoots();if(!roots.length)return;
      if(!confirm('Discard the transcript of '+roots.length+' source'+(roots.length>1?'s':'')+' and transcribe again?'))return;
      aiRetranscribe(roots);}},
  ]);
}
// Transcribe again into a NEW transcript and swap it in only when every source
// succeeded — Cancel (or a failure) keeps the old one, speaker labels included.
async function aiRetranscribe(roots){
  return aiRunJob('Transcribing',async prog=>{
    const fresh=[];let added=0;
    for(let i=0;i<roots.length;i++){
      const r=roots[i],o={};
      const res=await aiTranscribe(r,aiUsedSpans(r),(f,msg)=>prog((i+f)/roots.length,msg),{fresh:o});
      fresh.push([r,o.out]);added+=res.added||0;
    }
    for(const [r,t] of fresh){if(!t)continue;const old=aiTranscriptOf(r);if(old&&old.speakers)aiCarrySpeakers(old,t);r.transcript=t;}
    TX.rev++;aiTxRebuild(true);
    toast('Transcript ready — '+added+' words','ok',4200);
    return added;
  });
}
// Speaker labels onto re-transcribed words: each new word takes the label of
// the old word starting nearest to it (within 0.4 s).
function aiCarrySpeakers(old,t){
  const src=(old.speakers.byT||[]).slice().sort((a,b)=>a[0]-b[0]);if(!src.length)return;
  const byT=[];let j=0;
  for(const w of t.words){if(w[3])continue;
    while(j+1<src.length&&Math.abs(src[j+1][0]-w[1])<=Math.abs(src[j][0]-w[1]))j++;
    if(Math.abs(src[j][0]-w[1])<=0.4)byT.push([+w[1].toFixed(3),src[j][1]]);}
  t.speakers=Object.assign({},old.speakers,{byT,names:(old.speakers.names||[]).slice()});
  if(typeof _proSpkIndex==='function')_proSpkIndex(t,true);
}
function _aiSrtTime(t,vtt){t=Math.max(0,t);const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60,ms=Math.round((t-Math.floor(t))*1000)%1000;
  const p=(n,w=2)=>String(n).padStart(w,'0');return p(h)+':'+p(m)+':'+p(s)+(vtt?'.':',')+p(ms,3);}
// Caption lines from the timeline transcript: at most `max` words, broken at
// pauses, sentence ends and clause commas once a line is long enough.
function aiCaptionLines(max){
  max=max||7;const L=(TX.list&&TX.list.length&&!TX.dirty)?TX.list:aiTimelineWords();
  const lines=[];let cur=null;
  const spkOn=typeof proSpeakerOf==='function'&&proHasSpeakers();
  for(const x of L){
    if(x.k!=='w')continue;
    const sp=spkOn?proSpeakerOf(x):null;
    if(cur&&(x.t0-cur.end>=0.6||aiChainOf(x)!==cur.ch&&x.t0-cur.end>0.3||(sp&&cur.who&&sp.name!==cur.who))){lines.push(cur);cur=null;}
    if(!cur){cur={text:x.w,start:x.t0,end:x.t1,n:1,c:x.c,ch:aiChainOf(x),who:sp?sp.name:null};}
    else{cur.text+=(/^[.,!?;:]/.test(x.w)?'':' ')+x.w;cur.end=x.t1;cur.n++;}
    if(cur.n>=max||/[.!?]$/.test(x.w)||(/[,;:]$/.test(x.w)&&cur.n>=Math.max(3,max-2))){lines.push(cur);cur=null;}
  }
  if(cur)lines.push(cur);
  // hold each line until the next begins (max 1 s extra), never overlapping
  for(let i=0;i<lines.length;i++){
    const nx=lines[i+1];const hold=Math.min(lines[i].end+1,nx?nx.start-0.04:lines[i].end+1);
    lines[i].end=Math.max(lines[i].end,Math.max(lines[i].start+0.5,hold));
    if(nx&&lines[i].end>nx.start-0.04)lines[i].end=Math.max(lines[i].start+0.1,nx.start-0.04);
  }
  return lines;
}
async function aiExportSubs(kind){
  if(!TX.list.length&&!aiTimelineWords().length){toast('Transcribe your timeline first');return;}
  const lines=aiCaptionLines(kind==='txt'?40:7);
  let out='';
  // with speaker labels: SRT/TXT name the speaker when the voice changes; VTT uses <v Name>
  let prevWho=null;const named=l=>{const n=l.who&&l.who!==prevWho?l.who+': ':'';prevWho=l.who||prevWho;return n+l.text;};
  if(kind==='srt')out=lines.map((l,i)=>(i+1)+'\n'+_aiSrtTime(l.start)+' --> '+_aiSrtTime(l.end)+'\n'+named(l)+'\n').join('\n');
  else if(kind==='vtt')out='WEBVTT\n\n'+lines.map(l=>_aiSrtTime(l.start,true)+' --> '+_aiSrtTime(l.end,true)+'\n'+(l.who?'<v '+l.who.replace(/[<>]/g,'')+'>':'')+l.text+'\n').join('\n');
  else{let last=-99;out=lines.map(l=>{const ts=l.start-last>20||(l.who&&l.who!==prevWho)?'['+_aiFmtClock(l.start)+'] ':'';if(ts)last=l.start;return ts+named(l);}).join(' ').replace(/ \[/g,'\n\n[')+'\n';}
  const base=($('#projName').value.trim()||'transcript').replace(/[^\w\- ]+/g,'').replace(/ +/g,'-');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([out],{type:'text/plain;charset=utf-8'}));
  a.download=base+'.'+kind;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  toast('Saved '+a.download,'ok');
}

/* ---------- 5c. Captions from the transcript ----------
   Captions are laid out from the TIMELINE transcript, so they match the edit
   exactly — including after transcript cuts, pause removal and trims. */
async function aiCaptionsDialog(){
  if(!aiTranscriptRoots().length){toast(aiSpeechInCompound()?AI_CMP_MSG:'Put a video or audio clip with speech on the timeline first',aiSpeechInCompound()?'err':'',5000);return;}
  if(aiNeedsTranscription()){
    const r=await aiTranscribeTimeline();if(r==null)return;
  }
  if(!aiTimelineWords().some(x=>x.k==='w')){toast('No speech found to caption');return;}
  const ov=$('#overlay');ov.classList.add('show');
  const tt=TRACKS.filter(t=>t.kind==='text');
  // default to a titles track the captions fit on: one whose only clips under
  // the speech are earlier captions; otherwise offer a new track (the first
  // track usually holds the user's own titles, and captions skip every overlap)
  const _ln=aiCaptionLines(7),_free=t=>!state.clips.some(o=>o.track===t.id&&!o.isCaption&&_ln.some(l=>o.start<l.end-1e-6&&clipEnd(o)>l.start+1e-6));
  const _def=(tt.find(_free)||{id:'__new'}).id;
  ov.innerHTML=`<div class="modal aimodal" style="width:min(460px,92vw)">
    <div class="modal-head"><div><h3>Captions</h3>
      <div class="sub">On-screen text from your transcript, timed to your edit.</div></div>
      <button class="mclose" id="cpX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="field"><label>Place captions on</label>
        <select class="tsel" id="capTrack" title="Which titles track (TITLES) receives the caption clips">${tt.map(t=>`<option value="${t.id}"${t.id===_def?' selected':''}>${esc(t.name)}${_free(t)?'':' (has titles)'}</option>`).join('')}<option value="__new"${_def==='__new'?' selected':''}>New titles track</option></select></div>
      <div class="row2">
        <div class="field"><label>Style</label>
          <select class="tsel" id="capStyle" title="Subtitle sits low in the frame; Caption is big and centered, social-media style"><option value="sub">Subtitle (bottom)</option><option value="cap">Caption (centered)</option></select></div>
        <div class="field"><label>Max words / line</label><input class="tin" id="capWords" type="number" value="7" min="2" max="14" title="Longest caption line, in words — lines also break at pauses and sentence ends"></div>
      </div>
      <label class="rv-opt" title="Remove caption clips already on that track first, so re-running after more edits doesn’t double up"><input type="checkbox" id="capReplace" checked> Replace existing captions on that track</label>
      ${typeof proHasSpeakers==='function'&&proHasSpeakers()?'<label class="rv-opt" title="Start a caption with the speaker\u2019s name whenever the voice changes (label speakers in the Transcript tab)"><input type="checkbox" id="capWho"> Show speaker names</label>':''}
    </div>
    <div class="modal-foot"><div class="note">Edit any caption afterwards like a normal title.</div>
      <button class="tbtn primary" id="capGo" title="Add the caption clips to the timeline">Add captions</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#cpX').onclick=closeOverlay;
  $('#capGo').onclick=()=>{
    let track=$('#capTrack').value;const style=$('#capStyle').value,max=clamp(+$('#capWords').value||7,2,14);
    if(track==='__new'){const before=new Set(TRACKS.map(t=>t.id));addTrack('text');const nt=TRACKS.find(t=>!before.has(t.id));if(!nt)return;track=nt.id;}
    const lines=aiCaptionLines(max);
    if($('#capWho')&&$('#capWho').checked){let prev=null;for(const l of lines){if(l.who&&l.who!==prev){l.text=l.who+': '+l.text;l.named=l.who;}prev=l.who||prev;}}
    pushHistory();
    if($('#capReplace').checked)state.clips=state.clips.filter(c=>!(c.track===track&&c.type==='text'&&c.isCaption));
    let added=0,skipped=0;
    for(const l of lines){
      const c=makeClip({type:'text',track,start:aiFrameSnap(l.start),duration:Math.max(0.2,aiFrameSnap(l.end)-aiFrameSnap(l.start)),name:l.text.slice(0,24)||'Caption'});
      c.isCaption=true;c.text.content=l.text;if(l.named)c.capWho=l.named;c.text.size=style==='sub'?64:84;c.text.weight=700;c.text.align='center';
      c.text.shadow=true;c.text.stroke=true;if(style==='sub')c.props.y=38;
      // no overlaps with anything already on the track
      if(state.clips.some(o=>o.track===track&&o.start<clipEnd(c)-1e-6&&clipEnd(o)>c.start+1e-6)){skipped++;continue;}
      state.clips.push(c);added++;
    }
    closeOverlay();renderTimeline();requestDraw();
    toast(added+' caption'+(added!==1?'s':'')+' added'+(skipped?' — '+skipped+' skipped where a title is already on that track':''),skipped?'':'ok',skipped?6000:undefined);
  };
}

/* ---------- 5d. Wiring ---------- */
function aiClipMenuItems(c,t){
  const items=[];
  if(c.type==='video'||c.type==='audio'){
    items.push({label:'Transcribe…',tip:'Transcribe the speech so you can edit it as text (opens the Transcript tab)',fn:()=>{aiShowTab('tx');const r=aiRoot(aiMediaOfClip(c));if(r)aiTranscribeTimeline([r]);}});
    items.push({label:'Remove pauses…',tip:'Cut the silent stretches between phrases',fn:aiPausesDialog});
  }
  if(c.type==='video'&&typeof aiScenesDialog==='function')items.push({label:'Detect scenes…',tip:'Find every camera cut inside this clip and split or mark it there',fn:()=>aiScenesDialog(c)});
  return items;
}
function aiToolsMenu(x,y){
  const sel=state.clips.find(c=>c.id===state.selection);
  showCtx(x,y,[
    {label:'✎ Edit by transcript',tip:'Read your edit as text — delete words to cut them from the video',fn:()=>aiShowTab('tx')},
    {label:'Remove filler words…',tip:'Find um, uh and stutters in the transcript and cut them in one step',fn:()=>{aiShowTab('tx');if(TX.list.length)aiTxStartReview();else toast('Transcribe first — press Transcribe in the Transcript tab');}},
    {label:'Remove pauses…',tip:'Tighten the silence between phrases, straight from the audio',fn:aiPausesDialog},
    {label:'Captions…',tip:'On-screen captions from speech, timed to your edit',fn:aiCaptionsDialog},
    {sep:true},
    {label:'Detect scenes…',tip:'Find the camera cuts inside a video clip (the selected one, or the one under the playhead) and split or mark them',fn:()=>aiScenesDialog(sel)},
    {label:'Beat sync…',tip:'Cut your clips to the music: every N beats, or snap existing cuts onto the beat',fn:aiBeatSyncDialog},
    {label:'Auto-reframe…',tip:'Turn a landscape edit into vertical, portrait or square, keeping each shot’s subject in frame',fn:aiReframeDialog},
    {sep:true},
    {label:'Label speakers…',tip:'Mark who says what in the transcript',fn:()=>proSpeakersDialog()},
    {label:'Auto-duck music…',tip:'Music dips smoothly under speech and comes back up in the pauses',fn:()=>proDuckDialog()},
  ]);
}
(function aiInit(){
  aiBuildBinTabs();
  if(!$('#aiToolsBtn')){
    const b=document.createElement('button');b.className='tbtn aibtn';b.id='aiToolsBtn';
    b.title='AI tools — transcript editing, filler and pause removal, captions, scene detection, beat sync and auto-reframe. Everything runs on this computer.';
    b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg> AI tools';
    $('#helpGuideBtn').before(b);
    b.onclick=e=>{const r=b.getBoundingClientRect();aiToolsMenu(r.left,r.bottom+6);};
  }
  let tab=null;try{tab=localStorage.getItem('vibe-bin-tab');}catch(e){}
  if(tab==='tx')aiShowTab('tx');
  addEventListener('resize',aiInkTabs);
  // which side the user last worked on: decides where a stray Delete goes
  addEventListener('pointerdown',e=>{const t=e.target;if(!t||!t.closest)return;
    if(t.closest('#tracksHost'))TX.lastPtr='timeline';else if(t.closest('#binTx'))TX.lastPtr='tx';},true);
  COMMANDS.push(
    {n:'Transcript — edit video by editing text',f:()=>aiShowTab('tx')},
    {n:'Transcribe the timeline',f:()=>{aiShowTab('tx');aiTranscribeTimeline();}},
    {n:'Remove filler words (um, uh)…',f:()=>{aiShowTab('tx');if(TX.list.length)aiTxStartReview();else toast('Transcribe first — then press Fillers');}},
    {n:'Remove pauses…',f:aiPausesDialog},
    {n:'Captions…',f:aiCaptionsDialog},
    {n:'Export subtitles (.srt)',f:()=>aiExportSubs('srt')},
    {n:'Detect scenes in the selected clip…',f:()=>aiScenesDialog()},
    {n:'Beat sync — cut to the music…',f:aiBeatSyncDialog},
    {n:'Auto-reframe for vertical / square…',f:aiReframeDialog},
    {n:'AI tools…',f:()=>{const b=$('#aiToolsBtn').getBoundingClientRect();aiToolsMenu(b.left,b.bottom+6);}},
  );
  GUIDE.push({s:'AI editing',items:[
    {t:'Edit by text (Transcript)',k:'transcript text descript speech words delete edit ai whisper',
     d:'Read your edit as text and cut it like a document. Deleting words removes them from the video; everything after slides back, on every unlocked track, so picture, sound and titles stay in sync.',
     how:['Open the Transcript tab above the media bin and press Transcribe (the first run downloads a speech model once; after that it works offline, and nothing ever leaves your computer).',
          'Click a word to jump there and select it. Drag across words (or Shift+click another word) to select more.',
          'Press Delete to cut the selection. Cuts land in the quietest instant between words, and whole sentences keep a natural pause.',
          'Gray “1.2s” chips are pauses — click one and press Delete to shorten it.',
          'Search with the box at the top. Ctrl+Z undoes any cut.',
          'Precision: cuts at pauses are clean. Cutting one word out of fast, continuous speech is accurate to roughly ±40 ms — listen back, and use the Roll tool (N) to fine-tune if a syllable is clipped.']},
    {t:'Remove filler words',k:'um uh filler stutter repeat ums ahs clean',
     d:'Find “um”, “uh”, stutters like “the the”, and optionally softer fillers such as “like” and “you know” — then cut them all in one step.',
     how:['In the Transcript tab press Fillers. Everything it found is highlighted.',
          'Click any highlighted word to keep it (it turns struck-through).',
          'Tick “unwritten sounds” to also catch the ums Whisper left out of the text — these can include breaths and laughs, so glance over them.',
          'Press Remove. It’s one undo step.']},
    {t:'Remove pauses',k:'silence dead air pause gap tighten jump cut',
     d:'Shorten or remove the silence between phrases, measured straight from the audio (no transcript needed).',
     how:['Transcript tab → Pauses…, or right-click a clip, or Ctrl+K → Remove pauses.',
          'Choose how long a pause must be to count and how much of it to leave so speech still breathes. The strip previews every cut in red.',
          'Untick music tracks under “Listen to” — music would hide the pauses. Lock a track to keep it from being cut at all.',
          'Press Remove pauses. One undo step.']},
    {t:'Detect scenes',k:'scene cut detection split shots camera change',
     d:'Find every camera cut inside a long clip \u2014 a whole film, a screen recording, a phone video that was edited before \u2014 and split it into one clip per shot, or drop a marker on each cut.',
     how:['Select the video clip, then AI tools \u2192 Detect scenes (or right-click the clip).',
          'The desktop app checks every frame with FFmpeg; in a browser it samples four frames a second and pins each cut to its exact frame.',
          'Move the sensitivity slider to see more or fewer cuts \u2014 the thumbnails show the first frame of each scene.',
          'Choose Split into scenes (the linked audio is split too) or Add markers.']},
    {t:'Beat sync',k:'beat music rhythm tempo bpm montage cut to the beat',
     d:'Cut to the music. Either lay a set of shots back to back so each lasts an exact number of beats, or keep your edit and nudge every cut onto the nearest beat.',
     how:['Put the music on an audio track. For a montage, select the shots (two or more video, image or title clips).',
          'AI tools \u2192 Beat sync. Pick the music clip and how many beats each shot should last.',
          'Choose Cut the selected clips, Snap my cuts, or Just add markers, then Apply. One undo step.',
          'A shot whose footage runs out before its beats end keeps its full length and the next one starts on the following beat.']},
    {t:'Auto-reframe (vertical / square)',k:'reframe vertical 9:16 shorts reels tiktok square 1:1 4:5 crop face track',
     d:'Turn a landscape edit into 9:16, 4:5 or 1:1 while keeping each shot\u2019s subject in frame. Faces are found on this computer.',
     how:['AI tools \u2192 Auto-reframe, pick the shape.',
          'Each shot holds perfectly still unless the person really moves; then the frame glides after them. Shots with nobody in them stay centered.',
          'The project changes to the new size and every clip gets ordinary position keyframes \u2014 adjust any shot by hand afterwards.',
          'Tip: do your transcript and pause edits first \u2014 every cut then becomes its own shot and is framed on its own.']},
    {t:'Captions and subtitles',k:'captions subtitles srt vtt burn text auto',
     d:'Make on-screen captions from the transcript, or export .srt / .vtt subtitle files. Both follow your edit.',
     how:['Transcript tab → Captions… (or the Captions button in the Media tab).',
          'Pick a titles track, a style and the line length, then Add captions. Re-running replaces the previous captions.',
          'For a subtitle file, use the ⋯ menu in the Transcript tab → Export subtitles.']},
  ]});
})();
