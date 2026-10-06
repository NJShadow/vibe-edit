/* audio-filter.js — the FFmpeg audio mix for desktop exports.
 * buildAudioFilter(spec, firstInputIndex) turns the renderer's audioSpec
 * (buildAudioMixSpec in the app) into FFmpeg -i inputs + a filtergraph. Kept
 * free of Electron so tests can run its output through real FFmpeg
 * (tests/review-fixes.js, section "audio").
 *
 * It must sound like the browser mix (renderAudioOffline / buildAudioFxChain in
 * the app), which is what the user hears in the preview:
 *   order: speed → pitch → volume → effects → normalize → fades
 *   mono sources are played on both channels at full level (Web Audio up-mix),
 *   pan is the Web Audio StereoPannerNode law (a full pan folds the other side
 *   in, it never drops it), the compressor carries the same automatic makeup
 *   gain as a DynamicsCompressorNode, distortion is the same wave-shaper curve.
 */
const fs = require('fs');
const path = require('path');

const SR = 96000;

function fileUrlToPath(u){
  try{
    if(typeof u!=='string')return null;
    if(u.startsWith('file://')){ let p=decodeURI(u.replace(/^file:\/\/+/,''));
      // Windows: file:///C:/... -> C:/...  ; *nix: file:///home -> /home
      if(!/^[a-zA-Z]:/.test(p) && !p.startsWith('/')) p='/'+p;
      return p.replace(/\//g, path.sep);
    }
    return u;
  }catch(e){return null;}
}

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const dB=x=>20*Math.log10(Math.max(1e-12,x));
const lin=d=>Math.pow(10,d/20);

/* ---- Web Audio DynamicsCompressorNode static curve (Chromium's kernel) ---- */
function webCompCurve(thrDb, kneeDb, ratio){
  const linThr=lin(thrDb);
  const knee=(x,k)=>x<linThr?x:linThr+(1-Math.exp(-k*(x-linThr)))/k;
  const slopeAt=(x,k)=>{if(x<linThr)return 1;const x2=x*1.001;
    return (dB(knee(x2,k))-dB(knee(x,k)))/(dB(x2)-dB(x));};
  const xk=lin(thrDb+kneeDb);
  let minK=0.1,maxK=10000,k=5;
  for(let i=0;i<15;i++){if(slopeAt(xk,k)<1/ratio)maxK=k;else minK=k;k=Math.sqrt(minK*maxK);}
  const kneeThrDb=thrDb+kneeDb, yKneeDb=dB(knee(lin(kneeThrDb),k));
  const sat=x=>x<lin(kneeThrDb)?knee(x,k):lin(yKneeDb+(dB(x)-kneeThrDb)/ratio);
  const makeup=Math.pow(1/sat(1),0.6);
  return xDb=>dB(sat(lin(xDb))*makeup);   // output level (dB) for a steady input level
}
/* ---- FFmpeg acompressor static curve (peak detection, soft knee) ---- */
function ffCompCurve(thrDb, ratio, kneeLin){
  const thres=Math.log(lin(thrDb)), ks=Math.log(lin(thrDb)/Math.sqrt(kneeLin)), ke=Math.log(lin(thrDb)*Math.sqrt(kneeLin));
  const cks=(ks-thres)/ratio+thres, cke=(ke-thres)/ratio+thres;
  const herm=(x,x0,x1,p0,p1,m0,m1)=>{const w=x1-x0,t=(x-x0)/w;m0*=w;m1*=w;
    return (2*p0+m0-2*p1+m1)*t*t*t+(-3*p0-2*m0+3*p1-m1)*t*t+m0*t+p0;};
  return xDb=>{const s=Math.log(lin(xDb));if(s<=ks)return xDb;
    let g=(s-thres)/ratio+thres;if(kneeLin>1&&s<ke)g=herm(s,ks,ke,ks,cke,1,1/ratio);
    return xDb+dB(Math.exp(g-s));};
}
// acompressor settings whose curve best matches the browser's compressor
// (threshold, ratio, 24 dB knee, auto makeup) over normal program levels.
const _compCache=new Map();
function compressorFor(amount){
  const a=clamp(amount,0,100)/100, key=a.toFixed(3);
  if(_compCache.has(key))return _compCache.get(key);
  const T=-(8+a*32), R=2+a*10, web=webCompCurve(T,24,R);
  const xs=[];for(let x=-36;x<=0;x+=2)xs.push(x);
  const want=xs.map(web);
  let best=null;
  for(let t=T-6;t<=Math.min(-0.5,T+24);t+=0.5){
    for(const r of [1.25,1.5,1.75,2,2.5,3,3.5,4,5,6,7,8,10,12,15,20]){
      const ff=ffCompCurve(t,r,8);
      const d=xs.map((x,i)=>want[i]-ff(x));
      const mk=clamp(d.reduce((s,v)=>s+v,0)/d.length,0,36);
      const err=d.reduce((s,v)=>s+(v-mk)*(v-mk),0);
      if(!best||err<best.err)best={err,t,r,mk};
    }
  }
  const out='acompressor=threshold='+best.t.toFixed(1)+'dB:ratio='+best.r+':attack=3:release=250:knee=8'
    +':detection=peak:link=maximum:makeup='+lin(best.mk).toFixed(4);
  _compCache.set(key,out);
  return out;
}
// Web Audio StereoPannerNode on a stereo signal: the far side is folded in.
function panFilter(pan){
  const p=clamp(pan,-1,1);
  if(p>=0){const x=p*Math.PI/2;
    return 'pan=stereo|c0='+Math.cos(x).toFixed(6)+'*c0|c1=c1+'+Math.sin(x).toFixed(6)+'*c0';}
  const x=(p+1)*Math.PI/2;
  return 'pan=stereo|c0=c0+'+Math.cos(x).toFixed(6)+'*c1|c1='+Math.sin(x).toFixed(6)+'*c1';
}
// atempo only takes 0.5..2 per instance
function atempoChain(tempo){
  const out=[];let rem=tempo;
  while(rem>2.0){out.push('atempo=2.0');rem/=2.0;}
  while(rem<0.5){out.push('atempo=0.5');rem/=0.5;}
  out.push('atempo='+rem.toFixed(6));
  return out;
}

/* v4.10.2: the level curve of a clip that is part of a sound crossfade, as an
 * FFmpeg expression of t (seconds from the clip's own start), commas escaped for
 * a filtergraph. env (from the app's _axfEnvSpec), in the time T=t+o of the clip
 * whose sound this is (o>0 for a continued tail):
 *   fi/fo  its Fade in (from 0) / Fade out (ending at E, where its sound ends)
 *   xi     equal-power fade in over the first xi s (sin)
 *   xe/xo  equal-power fade out over xo s from xe (cos)
 * Each side is the SMALLER of the fade and the crossfade, never their product —
 * the same rule as _axfFade in the app. Returns null when it is constant 1. */
function envExpr(env){
  if(!env) return null;
  const n=v=>(+v||0).toFixed(6);
  const T=(+env.o||0)?'(t+'+n(env.o)+')':'t';
  let fin=null, fout=null;
  if(env.fi>0) fin='min(1,max(0,'+T+')/'+n(env.fi)+')';
  if(env.xi>0){ const x='sin(PI/2*min(1,max(0,'+T+')/'+n(env.xi)+'))'; fin=fin?'min('+fin+','+x+')':x; }
  if(env.fo>0) fout='min(1,max(0,'+n(env.E)+'-'+T+')/'+n(env.fo)+')';
  if(env.xo>0){ const x='if(gt('+T+','+n(env.xe)+'),cos(PI/2*min(1,('+T+'-'+n(env.xe)+')/'+n(env.xo)+')),1)'; fout=fout?'min('+fout+','+x+')':x; }
  if(!fin && !fout) return null;
  const g=fin&&fout?'('+fin+')*('+fout+')':(fin||fout);
  return '('+g.replace(/,/g,'\\,')+')';
}

// Build FFmpeg -i inputs and an audio filtergraph from an audioSpec produced by
// the renderer. Returns {inputs:[...args], filter:'...', outLabel:'[aout]'} or null.
// opts.exists: file check (default fs.existsSync).
function buildAudioFilter(spec, startInputIndex, opts){
  if(!spec || !Array.isArray(spec.clips)) return null;
  const exists=(opts&&opts.exists)||fs.existsSync;
  const D = Math.max(0.01, spec.duration||0);
  // spec.from: the export starts at this timeline second (an In point). The
  // clips keep their timeline positions, the graph mixes up to from+D, and the
  // first `from` seconds are dropped from the mix — sample-exact, and fades or
  // speed changes that straddle the In point come out exactly as they play.
  const FROM = Math.max(0, +spec.from||0);
  if(spec.clips.length===0){
    // silent track of length D
    return { inputs:['-f','lavfi','-t',String(D),'-i','anullsrc=channel_layout=stereo:sample_rate='+SR],
             filter:'', outLabel:String(startInputIndex)+':a', count:1 };
  }
  const inputs=[]; const parts=[]; const labels=[];
  let idx=startInputIndex;
  for(const c of spec.clips){
    const p=fileUrlToPath(c.url);
    if(!p || !exists(p)) return null; // can't do direct → caller falls back
    const srcStart=Math.max(0,c.inPoint||0);
    const speed=Math.max(0.0625,Math.min(16,c.speed||1));
    const dur=Math.max(0.01,c.duration||0);
    const srcSpan=dur*speed; // seconds of source consumed
    // Seek + read just the needed span, decode to 96k stereo float
    inputs.push('-ss', srcStart.toFixed(6), '-t', srcSpan.toFixed(6), '-i', p);
    const lbl='a'+idx;
    const f=[];
    f.push('aresample='+SR); // unify rate cleanly (FFmpeg's resampler, well-tested)
    // A mono source plays on BOTH sides at full level, as in the browser. (The
    // default mono→stereo rematrix puts it at −3 dB per side.)
    if(c.channels===1) f.push('pan=stereo|c0=c0|c1=c0');
    f.push('aformat=sample_fmts=fltp:channel_layouts=stereo');
    // speed / pitch
    if(Math.abs(speed-1)>1e-3){
      if(c.preservePitch){
        // We consumed srcSpan = duration*speed of source; to fit `duration`, tempo=speed
        f.push(...atempoChain(speed));
      }else{
        // record-style: play the samples `speed`× faster (pitch follows), then
        // resample back to the working rate
        f.push('asetrate='+Math.round(SR*speed));
        f.push('aresample='+SR);
      }
    }
    const fx=c.fx||{};
    if(fx.pitch && Math.abs(fx.pitch)>0.01){
      // pitch shift keeping tempo: asetrate (shifts pitch+speed) then atempo back.
      const ratio=Math.pow(2, fx.pitch/12);
      f.push('asetrate='+Math.round(SR*ratio));
      f.push('aresample='+SR);
      f.push(...atempoChain(1/ratio));
    }
    // exactly the clip's own span on the timeline — nothing of the source past it
    f.push('asetpts=N/SR/TB');
    f.push('atrim=end='+dur.toFixed(6));
    // volume
    if(Math.abs((c.volume==null?1:c.volume)-1)>1e-3) f.push('volume='+(c.volume).toFixed(4));
    // --- audio effects (mirror buildAudioFxChain in the renderer) ---
    if(fx.highpass>0) f.push('highpass=f='+Math.round(fx.highpass));
    if(fx.lowpass>0)  f.push('lowpass=f='+Math.round(fx.lowpass));
    if(fx.muffle>0){const m=Math.max(0,Math.min(100,fx.muffle))/100;
      const freq=Math.round(20000*Math.pow(360/20000,m));
      f.push('lowpass=f='+freq); f.push('treble=g='+(-(m*22)).toFixed(2)+':f=2000');}
    if(Math.abs(fx.bass||0)>0.01)   f.push('bass=g='+fx.bass.toFixed(2)+':f=200');
    if(Math.abs(fx.treble||0)>0.01) f.push('treble=g='+fx.treble.toFixed(2)+':f=3500');
    if(fx.midBoost>0){const g=(fx.midBoost/100)*12;
      f.push('equalizer=f=1800:width_type=q:width=1.1:g='+g.toFixed(2));}
    if(fx.compress>0) f.push(compressorFor(fx.compress));
    if(fx.distort>0){
      // the browser's wave-shaper curve, y=(3+k)·0.3·x/(3+k·|x|), input clamped to ±1
      const k=clamp(fx.distort,0,100), e=ch=>'(3+'+k+')*0.3*clip(val('+ch+')\\,-1\\,1)/(3+'+k+'*abs(clip(val('+ch+')\\,-1\\,1)))';
      f.push('aeval='+e(0)+'|'+e(1));}
    if(fx.vibrato>0){const d=fx.vibrato/100;
      f.push('vibrato=f='+(5+d*3).toFixed(1)+':d='+Math.min(1,d).toFixed(2));}
    if(fx.echo>0){
      // the browser's feedback delay (dry 1, wet×Σ fb^k) as a tap series
      const wet=Math.min(1,fx.echo/100), dly=Math.round(fx.echoTime||300), fb=Math.min(0.6,wet*0.6);
      const ds=[],gs=[];for(let k=0,g=wet;k<8&&g>=0.004;k++,g*=fb){ds.push(dly*(k+1));gs.push(g.toFixed(4));}
      f.push('aecho=1:1:'+ds.join('|')+':'+gs.join('|'));}
    if(fx.reverb>0){const wet=Math.min(1,fx.reverb/100);
      // dry 1−wet/2 like the browser; a decaying tap cloud at the convolver's level
      const taps=[23,31,41,53,67,79,97,113,131,151,173,199,229,263,293,337,389,443,509,587,673,769,887,1013];
      const env=taps.map(t=>Math.pow(1-t/1200,2.4)), nrm=Math.sqrt(env.reduce((s,v)=>s+v*v,0));
      f.push('aecho='+(1-wet*0.5).toFixed(3)+':1:'+taps.join('|')+':'+env.map(v=>(v/nrm*0.25*wet).toFixed(4)).join('|'));}
    if(Math.abs(fx.pan||0)>0.01) f.push(panFilter(fx.pan/100));
    if(fx.normalize) f.push('loudnorm=I=-16:TP=-1.5:LRA=11', 'aresample='+SR);
    // fades (relative to the clip's own timeline, after tempo => length ~= duration)
    if(c.env){
      // v4.10.2: part of a sound crossfade — fades + equal-power crossfade as one
      // per-sample curve (the app's _axfFade), replacing the two afades
      const g=envExpr(c.env);
      if(g) f.push('aeval=val(0)*'+g+'|val(1)*'+g);
    }else{
      if(c.fadeIn>0)  f.push('afade=t=in:st=0:d='+c.fadeIn.toFixed(4));
      if(c.fadeOut>0) f.push('afade=t=out:st='+Math.max(0,(dur-c.fadeOut)).toFixed(4)+':d='+c.fadeOut.toFixed(4));
    }
    // pad to exactly `duration` (BOUNDED — an infinite apad relying on a
    // downstream trim for EOF can stall the whole graph), then delay to the
    // clip's start on the timeline
    f.push('apad=whole_dur='+dur.toFixed(6));
    f.push('asetpts=PTS-STARTPTS');
    const delayMs=Math.round(Math.max(0,c.start)*1000);
    if(delayMs>0) f.push('adelay='+delayMs+'|'+delayMs);
    // a specific audio track of the file (chosen at import) instead of the default one
    const aSel=Number.isInteger(c.aTrack)&&c.aTrack>=0?':'+c.aTrack:'';
    parts.push('['+idx+':a'+aSel+']'+f.join(',')+'['+lbl+']');
    labels.push('['+lbl+']');
    idx++;
  }
  // FFmpeg PTS gotcha — THE truncated-export bug: amix inherits the FIRST
  // input's timestamp base. If that input is adelay'd, [amixed] begins at
  // pts=delay, and a final timestamp-based trim (atrim=0:D) throws away
  // everything before that delay — the exported audio died at exactly
  // D−delay seconds whenever a delayed clip happened to sit first in the
  // timeline array. Two defenses, both load-bearing:
  //  (1) a full-length SILENT BED is always amix's first input, pinning the
  //      output pts base to 0 (this also fixes the single-delayed-clip case,
  //      which the old single-label branch played at t=0);
  //  (2) pts are re-zeroed BEFORE the final bounded pad — a mixed stream is
  //      never trimmed by timestamp again.
  const bed='anullsrc=channel_layout=stereo:sample_rate='+SR+',atrim=0:'+(FROM+D).toFixed(6)+',asetpts=PTS-STARTPTS[abed]';
  // (the range cut is by SAMPLE count on a stream re-zeroed first — never by timestamp)
  const cut=FROM>0?',atrim=start_sample='+Math.round(FROM*SR)+',asetpts=PTS-STARTPTS':'';
  const filter=parts.join(';')+';'+bed
    +';[abed]'+labels.join('')+'amix=inputs='+(labels.length+1)+':normalize=0:dropout_transition=0[amixed];'
    +'[amixed]asetpts=PTS-STARTPTS'+cut+',apad=whole_dur='+D.toFixed(6)+'[aout]';
  return { inputs, filter, outLabel:'[aout]', count:idx-startInputIndex };
}

module.exports = { buildAudioFilter, fileUrlToPath, compressorFor, webCompCurve, ffCompCurve, panFilter, envExpr };
