
/* ---------- 3. Speech engine ---------- */
const AI_LIB='https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/dist/transformers.min.js';
const AI_MODELS=[
  {id:'Xenova/whisper-tiny.en',label:'Fast',note:'about 40 MB · quickest'},
  {id:'Xenova/whisper-base.en',label:'Accurate',note:'about 80 MB · fewer mistakes, roughly twice as slow'},
];
const AI={model:null,worker:null,workerModel:null,ready:null,seq:0,pending:{},job:null};
function aiModelId(){
  if(AI.model)return AI.model;               // tests / explicit override
  let m=null;try{m=localStorage.getItem('vibe-asr-model');}catch(e){}
  return AI_MODELS.some(x=>x.id===m)?m:AI_MODELS[0].id;
}
function aiSetModel(id){try{localStorage.setItem('vibe-asr-model',id);}catch(e){}}
// Whisper runs in a Web Worker so the editor stays responsive while it thinks.
// Cancel = terminate the worker: in-flight inference stops immediately.
const AI_WORKER_SRC=`
let mod=null,pipe=null,cur=null;
self.onmessage=async e=>{
  const d=e.data;
  try{
    if(d.type==='load'){
      if(!mod)mod=await import(d.lib);
      mod.env.allowLocalModels=false;
      if(cur!==d.model){
        pipe=null;
        pipe=await mod.pipeline('automatic-speech-recognition',d.model,{dtype:'q8',
          progress_callback:p=>{if(p&&p.status==='progress'&&p.total)postMessage({type:'progress',file:p.file,loaded:p.loaded,total:p.total});}});
        cur=d.model;
      }
      postMessage({type:'ready',id:d.id});
    }else if(d.type==='asr'){
      const out=await pipe(d.audio,d.opts);
      postMessage({type:'result',id:d.id,text:out.text,chunks:out.chunks||[]});
    }
  }catch(err){postMessage({type:'error',id:d.id,message:String(err&&err.message||err)});}
};`;
function _aiWorkerCall(msg,transfer){
  const id=++AI.seq;msg.id=id;
  return new Promise((res,rej)=>{AI.pending[id]={res,rej};AI.worker.postMessage(msg,transfer||[]);});
}
function aiStopWorker(){
  if(AI.worker){try{AI.worker.terminate();}catch(e){}}
  for(const k in AI.pending){AI.pending[k].rej(new Error('cancelled'));}
  AI.pending={};AI.worker=null;AI.workerModel=null;AI.ready=null;
}
async function aiLoadModel(onDownload){
  const model=aiModelId();
  if(AI.worker&&AI.workerModel===model&&AI.ready)return AI.ready;
  if(AI.worker&&AI.workerModel!==model)aiStopWorker();
  if(!AI.worker){
    AI.worker=new Worker(URL.createObjectURL(new Blob([AI_WORKER_SRC],{type:'text/javascript'})),{type:'module'});
    const files={};
    AI.worker.onmessage=e=>{
      const d=e.data;
      if(d.type==='progress'){files[d.file]=[d.loaded,d.total];
        let l=0,t=0;for(const k in files){l+=files[k][0];t+=files[k][1];}
        if(AI.onDownload)AI.onDownload(t?l/t:0);return;}
      const p=AI.pending[d.id];if(!p)return;delete AI.pending[d.id];
      if(d.type==='error')p.rej(new Error(d.message));else p.res(d);
    };
    AI.worker.onerror=e=>{const msg=(e&&e.message)||'speech worker failed';
      for(const k in AI.pending)AI.pending[k].rej(new Error(msg));AI.pending={};};
  }
  AI.onDownload=onDownload;
  AI.workerModel=model;
  AI.ready=_aiWorkerCall({type:'load',lib:AI_LIB,model}).catch(err=>{AI.ready=null;throw err;});
  return AI.ready;
}
async function aiRecognize(audio){
  const model=aiModelId();
  const opts={return_timestamps:'word'};
  if(!/\.en$/.test(model)){opts.language='english';opts.task='transcribe';}
  const copy=audio.slice(); // transferred to the worker
  return _aiWorkerCall({type:'asr',audio:copy,opts},[copy.buffer]);
}
// Share of the window's voiced audio that ended up under a word (0..1).
function aiWindowCoverage(env,a,b,words){
  const runs=aiVoicedRuns(env,a,b);
  const V=runs.reduce((s,r)=>s+r[1]-r[0],0);if(V<0.05)return 1;
  let C=0;for(const r of runs)for(const w of words)C+=Math.max(0,Math.min(r[1],w.e)-Math.max(r[0],w.s));
  return Math.min(1,C/V);
}
/* Recognize one window, and check the answer against the audio. The small
   models occasionally fail outright on a window (MEASURED: 1-2 in 8 start
   offsets over digital silence returned garbage with every timestamp collapsed
   onto one instant) or silently skip a sentence. Either shows up as voiced
   audio with no words on it, so a poorly covered window is retried from a
   shifted start (plus a whisper of dither over digital silence) and the best
   attempt wins. Words that fall before `a` belong to the previous window. */
