/* ==================== PRO: SPEAKER EMBEDDINGS (v4.7) ====================
   A GE2E speaker encoder (Wan et al. 2018; the pretrained weights published
   with Resemblyzer, Apache-2.0) implemented in plain JavaScript: 40-band
   mel power spectrogram, 3-layer LSTM (256), linear + ReLU, L2 norm. It maps
   1.6 s of speech to a 256-number "voice print"; two stretches of the same
   voice land close together. The weights (2.8 MB, float16) are embedded in
   the page, so labelling speakers works offline with no download.
   This whole function is ALSO the Worker's source (see _proGe2eWorker), and
   tests/ge2e-reference.js runs it in Node against the Python original. */
function _proGe2eEngine(){
  const SR=16000,NFFT=400,HOP=160,NMEL=40,NF=160,H=256;
  let W=null;                    // {ih:[3],hh:[3],b:[3],lw,lb}
  // ---- float16 -> float32 ----
  function f16(u16){const out=new Float32Array(u16.length);
    for(let i=0;i<u16.length;i++){const h=u16[i],s=h&0x8000?-1:1,e=(h>>10)&31,m=h&1023;
      out[i]=e===0?s*m*5.960464477539063e-8:e===31?(m?NaN:s*Infinity):s*Math.pow(2,e-15)*(1+m/1024);}
    return out;}
  function load(buf){
    const dv=new DataView(buf);
    if(String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3))!=='VGE2')throw new Error('bad speaker model');
    const hl=dv.getUint32(4,true);const hdr=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,8,hl)));
    let off=8+hl;off+=(8-off%8)%8;
    const T={};
    for(const [k,shape] of hdr.tensors){const n=shape.reduce((a,b)=>a*b,1);T[k]=f16(new Uint16Array(buf,off,n));off+=n*2;}
    W={ih:[0,1,2].map(l=>T['lstm.weight_ih_l'+l]),hh:[0,1,2].map(l=>T['lstm.weight_hh_l'+l]),
       b:[0,1,2].map(l=>{const a=T['lstm.bias_ih_l'+l],c=T['lstm.bias_hh_l'+l],o=new Float32Array(4*H);for(let i=0;i<4*H;i++)o[i]=a[i]+c[i];return o;}),
       lw:T['linear.weight'],lb:T['linear.bias']};
  }
  // ---- librosa.feature.melspectrogram(sr=16000,n_fft=400,hop=160,n_mels=40): hann, center, power 2, Slaney mel ----
  const NB=NFFT/2+1,WIN=new Float32Array(NFFT),COS=new Float32Array(NB*NFFT),SIN=new Float32Array(NB*NFFT);
  for(let n=0;n<NFFT;n++)WIN[n]=0.5-0.5*Math.cos(2*Math.PI*n/NFFT);
  for(let k=0;k<NB;k++)for(let n=0;n<NFFT;n++){const a=2*Math.PI*k*n/NFFT;COS[k*NFFT+n]=Math.cos(a);SIN[k*NFFT+n]=Math.sin(a);}
  const hz2mel=f=>f<1000?f/(200/3):15+Math.log(f/1000)/(Math.log(6.4)/27);
  const mel2hz=m=>m<15?m*(200/3):1000*Math.exp((m-15)*(Math.log(6.4)/27));
  const MELW=(()=>{const mn=hz2mel(0),mx=hz2mel(SR/2),mf=[];for(let i=0;i<NMEL+2;i++)mf.push(mel2hz(mn+(mx-mn)*i/(NMEL+1)));
    const ff=[];for(let k=0;k<NB;k++)ff.push(k*SR/NFFT);
    const w=new Float32Array(NMEL*NB);
    for(let i=0;i<NMEL;i++){const d0=mf[i+1]-mf[i],d1=mf[i+2]-mf[i+1],en=2/(mf[i+2]-mf[i]);
      for(let k=0;k<NB;k++){const lo=(ff[k]-mf[i])/d0,hi=(mf[i+2]-ff[k])/d1;w[i*NB+k]=Math.max(0,Math.min(lo,hi))*en;}}
    return w;})();
  function mel(y){ // y: Float32Array of NF*HOP samples -> Float32Array(NF*NMEL), frame-major
    const out=new Float32Array(NF*NMEL),fr=new Float32Array(NFFT),P=new Float32Array(NB),half=NFFT/2;
    for(let t=0;t<NF;t++){
      const c=t*HOP;for(let n=0;n<NFFT;n++){const i=c-half+n;fr[n]=(i>=0&&i<y.length?y[i]:0)*WIN[n];}
      for(let k=0;k<NB;k++){let re=0,im=0;const o=k*NFFT;for(let n=0;n<NFFT;n++){re+=fr[n]*COS[o+n];im-=fr[n]*SIN[o+n];}P[k]=re*re+im*im;}
      for(let m=0;m<NMEL;m++){let s=0;const o=m*NB;for(let k=0;k<NB;k++)s+=MELW[o+k]*P[k];out[t*NMEL+m]=s;}
    }
    return out;
  }
  // Resemblyzer's normalize_volume(target -30 dBFS, increase_only)
  function normVol(y){let s=0;for(let i=0;i<y.length;i++)s+=y[i]*y[i];
    const rms=Math.sqrt(s/Math.max(1,y.length));if(!(rms>0))return y;
    const ch=-30-20*Math.log10(rms);if(ch<0)return y;const g=Math.pow(10,ch/20),o=new Float32Array(y.length);
    for(let i=0;i<y.length;i++)o[i]=y[i]*g;return o;}
  const sig=x=>1/(1+Math.exp(-x));
  // B windows at once: X = B mel arrays (NF×in). Returns B embeddings (256 each).
  function lstmBatch(X,inDim0){
    const B=X.length;let inp=X,inDim=inDim0,hLast=null;
    for(let l=0;l<3;l++){
      const Wi=W.ih[l],Wh=W.hh[l],bb=W.b[l],G=4*H;
      // input projections for every frame of every window
      const pre=inp.map(x=>{const p=new Float32Array(NF*G);
        // row-outer: each weight row stays in cache while it meets all 160 frames
        for(let r=0;r<G;r++){const wo=r*inDim,br=bb[r];
          for(let t=0;t<NF;t++){const xo=t*inDim;let s0=br,s1=0,s2=0,s3=0,j=0;
            for(;j+3<inDim;j+=4){s0+=Wi[wo+j]*x[xo+j];s1+=Wi[wo+j+1]*x[xo+j+1];s2+=Wi[wo+j+2]*x[xo+j+2];s3+=Wi[wo+j+3]*x[xo+j+3];}
            for(;j<inDim;j++)s0+=Wi[wo+j]*x[xo+j];p[t*G+r]=s0+s1+s2+s3;}}
        return p;});
      const h=Array.from({length:B},()=>new Float32Array(H)),c=Array.from({length:B},()=>new Float32Array(H));
      const out=inp.map(()=>new Float32Array(NF*H)),g=Array.from({length:B},()=>new Float32Array(G));
      for(let t=0;t<NF;t++){
        for(let b=0;b<B;b++)g[b].set(pre[b].subarray(t*G,t*G+G));
        for(let r=0;r<G;r++){const wo=r*H;
          for(let b=0;b<B;b++){const hb=h[b];let s0=0,s1=0,s2=0,s3=0;
            for(let j=0;j<H;j+=4){s0+=Wh[wo+j]*hb[j];s1+=Wh[wo+j+1]*hb[j+1];s2+=Wh[wo+j+2]*hb[j+2];s3+=Wh[wo+j+3]*hb[j+3];}
            g[b][r]+=s0+s1+s2+s3;}}
        for(let b=0;b<B;b++){const gb=g[b],hb=h[b],cb=c[b],ob=out[b];
          for(let j=0;j<H;j++){const i_=sig(gb[j]),f_=sig(gb[H+j]),g_=Math.tanh(gb[2*H+j]),o_=sig(gb[3*H+j]);
            cb[j]=f_*cb[j]+i_*g_;hb[j]=o_*Math.tanh(cb[j]);ob[t*H+j]=hb[j];}}
      }
      inp=out;inDim=H;hLast=h;
    }
    return hLast.map(hv=>{const e=new Float32Array(H);let n=0;
      for(let r=0;r<H;r++){let s=W.lb[r];const wo=r*H;for(let j=0;j<H;j++)s+=W.lw[wo+j]*hv[j];e[r]=Math.max(0,s);n+=e[r]*e[r];}
      n=Math.sqrt(n)||1;for(let r=0;r<H;r++)e[r]/=n;return e;});
  }
  // windows: array of Float32Array(NF*HOP) at 16 kHz -> embeddings
  function embed(windows){return lstmBatch(windows.map(w=>mel(normVol(w))),NMEL);}
  const api={load,mel,embed,normVol,SR,NF,HOP,H};
  if(typeof self!=='undefined'&&typeof window==='undefined'&&typeof self.postMessage==='function'&&!self.__ge2eNoWorker){
    self.onmessage=e=>{const d=e.data;
      try{
        if(d.type==='load'){load(d.buf);self.postMessage({type:'ready'});}
        else if(d.type==='embed'){const E=embed(d.windows);const flat=new Float32Array(E.length*H);E.forEach((v,i)=>flat.set(v,i*H));
          self.postMessage({type:'emb',id:d.id,emb:flat},[flat.buffer]);}
      }catch(err){self.postMessage({type:'error',id:d.id,error:String(err&&err.message||err)});}
    };
  }
  return api;
}
