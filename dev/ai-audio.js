
/* ---------- 2. Audio analysis ----------
   Each source is decoded once to 16 kHz mono (what Whisper wants) and reduced
   to a 10 ms energy envelope in dBFS. The envelope is all the pause detector
   and the cut-point refiner need, and it is tiny (an hour = 1.4 MB), so the
   samples themselves are dropped as soon as a job is done. */
const AI_SR=16000, AI_HOP=0.01;
const _aiEnv={};        // root media id -> {db:Float32Array, hop, dur, floor, loud, auto}
// Detached audio is the parent video's sound: analysis and transcripts live on
// the ROOT (the parent), so both clips share one transcript and one envelope.
function aiRoot(m){
  if(!m)return null;
  if(m.fromMedia){const p=state.media.find(x=>x.id===m.fromMedia);if(p)return p;}
  return m;
}
function aiMediaOfClip(c){return c&&c.mediaId?state.media.find(x=>x.id===c.mediaId):null;}
async function aiDecode16k(m){
  const url=m.url;
  if(!url||m.missing)throw new Error('“'+(m.name||'This file')+'” is offline — relink it first');
  const arr=await (await fetch(url)).arrayBuffer();
  let buf=null;
  // Decoding straight into a 16 kHz context resamples during decode (small and
  // fast). Validate the length: under memory pressure decodeAudioData can hand
  // back a PARTIAL buffer instead of failing (see ensureDecodedBuffer).
  try{buf=await new OfflineAudioContext(1,1,AI_SR).decodeAudioData(arr.slice(0));}catch(e){buf=null;}
  if(!buf||(m.duration>0&&buf.duration<m.duration-1.5)){
    try{
      const ctx=new (window.AudioContext||window.webkitAudioContext)();
      const b=await ctx.decodeAudioData(arr.slice(0));try{ctx.close();}catch(_){}
      if(!buf||b.duration>buf.duration)buf=b;
    }catch(e){}
  }
  if(!buf)throw new Error('“'+(m.name||'This file')+'” has no audio track the app can read');
  if(buf.sampleRate!==AI_SR){
    const off=new OfflineAudioContext(1,Math.ceil(buf.duration*AI_SR),AI_SR);
    const src=off.createBufferSource();src.buffer=buf;src.connect(off.destination);src.start();
    buf=await off.startRendering();
  }
  const n=buf.length,out=new Float32Array(n),nch=buf.numberOfChannels;
  for(let ch=0;ch<nch;ch++){const d=buf.getChannelData(ch);for(let i=0;i<n;i++)out[i]+=d[i]/nch;}
  return out;
}
// 20 ms RMS window every 10 ms, in dBFS (floored at -100 so digital silence is finite).
function aiEnvelope(samples){
  const hop=Math.round(AI_SR*AI_HOP),win=hop*2,n=Math.ceil(samples.length/hop),db=new Float32Array(n);
  for(let f=0;f<n;f++){
    const a=Math.max(0,f*hop-hop/2),b=Math.min(samples.length,a+win);let s=0;
    for(let i=a;i<b;i++)s+=samples[i]*samples[i];
    db[f]=Math.max(-100,10*Math.log10(s/Math.max(1,b-a)+1e-12));
  }
  return db;
}
function _aiPct(sorted,p){return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:-100;}
// Noise floor, speech level and an automatic speech/silence threshold. The
// threshold sits a third of the way from the floor to the speech level, but
// never closer than 8 dB to the floor (room tone must not read as speech).
function aiEnvStats(db){
  const s=Float32Array.from(db).sort();
  const floor=_aiPct(s,0.10),loud=_aiPct(s,0.95);
  const auto=Math.min(loud-6,Math.max(floor+8,floor+(loud-floor)*0.33));
  return {floor,loud,auto};
}
function aiSetEnvelope(root,samples){
  const db=aiEnvelope(samples);
  const e=Object.assign({db,hop:AI_HOP,dur:samples.length/AI_SR},aiEnvStats(db));
  _aiEnv[root.id]=e;return e;
}
async function aiEnsureEnvelope(root){
  if(_aiEnv[root.id])return _aiEnv[root.id];
  const samples=await aiDecode16k(root);
  return aiSetEnvelope(root,samples);
}
function aiDbAt(env,t){const f=Math.round(t/env.hop);return (f>=0&&f<env.db.length)?env.db[f]:-100;}
// Mean energy over [t-r, t+r] — used to rank candidate cut points.
function aiDbAround(env,t,r){
  const a=Math.max(0,Math.round((t-r)/env.hop)),b=Math.min(env.db.length-1,Math.round((t+r)/env.hop));
  if(b<a)return -100;let s=0;for(let f=a;f<=b;f++)s+=Math.pow(10,env.db[f]/10);
  return 10*Math.log10(s/(b-a+1)+1e-12);
}
// Voiced runs [start,end] (seconds) inside [a,b]. Dips shorter than `bridge`
// (stop consonants, micro-pauses) are bridged so one word stays one run.
function aiVoicedRuns(env,a,b,thr,bridge){
  thr=thr==null?env.auto:thr;bridge=bridge==null?0.12:bridge;
  const f0=Math.max(0,Math.floor(a/env.hop)),f1=Math.min(env.db.length-1,Math.ceil(b/env.hop));
  const runs=[];let st=-1;
  for(let f=f0;f<=f1;f++){
    const v=env.db[f]>thr;
    if(v&&st<0)st=f;
    if((!v||f===f1)&&st>=0){runs.push([st*env.hop,(v?f+1:f)*env.hop]);st=-1;}
  }
  const out=[];
  for(const r of runs){const l=out[out.length-1];if(l&&r[0]-l[1]<bridge)l[1]=r[1];else out.push(r);}
  return out;
}
