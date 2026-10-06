/* ==================== PRO: COLOR SCOPES (v4.9) ====================
   Replaces the small v3.25 scopes with grading-grade ones:
   · Waveform — Luma, RGB Parade or RGB overlay; density-accumulated (every
     sampled pixel counts), graticule at 0/25/50/75/100 %, dashed video-legal
     lines (16/235), and a crushed/clipped readout.
   · Vectorscope — BT.709 Cb/Cr, 75 % color-bar target boxes, skin-tone line,
     plotted in each point's own hue.
   · Histogram — R, G, B and luma.
   The math is in proScopeCompute (pure, tested against known test patterns);
   the drawing is separate. Updates ~8×/s while playing, on every seek when
   paused. */
const PRO_SC={W:320,H:180,wave:'luma'};
try{const m=localStorage.getItem('vibe-scope-wave');if(m)PRO_SC.wave=m;}catch(e){}
// BT.709 (full range, 0..1): Cb/Cr in −0.5..0.5
function proScopeYCbCr(R,G,B){const Y=0.2126*R+0.7152*G+0.0722*B;return [Y,(B-Y)/1.8556,(R-Y)/1.5748];}
// d: RGBA bytes of a w×h image. Returns the accumulators.
function proScopeCompute(d,w,h,VN){
  VN=VN||181;
  const luma=new Uint32Array(w*256),rgb=[new Uint32Array(w*256),new Uint32Array(w*256),new Uint32Array(w*256)];
  const vec=new Uint32Array(VN*VN),hist=[new Uint32Array(256),new Uint32Array(256),new Uint32Array(256),new Uint32Array(256)];
  let crushed=0,clipped=0;const n=w*h,c=(VN-1)/2;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4,R=d[i],G=d[i+1],B=d[i+2];
    const Y=0.2126*R+0.7152*G+0.0722*B,Yi=Math.min(255,Math.round(Y));
    luma[Yi*w+x]++;rgb[0][R*w+x]++;rgb[1][G*w+x]++;rgb[2][B*w+x]++;
    hist[0][R]++;hist[1][G]++;hist[2][B]++;hist[3][Yi]++;
    if(Yi<=2)crushed++;else if(Yi>=253)clipped++;
    const cb=(B-Y)/255/1.8556,cr=(R-Y)/255/1.5748;
    const vx=Math.round(c+cb*2*c),vy=Math.round(c-cr*2*c);   // ±0.5 → edge of the scope
    if(vx>=0&&vx<VN&&vy>=0&&vy<VN)vec[vy*VN+vx]++;
  }
  return {w,h,VN,luma,rgb,vec,hist,crushed:crushed/n,clipped:clipped/n};
}
// 75 % bars: where their chroma lands (x,y in −0.5..0.5, y up = +Cr)
const PRO_SC_TARGETS=[['R',[.75,0,0]],['Mg',[.75,0,.75]],['B',[0,0,.75]],['Cy',[0,.75,.75]],['G',[0,.75,0]],['Yl',[.75,.75,0]]].map(([n,c])=>{const [,cb,cr]=proScopeYCbCr(...c);return {n,cb,cr};});
function _proScHTML(){
  const m=PRO_SC.wave;
  return `<div class="sc-box sc-wave"><span class="sc-lab">Waveform</span>
      <div class="sc-modes seg" id="scWaveMode">
        <button data-m="luma" class="${m==='luma'?'on':''}" title="Brightness of the picture, column by column (top = white, bottom = black)">Luma</button>
        <button data-m="parade" class="${m==='parade'?'on':''}" title="Red, green and blue side by side — balance the three to neutralize a color cast">Parade</button>
        <button data-m="rgb" class="${m==='rgb'?'on':''}" title="Red, green and blue overlaid — where they line up, the picture is neutral">RGB</button></div>
      <canvas id="scWave" width="${PRO_SC.W}" height="160" title="Waveform — 0% at the bottom, 100% at the top; dashed lines mark the video-legal range (16–235)"></canvas>
      <div class="sc-read" id="scRead"></div></div>
    <div class="sc-box sc-vec"><span class="sc-lab">Vectorscope</span><canvas id="scVec" width="181" height="181" title="Vectorscope — hue is the angle, saturation the distance from the center. Boxes: 75% color bars (R, Mg, B, Cy, G, Yl). The line toward upper-left is the skin-tone line."></canvas></div>
    <div class="sc-box sc-hist"><span class="sc-lab">Histogram</span><canvas id="scHist" width="256" height="120" title="Histogram — how much of the picture sits at each brightness, for red, green, blue and luma"></canvas></div>`;
}
function _proScInit(){
  const p=document.getElementById('scopes');if(!p||p.dataset.v49)return p;
  p.dataset.v49='1';p.innerHTML=_proScHTML();p.classList.add('sc49');
  p.querySelectorAll('#scWaveMode button').forEach(b=>b.onclick=()=>{PRO_SC.wave=b.dataset.m;try{localStorage.setItem('vibe-scope-wave',b.dataset.m);}catch(e){}
    p.querySelectorAll('#scWaveMode button').forEach(x=>x.classList.toggle('on',x===b));updateScopes(true);});
  return p;
}
let _proScT=0,_proScC=null,_proScImg={};
function _proScPut(el,key,W,H,fill){   // draw a density image through a reused ImageData
  const g=el.getContext('2d');let im=_proScImg[key];if(!im||im.width!==W||im.height!==H)im=_proScImg[key]=g.createImageData(W,H);
  fill(im.data);g.putImageData(im,0,0);return g;
}
// eslint-disable-next-line no-global-assign
updateScopes=function(force){
  const panel=_proScInit();if(!panel)return;
  panel.hidden=!scopesOn;
  const sb=document.getElementById('scopesBtn');if(sb)sb.classList.toggle('on',scopesOn);
  if(!scopesOn)return;
  const now=performance.now();if(!force&&now-_proScT<(state.playing?120:40))return;_proScT=now;
  if(!_proScC){_proScC=document.createElement('canvas');_proScC.width=PRO_SC.W;_proScC.height=PRO_SC.H;}
  const g=_proScC.getContext('2d',{willReadFrequently:true});
  g.drawImage(cv,0,0,PRO_SC.W,PRO_SC.H);
  let d;try{d=g.getImageData(0,0,PRO_SC.W,PRO_SC.H).data;}catch(e){return;}
  const S=proScopeCompute(d,PRO_SC.W,PRO_SC.H,181);
  proScopeDraw(S);
};
function proScopeDraw(S){
  const wv=document.getElementById('scWave'),vc=document.getElementById('scVec'),hc=document.getElementById('scHist');if(!wv||!vc||!hc)return;
  const W=wv.width,H=wv.height,w=S.w,mode=PRO_SC.wave,k=Math.log1p(S.h*0.35);
  const lvl=cnt=>Math.min(1,Math.log1p(cnt)/k);
  // ---- waveform ----
  const wg=_proScPut(wv,'w',W,H,px=>{
    for(let i=0;i<px.length;i+=4){px[i]=11;px[i+1]=13;px[i+2]=18;px[i+3]=255;}
    const plot=(acc,x0,xw,col)=>{for(let v=0;v<256;v++){const Y=Math.round((1-v/255)*(H-1));for(let x=0;x<w;x++){const n=acc[v*w+x];if(!n)continue;
      const X=x0+Math.floor(x*xw/w),o=(Y*W+X)*4,a=lvl(n);
      px[o]=Math.min(255,px[o]+col[0]*a);px[o+1]=Math.min(255,px[o+1]+col[1]*a);px[o+2]=Math.min(255,px[o+2]+col[2]*a);}}};
    if(mode==='parade'){const pw=Math.floor(W/3);plot(S.rgb[0],0,pw,[255,70,70]);plot(S.rgb[1],pw,pw,[70,235,110]);plot(S.rgb[2],2*pw,pw,[90,140,255]);}
    else if(mode==='rgb'){plot(S.rgb[0],0,W,[230,40,40]);plot(S.rgb[1],0,W,[40,210,70]);plot(S.rgb[2],0,W,[50,90,255]);}
    else plot(S.luma,0,W,[150,245,170]);
  });
  wg.save();wg.font='9px system-ui,sans-serif';wg.textAlign='left';
  for(const p of [0,25,50,75,100]){const y=Math.round((1-p/100)*(H-1))+0.5;wg.strokeStyle='rgba(255,255,255,.14)';wg.beginPath();wg.moveTo(0,y);wg.lineTo(W,y);wg.stroke();
    wg.fillStyle='rgba(255,255,255,.35)';wg.fillText(p,2,Math.min(H-2,Math.max(9,y-2)));}
  wg.setLineDash([3,3]);wg.strokeStyle='rgba(255,200,90,.35)';
  for(const v of [16,235]){const y=Math.round((1-v/255)*(H-1))+0.5;wg.beginPath();wg.moveTo(0,y);wg.lineTo(W,y);wg.stroke();}
  if(mode==='parade'){wg.setLineDash([]);wg.strokeStyle='rgba(255,255,255,.12)';const pw=Math.floor(W/3);for(const x of [pw,2*pw]){wg.beginPath();wg.moveTo(x+0.5,0);wg.lineTo(x+0.5,H);wg.stroke();}}
  wg.restore();
  const rd=document.getElementById('scRead');
  if(rd){const f=v=>v<0.001?'0%':v<0.01?'<1%':Math.round(v*100)+'%';
    rd.innerHTML=`<span class="${S.crushed>0.02?'warn':''}" title="Share of the picture at pure black (detail lost in the shadows)">Crushed ${f(S.crushed)}</span><span class="${S.clipped>0.02?'warn':''}" title="Share of the picture at pure white (detail lost in the highlights)">Clipped ${f(S.clipped)}</span>`;}
  // ---- vectorscope (each point in its own hue) ----
  const VN=S.VN,c=(VN-1)/2,vk=Math.log1p(S.w*S.h*0.02);
  const vg=_proScPut(vc,'v',VN,VN,px=>{
    for(let i=0;i<px.length;i+=4){px[i]=11;px[i+1]=13;px[i+2]=18;px[i+3]=255;}
    for(let y=0;y<VN;y++)for(let x=0;x<VN;x++){const n=S.vec[y*VN+x];if(!n)continue;
      const cb=(x-c)/(2*c),cr=(c-y)/(2*c),Y=0.55;let R=Y+1.5748*cr,B=Y+1.8556*cb,G=(Y-0.2126*R-0.0722*B)/0.7152;
      const m=Math.max(R,G,B,1e-6),a=Math.min(1,0.25+Math.log1p(n)/vk);R=Math.max(0,R/m);G=Math.max(0,G/m);B=Math.max(0,B/m);
      const o=(y*VN+x)*4;px[o]=Math.min(255,40+215*R*a);px[o+1]=Math.min(255,40+215*G*a);px[o+2]=Math.min(255,40+215*B*a);}
  });
  vg.save();vg.strokeStyle='rgba(255,255,255,.16)';vg.beginPath();vg.arc(c+0.5,c+0.5,c-1,0,7);vg.moveTo(c+0.5,0);vg.lineTo(c+0.5,VN);vg.moveTo(0,c+0.5);vg.lineTo(VN,c+0.5);vg.stroke();
  // skin-tone line (≈123°)
  const a=123*Math.PI/180;vg.strokeStyle='rgba(255,190,140,.35)';vg.beginPath();vg.moveTo(c,c);vg.lineTo(c+Math.cos(a)*(c-2),c-Math.sin(a)*(c-2));vg.stroke();
  vg.font='8px system-ui,sans-serif';vg.textAlign='center';
  for(const t of PRO_SC_TARGETS){const x=c+t.cb*2*c,y=c-t.cr*2*c;vg.strokeStyle='rgba(255,255,255,.4)';vg.strokeRect(x-4,y-4,8,8);
    vg.fillStyle='rgba(255,255,255,.45)';const ox=(x-c)*0.18,oy=(y-c)*0.18;vg.fillText(t.n,x+ox,y+oy+(oy<0?-4:10));}
  vg.restore();
  // ---- histogram ----
  const HW=hc.width,HH=hc.height,hg=hc.getContext('2d');
  hg.fillStyle='#0b0d12';hg.fillRect(0,0,HW,HH);
  let mx=1;for(const h of S.hist)for(let b=1;b<255;b++)mx=Math.max(mx,h[b]);   // ignore the end bins so a clipped frame doesn't flatten the rest
  const cols=['rgba(255,90,90,.9)','rgba(90,225,130,.9)','rgba(110,150,255,.9)','rgba(235,235,235,.75)'];
  S.hist.forEach((h,ci)=>{hg.strokeStyle=cols[ci];hg.lineWidth=1;hg.beginPath();
    for(let b=0;b<256;b++){const X=b/255*(HW-1),Yv=HH-1-Math.min(1,h[b]/mx)*(HH-4);b?hg.lineTo(X,Yv):hg.moveTo(X,Yv);}hg.stroke();});
}
// Grading sections get a quick "Scopes" toggle in their header.
function proScopesChips(host){
  host=host||document.getElementById('inspBody');if(!host)return;
  // ONE chip per inspector, on the first grading header (Color & effects, else Color grading, else LUT)
  if(host.querySelector('.sc-chip'))return;
  [host.querySelector('.accSec[data-sec="color"]>h4,.accSec[data-sec="grade"]>h4,.accSec[data-sec="lut"]>h4')].filter(Boolean).forEach(h=>{
    const b=document.createElement('span');b.className='sc-chip'+(scopesOn?' on':'');b.textContent='Scopes';b.title='Show or hide the waveform, vectorscope and histogram under the viewer';
    b.onclick=e=>{e.stopPropagation();document.getElementById('scopesBtn').click();document.querySelectorAll('.sc-chip').forEach(x=>x.classList.toggle('on',scopesOn));};
    const r=h.querySelector('.reset');h.insertBefore(b,r||null);});
}
_proScInit();
