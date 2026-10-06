/* ==================== PRO: menus, commands, guide (v4.7) ==================== */
// ---------- inspector sections added by the Pro block (v4.8) ----------
function proInspectorSections(c,p,SEC,ORDER){
  const ins=(type,after,key)=>{const o=ORDER[type];if(!o||o.includes(key))return;const i=o.indexOf(after);o.splice(i<0?o.length:i+1,0,key);};
  if(typeof proLutSectionHTML==='function'&&['video','image','adjust','compound'].includes(c.type)){
    SEC.lut=proLutSectionHTML(c,p);
    // a compound shows only what draws on it / plays through it (no Motion presets,
    // Transitions, Vignette, Film fade or grain: those don't apply to a compound)
    ORDER.compound=ORDER.compound||['timing','smooth','transform','filters','color','grade','lut','audio','fades'];
    for(const t of ['video','image','adjust'])ins(t,'grade','lut');
  }
  if(c.type==='compound'){
    SEC.audio=typeof proCmpHasSound==='function'&&proCmpHasSound(c)?`<div class="sec"><h4>Audio</h4>
      ${slider('volume','Volume',p.muteClip?0:(p.volume??1),0,3,0.01,v=>Math.round(v*100)+'%')}
      <label class="ckrow ramp-ck" title="Silence everything inside this compound clip — its volume setting and keyframes are kept"><input type="checkbox" id="cmpMute" ${p.muteClip?'checked':''}> Mute this compound clip</label>
      <div class="lut-note">Sets the level of everything inside. Above 100% boosts it.</div></div>`:'';
    SEC.smooth=typeof proCmpHasVideo==='function'&&proCmpHasVideo(c)?`<div class="sec"><h4>Smoothing</h4>
      <label class="ckrow ramp-ck" title="Where the video inside plays slower than it was shot (e.g. this compound slowed down), mix neighboring frames instead of repeating them — smoother slow motion"><input type="checkbox" id="pFrameBlend" ${p.frameBlend?'checked':''}> Smooth slow motion (frame blending)</label>
      ${slider('motionBlur','Motion blur',p.motionBlur||0,0,360,15,v=>v+'°')}
      <div class="lut-note">Applies to the video clips inside. Frame blending works where they play slower than shot, motion blur where they play faster (180° is natural). Both show in the preview when paused and in Precise exports.</div></div>`:'';
  }
  if(typeof proRampSectionHTML==='function'&&(c.type==='video'||c.type==='audio')){
    SEC.ramp=proRampSectionHTML(c,p);ins('video','timing','ramp');ins('audio','timing','ramp');
  }
}
function proBindInspector(c,host){
  if(typeof proLutBind==='function')proLutBind(c);
  if(typeof proRampBind==='function')proRampBind(c);
  if(typeof proScopesChips==='function')proScopesChips(host);
  if(c.type==='compound'){
    const fb=document.getElementById('pFrameBlend');if(fb)fb.onchange=()=>{pushHistory();c.props.frameBlend=fb.checked;requestDraw();};
    const mu=document.getElementById('cmpMute');if(mu)mu.onchange=()=>{pushHistory();c.props.muteClip=mu.checked;renderTimeline();renderInspector();requestDraw();syncMediaPlayback();};
  }
}
try{INSP_GROUP.lut=['Look',2.5];INSP_GROUP.ramp=['',-0.95];INSP_GROUP.smooth=['',-0.9];}catch(e){}   // LUT after Grade; Speed ramp right under Timing
try{HINTS.motionBlur='Virtual shutter for the fast parts of this clip: 0° is sharp, 180° looks like normal camera blur, 360° is the smoothest.';}catch(e){}
try{HINTS.lutAmt='How strongly the LUT applies \u2014 100% is the LUT exactly as designed, lower blends back toward the original picture.';}catch(e){}
(function proWire(){
  COMMANDS.push(
    {n:'Auto-duck music under speech…',f:()=>proDuckDialog()},
    {n:'Proxies: play originals for all clips',f:()=>proAllOriginals(true)},
    {n:'Proxies: play proxies for all clips',f:()=>proAllOriginals(false)},
    {n:'Proxies: make proxies for heavy footage',f:()=>proMakeHeavyProxies()},
    {n:'Label speakers in the transcript…',f:()=>proSpeakersDialog()},
    {n:'Make compound clip from the selection',k:'Ctrl Alt G',f:()=>proMakeCompound()},
    {n:'Edit inside the selected compound clip',f:()=>{const c=state.clips.find(x=>x.id===state.selection);if(c&&c.type==='compound')proOpenCompound(c);else toast('Select a compound clip first');}},
    {n:'Keyframe curve editor…',f:()=>{const c=state.clips.find(x=>x.id===state.selection);if(c)proCurvesOpen(c);else toast('Select a clip with keyframes first');}},
    {n:'Load a .cube LUT for the selected clip…',f:async()=>{const c=state.clips.find(x=>x.id===state.selection);
      if(!c||!['video','image','adjust','compound'].includes(c.type)){toast('Select a video, image, adjustment or compound clip first');return;}
      const id=await proLoadCubeFile();if(!id)return;pushHistory();c.props.lutId=id;if(c.props.lutAmt==null)c.props.lutAmt=100;renderInspector();requestDraw();}},
    ...PRO_RAMPS.map(P=>({n:'Speed ramp: '+P.n,f:()=>{const c=state.clips.find(x=>x.id===state.selection);
      if(!proRampCanUse(c)){toast('Select a video or audio clip first');return;}pushHistory();proRampApply(c,P.id);renderTimeline();renderInspector();requestDraw();}})),
    {n:'Speed ramp: remove',f:()=>{const c=state.clips.find(x=>x.id===state.selection);
      if(!c){toast('Select a clip with a speed ramp first');return;}
      if(!c.ramp){toast('“'+c.name+'” has no speed ramp');return;}
      if(state.locked[c.track]){toast('That clip is on a locked track','err');return;}
      pushHistory();proRampRemove(c);renderTimeline();renderInspector();requestDraw();toast('Speed ramp removed — the clip keeps its average speed','ok');}},
    {n:'Break apart the selected compound clip',k:'Ctrl Alt G',f:()=>{const c=state.clips.find(x=>x.id===state.selection);if(c&&c.type==='compound')proBreakCompound(c);else toast('Select a compound clip first');}},
  );
  GUIDE.push({s:'Pro tools',items:[
    {t:'Auto-duck music',k:'duck ducking music under speech voice dialogue dip lower background level sidechain',
     d:'Make background music dip while someone talks and come back up in the pauses — the classic podcast and vlog mix, done in one step.',
     how:['Put the voice on one track and the music on another.',
          'AI tools → Auto-duck music. Each track is marked Voice, Music or Ignore — change any that were guessed wrong.',
          'Set how far the music drops, how fast it fades down and back up, and how long a pause has to be before it comes back. The strip shows the music level it will produce.',
          'Press Duck music. The dips are ordinary volume keyframes on the music clips: drag them in the inspector to fine-tune. Running it again replaces the old dips; Remove ducking takes them off.',
          'With a transcript, only words count as speech (a cough or a laugh won’t dip the music). Without one, the voice track’s loudness decides.']},
    {t:'Compound clips (nesting)',k:'compound nest nested sequence group precomp collapse combine clips container',
     d:'Wrap several clips \u2014 on any tracks, with titles and sound \u2014 into one clip. Move, trim, split, fade, scale or animate it as a unit, and still edit what\u2019s inside whenever you like.',
     how:['Select the clips (Shift+click or drag a box), then right-click \u2192 Make compound clip, or Ctrl+Alt+G.',
          'The compound sits on the highest video track the clips used. Trim its edges to show only part of it; its position, scale, rotation, opacity, look and volume apply to everything inside.',
          'Double-click it (or right-click \u2192 Edit inside) to change the clips inside. A bar above the timeline shows where you are \u2014 press Back or Esc to return. Everything you did inside is one undo step outside.',
          'Right-click \u2192 Break apart (or Ctrl+Alt+G on a compound) puts the clips back on the timeline where they are now. Its look, opacity, volume and fades go onto the clips where they map one-to-one; anything that can\u2019t is named in the message.',
          'Compounds can contain compounds. The transcript and AI tools work on clips outside compounds \u2014 open a compound to use them on what\u2019s inside.']},
    {t:'Speaker labels',k:'speaker speakers diarization who is talking names interview podcast dialogue voices label',
     d:'Mark who says what in the transcript. Each voice gets a colored name you can rename; captions and subtitles can carry the names.',
     how:['Transcribe first, then in the Transcript tab open \u22ef \u2192 Label speakers (or AI tools, or Ctrl+K).',
          'Leave Speakers on Auto, or set how many people are talking \u2014 setting the number is more reliable when two voices sound alike.',
          'Click a speaker\u2019s name in the transcript to rename them, select everything they say (then Delete to cut it), relabel one paragraph, or merge two speakers that are really the same person.',
          'Captions: tick \u201cShow speaker names\u201d. Exported .srt/.txt name the speaker when the voice changes; .vtt uses standard voice tags.',
          'It runs on this computer. The desktop app uses CAM++, a high-accuracy voice model installed with it (no download): a real two-person phone call is labeled 99% right, with the count found automatically. The single-file browser copy uses a smaller built-in model, where similar voices may need the count set.']},
    {t:'LUT color grading (.cube)',k:'lut cube look up table color grade grading log rec709 film look slog vlog clog preset',
     d:'Apply any .cube LUT — camera log to Rec.709 conversions, film emulations and creative looks — to a clip, a compound clip, or an adjustment layer that grades everything below it.',
     how:['Select a clip and open the LUT section in the inspector. Pick a built-in camera conversion (Sony S-Log3, Panasonic V-Log, ARRI LogC3, Apple Log → Rec.709) or a look (Teal & orange, Warm film, Bleach bypass, Black & white…), or choose Load a .cube file… for your own (also Ctrl+K → Load a .cube LUT).',
          'Intensity blends between the original and the full look.',
          'The LUT is applied first, then the clip’s own color settings — so a log conversion comes before your exposure or saturation tweaks.',
          'Loaded LUTs are saved inside the project file, so a project opens with its looks on any computer. Both 3D and 1D .cube files work.']},
    {t:'Keyframe curves',k:'keyframe curve graph editor easing ease in out bezier hold linear animation smooth velocity',
     d:'Shape how an animation moves between keyframes — ease in, ease out, hold, or your own curve — on a graph of the value over time.',
     how:['Add keyframes with the ◇ buttons next to the sliders, then press Curves… on the Keyframes row (or Ctrl+K → Keyframe curve editor).',
          'Pick a property on the left. Drag a key to change its time and value (Shift: value only, Alt: time only); double-click to add a key; Delete removes the selected one.',
          'Choose how the move from the selected key to the next one eases: Linear, Smooth, Ease in, Ease out, Hold, or Custom — drag the two handles to shape it. Apply to all uses it on every key.',
          'Everything in one visit is one undo step. Splits and transcript cuts keep the curves exactly.']},
    {t:'Speed ramps',k:'speed ramp curve velocity slow motion slowmo fast bullet time hero montage flash time remap retime',
     d:'Vary a clip’s speed over time: race into a slow-motion moment and back out, flash in or out, or draw your own speed curve.',
     how:['Select a video or audio clip and open Speed ramp in the inspector (under Timing). Pick a shape — Hero moment, Bullet time and Jump center their slow (or fast) moment on the playhead when it’s over the clip.',
          'Drag points on the curve up (faster) or down (slower), or sideways; double-click adds a point, right-click removes one. It snaps to 1×.',
          'The clip keeps the same source footage and gets longer or shorter to fit. The Speed slider scales the whole ramp; None or reset removes it.',
          'Sound follows the ramp — with Preserve pitch on, voices keep their pitch. Splitting a ramped clip keeps each half exactly as it played.',
          'Smoothing (video clips): Smooth slow motion mixes neighboring frames where the clip plays slower than it was shot; Motion blur adds a camera-like blur where it plays faster (180° looks natural). Both show when paused and in Precise exports.']},
    {t:'Color scopes',k:'scopes waveform parade vectorscope histogram grading exposure clipping crushed skin tone line levels',
     d:'Judge exposure and color by the numbers while you grade: a waveform (luma, RGB parade or overlay), a vectorscope with color-bar targets and a skin-tone line, and a histogram.',
     how:['Press the scopes button under the viewer, or “Scopes” in the Color grading, Color or LUT section header.',
          'Waveform: brightness from bottom (0%) to top (100%), column by column. Dashed lines mark the video-legal range; the readout warns when shadows are crushed or highlights clipped.',
          'Parade shows red, green and blue side by side — when a gray or white object lines up in all three, the color is neutral.',
          'Vectorscope: angle is hue, distance is saturation. Faces should sit near the skin-tone line; the boxes are 75% color bars.']},
    {t:'Speed and reverse on compound clips',k:'compound speed reverse nested sequence retime slow fast backwards',
     d:'A compound clip can play faster, slower or backwards as a whole — everything inside (clips, titles, keyframes, sound) follows.',
     how:['Select the compound and use Speed and Play in reverse under Timing, just like on a video clip. Preserve pitch applies to the sound inside; Smoothing (frame blending / motion blur) to the video inside.',
          'Break apart keeps the timing: the clips come out already sped up or reversed.',
          'Text entrance/exit animations and transitions inside are swapped for their exit/entrance counterparts when reversed.']},
  ]});
  try{SHORTCUTS.push(['Make / break apart compound clip','Ctrl Alt G'],['Leave a compound clip','Esc']);}catch(e){}
})();