async function aiRecognizeWindow(samples,env,a,b){
  const tries=[[a,b,false],[Math.max(0,a-0.5),b,true],[Math.max(0,a-0.2),Math.min(env.dur,b+0.3),true]];
  let best=null,attempts=0;
  for(const [x,y,dither] of tries){
    if(AI.cancelled)throw new Error('cancelled');
    attempts++;
    let seg=samples.subarray(Math.floor(x*AI_SR),Math.ceil(y*AI_SR));
    if(dither){seg=Float32Array.from(seg);let q=0x2545f491;
      for(let i=0;i<seg.length;i++)if(seg[i]===0){q^=q<<13;q^=q>>>17;q^=q<<5;seg[i]=((q>>>0)/4294967296-0.5)*6e-4;}}
    const r=await aiRecognize(seg);
    const inWin=w=>(w.s+w.e)/2>=a-1e-6&&(w.s+w.e)/2<b+1e-6;
    const raw=aiRawWords(r.chunks,x,y).filter(inWin);
    const words=aiRefineWords(raw,env,0).filter(inWin);
    const cov=aiWindowCoverage(env,a,b,words);
    if(!best||cov>best.cov)best={words,raw,cov};
    if(cov>=0.8)break;
    // the same answer again means the audio, not a glitch, is the limit (music, crowds)
    const txt=raw.map(w=>w.w).join(' ');if(txt===best.lastTxt)break;best.lastTxt=txt;
  }
  return {words:best.words,raw:best.raw,cov:best.cov,attempts};
}
/* Plan recognition windows inside the spans that need transcribing: at most
   28 s each (Whisper's context is 30 s), always ending in the quietest moment
   available so no word is ever split, and skipping stretches with no voice at
   all — silence is where Whisper invents text. */
function aiPlanWindows(env,spans,thr){
  thr=thr==null?env.auto:thr;
  const MAX=28,MIN=12,PRE=0.25,out=[];
  const voicedAt=f=>env.db[f]>thr;
  const firstVoiced=(a,b)=>{for(let f=Math.max(0,Math.floor(a/env.hop));f*env.hop<b&&f<env.db.length;f++)if(voicedAt(f))return f*env.hop;return null;};
  const lastVoiced=(a,b)=>{for(let f=Math.min(env.db.length-1,Math.floor(b/env.hop));f*env.hop>=a&&f>=0;f--)if(voicedAt(f))return (f+1)*env.hop;return null;};
  for(const [sa,sb0] of spans){
    const sb=Math.min(sb0,env.dur);let t=Math.max(0,sa);
    while(t<sb-0.05){
      const v=firstVoiced(t,sb);if(v==null)break;
      const ws=Math.max(t,v-PRE);let we=Math.min(sb,ws+MAX);
      if(we<sb){
        // quietest 300 ms in the back half of the window; ties go to the later point
        let best=we,bs=Infinity;
        for(let x=ws+MIN;x<=ws+MAX;x+=env.hop){const d=aiDbAround(env,x,0.15);if(d<=bs+0.25){bs=Math.min(bs,d);best=x;}}
        we=best;
      }
      const lv=lastVoiced(ws,we);
      if(lv!=null)out.push([ws,Math.min(we,lv+PRE)]);
      t=we;
    }
  }
  return out;
}
const _aiHasWordChars=s=>/[\p{L}\p{N}]/u.test(s);
// One window's raw chunks -> source-time words (punctuation-only tokens attach
// to the previous word). Timings are still Whisper's own at this point.
// Whisper writes non-speech as bracketed tags — "[screaming]", "(crowd cheering)",
// "[Music]" — and wraps sung lines in ♪. Tags become labelled SOUNDS (never
// words: not captioned, not searchable); ♪ marks are stripped from words.
// (Found on real footage: a clip of pure screaming transcribed as two "words".)
function aiRawWords(chunks,w0,w1){
  const raw=[];let tag=null;
  for(const ch of chunks){
    let txt=String(ch.text||'').replace(/\s+/g,' ').trim();if(!txt)continue;
    const ts=ch.timestamp||[];let s=+ts[0],e=+ts[1];
    if(!isFinite(s))continue;if(!isFinite(e)||e<s)e=s+0.3;
    s=clamp(s+w0,w0,w1);e=clamp(e+w0,w0,w1);
    if(tag||/^[\[(]/.test(txt)){
      if(!tag)tag={w:txt,s,e,tag:true};else{tag.w+=' '+txt;tag.e=e;}
      if(/[\])]$/.test(txt)){raw.push(tag);tag=null;}
      continue;
    }
    txt=txt.replace(/\u266a/g,'').trim();if(!txt)continue;
    if(!_aiHasWordChars(txt)){if(raw.length&&!raw[raw.length-1].tag)raw[raw.length-1].w+=txt;continue;}
    raw.push({w:txt,s,e});
  }
  if(tag)raw.push(tag);
  return raw;
}
/* Whisper's word times come from cross-attention and run LATE. Measured on
   ground-truth speech: mid-sentence boundaries ~80 ms late, sentence starts
   ~190 ms late. The lag varies with model and voice, so it is measured on each
   recording: where a word ends right before a pause, the audio says exactly
   when it really ended. The median of (Whisper end - acoustic end) is the lag
   (0 if there are too few such places to trust). */
