/* desktop-pro.js — Pro features that need the REAL desktop app (Electron +
 * FFmpeg + H.264): the proxy workflow. Runs desktop/main.js unmodified through
 * tests/electron-harness and checks, on a real video:
 *   · Make proxy: FFmpeg builds a downscaled proxy and the viewer switches to it;
 *   · every frame the viewer shows is the SAME moment of the source on proxy
 *     and on original (compared as pixels), including a proxy made from a
 *     trimmed portion, where the original needs the window offset;
 *   · the switch is saved with the project; export still prefers originals;
 *   · review fixes (io): a ranged (In/Out) export through FFmpeg carries the
 *     audio of exactly that range (correlation vs the source), a sparse-keyframe
 *     original goes through an intermediate that is deleted afterwards, the audio
 *     track chosen at import is the one exported, a Cancel sent before FFmpeg
 *     starts is honored per job, and a failed encode leaves no file behind;
 *   · v4.8: a speed-ramped clip shows exactly the source frame an independent
 *     integral of its speed curve says (vs a plain clip at that in-point), and a
 *     LUT on a playing video matches the analytic transform (GPU or CPU path).
 * Needs: an Electron binary (ELECTRON=path, or desktop/node_modules/electron),
 * FFmpeg in desktop/bin (ffmpeg + ffprobe), a video (VIBE_TEST_VIDEO=path,
 * default: the news clip in VIBE_TEST_MEDIA). Linux runs under xvfb-run.
 * Usage: node tests/desktop-pro.js
 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), DESK = path.join(ROOT, 'desktop');
const exe = process.platform === 'win32' ? '.exe' : '';
const electron = process.env.ELECTRON || [path.join(DESK, 'node_modules', 'electron', 'dist', 'electron' + exe)].find(fs.existsSync);
const ffOk = fs.existsSync(path.join(DESK, 'bin', 'ffmpeg' + exe));
const media = (process.env.VIBE_TEST_MEDIA || '').split(path.delimiter)[0];
const video = process.env.VIBE_TEST_VIDEO || (media && path.join(media, 'Canadian News Team [Cd0uaMynQJI].converted.mp4'));
if (!electron || !ffOk || !video || !fs.existsSync(video)) {
  console.log('SKIP: needs ELECTRON (or desktop/node_modules/electron), FFmpeg in desktop/bin, and VIBE_TEST_VIDEO / VIBE_TEST_MEDIA');
  process.exit(0);
}
// io checks: exports land in a scratch folder; a two-track file shows which track was exported
const FFM = path.join(DESK, 'bin', 'ffmpeg' + exe);
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-dp-out-'));
const multi = path.join(saveDir, 'two-tracks.mkv');
spawnSync(FFM, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-g', '3', '-c:a', 'aac', multi]);
if (fs.existsSync(multi)) process.env.__VIBE_MULTI = multi;
const hqBefore = new Set(fs.readdirSync(os.tmpdir()).filter(n => /^vibe-hq-/.test(n)));
const script = `
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await ffReady().catch(()=>{});
const P=${JSON.stringify(video)};
const R={ffmpeg:!!FF_AVAILABLE};
// a video media as the importer would register it (original, not proxied)
const el0=await loadMediaEl('video',toFileUrl(P));
const m={id:'pv1',type:'video',name:'clip',ext:'MP4',url:toFileUrl(P),duration:el0.duration,w:el0.videoWidth,h:el0.videoHeight,size:1,sourcePath:P,trim:null,srcBrowserOk:true,srcGop:0};
state.media=[m];els[m.id]=el0;
const c=makeClip({type:'video',track:'V1',start:0,duration:Math.min(20,m.duration),mediaId:m.id});c.inPoint=3;state.clips=[c];
renderTimeline();renderBin();
const pc=document.createElement('canvas');pc.width=64;pc.height=36;const g=pc.getContext('2d',{willReadFrequently:true});
// What the VIEWER shows: move the playhead the normal way and read the preview canvas.
async function frameAt(clip,t){setPlaying(false);setTime(t);
  const el=els[clip.mediaId];
  for(let k=0;k<40;k++){await sleep(50);if(!el.seeking&&Math.abs(el.currentTime-srcTimeFor(clip,t))<0.02)break;}
  await new Promise(res=>{let d=false;const f=()=>{if(!d){d=true;res();}};try{el.requestVideoFrameCallback(f);}catch(e){}setTimeout(f,300);});
  requestDraw();await sleep(250);
  g.drawImage(cv,0,0,64,36);return g.getImageData(0,0,64,36).data;}
const diff=(a,b)=>{let s=0;for(let i=0;i<a.length;i+=4)s+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);return s/(a.length/4*3)/255;};
const TS=[1.0,4.37,8.0,12.5];
const orig=[];for(const t of TS)orig.push(await frameAt(c,t));
R.meanOrig=orig.map(a=>{let s=0;for(let i=0;i<a.length;i+=4)s+=a[i];return Math.round(s/(a.length/4));});
R.infoBefore=proProxyInfo(m).canMake;
const ok=await proMakeProxy(m,640);
R.made=ok;R.proxied=!!m.proxied;R.proxyWidth=els[m.id].videoWidth;
R.badge=(document.querySelector('#binList .bin-px')||{}).textContent||null;
const onProxy=[];for(const t of TS)onProxy.push(await frameAt(c,t));
R.meanProxy=onProxy.map(a=>{let s=0;for(let i=0;i<a.length;i+=4)s+=a[i];return Math.round(s/(a.length/4));});
R.proxyVsOrig=TS.map((t,i)=>+diff(orig[i],onProxy[i]).toFixed(4));
// a neighbouring moment, to show what a WRONG frame would score
R.wrongFrame=+diff(orig[1],await frameAt(c,TS[1]+0.25)).toFixed(4);   // ~7 frames later
await proUseOriginal(m,true,true);
R.origWidth=els[m.id].videoWidth;R.badgeAfter=(document.querySelector('#binList .bin-px')||{}).textContent||null;
const onOrig=[];for(const t of TS)onOrig.push(await frameAt(c,t));
R.origSwitchVsOrig=TS.map((t,i)=>+diff(orig[i],onOrig[i]).toFixed(4));
R.savedPlayOriginal=JSON.parse(serializeProject()).media[0].playOriginal===true;
await proUseOriginal(m,false,true);R.backOnProxy=els[m.id].videoWidth===R.proxyWidth;
// trimmed portion: the proxy covers source 10..22 s; clip in-points are
// relative to that window, so the original needs +10 s
const el2=await loadMediaEl('video',toFileUrl(P));
const m2={id:'pv2',type:'video',name:'part',ext:'MP4',url:toFileUrl(P),duration:12,w:el2.videoWidth,h:el2.videoHeight,size:1,sourcePath:P,trim:{start:10,duration:12},srcBrowserOk:true,srcGop:0};
state.media.push(m2);els[m2.id]=el2;
const c2=makeClip({type:'video',track:'V2',start:0,duration:8,mediaId:m2.id});c2.inPoint=1;state.clips.push(c2);
const ok2=await proMakeProxy(m2,640);R.madeTrimmed=ok2;
const T2=[0.5,3.2,6.9];
const p2=[];for(const t of T2)p2.push(await frameAt(c2,t));
await proUseOriginal(m2,true,true);
R.trimOffset=_hqOffset(m2.id);
const o2=[];for(const t of T2)o2.push(await frameAt(c2,t));
R.trimmedProxyVsOrig=T2.map((t,i)=>+diff(p2[i],o2[i]).toFixed(4));
// ---- v4.8: a speed ramp and a LUT on real footage, through the real decoder ----
await proUseOriginal(m,true,true);state.media=[m];
const rc=makeClip({type:'video',track:'V1',start:0,duration:8,mediaId:m.id});rc.inPoint=2;state.clips=[rc];state.time=0;
proRampApply(rc,'hero');renderTimeline();
const span=rc.duration*rc.props.speed,Sq=q=>rampS(rc.ramp.pts,q);
// independent: invert t = span * integral_0^p dq/S(q) (Simpson + bisection)
const srcAt=t=>{const I=p=>{const n=400,h=p/n;let s=1/Sq(0)+1/Sq(p);for(let i=1;i<n;i++)s+=(i%2?4:2)/Sq(i*h);return span*s*h/3;};
  let lo=0,hi=1;for(let k=0;k<50;k++){const mid=(lo+hi)/2;if(I(mid)<t-rc.start)lo=mid;else hi=mid;}return rc.inPoint+span*(lo+hi)/2;};
const refC=makeClip({type:'video',track:'V1',start:100,duration:1,mediaId:m.id});
const refAt=async s0=>{state.clips=[refC];refC.inPoint=s0;const f=await frameAt(refC,100);state.clips=[rc];return f;};
const TT=[0.6,rc.duration*0.3,rc.duration*0.5,rc.duration*0.62,rc.duration*0.9];
R.rampVsRef=[];R.rampWrong=[];
for(const t of TT){const a=await frameAt(rc,t),s0=srcAt(t);R.rampVsRef.push(+diff(a,await refAt(s0)).toFixed(4));R.rampWrong.push(+diff(a,await refAt(s0+0.25)).toFixed(4));}
R.rampSrcErr=Math.max(...TT.map(t=>Math.abs(srcTimeFor(rc,t)-srcAt(t))));
// LUT: GPU path fed by the video element itself
delete rc.ramp;rc.props.speed=1;
const N=17,Lc=[];for(let b=0;b<N;b++)for(let gg=0;gg<N;gg++)for(let r=0;r<N;r++)Lc.push([Math.pow(r/(N-1),0.8),gg/(N-1)*0.9+0.05,Math.pow(b/(N-1),1.2)].join(' '));
const lid=proLutAdd(proParseCube('LUT_3D_SIZE 17\\n'+Lc.join('\\n')));R.lutGPU=!!_lutGLInit();
const plain=await frameAt(rc,3);rc.props.lutId=lid;rc.props.lutAmt=100;const graded=await frameAt(rc,3);
const exp=new Uint8ClampedArray(plain.length);for(let i=0;i<plain.length;i+=4){exp[i]=255*Math.pow(plain[i]/255,0.8);exp[i+1]=255*(plain[i+1]/255*0.9+0.05);exp[i+2]=255*Math.pow(plain[i+2]/255,1.2);exp[i+3]=255;}
R.lutVsAnalytic=+diff(graded,exp).toFixed(4);R.lutChanged=+diff(graded,plain).toFixed(4);
// ---- v4.9: the CAM++ speaker model loads from app/models through the native bridge ----
const cf=await proCamppFiles();R.camppFiles=!!cf;
if(cf){_proSpkEngine='campp';const t0=performance.now();
  const E=await proEmbedWindows(i=>{const b=new Float32Array(24000);for(let j=0;j<b.length;j++)b[j]=0.1*Math.sin(j*(0.03+i*0.01))*Math.sin(j*0.0007);return b;},4,null,cf);
  R.camppDim=E[0].length;R.camppMs=Math.round(performance.now()-t0);let nn=0;for(const v of E[0])nn+=v*v;R.camppNorm=+Math.sqrt(nn).toFixed(4);}
// ---- review fixes (io) ----
{const waitX=async()=>{for(let i=0;i<2400;i++){await sleep(100);if(!exportInFlight()&&!document.querySelector('#hqPrep'))return;}};
 const toasts=()=>[...document.querySelectorAll('.toast')].map(t=>t.textContent);
 document.querySelectorAll('.toast').forEach(t=>t.remove());
 // ranged export from a sparse-keyframe original (→ full-quality intermediate)
 await proUseOriginal(m,false,true);m.srcGop=1.2;m.srcBrowserOk=true;m.hasAudio=true;state.media=[m];
 const ic=makeClip({type:'video',track:'V1',start:0,duration:8,mediaId:m.id});ic.inPoint=3;state.clips=[ic];renderTimeline();
 state.exportSource='full';state.exportSourceRemember=true;state.rangeIn=2;state.rangeOut=4;
 let sawHq=false;const mo=new MutationObserver(()=>{if(document.querySelector('#hqPrep'))sawHq=true;});mo.observe(document.body,{childList:true});
 renderPrecise({name:'r',w:320,h:180,fps:15,mbps:2,ffmpeg:true,ffTarget:'mp4-h264'});
 await sleep(300);await waitX();await sleep(2500);mo.disconnect();R.ioSawHq=sawHq;
 R.ioRangeToast=toasts().join('|');
 // the audio track chosen at import is the one exported from the original
 const MT=${JSON.stringify(process.env.__VIBE_MULTI || '')};
 if(MT){const el3=await loadMediaEl('video',toFileUrl(MT));
   const mt={id:'mt',type:'video',name:'multi',ext:'MKV',url:toFileUrl(MT),duration:el3.duration,w:el3.videoWidth,h:el3.videoHeight,size:1,sourcePath:MT,proxied:true,srcGop:0,srcBrowserOk:true,hasAudio:true,audioTrack:1};
   state.media=[mt];els.mt=el3;state.clips=[makeClip({type:'video',track:'V1',start:0,duration:3,mediaId:'mt'})];renderTimeline();
   state.rangeIn=state.rangeOut=null;document.querySelectorAll('.toast').forEach(t=>t.remove());
   renderPrecise({name:'t',w:320,h:180,fps:15,mbps:2,ffmpeg:true,ffTarget:'mkv-h264'});
   await sleep(300);await waitX();R.ioTrackToast=toasts().join('|');}
 // per-job cancel: a Cancel for a job that has not reached FFmpeg yet
 await vibeNative.cancelEncode('job-early2');
 R.ioEarlyCancel2=await vibeNative.encodeMp4(new ArrayBuffer(16),{jobId:'job-early2',filename:'early2'});
 // an old global cancel no longer poisons the next job; a failing encode leaves no file
 await vibeNative.cancelEncode();
 R.ioBad=await vibeNative.encodeMp4(new Uint8Array(4096).fill(7).buffer,{jobId:'job-bad',filename:'bad'});
 R.ioDeleteForeign=await vibeNative.deleteTemp('/etc/hostname');
}
return R;`;
const tmp = path.join(os.tmpdir(), 'vibe-desktop-pro-' + Date.now() + '.js');
fs.writeFileSync(tmp, script);
const args = [path.join(__dirname, 'electron-harness'), '--no-sandbox'];
const cmd = process.platform === 'linux' ? 'xvfb-run' : electron;
const full = process.platform === 'linux' ? ['-a', electron, ...args] : args;
const out = spawnSync(cmd, full, { env: { ...process.env, VIBE_TEST_SCRIPT: tmp, VIBE_SAVE_DIR: saveDir }, encoding: 'utf8', timeout: 900000 });
fs.unlinkSync(tmp);
const line = (out.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
if (!line) { console.log(out.stdout, out.stderr); console.log('FAIL: no result'); process.exit(1); }
const R = JSON.parse(line.slice(7));
const fails = [];
const ck = (k, v) => { R[k] = !!v; if (!v) fails.push(k); };
if (R.error) fails.push('error');
ck('makeProxyOK', R.made && R.proxied && R.proxyWidth === 640 && R.badge === 'PROXY');
// same moment: proxy vs original differ only by scaling/compression (well under a wrong frame)
ck('proxyFramesMatchOK', R.proxyVsOrig && Math.max(...R.proxyVsOrig) < 0.01 && R.wrongFrame > Math.max(...R.proxyVsOrig));
ck('originalSwitchOK', R.origWidth > 640 && R.badgeAfter === 'ORIGINAL' && Math.max(...R.origSwitchVsOrig) < 0.01 && R.backOnProxy);
ck('savedOK', R.savedPlayOriginal);
ck('noConsoleErrorsOK', Array.isArray(R.consoleErrors) && R.consoleErrors.length === 0);
ck('rampRealOK', R.rampVsRef && Math.max(...R.rampVsRef) < 0.01 && R.rampVsRef.every((d, i) => d < R.rampWrong[i]) && R.rampSrcErr < 1e-3);
ck('lutRealOK', R.lutVsAnalytic < 0.01 && R.lutChanged > 0.02);
ck('camppOK', R.camppFiles && R.camppDim === 192 && Math.abs(R.camppNorm - 1) < 1e-3);
ck('trimmedOffsetOK', R.madeTrimmed && R.trimOffset === 10 && Math.max(...R.trimmedProxyVsOrig) < 0.01);
// ---- review fixes (io) ----
const pcm = (f, m, ss, t) => { const r = spawnSync(FFM, ['-v', 'error', ...(ss != null ? ['-ss', String(ss)] : []), ...(t ? ['-t', String(t)] : []), '-i', f, ...(m ? ['-map', m] : []), '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const b = r.stdout || Buffer.alloc(0); return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)); };
const corr = (a, b) => { const n = Math.min(a.length, b.length); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; } return s / Math.sqrt(sa * sb + 1e-12); };
const outs = fs.readdirSync(saveDir);
const ranged = outs.find(n => /\.mp4$/.test(n)), tracked = outs.find(n => /\.mkv$/.test(n) && n !== 'two-tracks.mkv');
if (ranged) {
  const f = path.join(saveDir, ranged), o = pcm(f, null, 0, 1.9);
  R.ioRangeDur = +(spawnSync(path.join(DESK, 'bin', 'ffprobe' + exe), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout || 0);
  R.ioRangeCorr = +corr(o, pcm(video, null, 5, 1.9)).toFixed(3);          // clip in-point 3 + range start 2
  R.ioRangeWrong = +corr(o, pcm(video, null, 3, 1.9)).toFixed(3);         // what an unranged mix would carry
}
if (tracked) {
  const o = pcm(path.join(saveDir, tracked), '0:a:0', 0.2, 2.5);
  R.ioTrackCorr = [+Math.abs(corr(o, pcm(multi, '0:a:0', 0.2, 2.5))).toFixed(3), +Math.abs(corr(o, pcm(multi, '0:a:1', 0.2, 2.5))).toFixed(3)];
}
R.ioHqLeft = fs.readdirSync(os.tmpdir()).filter(n => /^vibe-hq-/.test(n) && !hqBefore.has(n));
R.ioOuts = outs;
ck('ioRangedAudioOK', /Saved/.test(R.ioRangeToast || '') && Math.abs(R.ioRangeDur - 2) < 0.1 && R.ioRangeCorr > 0.9 && R.ioRangeCorr > R.ioRangeWrong + 0.3);
ck('ioIntermediateDeletedOK', R.ioSawHq && R.ioHqLeft.length === 0);
ck('ioChosenTrackOK', !process.env.__VIBE_MULTI || (R.ioTrackCorr && R.ioTrackCorr[1] > 0.9 && R.ioTrackCorr[0] < 0.3));
ck('ioEarlyCancelOK', R.ioEarlyCancel2 && R.ioEarlyCancel2.cancelled && !outs.some(n => /early2/.test(n)));
ck('ioFailedEncodeLeavesNoFileOK', R.ioBad && !R.ioBad.ok && !R.ioBad.cancelled && !outs.some(n => /bad\.mp4$/.test(n)) && R.ioDeleteForeign === false);
try { fs.rmSync(saveDir, { recursive: true, force: true }); } catch (_) {}
console.log(JSON.stringify(R, null, 1));
console.log(fails.length ? 'FAIL: ' + fails.join(', ') : 'PASS');
process.exit(fails.length ? 1 : 0);
