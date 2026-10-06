/* ==================== PRO: SPEAKER LABELS (v4.7) ====================
   Who is talking, per word, for each transcribed source:
     1. speech regions from the transcript's words;
     2. a voice print (GE2E, dev/pro-ge2e.js) every 0.8 s over 1.6 s windows,
        computed in background Workers;
     3. clustering: automatic count — average-linkage merging while voices
        are more alike than AUTO_TAU, tiny clusters folded in — or the count
        the user asks for (then prints are centered on the recording's own
        average first, which separates similar voices better);
     4. centroid refinement and a light Viterbi pass (switching speaker costs
        a little, so one odd window can't flip a sentence);
     5. every word takes the label of the windows that cover it.
   MEASURED (tests/pro-tools.js, words from ground truth): three synthetic
   voices 99% of words with the count found automatically; one voice → 1
   speaker; four voices with two near-identical 83%; a REAL two-woman phone
   call 94% when told "2" — automatic over-splits it to 4 (86%), which is why
   the panel lets you set the count, merge, rename and relabel paragraphs.
   Labels are stored by word START TIME (source seconds), so they survive
   re-transcribing other parts of the source and every edit. */
const PRO_SPK={win:1.6,step:0.8,gap:0.3,autoTau:0.70,lambda:0.05,minQ:0.9};
// v4.9: per-model settings (CAM++ voice prints are spread wider, so its threshold is lower)
const PRO_SPK_ENGINES={ge2e:{dim:256,autoTau:0.70,lambda:0.05},campp:{dim:192,autoTau:0.55,lambda:0.05}};
let _proSpkEngine='ge2e';   // the engine the current run uses
const PRO_SPK_COLORS=['#5aa0ff','#ff8a5c','#7ee08a','#e879f9','#ffd166','#4dd4c6','#ff6b8b','#b39cff'];
let _proSpkModel=null,_proSpkPool=null;
function _proSpkModelBuf(){
  if(_proSpkModel)return _proSpkModel;
  const el=document.getElementById('vibeSpeakerModel');
  if(!el)throw new Error('The speaker model isn’t in this copy of the app');
  const b=atob(el.textContent.trim()),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
  return _proSpkModel=u.buffer;
}
function _proSpkWorkers(){
  if(_proSpkPool)return _proSpkPool;
  const src='('+_proGe2eEngine.toString()+')()';
  const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
  const n=Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1));
  const pool=[];
  for(let i=0;i<n;i++){const w=new Worker(url);const ready=new Promise((res,rej)=>{w.onmessage=e=>{if(e.data.type==='ready')res();else if(e.data.type==='error')rej(new Error(e.data.error));};});
    w.postMessage({type:'load',buf:_proSpkModelBuf().slice(0)});pool.push({w,ready,busy:false});}
  return _proSpkPool=pool;
}
function proStopSpeakerWorkers(){if(_proSpkPool){_proSpkPool.forEach(p=>p.w.terminate());_proSpkPool=null;}}
// Embed windows (Float32Array(25600) each) on the worker pool. prog(done,total)
async function proEmbedWindows(makeBuf,count,prog,files){
  const cam=_proSpkEngine==='campp',dim=PRO_SPK_ENGINES[_proSpkEngine].dim;
  const pool=cam?proCamppPool(files):_proSpkWorkers();
  const stopAll=()=>cam?proStopCamppWorkers():proStopSpeakerWorkers();
  AI.cancelHook=()=>stopAll();          // Cancel ends the work at once
  try{await Promise.all(pool.map(p=>p.ready));}catch(e){stopAll();throw e;}
  const out=new Array(count);let next=0,done=0,stop=false;const B=6;
  try{await Promise.all(pool.map(p=>new Promise((res,rej)=>{
    const run=()=>{
      if(stop||AI.cancelled){stop=true;rej(new Error('cancelled'));return;}
      if(next>=count){res();return;}
      const i0=next,i1=Math.min(count,next+B);next=i1;
      const wins=[];for(let i=i0;i<i1;i++)wins.push(makeBuf(i));
      p.w.onmessage=e=>{const d=e.data;if(stop)return;
        if(d.type==='error'){stop=true;rej(new Error(d.error));return;}
        if(d.type!=='emb'||d.id!==i0)return;          // not this batch's reply
        for(let i=i0;i<i1;i++)out[i]=d.emb.subarray((i-i0)*dim,(i-i0+1)*dim);
        done+=i1-i0;prog&&prog(done,count);run();};
      p.w.postMessage({type:'embed',id:i0,windows:wins},wins.map(w=>w.buffer));
    };run();})));}
  catch(e){stop=true;stopAll();throw e;}
  finally{AI.cancelHook=null;}
  return out;
}
// ---------- clustering ----------
function _proDot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}
function _proNorm(v){let n=0;for(let i=0;i<v.length;i++)n+=v[i]*v[i];n=Math.sqrt(n)||1;const o=new Float32Array(v.length);for(let i=0;i<v.length;i++)o[i]=v[i]/n;return o;}
function _proCentroid(E,w,idx){const c=new Float32Array(E[0].length);for(const i of idx)for(let j=0;j<c.length;j++)c[j]+=E[i][j]*w[i];return _proNorm(c);}
// E: embeddings, w: weights (speech fraction), k: wanted count (0 = automatic),
// order: window indices in time order. Returns a label per window.
function proClusterSpeakers(E0,w,k,order){
  const n=E0.length;if(!n)return [];
  let E=E0;
  if(k){ // center on the recording's average voice (separates similar voices)
    const m=new Float32Array(E0[0].length);E0.forEach(e=>{for(let j=0;j<m.length;j++)m[j]+=e[j]/n;});
    E=E0.map(e=>_proNorm(e.map((v,j)=>v-m[j])));
  }
  const good=[];for(let i=0;i<n;i++)if(w[i]>=PRO_SPK.minQ)good.push(i);
  const seed=good.length>=2?good:[...Array(n).keys()];
  // average linkage; pairwise similarity matrix on the seed windows
  const S=seed.map(i=>seed.map(j=>_proDot(E[i],E[j])*w[i]*w[j]));
  let cl=seed.map((_,a)=>({m:[a]}));
  const link=(A,B)=>{let s=0,z=0;for(const a of A.m)for(const b of B.m){s+=S[a][b];z+=w[seed[a]]*w[seed[b]];}return s/z;};
  while(cl.length>1){
    let best=-2,bi=-1,bj=-1;
    for(let i=0;i<cl.length;i++)for(let j=i+1;j<cl.length;j++){const s=link(cl[i],cl[j]);if(s>best){best=s;bi=i;bj=j;}}
    if(k?cl.length<=k:best<PRO_SPK_ENGINES[_proSpkEngine].autoTau)break;
    cl[bi]={m:cl[bi].m.concat(cl[bj].m)};cl.splice(bj,1);
  }
  const total=seed.reduce((s,i)=>s+w[i],0);
  let C=cl.filter(c=>k||c.m.reduce((s,a)=>s+w[seed[a]],0)>=Math.max(1.5,0.06*total)).map(c=>_proCentroid(E,w,c.m.map(a=>seed[a])));
  if(!C.length)C=[_proCentroid(E,w,seed)];
  let lab=new Array(n).fill(0);
  for(let it=0;it<6;it++){
    lab=E.map(e=>{let b=0,bs=-9;C.forEach((c,q)=>{const s=_proDot(e,c);if(s>bs){bs=s;b=q;}});return b;});
    C=C.map((c,q)=>{const idx=[];lab.forEach((l,i)=>{if(l===q)idx.push(i);});return idx.length?_proCentroid(E,w,idx):c;});
  }
  // Viterbi smoothing along time
  const K=C.length;if(K<2)return lab;
  order=order||[...Array(n).keys()];
  let cost=new Array(K).fill(0);const back=[];
  for(const i of order){const nc=[],bk=[];
    for(let q=0;q<K;q++){let best=Infinity,bj=0;for(let j=0;j<K;j++){const v=cost[j]+(j===q?0:PRO_SPK_ENGINES[_proSpkEngine].lambda);if(v<best){best=v;bj=j;}}
      nc.push(best-_proDot(E[i],C[q])*w[i]);bk.push(bj);}
    cost=nc;back.push(bk);}
  let st=cost.indexOf(Math.min(...cost));const out=new Array(n);
  for(let t=order.length-1;t>=0;t--){out[order[t]]=st;st=back[t][st];}
  // renumber by first appearance so "Speaker 1" speaks first
  const map={};let nx=0;for(const i of order){if(map[out[i]]==null)map[out[i]]=nx++;}
  return out.map(l=>map[l]);
}
// ---------- the pipeline for one source ----------
function _proSpkRegions(words){
  const reg=[];for(const w of words){if(w[3])continue;const l=reg[reg.length-1];if(l&&w[1]-l[1]<PRO_SPK.gap)l[1]=Math.max(l[1],w[2]);else reg.push([w[1],w[2]]);}
  return reg;
}
function _proSpkWindows(reg){
  const WL=PRO_SPK.win,st=PRO_SPK.step,wins=[];
  for(const [a,b] of reg){const len=b-a;
    const starts=[];if(len<=WL)starts.push((a+b)/2-WL/2);
    else{for(let t=a;t+WL<=b+1e-6;t+=st)starts.push(t);if(starts[starts.length-1]+WL<b-0.2)starts.push(b-WL);}
    for(const s of starts)wins.push({s,e:s+WL,a,b,q:(Math.min(b,s+WL)-Math.max(a,s))/WL});
  }
  return wins;
}
// Voice prints come every 0.8 s, so a change of speaker is only known to within
// a word or two. People change turns at pauses and sentence ends: move each
// change to the best such point nearby (never across another change).
function _proSnapTurns(words,byT){
  const L=byT.map(x=>x[1]),n=L.length;
  const score=j=>{const gap=words[j][1]-words[j-1][2];return gap+(/[.?!]["'\u201d)]?$/.test(words[j-1][0])?0.35:0)+(/,$/.test(words[j-1][0])?0.08:0);};
  for(let k=1;k<n;k++){
    if(L[k]===L[k-1])continue;
    const a=L[k-1],b=L[k];
    // candidates: word boundaries within 0.9 s of the change, inside this turn pair
    let lo=k,hi=k;
    while(lo-1>0&&L[lo-2]===a&&L[lo-1]===a&&words[k][1]-words[lo-1][1]<0.9)lo--;
    while(hi+1<n&&L[hi+1]===b&&words[hi+1][1]-words[k][1]<0.9)hi++;
    let best=k,bs=score(k);
    for(let j=lo;j<=hi;j++){const s2=score(j);if(s2>bs+0.02){bs=s2;best=j;}}
    if(best!==k){for(let j=Math.min(best,k);j<Math.max(best,k);j++)L[j]=best<k?b:a;k=Math.max(best,k);}
  }
  L.forEach((l,i)=>{byT[i][1]=l;});
}
// Label speakers for a source. k = wanted number of speakers (0 = automatic).
async function proLabelSpeakers(root,k,prog){
  const tr=aiTranscriptOf(root);if(!tr||!tr.words.some(w=>!w[3]))throw new Error('Transcribe “'+root.name+'” first');
  const words=tr.words.filter(w=>!w[3]);
  prog&&prog(0.02,'Listening to “'+root.name+'”…');
  let y=await aiDecode16k(root);
  // v4.9: the CAM++ model when its files are installed (desktop app), else GE2E
  let files=(typeof proCamppFiles==='function'&&!PRO_SPK.forceGe2e&&!PRO_SPK.camppBroken)?await proCamppFiles():null;
  _proSpkEngine=files?'campp':'ge2e';
  const reg=_proSpkRegions(words),wins=_proSpkWindows(reg),SR=16000,N=Math.round(PRO_SPK.win*SR);
  let makeBuf=files
    ?i=>{const w=wins[i],a=Math.max(0,Math.round(Math.max(w.a,w.s)*SR)),b=Math.min(y.length,Math.round(Math.min(w.b,w.s+PRO_SPK.win)*SR));return y.slice(a,Math.max(a,b));}   // the voiced part only
    :i=>{const w=wins[i],buf=new Float32Array(N),a=Math.round(w.a*SR),b=Math.round(w.b*SR),s=Math.round(w.s*SR);
    for(let j=0;j<N;j++){const k2=s+j;if(k2>=a&&k2<b&&k2>=0&&k2<y.length)buf[j]=y[k2];}return buf;};
  const ge2eBuf=i=>{const w=wins[i],buf=new Float32Array(N),a=Math.round(w.a*SR),b=Math.round(w.b*SR),s=Math.round(w.s*SR);
    for(let j=0;j<N;j++){const k2=s+j;if(k2>=a&&k2<b&&k2>=0&&k2<y.length)buf[j]=y[k2];}return buf;};
  const embProg=(d,t)=>prog&&prog(0.05+0.85*d/t,'Telling voices apart — '+Math.round(d/t*100)+'%');
  let E;
  try{E=await proEmbedWindows(makeBuf,wins.length,embProg,files);}
  catch(e){
    // v4.9: a CAM++ install that won't load (damaged file…) falls back to the built-in model
    if(_proSpkEngine!=='campp'||AI.cancelled||/cancel/i.test(String(e&&e.message)))throw e;
    console.warn('[speakers] CAM++ failed, using the built-in model:',e);
    PRO_SPK.camppBroken=true;if(typeof proCamppForget==='function')proCamppForget();
    _proSpkEngine='ge2e';files=null;makeBuf=ge2eBuf;
    E=await proEmbedWindows(makeBuf,wins.length,embProg,null);
  }
  y=null;
  const order=wins.map((_,i)=>i).sort((p,q)=>wins[p].s-wins[q].s);
  const lab=proClusterSpeakers(E,wins.map(w=>w.q),k||0,order);
  const K=lab.length?Math.max(...lab)+1:0;
  // each word: the label with the most (overlap × speech fraction) among windows covering it
  const byT=[];
  for(const w of words){const vote=new Array(K).fill(0);
    for(let i=0;i<wins.length;i++){const x=wins[i];if(x.s>w[2]||x.e<w[1])continue;
      const ov=Math.min(w[2],x.e,x.b)-Math.max(w[1],x.s,x.a);if(ov>0)vote[lab[i]]+=ov*x.q;}
    const best=vote.indexOf(Math.max(...vote));byT.push([+w[1].toFixed(3),Math.max(0,best)]);}
  _proSnapTurns(words,byT);
  const old=tr.speakers;
  tr.speakers={byT,n:K,names:[...Array(K).keys()].map(i=>(old&&old.n===K&&old.names&&old.names[i])||('Speaker '+(i+1))),k:k||0,engine:_proSpkEngine};
  _proSpkIndex(tr,true);
  return {speakers:K,windows:wins.length,engine:_proSpkEngine};
}
// word start (source s) -> speaker index, via a cached Map
function _proSpkIndex(tr,rebuild){
  if(!tr||!tr.speakers)return null;
  if(!rebuild&&tr._spkMap)return tr._spkMap;
  const m=new Map();for(const [t,l] of tr.speakers.byT)m.set(t,l);
  Object.defineProperty(tr,'_spkMap',{value:m,writable:true,configurable:true,enumerable:false});
  return m;
}
// Speaker of a timeline-transcript entry, or null.
function proSpeakerOf(x){
  if(!x||x.wi==null||x.wi<0||!x.root)return null;
  const tr=aiTranscriptOf(x.root);if(!tr||!tr.speakers)return null;
  const w=tr.words[x.wi];if(!w)return null;
  const l=_proSpkIndex(tr).get(+w[1].toFixed(3));
  return l==null?null:{root:x.root,i:l,name:tr.speakers.names[l]||('Speaker '+(l+1)),color:PRO_SPK_COLORS[l%PRO_SPK_COLORS.length]};
}
function proHasSpeakers(){return aiTranscriptRoots().some(r=>{const t=aiTranscriptOf(r);return t&&t.speakers&&t.speakers.n>0;});}
function _proSpkSet(root,wordT,label){const tr=aiTranscriptOf(root);const m=_proSpkIndex(tr);
  for(const e of tr.speakers.byT)if(e[0]===wordT){e[1]=label;m.set(wordT,label);return;}
  tr.speakers.byT.push([wordT,label]);m.set(wordT,label);}
// ---------- undo ----------
// Speaker labels live on the media's transcript (not in state.clips), so the
// undo snapshots carry them explicitly: {rootId: speakers | 0} for every source
// with a transcript (core snapshot()/restore() call these, guarded).
function proSpkSnapshot(){
  const out={};let any=false;
  for(const m of state.media){const t=aiTranscriptOf(m);if(!t)continue;out[m.id]=t.speakers||0;any=true;}
  return any?out:undefined;
}
function proSpkRestore(spk){
  let changed=false;
  for(const id in spk){const m=state.media.find(x=>x.id===id),t=aiTranscriptOf(m);if(!t)continue;
    const cur=JSON.stringify(t.speakers||0),want=JSON.stringify(spk[id]);if(cur===want)continue;
    if(spk[id])t.speakers=JSON.parse(want);else delete t.speakers;
    if(t.speakers)_proSpkIndex(t,true);changed=true;}
  if(changed){TX.rev++;TX.dirty=true;if(TX.visible)aiTxRebuild(true);}
}
// Record `pre` (a snapshot taken before a long job) as the undo step for it.
function proSpkPushBefore(pre){
  state.history=state.history.slice(0,state.hIndex+1);
  if(state.history[state.history.length-1]!==pre)state.history.push(pre);
  state.hIndex=state.history.length-1;updateUndoUI();
}
// ---------- UI ----------
function proRenameSpeaker(root,i){
  const tr=aiTranscriptOf(root);if(!tr||!tr.speakers)return;
  const cur=tr.speakers.names[i]||('Speaker '+(i+1));
  const ov=$('#overlay');ov.classList.add('show');
  ov.innerHTML=`<div class="modal" style="width:min(380px,90vw)">
    <div class="modal-head"><div><h3>Rename speaker</h3><div class="sub">Used in the transcript, captions and subtitles.</div></div><button class="mclose" id="snX" title="Close without renaming (Esc)">\u2715</button></div>
    <div class="modal-body"><input class="tin" id="snIn" value="${esc(cur)}" maxlength="40" title="The speaker's name"></div>
    <div class="modal-foot"><div class="note"></div>
      <button class="tbtn" id="snCancel" style="border:1px solid var(--border)" title="Close without renaming">Cancel</button>
      <button class="tbtn primary" id="snOk" title="Apply the new name">Rename</button></div></div>`;
  setOverlayDismiss(closeOverlay);
  $('#snX').onclick=$('#snCancel').onclick=()=>closeOverlay();
  const ok=()=>{const v=$('#snIn').value.trim().slice(0,40);closeOverlay();if(!v||v===cur)return;
    pushHistory();tr.speakers.names[i]=v;TX.dirty=true;aiTxRebuild(true);toast('Renamed to '+v,'ok');};
  $('#snOk').onclick=ok;const inp=$('#snIn');inp.focus();inp.select();
  inp.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();ok();}};
}
function proMergeSpeaker(root,from,into){
  const tr=aiTranscriptOf(root);if(!tr||!tr.speakers)return;
  pushHistory();
  for(const e of tr.speakers.byT)if(e[1]===from)e[1]=into;
  // close the gap in numbering
  for(const e of tr.speakers.byT)if(e[1]>from)e[1]--;
  tr.speakers.names.splice(from,1);tr.speakers.n--;
  _proSpkIndex(tr,true);TX.dirty=true;aiTxRebuild(true);
  toast('Merged into '+tr.speakers.names[into>from?into-1:into],'ok');
}
// Give every word of the paragraph that starts at list index i0 to speaker `to`.
function proAssignParagraph(i0,to){
  const L=TX.list,x0=L[i0];const s0=proSpeakerOf(x0);if(!s0)return;
  const tr=aiTranscriptOf(s0.root);
  pushHistory();
  // only this paragraph as the transcript shows it: stop where the next one starts
  for(let i=i0;i<L.length;i++){const x=L[i];if(i>i0&&TX.paraStarts&&TX.paraStarts.has(i))break;if(x.root!==s0.root)break;if(x.k!=='w'){continue;}
    const sp=proSpeakerOf(x);if(i>i0&&(!sp||sp.i!==s0.i))break;
    _proSpkSet(s0.root,+tr.words[x.wi][1].toFixed(3),to);}
  TX.dirty=true;aiTxRebuild(true);
}
function proSelectSpeaker(root,i){
  const L=TX.list,idx=[];L.forEach((x,j)=>{const s=proSpeakerOf(x);if(s&&s.root===root&&s.i===i)idx.push(j);});
  if(!idx.length)return;
  TX.pauseSel=null;TX.sel=[idx[0],idx[idx.length-1]];TX.selSet=new Set(idx);TX.anchor=idx[0];TX.lastPtr='tx';
  aiTxPaint();
  if(typeof aiTxFocus==='function')aiTxFocus();   // Delete now cuts these words
  const d=idx.reduce((s,j)=>s+L[j].t1-L[j].t0,0);
  $('#txSelInfo').textContent=idx.length+' words by '+(proSpeakerOf(L[idx[0]]).name)+' · '+d.toFixed(1)+' s';
}
function proSpeakerChipMenu(el){
  const i0=+el.dataset.i,x=TX.list[i0],sp=proSpeakerOf(x);if(!sp)return;
  const tr=aiTranscriptOf(sp.root),others=tr.speakers.names.map((n,i)=>i).filter(i=>i!==sp.i);
  const r=el.getBoundingClientRect();
  showCtx(r.left,r.bottom+4,[
    {label:'Rename “'+esc(sp.name)+'”…',tip:'Give this speaker a name — used everywhere, including captions and subtitles',fn:()=>proRenameSpeaker(sp.root,sp.i)},
    {label:'Select all their words',tip:'Select everything this speaker says — press Delete to cut it all',fn:()=>proSelectSpeaker(sp.root,sp.i)},
    ...(others.length?[{sep:true}]:[]),
    ...others.map(o=>({label:'This paragraph is '+esc(tr.speakers.names[o]),tip:'Relabel just this paragraph',fn:()=>proAssignParagraph(i0,o)})),
    ...others.map(o=>({label:'Merge '+esc(sp.name)+' into '+esc(tr.speakers.names[o]),tip:'They are the same person — combine them everywhere in this source',fn:()=>proMergeSpeaker(sp.root,sp.i,o)})),
    {sep:true},
    {label:'Label speakers again…',tip:'Run speaker labeling again — for example with a different number of speakers',fn:()=>proSpeakersDialog()},
  ]);
}
async function proSpeakersDialog(){
  const roots=aiTranscriptRoots().filter(r=>{const t=aiTranscriptOf(r);return t&&t.words.some(w=>!w[3]);});
  if(!roots.length){toast('Transcribe your timeline first — speakers are labeled from the transcript');return;}
  const ov=$('#overlay');ov.classList.add('show');
  const prevK=(aiTranscriptOf(roots[0]).speakers||{}).k||0;
  ov.innerHTML=`<div class="modal aimodal" style="width:min(520px,94vw)">
    <div class="modal-head"><div><h3>Label speakers</h3>
      <div class="sub">Tell the voices in your transcript apart and mark who says what. Runs on this computer.</div></div>
      <button class="mclose" id="spX" title="Close (Esc)" aria-label="Close">✕</button></div>
    <div class="modal-body">
      <div class="gif-group"><label>Speakers</label><div class="seg sp-k" id="spK">
        ${[0,2,3,4,5,6].map(k=>`<button data-k="${k}" class="${k===prevK?'on':''}" title="${k?'There are exactly '+k+' people talking':'Work out how many people are talking'}">${k||'Auto'}</button>`).join('')}</div></div>
      <p class="sp-help">Auto works well when voices are clearly different. If two people sound alike (or it finds too many), set the number — or fix it afterwards: click any speaker name in the transcript to rename, merge or relabel a paragraph.</p>
      <p class="sp-help sp-src">${roots.length} source${roots.length>1?'s':''}: ${roots.map(r=>esc(r.name)).join(', ')}</p>
      <p class="sp-help sp-src" id="spModel">Voice model: checking…</p>
    </div>
    <div class="modal-foot"><div class="note">Names are kept if you run it again with the same count.</div>
      ${proHasSpeakers()?'<button class="tbtn" id="spClear" title="Remove the speaker labels">Remove labels</button>':''}
      <button class="tbtn primary" id="spGo" title="Label the speakers">Label speakers</button></div></div>`;
  setOverlayDismiss(closeOverlay);$('#spX').onclick=closeOverlay;
  (typeof proCamppPresent==='function'?proCamppPresent():Promise.resolve(false)).then(f=>{const el=$('#spModel');if(el)el.textContent=f
    ?'Voice model: CAM++ (high accuracy, installed with the desktop app).'
    :'Voice model: the built-in compact model. The desktop app includes a more accurate one (CAM++).';});
  let k=prevK;
  $$('#spK button').forEach(b=>b.onclick=()=>{k=+b.dataset.k;$$('#spK button').forEach(x=>x.classList.toggle('on',x===b));});
  if($('#spClear'))$('#spClear').onclick=()=>{pushHistory();roots.forEach(r=>{const t=aiTranscriptOf(r);if(t)delete t.speakers;});closeOverlay();TX.dirty=true;aiTxRebuild(true);toast('Speaker labels removed','ok');};
  $('#spGo').onclick=async()=>{
    closeOverlay();aiShowTab('tx');
    const pre=snapshot();   // one undo step, recorded only if labelling finishes
    const res=await aiRunJob('Labeling speakers',async prog=>{const out=[];
      try{for(let i=0;i<roots.length;i++)out.push(await proLabelSpeakers(roots[i],k,(f,m)=>prog((i+f)/roots.length,m)));}
      finally{if(typeof proCamppForget==='function')proCamppForget();}   // give the model's memory back
      return out;});
    if(!res)return;
    proSpkPushBefore(pre);
    TX.dirty=true;aiTxRebuild(true);
    const n=res.map(r=>r.speakers);
    toast(roots.length===1?('Found '+n[0]+' speaker'+(n[0]>1?'s':'')+' — click a name to rename it'):('Labeled speakers in '+roots.length+' sources'),'ok',5000);
  };
}