function aiMeasureLag(raw,env,thr){
  thr=thr==null?env.auto:thr;const hop=env.hop,db=env.db,sil=Math.round(0.15/hop),d=[];
  for(const w of raw){
    let best=null;
    for(let f=Math.floor((w.e-0.4)/hop);f<Math.floor((w.e+0.1)/hop);f++){
      if(f<=0||f+sil>=db.length||db[f]<=thr)continue;
      let quiet=true;for(let g=f+1;g<=f+sil;g++)if(db[g]>thr){quiet=false;break;}
      if(quiet)best=(f+1)*hop;
    }
    if(best!=null)d.push(w.e-best);
  }
  if(d.length<4)return 0;
  d.sort((x,y)=>x-y);return clamp(d[d.length>>1],0,0.15);
}
/* Raw words -> clean words that sit on the audio they actually cover:
   - every time shifts back by the measured lag;
   - each word is tightened onto its voiced run. A word whose span holds
     several runs (it swallowed a pause and whatever followed — often an "um"
     Whisper chose not to write) keeps the run nearest its start;
   - a word that starts just after a pause snaps to the true acoustic onset;
   - a boundary inside continuous speech moves to the quietest instant within
     60 ms (the dip between words), halving the timing error (measured: median
     80-90 ms -> 34-37 ms against ground truth);
   - a word with no voice anywhere near it is a hallucination and is dropped;
   - a phrase repeated 3+ times back-to-back (Whisper's loop failure) keeps one. */
