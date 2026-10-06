/* ==================== PRO: PROXY WORKFLOW (v4.7) ====================
   Vibe Edit already makes a proxy on import when it has to (a codec the
   editor can't play, 4K and up, far-apart keyframes) and always exports from
   the originals. This adds the controls around it:
     · a PROXY / ORIGINAL badge on every video in the bin, saying why;
     · play the ORIGINAL instead of the proxy (when it can play and seek
       accurately) — e.g. to judge focus or grain — and switch back;
     · make a proxy on demand for footage that stutters (high-bitrate 1080p,
       phone HDR, screen recordings…), one clip or all heavy clips at once.
   Switching never touches clip timing: an original's frames are addressed
   through the same offset door (_hqOffset → srcTimeFor) the export uses. */
const _proPlay={};          // mediaId -> {offset}  (playing the original)
function _proIsDesktop(){return !!(window.vibeNative&&vibeNative.makeProxy);}
// What can be done with this media's proxy, and why not when it can't.
function proProxyInfo(m){
  const out={kind:'none',why:'',canOriginal:false,noOriginal:'',canMake:false,noMake:''};
  if(!m||m.type!=='video'||m.loading||m.missing)return out;
  const path=_mediaPath(m);
  if(m.proxied){
    out.kind=_proPlay[m.id]?'original':'proxy';
    out.why=m.proxyMade?'You made this proxy so the footage edits smoothly.'
      :m._convWhy==='big'||(m.srcHeight>1440)?'The original is '+(m.srcHeight||'over 1440')+'p — the proxy is a lighter 1080p copy for smooth playback.'
      :m._convWhy==='reseek'||(m.srcGop>=0.5)?'The original’s keyframes are far apart, so it can’t jump to exact frames. The proxy has one every few frames.'
      :'The original’s video or audio format can’t play in the editor, so it was converted for editing.';
    const hc=hqCandidate(m);
    if(!_proIsDesktop()||!path)out.noOriginal='The original file’s location is unknown here — import it in the desktop app to switch.';
    else if(!hc||!hc.browserOk)out.noOriginal=(m.srcGop>=0.5)
      ?'The original can’t jump to exact frames (keyframes are far apart), so editing on it would show the wrong frames. Exports still use it, through a precise intermediate.'
      :'The original’s format can’t play in the editor. Exports still use it, through a full-quality intermediate.';
    else out.canOriginal=true;
  }else{
    out.kind='none';
    if(!_proIsDesktop())out.noMake='Proxies are made with FFmpeg in the desktop app.';
    else if(!FF_AVAILABLE)out.noMake='FFmpeg isn’t installed — put ffmpeg and ffprobe in the app’s bin folder.';
    else if(!path)out.noMake='The file’s location is unknown — re-import it to make a proxy.';
    else out.canMake=true;
  }
  return out;
}
// Put a different element in charge of a media id. The live audio chain belongs
// to the element it was built on (a media element can only feed ONE source
// node), so the id's node follows whichever element is playing.
function _proSwapEl(id,el){
  const old=els[id];els[id]=el;
  if(typeof audioNodes==='object'){if(el._vibeNode)audioNodes[id]=el._vibeNode;else delete audioNodes[id];}
  if(old&&old!==el){try{old.pause();}catch(e){}}
  return old;
}
// Never swap elements under a running export: wait for it to finish.
async function _proAfterExport(){while(typeof exportInFlight==='function'&&exportInFlight())await new Promise(r=>setTimeout(r,500));}
function _proWireEl(el){
  el.addEventListener('seeked',()=>requestDraw());
  el.addEventListener('loadeddata',()=>requestDraw());
  try{el.currentTime=0.001;}catch(e){}
}
// Play the original (on=true) or the proxy (on=false) for this media.
async function proUseOriginal(m,on,quiet){
  const info=proProxyInfo(m);
  if(on){
    if(_proPlay[m.id])return true;
    if(!info.canOriginal){if(!quiet)toast(info.noOriginal||'This clip has no proxy','err',5000);return false;}
    await _proAfterExport();setPlaying(false);
    let el;try{el=await loadMediaEl('video',toFileUrl(_mediaPath(m)));}
    catch(e){if(!quiet)toast('The original couldn’t be opened — staying on the proxy','err');m.playOriginal=false;return false;}
    _proWireEl(el);
    m._proxyEl=_proSwapEl(m.id,el);
    _proPlay[m.id]={offset:(m.trim&&m.trim.start)||0};
    m.playOriginal=true;
  }else{
    if(!_proPlay[m.id]){m.playOriginal=false;return true;}
    await _proAfterExport();setPlaying(false);
    const orig=m._proxyEl?_proSwapEl(m.id,m._proxyEl):null;
    delete m._proxyEl;delete _proPlay[m.id];m.playOriginal=false;
    if(orig&&orig!==els[m.id]){try{orig.removeAttribute('src');orig.load();}catch(e){}}
  }
  renderBin();requestDraw();
  if(!quiet)toast(on?'Playing the original of “'+m.name+'” — full quality, heavier to scrub'
    :'Back on the proxy for “'+m.name+'” — smooth editing','ok');
  return true;
}
// Make an editing proxy on demand (desktop + FFmpeg). maxDim caps the longest side.
async function proMakeProxy(m,maxDim){
  const info=proProxyInfo(m);
  if(!info.canMake){toast(info.noMake||'This clip already has a proxy','err',5000);return false;}
  const path=_mediaPath(m);
  const dim=maxDim||Math.min(1920,Math.max(m.w||0,m.h||0)>1920?1920:1280);
  ensureProxyProgress();
  const jobId=uid();let unsub=null;
  const r=await aiRunJob('Making a proxy for “'+m.name+'”',async prog=>{
    unsub=vibeNative.onProxyProgress?vibeNative.onProxyProgress(d=>{if(d&&d.jobId===jobId)prog((d.pct||0)/100,'Making a proxy — '+(d.pct||0)+'%');}):null;
    AI.cancelHook=()=>{try{vibeNative.cancelProxy(jobId);}catch(e){}};
    const o=Object.assign({maxDim:dim},m.trim&&m.trim.duration>0?{start:m.trim.start||0,end:(m.trim.start||0)+m.trim.duration}:{});
    return vibeNative.makeProxy(path,jobId,o);
  });
  try{unsub&&unsub();}catch(e){}
  AI.cancelHook=null;
  if(!r||r.cancelled){if(r&&r.cancelled)toast('Proxy stopped');return false;}                                    // cancelled / failed (job card said so)
  if(!r.ok){toast('Couldn’t make the proxy: '+(r.error||'FFmpeg failed'),'err',6000);return false;}
  let url=null;
  try{if(vibeNative.readProxy){const bytes=await vibeNative.readProxy(r.path);if(bytes)url=URL.createObjectURL(new Blob([bytes],{type:'video/mp4'}));}}catch(e){}
  url=url||toFileUrl(r.path);
  let el;try{el=await loadMediaEl('video',url);}catch(e){toast('The proxy was made but couldn’t be opened','err');return false;}
  await _proAfterExport();setPlaying(false);
  _proWireEl(el);
  _proSwapEl(m.id,el);
  m.proxyPath=toFileUrl(r.path);m.url=url;m.proxied=true;m.proxyMade=true;m.proxyMaxDim=dim;
  m.srcBrowserOk=m.srcBrowserOk!==false;             // it played before, so the original can be switched back to
  if(m.srcGop==null)m.srcGop=0;
  renderBin();requestDraw();
  toast('Proxy ready for “'+m.name+'” — editing uses the lighter copy; exports still use the original','ok',4500);
  return true;
}
// "Heavy" footage that benefits from a proxy: above 1080p, or a high bitrate.
function proHeavyMedia(){
  return state.media.filter(m=>{if(m.type!=='video'||m.proxied||m.loading||m.missing)return false;
    const tall=Math.min(m.w||0,m.h||0)>1080;
    const mbps=m.size&&m.duration?m.size*8/m.duration/1e6:0;
    return (tall||mbps>40)&&proProxyInfo(m).canMake;});
}
async function proMakeHeavyProxies(){
  const list=proHeavyMedia();
  if(!list.length){
    // heavy footage that can't get a proxy HERE (browser copy / no FFmpeg): say why
    const heavy=state.media.filter(m=>m.type==='video'&&!m.proxied&&!m.loading&&!m.missing&&(Math.min(m.w||0,m.h||0)>1080||(m.size&&m.duration&&m.size*8/m.duration/1e6>40)));
    if(heavy.length&&(!_proIsDesktop()||!FF_AVAILABLE)){toast('Making proxies needs the desktop app (FFmpeg)'+(_proIsDesktop()?' — FFmpeg isn’t installed: put ffmpeg and ffprobe in the app’s bin folder':' — this browser copy can’t make them'),'err',6000);return;}
    if(heavy.length){toast(proProxyInfo(heavy[0]).noMake||'Can’t make a proxy for that footage here','err',6000);return;}
    toast('No heavy footage without a proxy — nothing to do','ok');return;}
  for(const m of list){const ok=await proMakeProxy(m);if(!ok)break;}
}
async function proAllOriginals(on){
  if(!state.media.some(m=>m.proxied)){toast('No proxies yet — every clip already plays its original file','ok',4000);return;}
  if(on&&!_proIsDesktop()){toast('Playing the originals needs the desktop app — this browser copy can’t open the original files','err',5000);return;}
  let n=0,skip=0;
  for(const m of state.media){if(!m.proxied)continue;
    const info=proProxyInfo(m);
    if(on&&!info.canOriginal){skip++;continue;}
    if(await proUseOriginal(m,on,true))n++;}
  renderBin();
  toast(on?(n?'Playing originals for '+n+' clip'+(n>1?'s':''):'No originals can play here')+(skip?' — '+skip+' must stay on proxies (see the badge for why)':'')
    :'Playing proxies for every clip','ok',5000);
}
function proProxyMenuItems(m){
  const info=proProxyInfo(m),items=[];
  if(m.proxied){
    items.push({label:(info.kind==='original'?'✓ ':'')+'Play the original',tip:info.canOriginal?'Full quality in the viewer — heavier to scrub':info.noOriginal,
      fn:()=>info.canOriginal?proUseOriginal(m,true):toast(info.noOriginal,'err',6000)});
    items.push({label:(info.kind==='proxy'?'✓ ':'')+'Play the proxy',tip:'The lighter editing copy — smooth scrubbing',fn:()=>proUseOriginal(m,false)});
  }else if(m.type==='video'){
    items.push({label:'Make an editing proxy',tip:info.canMake?'Make a lighter copy for smooth editing. Exports still use this original.':info.noMake,
      fn:()=>info.canMake?proMakeProxy(m):toast(info.noMake,'err',6000)});
  }
  return items;
}
function proBinMenu(m,x,y){
  const items=proProxyMenuItems(m);
  const heavy=proHeavyMedia().length,anyProxy=state.media.some(q=>q.proxied);
  if(items.length)items.push({sep:true});
  items.push({label:'Add to timeline at playhead',tip:'Same as double-clicking the item',fn:()=>addMediaToTimeline(m,state.time,null)});
  if(anyProxy){items.push({sep:true});
    items.push({label:'Play originals for all clips',tip:'Full quality everywhere it can play; the rest stay on proxies',fn:()=>proAllOriginals(true)});
    items.push({label:'Play proxies for all clips',tip:'Smoothest editing',fn:()=>proAllOriginals(false)});}
  if(heavy)items.push({label:'Make proxies for heavy footage ('+heavy+')',tip:'Above 1080p or a very high bitrate, without a proxy yet',fn:proMakeHeavyProxies});
  items.push({sep:true});
  items.push({label:'Remove from bin',tip:'Clips using it are removed from the timeline too',danger:true,fn:()=>removeMedia(m.id)});
  showCtx(x,y,items);
}
// Called at the end of renderBin(): badges + menus on video items.
function proDecorateBin(){
  for(const m of state.media){
    const d=document.querySelector(`#binList .bin-item[data-id="${m.id}"]`);if(!d||m.loading)continue;
    d.oncontextmenu=e=>{e.preventDefault();proBinMenu(m,e.clientX,e.clientY);};
    if(m.type!=='video'||m.missing)continue;
    // a project saved while playing originals switches back to them once relinked
    if(m.playOriginal&&m.proxied&&!_proPlay[m.id]&&!m._proApplying){m._proApplying=true;
      proUseOriginal(m,true,true).finally(()=>{m._proApplying=false;});}
    const info=proProxyInfo(m);if(info.kind==='none')continue;
    const sub=d.querySelector('.bin-sub');if(!sub)continue;
    const b=document.createElement('button');
    b.className='bin-px '+(info.kind==='original'?'orig':'prox');
    b.textContent=info.kind==='original'?'ORIGINAL':'PROXY';
    b.title=(info.kind==='original'?'Playing the original file. ':'Editing on a proxy. ')+info.why
      +(info.canOriginal?' Click to switch.':' '+info.noOriginal)+' Exports always use the original.';
    b.onclick=e=>{e.stopPropagation();const r=b.getBoundingClientRect();showCtx(r.left,r.bottom+4,proProxyMenuItems(m));};
    sub.appendChild(b);
  }
}
