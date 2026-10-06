/* ==================== PRO: CAM++ SPEAKER MODEL (v4.9) ====================
   A much stronger voice-print model than the built-in GE2E: CAM++ (3D-Speaker,
   Apache-2.0), run with ONNX Runtime Web inside Workers. Its files ship with
   the desktop app in app/models/ (≈29 MB: the graph, float16 weights and the
   ONNX Runtime wasm), read through the native bridge — so it works offline.
   When they aren't there (the single-file browser copy), speaker labels use
   GE2E as before.
   Features: 80-bin Kaldi log-fbank (povey window, pre-emphasis 0.97, no dither,
   25/10 ms, 20 Hz–Nyquist), mean-normalized per window — matched to
   torchaudio.compliance.kaldi.fbank in tests/pro-grade.js. */
const PRO_CAMPP_FILES={graph:'speaker-campp.onnx',weights:'speaker-campp.f16',ort:'ort.wasm.bundle.min.mjs',wasm:'ort-wasm-simd-threaded.wasm'};
// Kaldi fbank of a 16 kHz mono Float32Array → {F: Float32Array(T*80), T}
function proKaldiFbank(x,cmn){
  const FL=400,FS=160,NF=512,NB=80,SR=16000;
  const T=x.length<FL?0:1+Math.floor((x.length-FL)/FS);
  const F=new Float32Array(T*NB);if(!T)return {F,T};
  const G=proKaldiFbank._g||(proKaldiFbank._g=(()=>{
    const win=new Float32Array(FL);for(let i=0;i<FL;i++)win[i]=Math.pow(0.5-0.5*Math.cos(2*Math.PI*i/(FL-1)),0.85);
    const mel=f=>1127*Math.log(1+f/700),lo=mel(20),hi=mel(SR/2),d=(hi-lo)/(NB+1),bw=SR/NF;
    const banks=[];
    for(let m=0;m<NB;m++){const l=lo+m*d,c=l+d,r=c+d,w=new Float32Array(NF/2);let a=-1,b=-1;
      for(let i=0;i<NF/2;i++){const z=mel(i*bw);let v=0;if(z>l&&z<r)v=z<=c?(z-l)/(c-l):(r-z)/(r-c);w[i]=v;if(v>0){if(a<0)a=i;b=i;}}
      banks.push({w,a,b});}
    // radix-2 FFT tables
    const rev=new Uint16Array(NF);for(let i=0,j=0;i<NF;i++){rev[i]=j;let bit=NF>>1;while(j&bit){j^=bit;bit>>=1;}j|=bit;}
    const cs=new Float64Array(NF/2),sn=new Float64Array(NF/2);for(let i=0;i<NF/2;i++){cs[i]=Math.cos(-2*Math.PI*i/NF);sn[i]=Math.sin(-2*Math.PI*i/NF);}
    return {win,banks,rev,cs,sn};})());
  const re=new Float64Array(NF),im=new Float64Array(NF),fr=new Float64Array(FL),pw=new Float64Array(NF/2);
  for(let t=0;t<T;t++){
    let mean=0;for(let i=0;i<FL;i++){fr[i]=x[t*FS+i];mean+=fr[i];}mean/=FL;
    for(let i=0;i<FL;i++)fr[i]-=mean;
    for(let i=FL-1;i>0;i--)fr[i]-=0.97*fr[i-1];fr[0]-=0.97*fr[0];
    re.fill(0);im.fill(0);for(let i=0;i<FL;i++)re[G.rev[i]]=fr[i]*G.win[i];
    for(let s=2;s<=NF;s<<=1){const h=s>>1,k=NF/s;
      for(let i=0;i<NF;i+=s)for(let j=0;j<h;j++){const c=G.cs[j*k],n=G.sn[j*k],a=i+j,b=a+h;
        const tr=re[b]*c-im[b]*n,ti=re[b]*n+im[b]*c;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;}}
    for(let i=0;i<NF/2;i++)pw[i]=re[i]*re[i]+im[i]*im[i];
    for(let m=0;m<NB;m++){const B=G.banks[m];let s=0;for(let i=B.a;i<=B.b;i++)s+=B.w[i]*pw[i];F[t*NB+m]=Math.log(Math.max(1.1920928955078125e-7,s));}
  }
  if(cmn){for(let m=0;m<NB;m++){let s=0;for(let t=0;t<T;t++)s+=F[t*NB+m];s/=T;for(let t=0;t<T;t++)F[t*NB+m]-=s;}}
  return {F,T};
}
// The Worker body (also stringified with proKaldiFbank into the Worker source).
function _proCamppWorker(){
  let ort=null,sess=null;
  const half=h=>{const s=h>>15,e=(h>>10)&31,f=h&1023;const v=e===0?f*5.960464477539063e-8:e===31?(f?NaN:Infinity):Math.pow(2,e-15)*(1+f/1024);return s?-v:v;};
  self.onmessage=async e=>{const d=e.data;
    try{
      if(d.type==='load'){
        ort=await import(URL.createObjectURL(new Blob([d.ortSrc],{type:'text/javascript'})));
        ort.env.wasm.wasmBinary=d.wasm;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
        const h=new Uint16Array(d.weights),w=new Float32Array(h.length);
        const lut=new Float32Array(65536);for(let i=0;i<65536;i++)lut[i]=half(i);
        for(let i=0;i<h.length;i++)w[i]=lut[h[i]];
        sess=await ort.InferenceSession.create(new Uint8Array(d.graph),{executionProviders:['wasm'],externalData:[{path:'speaker-campp.data',data:new Uint8Array(w.buffer)}]});
        self.postMessage({type:'ready'});return;
      }
      if(d.type==='embed'){
        const out=new Float32Array(d.windows.length*192);
        for(let k=0;k<d.windows.length;k++){
          let x=d.windows[k];
          if(x.length<8000){const y=new Float32Array(8000);for(let i=0;i<8000;i++)y[i]=x.length?x[i%x.length]:0;x=y;}   // very short: repeat to 0.5 s
          const {F,T}=proKaldiFbank(x,true);
          const r=await sess.run({feats:new ort.Tensor('float32',F,[1,T,80])});
          const v=r.emb.data;let n=0;for(let i=0;i<192;i++)n+=v[i]*v[i];n=Math.sqrt(n)||1;
          for(let i=0;i<192;i++)out[k*192+i]=v[i]/n;
        }
        self.postMessage({type:'emb',id:d.id,emb:out},[out.buffer]);
      }
    }catch(err){self.postMessage({type:'error',error:String(err&&err.message||err)});}
  };
}
let _proCamppFilesP=null;
// Read the model files next to the app (desktop: native bridge; served copies: fetch/XHR).
function proCamppFiles(){
  if(_proCamppFilesP)return _proCamppFilesP;
  const base=new URL('models/',location.href);
  const read=async name=>{
    const u=new URL(name,base);
    if(u.protocol==='file:'&&window.vibeNative&&vibeNative.readPath){
      let p=decodeURIComponent(u.pathname);if(/^\/[A-Za-z]:/.test(p))p=p.slice(1);
      const r=await vibeNative.readPath(p);if(!r||!r.ok)throw new Error('missing '+name);
      const b=r.bytes;return b.buffer?b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength):b;
    }
    return await new Promise((res,rej)=>{const q=new XMLHttpRequest();q.open('GET',u.href);q.responseType='arraybuffer';
      q.onload=()=>(q.status===200||(q.status===0&&q.response&&q.response.byteLength))?res(q.response):rej(new Error('missing '+name));
      q.onerror=()=>rej(new Error('missing '+name));q.send();});
  };
  return _proCamppFilesP=(async()=>{
    try{const [graph,weights,ortBuf,wasm]=await Promise.all([read(PRO_CAMPP_FILES.graph),read(PRO_CAMPP_FILES.weights),read(PRO_CAMPP_FILES.ort),read(PRO_CAMPP_FILES.wasm)]);
      return {graph,weights,ortSrc:new TextDecoder().decode(ortBuf),wasm};}
    catch(e){return null;}
  })();
}
let _proCamppPool=null;
function proCamppPool(files){
  if(_proCamppPool)return _proCamppPool;
  const src=proKaldiFbank.toString()+'\n('+_proCamppWorker.toString()+')()';
  const url=URL.createObjectURL(new Blob([src],{type:'text/javascript'}));
  const n=Math.max(1,Math.min(3,(navigator.hardwareConcurrency||2)-1));
  const pool=[];
  for(let i=0;i<n;i++){const w=new Worker(url);
    const ready=new Promise((res,rej)=>{w.onmessage=e=>{if(e.data.type==='ready')res();else if(e.data.type==='error')rej(new Error(e.data.error));};
      w.onerror=e=>rej(new Error('The speaker model worker failed: '+((e&&e.message)||'error')));});
    w.postMessage({type:'load',ortSrc:files.ortSrc,wasm:files.wasm.slice(0),graph:files.graph.slice(0),weights:files.weights.slice(0)});
    pool.push({w,ready,busy:false});}
  return _proCamppPool=pool;
}
function proStopCamppWorkers(){if(_proCamppPool){_proCamppPool.forEach(p=>p.w.terminate());_proCamppPool=null;}}
function proCamppForget(){proStopCamppWorkers();_proCamppFilesP=null;}
// Are the model files installed? (cheap: no reading)
async function proCamppPresent(){
  if(PRO_SPK.camppBroken)return false;
  const base=new URL('models/',location.href);
  if(base.protocol==='file:'&&window.vibeNative&&vibeNative.statPath){
    try{const all=await Promise.all(Object.values(PRO_CAMPP_FILES).map(n=>{let p=decodeURIComponent(new URL(n,base).pathname);if(/^\/[A-Za-z]:/.test(p))p=p.slice(1);return vibeNative.statPath(p);}));
      return all.every(r=>r&&r.ok!==false&&!r.missing);}catch(e){return false;}
  }
  return !!(await proCamppFiles());
}
