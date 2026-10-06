/* ==================== PRO: .cube LUT GRADING (v4.8) ====================
   Load any .cube LUT (3D, or 1D which is expanded to 3D) and apply it to a
   clip — or to an adjustment layer, which grades everything below it.
   A LUT is applied to the picture FIRST (so a camera log → Rec.709 LUT does
   its job), then the clip's own color controls act on the result.

   GPU: WebGL2, the LUT as a 3D texture with hardware trilinear filtering
   (half-float, so no banding). CPU fallback does the same trilinear math.
   LUTs live in state.luts (saved in the project file, NOT in undo history —
   a 33³ LUT is ~210 KB); clips reference one by id (p.lutId, p.lutAmt 0-100). */
state.luts=state.luts||{};
// ---------- parsing ----------
function proParseCube(text,name){
  let size3=0,size1=0,dmin=[0,0,0],dmax=[1,1,1],title='',r1=null;const vals=[];
  for(const raw of String(text).split(/\r?\n/)){
    const line=raw.replace(/#.*/,'').trim();if(!line)continue;
    const up=line.toUpperCase();
    if(up.startsWith('TITLE')){title=line.replace(/^TITLE\s*/i,'').replace(/^"|"$/g,'');continue;}
    if(up.startsWith('LUT_3D_SIZE')){size3=parseInt(line.split(/\s+/)[1]);continue;}
    if(up.startsWith('LUT_1D_SIZE')){size1=parseInt(line.split(/\s+/)[1]);continue;}
    if(up.startsWith('DOMAIN_MIN')){dmin=line.split(/\s+/).slice(1,4).map(Number);continue;}
    if(up.startsWith('DOMAIN_MAX')){dmax=line.split(/\s+/).slice(1,4).map(Number);continue;}
    if(up.startsWith('LUT_3D_INPUT_RANGE')){const r=line.split(/\s+/).slice(1,3).map(Number);dmin=[r[0],r[0],r[0]];dmax=[r[1],r[1],r[1]];continue;}
    if(up.startsWith('LUT_1D_INPUT_RANGE')){r1=line.split(/\s+/).slice(1,3).map(Number);continue;}
    if(/^[A-Z_]+(\s|$)/.test(up))continue;               // other keywords we don't need
    const n=line.split(/\s+/).map(Number);
    if(n.length>=3&&n.slice(0,3).every(isFinite))vals.push(n[0],n[1],n[2]);
  }
  if(size3&&!(size3>=2&&size3<=129))throw new Error('LUT size '+size3+' isn’t supported (2–129)');
  if(size1&&!(size1>=2&&size1<=65536))throw new Error('1D LUT size '+size1+' isn’t supported');
  const shaperN=size3&&size1?size1*3:0;   // Resolve-style: a 1D shaper listed before the 3D table
  if(size3){
    if(vals.length<shaperN+size3**3*3)throw new Error('The LUT is incomplete ('+Math.max(0,vals.length-shaperN)/3+' of '+size3**3+' entries)');
    const L={name:title||name||'LUT',size:size3,dmin,dmax,data:Float32Array.from(vals.slice(shaperN,shaperN+size3**3*3))};
    if(!shaperN)return L;
    // the shaper stays a separate first stage (baking a steep log curve into the
    // 3D grid would lose the shadows); resampled to at most 4096 entries
    const lo=r1?r1[0]:0,hi=r1?r1[1]:1,M=Math.min(size1,4096),sd=new Float32Array(M*3);
    for(let i=0;i<M;i++){const f=i/(M-1)*(size1-1),k=Math.min(size1-2,Math.floor(f)),u=f-k;for(let ch=0;ch<3;ch++)sd[i*3+ch]=vals[k*3+ch]*(1-u)+vals[(k+1)*3+ch]*u;}
    L.shaper={n:M,lo,hi,data:sd};
    return L;
  }
  if(size1){
    if(r1){dmin=[r1[0],r1[0],r1[0]];dmax=[r1[1],r1[1],r1[1]];}
    if(vals.length<size1*3)throw new Error('The 1D LUT is incomplete');
    // expand to a 33³ table (per-channel curves, sampled with linear interpolation)
    const N=33,d=new Float32Array(N*N*N*3);
    const c1=(ch,x)=>{const f=clamp(x,0,1)*(size1-1),i=Math.min(size1-2,Math.floor(f)),u=f-i;return vals[i*3+ch]*(1-u)+vals[(i+1)*3+ch]*u;};
    for(let b=0;b<N;b++)for(let g=0;g<N;g++)for(let r=0;r<N;r++){const o=((b*N+g)*N+r)*3;d[o]=c1(0,r/(N-1));d[o+1]=c1(1,g/(N-1));d[o+2]=c1(2,b/(N-1));}
    return {name:title||name||'LUT',size:N,dmin,dmax,data:d};
  }
  throw new Error('No LUT_3D_SIZE or LUT_1D_SIZE line — is this a .cube file?');
}
// project file form: 16-bit, base64 (values clamped to 0..1, the display range)
// (a shaper's output feeds the 3D table's input range, so it is stored relative to that range)
function _lutB64(arr,lo,hi){
  const q=new Uint16Array(arr.length);for(let i=0;i<q.length;i++)q[i]=Math.round(clamp((arr[i]-lo)/((hi-lo)||1),0,1)*65535);
  const u=new Uint8Array(q.buffer);let s='';for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode.apply(null,u.subarray(i,i+0x8000));
  return btoa(s);
}
function _lutUnB64(b64,lo,hi){
  const b=atob(b64),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);
  const q=new Uint16Array(u.buffer),d=new Float32Array(q.length);for(let i=0;i<q.length;i++)d[i]=lo+(hi-lo)*q[i]/65535;
  return d;
}
function proLutPack(L){
  if(L.builtin)return {name:L.name,builtin:L.builtin};   // v4.9: built-ins are regenerated, not stored
  const o={name:L.name,size:L.size,dmin:L.dmin,dmax:L.dmax,b64:_lutB64(L.data,0,1)};
  if(L.shaper){const S=L.shaper,lo=Math.min(...L.dmin),hi=Math.max(...L.dmax);o.shaper={n:S.n,lo:S.lo,hi:S.hi,olo:lo,ohi:hi,b64:_lutB64(S.data,lo,hi)};}
  return o;
}
function proLutUnpack(o){
  if(o.builtin&&typeof proBuiltinLut==='function'){const B=proBuiltinLut(o.builtin);if(B)return B;}
  const L={name:o.name,size:o.size,dmin:o.dmin||[0,0,0],dmax:o.dmax||[1,1,1],data:_lutUnB64(o.b64,0,1)};
  if(o.shaper){const S=o.shaper;L.shaper={n:S.n,lo:S.lo,hi:S.hi,data:_lutUnB64(S.b64,S.olo,S.ohi)};}
  return L;
}
function proLutAdd(L){
  const id='lut'+uid();state.luts[id]=L;return id;
}
// ---------- CPU reference (also the fallback) ----------
function _lutShape(S,ch,x){const f=clamp((x-S.lo)/((S.hi-S.lo)||1),0,1)*(S.n-1),i=Math.min(S.n-2,Math.floor(f)),u=f-i;return S.data[i*3+ch]*(1-u)+S.data[(i+1)*3+ch]*u;}
function proLutSample(L,r,g,b){
  if(L.shaper){const S=L.shaper;r=_lutShape(S,0,r);g=_lutShape(S,1,g);b=_lutShape(S,2,b);}
  const N=L.size,d=L.data,x=[r,g,b].map((v,i)=>clamp((v-L.dmin[i])/((L.dmax[i]-L.dmin[i])||1),0,1)*(N-1));
  const i0=x.map(v=>Math.min(N-2,Math.floor(v))),f=x.map((v,i)=>v-i0[i]);
  const at=(ri,gi,bi,ch)=>d[((bi*N+gi)*N+ri)*3+ch];
  const out=[0,0,0];
  for(let ch=0;ch<3;ch++){
    let s=0;
    for(let k=0;k<8;k++){const dr=k&1,dg=(k>>1)&1,db=(k>>2)&1;
      const w=(dr?f[0]:1-f[0])*(dg?f[1]:1-f[1])*(db?f[2]:1-f[2]);if(w)s+=w*at(i0[0]+dr,i0[1]+dg,i0[2]+db,ch);}
    out[ch]=s;
  }
  return out;
}
function proLutCPU(img,L,amt){ // ImageData in place
  const d=img.data;
  for(let i=0;i<d.length;i+=4){const r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255,o=proLutSample(L,r,g,b);
    d[i]=Math.round(clamp(r+(o[0]-r)*amt,0,1)*255);d[i+1]=Math.round(clamp(g+(o[1]-g)*amt,0,1)*255);d[i+2]=Math.round(clamp(b+(o[2]-b)*amt,0,1)*255);}
  return img;
}
// ---------- GPU ----------
let _lutGL=null;
function _lutGLInit(){
  if(_lutGL!==null)return _lutGL;
  try{
    const c=document.createElement('canvas');c.width=2;c.height=2;
    const gl=c.getContext('webgl2',{premultipliedAlpha:false,preserveDrawingBuffer:true,antialias:false});
    if(!gl)return _lutGL=false;
    const sh=(t,src)=>{const s=gl.createShader(t);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    const pr=gl.createProgram();
    gl.attachShader(pr,sh(gl.VERTEX_SHADER,`#version 300 es
in vec2 p;uniform vec4 crop;out vec2 uv;
void main(){uv=crop.xy+(p*0.5+0.5)*crop.zw;gl_Position=vec4(p.x,-p.y,0.,1.);}`));
    gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,`#version 300 es
precision highp float;precision highp sampler3D;
in vec2 uv;uniform sampler2D src;uniform sampler3D lut;uniform sampler2D shp;uniform float n;uniform float amt;uniform vec3 dmin;uniform vec3 dmax;
uniform float sn;uniform vec2 sr;out vec4 o;
float sh(float v,int ch){float t=clamp((v-sr.x)/max(sr.y-sr.x,1e-6),0.,1.)*((sn-1.)/sn)+0.5/sn;return texture(shp,vec2(t,0.5))[ch];}
void main(){vec4 c=texture(src,uv);vec3 y=c.rgb;
if(sn>1.)y=vec3(sh(y.r,0),sh(y.g,1),sh(y.b,2));
vec3 x=clamp((y-dmin)/max(dmax-dmin,vec3(1e-6)),0.,1.);
vec3 l=texture(lut,x*((n-1.)/n)+0.5/n).rgb;o=vec4(mix(c.rgb,l,amt),c.a);}`));
    gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const lp=gl.getAttribLocation(pr,'p');gl.enableVertexAttribArray(lp);gl.vertexAttribPointer(lp,2,gl.FLOAT,false,0,0);
    const src=gl.createTexture();gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,src);
    for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,k,v);
    const U=k=>gl.getUniformLocation(pr,k);
    gl.uniform1i(U('src'),0);gl.uniform1i(U('lut'),1);gl.uniform1i(U('shp'),2);
    const none=gl.createTexture();gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,none);   // bound when a LUT has no shaper
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(4));gl.activeTexture(gl.TEXTURE0);
    _lutGL={c,gl,src,none,U:{crop:U('crop'),n:U('n'),amt:U('amt'),dmin:U('dmin'),dmax:U('dmax'),sn:U('sn'),sr:U('sr')},tex:{},cur:null};
  }catch(e){console.warn('[LUT] WebGL2 unavailable, using the CPU path:',e);_lutGL=false;}
  return _lutGL;
}
function _lutTex(G,id,L){
  const gl=G.gl;
  for(const k in G.tex)if(!(state.luts&&state.luts[k]===G.tex[k].L)){gl.deleteTexture(G.tex[k].t);if(G.tex[k].s)gl.deleteTexture(G.tex[k].s);delete G.tex[k];}   // LUTs no longer loaded
  const t=G.tex[id];
  if(t)return t;
  const tex=gl.createTexture();gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,tex);
  for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_3D,k,v);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
  gl.texImage3D(gl.TEXTURE_3D,0,gl.RGB16F,L.size,L.size,L.size,0,gl.RGB,gl.FLOAT,L.data);
  let s=null;
  if(L.shaper){s=gl.createTexture();gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,s);
    for(const [k,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,k,v);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB16F,L.shaper.n,1,0,gl.RGB,gl.FLOAT,L.shaper.data);}
  G.tex[id]={t:tex,s,L};gl.activeTexture(gl.TEXTURE0);
  return G.tex[id];
}
const _lutCpuC=document.createElement('canvas');
// Graded copy of the source rect (sx,sy,sw,sh in the source element's pixels),
// at up to (maxW × maxH). Returns a canvas (valid until the next call) or null.
function proLutApply(source,sx,sy,sw,sh,lutId,amt,maxW,maxH){
  const L=state.luts&&state.luts[lutId];if(!L||!(amt>0))return null;
  const sW=source.videoWidth||source.naturalWidth||source.width,sH=source.videoHeight||source.naturalHeight||source.height;
  if(!sW||!sH)return null;
  const k=Math.min(1,(maxW||sw)/sw,(maxH||sh)/sh,4096/sw,4096/sh);
  const w=Math.max(1,Math.round(sw*k)),h=Math.max(1,Math.round(sh*k));
  const G=_lutGLInit();
  if(G){
    const gl=G.gl;
    if(G.c.width!==w)G.c.width=w;if(G.c.height!==h)G.c.height=h;
    gl.viewport(0,0,w,h);
    const T=_lutTex(G,lutId,L);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,T.t);
    gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,T.s||G.none);
    gl.uniform1f(G.U.sn,L.shaper?L.shaper.n:0);gl.uniform2f(G.U.sr,L.shaper?L.shaper.lo:0,L.shaper?L.shaper.hi:1);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,G.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    try{gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);}catch(e){return null;}
    gl.uniform4f(G.U.crop,sx/sW,sy/sH,sw/sW,sh/sH);
    gl.uniform1f(G.U.n,L.size);gl.uniform1f(G.U.amt,clamp(amt,0,1));
    gl.uniform3fv(G.U.dmin,L.dmin);gl.uniform3fv(G.U.dmax,L.dmax);
    gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    return G.c;
  }
  _lutCpuC.width=w;_lutCpuC.height=h;const g=_lutCpuC.getContext('2d',{willReadFrequently:true});
  g.drawImage(source,sx,sy,sw,sh,0,0,w,h);
  g.putImageData(proLutCPU(g.getImageData(0,0,w,h),L,clamp(amt,0,1)),0,0);
  return _lutCpuC;
}
// Adjustment layers: grade a whole-frame snapshot canvas in place.
function proLutInPlace(canvas,lutId,amt){
  const r=proLutApply(canvas,0,0,canvas.width,canvas.height,lutId,amt,canvas.width,canvas.height);
  if(!r)return;
  const g=canvas.getContext('2d');g.save();g.setTransform(1,0,0,1,0,0);g.globalCompositeOperation='copy';g.drawImage(r,0,0,canvas.width,canvas.height);g.restore();
}
// A loaded project (or a restored session) whose clips use a LUT it doesn't carry.
function proLutMissingNote(){
  const miss=new Set();
  const look=c=>{if(c.props&&c.props.lutId&&!(state.luts&&state.luts[c.props.lutId]))miss.add(c.props.lutId);};
  if(typeof proEachClip==='function')proEachClip(look);else state.clips.forEach(look);
  if(miss.size)toast((miss.size===1?'A LUT this project uses isn’t':miss.size+' LUTs this project uses aren’t')+' in the file \u2014 those clips play without it. Load the .cube again from the LUT section.','err',7000);
}
// ---------- UI ----------
async function proLoadCubeFile(){
  const f=await new Promise(res=>{const i=document.createElement('input');i.type='file';i.accept='.cube,.CUBE';i.onchange=()=>res(i.files[0]||null);i.click();});
  if(!f)return null;
  try{const L=proParseCube(await f.text(),f.name.replace(/\.cube$/i,''));if(!L.name||L.name==='LUT')L.name=f.name.replace(/\.cube$/i,'');
    const id=proLutAdd(L);toast('Loaded LUT “'+L.name+'” ('+L.size+'³)','ok');return id;}
  catch(e){toast('Couldn’t read '+f.name+': '+e.message,'err',6000);return null;}
}
function proLutSectionHTML(c,p){
  const cur=p.lutId&&state.luts[p.lutId]?p.lutId:'';
  const ids=Object.keys(state.luts||{}).filter(id=>!state.luts[id].builtin);
  const lib=typeof PRO_LUT_LIB!=='undefined'?PRO_LUT_LIB:[];
  const bOpt=B=>`<option value="b:${B.id}"${cur==='lutB_'+B.id?' selected':''}>${esc(B.name)}</option>`;
  return `<div class="sec"><h4>LUT <span class="reset" data-lutreset="1" title="Remove the LUT from this clip">reset</span></h4>
    <div class="field"><label>Look-up table</label>
      <select class="tsel" id="lutSel" title="A LUT applied to this ${c.type==='adjust'?'layer (everything below it)':'clip'} before its other color settings — camera log conversions, film looks, or your own .cube files">
        <option value="">None</option>
        ${lib.length?`<optgroup label="Camera log → Rec.709">${lib.filter(B=>B.group==='cam').map(bOpt).join('')}</optgroup>
        <optgroup label="Looks">${lib.filter(B=>B.group==='look').map(bOpt).join('')}</optgroup>`:''}
        ${ids.length?`<optgroup label="Your LUTs">${ids.map(id=>`<option value="${id}"${id===cur?' selected':''}>${esc(state.luts[id].name)} (${state.luts[id].size}³)</option>`).join('')}</optgroup>`:''}
        <option value="__load">Load a .cube file…</option>
      </select></div>
    ${cur?slider('lutAmt','Intensity',p.lutAmt==null?100:p.lutAmt,0,100,1,v=>v+'%'):''}
    <div class="lut-note">${cur?(state.luts[cur].builtin&&PRO_LUT_LIB.find(B=>B.id===state.luts[cur].builtin&&B.group==='cam')?'For footage shot in that log profile. Applied first, then this clip’s color settings.':'Applied first, then this clip’s color settings.'):'Built-in looks and camera conversions, or load your own .cube (saved inside the project).'}</div>
  </div>`;
}
function proLutBind(c){
  const sel=document.getElementById('lutSel');if(!sel)return;
  sel.onchange=async()=>{
    let v=sel.value;
    if(v==='__load'){v=await proLoadCubeFile();if(!v){renderInspector();return;}}
    else if(v.startsWith('b:'))v=proBuiltinLutId(v.slice(2));   // v4.9 built-in
    pushHistory();c.props.lutId=v||undefined;if(!v)delete c.props.lutId;if(c.props.lutAmt==null)c.props.lutAmt=100;
    renderInspector();requestDraw();
  };
  const rs=document.querySelector('[data-lutreset]');
  if(rs)rs.onclick=()=>{pushHistory();delete c.props.lutId;renderInspector();requestDraw();};
}