function aiRefineWords(raw,env,lag,thr){
  thr=thr==null?env.auto:thr;lag=lag||0;
  const hop=env.hop,db=env.db,out=[];
  const silentBefore=(f,n)=>{for(let g=f-n;g<f;g++)if(g<0||db[g]>thr)return false;return true;};
  for(const w0 of raw){
    if(w0.tag){if(w0.e-w0.s>=0.15)out.push({w:w0.w,s:Math.max(0,w0.s-lag),e:Math.max(0,w0.e-lag),tag:true});continue;} // tag times can be degenerate
    const x={w:w0.w,s:Math.max(0,w0.s-lag),e:Math.max(0,w0.e-lag)};
    let runs=aiVoicedRuns(env,x.s,x.e,thr);
    if(!runs.length){
      runs=aiVoicedRuns(env,x.s-0.15,x.e+0.15,thr);
      if(!runs.length)continue;                              // no voice at all: hallucinated
      const r=runs.reduce((a,b)=>Math.min(Math.abs(a[0]-x.s),Math.abs(a[1]-x.e))<=Math.min(Math.abs(b[0]-x.s),Math.abs(b[1]-x.e))?a:b);
      x.s=Math.max(x.s-0.15,r[0]);x.e=Math.min(x.e+0.15,r[1]);
    }else{
      const r=runs.reduce((a,b)=>Math.abs(a[0]-x.s)<=Math.abs(b[0]-x.s)?a:b);
      x.s=Math.max(x.s,r[0]);x.e=Math.min(x.e,r[1]+0.03);
    }
    // onset snap: a voiced run starting up to 0.3 s earlier, after real silence
    const prev=out[out.length-1];
    for(let f=Math.floor((x.s-0.3)/hop);f<=Math.round(x.s/hop);f++){
      if(f>0&&f<db.length&&db[f]>thr&&db[f-1]<=thr&&silentBefore(f,12)&&(!prev||f*hop>=prev.e-1e-6)){x.s=f*hop;break;}
    }
    if(prev&&x.s<prev.e)x.s=prev.e;
    // No spoken word lasts seconds. An overlong word swallowed noise or music
    // before it (MEASURED on film audio: "There's" spanning 1.6 s of crowd
    // shouting); keep its end, which the next word anchors, and trim the start.
    const cap=Math.max(0.9,0.09*x.w.length+0.45);
    if(x.e-x.s>cap)x.s=x.e-cap;
    if(x.e-x.s<0.04)x.e=x.s+0.04;
    out.push(x);
  }
  // continuous-speech boundaries -> the energy dip between the words
  for(let i=1;i<out.length;i++){
    const p=out[i-1],c=out[i];
    if(p.tag||c.tag||c.s-p.e>0.03)continue;
    const b0=(p.e+c.s)/2,R=0.06;let best=b0,bs=Infinity;
    for(let f=Math.round((b0-R)/hop);f<=Math.round((b0+R)/hop);f++){
      if(f<0||f>=db.length)continue;const t=f*hop;
      if(t<=p.s+0.04||t>=c.e-0.04)continue;
      const sc=db[f]+10*Math.abs(t-b0)/R;if(sc<bs){bs=sc;best=t;}
    }
    p.e=best;c.s=best;
  }
  // loop guard
  const norm=w=>w.toLowerCase().replace(/[^\p{L}\p{N}']/gu,'');
  for(let n=6;n>=2;n--){
    for(let i=0;i+3*n<=out.length;i++){
      const g=k=>out.slice(i+k*n,i+k*n+n).map(q=>norm(q.w)).join(' ');
      if(g(0)&&g(0)===g(1)&&g(1)===g(2)){let k=3;while(i+(k+1)*n<=out.length&&g(k)===g(0))k++;out.splice(i+n,(k-1)*n);}
    }
  }
  return out;
}
// Back-compat single-step helper (raw -> refined, no lag): used for scoring.
function aiFixWords(chunks,env,w0,w1,thr){return aiRefineWords(aiRawWords(chunks,w0,w1),env,0,thr);}
// Transcript storage on the root media: compact [text, start, end] rows plus
// the source spans already covered (so extending a clip only transcribes the
// new part). Saved in the project file; nothing is ever sent anywhere.
function aiTranscriptOf(root){return root&&root.transcript&&Array.isArray(root.transcript.words)?root.transcript:null;}
function aiSpanUnion(spans){
  const s=spans.map(x=>[x[0],x[1]]).sort((a,b)=>a[0]-b[0]),out=[];
  for(const r of s){const l=out[out.length-1];if(l&&r[0]<=l[1]+1e-6)l[1]=Math.max(l[1],r[1]);else out.push(r);}
  return out;
}
function aiSpanSubtract(spans,cover){
  const out=[];
  for(const [a,b] of spans){
    let cur=[[a,b]];
    for(const [c,d] of cover){const nx=[];for(const [x,y] of cur){if(d<=x||c>=y){nx.push([x,y]);continue;}
      if(c>x)nx.push([x,c]);if(d<y)nx.push([d,y]);}cur=nx;}
    out.push(...cur.filter(r=>r[1]-r[0]>0.3));
  }
  return out;
}
/* A new span that continues an already-transcribed one (a clip was extended)
   starts where the old recognition window was cut off — often mid-word, so
   the old words there are garbled. Widen the new span back (and forward) to
   the nearest pause within 3 s; its words are recognized again and replace the
   old ones there (review fix). */
function _aiSeamPoint(env,t,dir){
  const hop=env.hop,need=Math.round(0.15/hop),F=Math.round(t/hop),lim=Math.round(3/hop);let run=0;
  for(let k=0;k<=lim;k++){const f=F+dir*k;if(f<0)return 0;if(f>=env.db.length)return env.dur;
    if(env.db[f]<=env.auto){if(++run>=need)return Math.max(0,Math.min(env.dur,(f-dir*Math.floor(need/2))*hop));}else run=0;}
  let best=t,bs=Infinity;
  for(let k=0;k<=lim;k++){const x=t+dir*k*hop;if(x<0||x>env.dur)break;const d=aiDbAround(env,x,0.05);if(d<bs-0.01){bs=d;best=x;}}
  return best;
}
function aiWidenSeams(env,todo,covered){
  return aiSpanUnion(todo.map(([a,b])=>{
    if(covered.some(c=>Math.abs(c[1]-a)<0.05))a=Math.min(a,_aiSeamPoint(env,a,-1));
    if(covered.some(c=>Math.abs(c[0]-b)<0.05))b=Math.max(b,_aiSeamPoint(env,b,1));
    return [a,b];
  }));
}
// Source spans of `root` that the timeline actually uses (+1 s margin for trims).
function aiUsedSpans(root){
  const spans=[];
  for(const c of state.clips){
    const m=aiMediaOfClip(c);if(!m||aiRoot(m)!==root||(c.type!=='video'&&c.type!=='audio'))continue;
    if(c.freeze)continue;
    const sp=c.props.speed||1,a=c.inPoint||0;
    spans.push([Math.max(0,a-1),Math.min(root.duration||1e9,a+c.duration*sp+1)]);
  }
  return aiSpanUnion(spans);
}
/* Transcribe the parts of `root` listed in `spans` that are not yet covered.
   onProgress(fraction, message). Throws 'cancelled' if aiCancelJob() is called. */
async function aiTranscribe(root,spans,onProgress,opts){
  const prog=onProgress||(()=>{});opts=opts||{};
  // opts.fresh: transcribe from scratch into opts.fresh.out (the stored
  // transcript is untouched until the caller swaps it in)
  const tr=opts.fresh?null:aiTranscriptOf(root);
  let todo=aiSpanSubtract(aiSpanUnion(spans),tr?tr.covered||[]:[]);
  if(!todo.length)return {added:0};
  prog(0,'Loading the speech model…');
  await aiLoadModel(f=>prog(f*0.15,'Downloading the speech model (one time only) — '+Math.round(f*100)+'%'));
  prog(0.15,'Reading the audio…');
  const samples=await aiDecode16k(root);
  const env=aiSetEnvelope(root,samples);
  if(tr)todo=aiWidenSeams(env,todo,tr.covered||[]);
  const wins=aiPlanWindows(env,todo);
  const total=wins.reduce((a,w)=>a+w[1]-w[0],0)||1;let done=0;
  const words=[],rawAll=[];
  let retries=0;
  for(const [a,b] of wins){
    if(AI.cancelled)throw new Error('cancelled');
    prog(0.18+0.8*done/total,'Transcribing “'+root.name+'” — '+fmtDur(a)+' of '+fmtDur(env.dur));
    const r=await aiRecognizeWindow(samples,env,a,b);
    retries+=r.attempts-1;
    rawAll.push(...r.raw);
    done+=b-a;
  }
  const lag=aiMeasureLag(rawAll,env);
  words.push(...aiRefineWords(rawAll,env,lag));
  const t=opts.fresh?(opts.fresh.out={v:1,model:aiModelId(),words:[],covered:[]}):(root.transcript=root.transcript||{v:1,model:aiModelId(),words:[],covered:[]});
  const keep=t.words.filter(w=>!todo.some(([a,b])=>w[1]>=a-1e-6&&w[1]<b));
  t.words=keep.concat(words.map(w=>w.tag?[w.w,+w.s.toFixed(3),+w.e.toFixed(3),1]:[w.w,+w.s.toFixed(3),+w.e.toFixed(3)])).sort((x,y)=>x[1]-y[1]);
  t.covered=aiSpanUnion((t.covered||[]).concat(todo));
  t.model=aiModelId();t.lag=+lag.toFixed(3);
  prog(1,'Done');
  return {added:words.length,windows:wins.length,retries,lag};
}
