/* ==================== PRO: BUILT-IN LUT LIBRARY (v4.9) ====================
   Camera log → Rec.709 conversions built from the manufacturers' published
   curves and color-space primaries, plus a set of creative looks — all
   generated in the app as 33³ tables (no files). A project stores only the
   name of a built-in LUT ({builtin:id}), so it costs nothing to save.

   Camera conversions: log curve → scene-linear → camera gamut to Rec.709
   primaries (matrix computed from the primaries, D65) → a gentle highlight
   shoulder above 0.6 → Rec.709 OETF. Middle gray (18 %) lands at 0.41,
   exactly where Rec.709 puts it. */
const PRO_LUT_N=33;
function _lutXYZ(p){   // RGB→XYZ for primaries p=[[x,y]×3], white D65
  const P=[0,1,2].map(r=>p.map(([x,y])=>[x/y,1,(1-x-y)/y][r]));
  const W=[0.3127/0.3290,1,(1-0.3127-0.3290)/0.3290];
  const S=_lutSolve(P,W);return P.map(row=>row.map((v,j)=>v*S[j]));
}
function _lutSolve(A,b){const M=A.map((r,i)=>[...r,b[i]]),n=3;
  for(let i=0;i<n;i++){let p=i;for(let r=i+1;r<n;r++)if(Math.abs(M[r][i])>Math.abs(M[p][i]))p=r;[M[i],M[p]]=[M[p],M[i]];
    for(let r=0;r<n;r++)if(r!==i){const f=M[r][i]/M[i][i];for(let c=i;c<=n;c++)M[r][c]-=f*M[i][c];}}
  return M.map((r,i)=>r[n]/r[i]);}
function _lutInv3(m){const [a,b,c]=m[0],[d,e,f]=m[1],[g,h,i]=m[2],D=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  return [[(e*i-f*h)/D,(c*h-b*i)/D,(b*f-c*e)/D],[(f*g-d*i)/D,(a*i-c*g)/D,(c*d-a*f)/D],[(d*h-e*g)/D,(b*g-a*h)/D,(a*e-b*d)/D]];}
function _lutMul(A,B){return A.map(r=>[0,1,2].map(j=>r[0]*B[0][j]+r[1]*B[1][j]+r[2]*B[2][j]));}
const PRO_PRIM={rec709:[[0.64,0.33],[0.30,0.60],[0.15,0.06]],sgamut3cine:[[0.766,0.275],[0.225,0.800],[0.089,-0.087]],
  vgamut:[[0.730,0.280],[0.165,0.840],[0.100,-0.030]],awg3:[[0.6840,0.3130],[0.2210,0.8480],[0.0861,-0.1020]],rec2020:[[0.708,0.292],[0.170,0.797],[0.131,0.046]]};
function proGamutTo709(g){return _lutMul(_lutInv3(_lutXYZ(PRO_PRIM.rec709)),_lutXYZ(PRO_PRIM[g]));}
// published log curves: code value (0..1) → scene-linear reflectance (0.18 = middle gray)
const PRO_LOGS={
  slog3:x=>x>=171.2102946929/1023?Math.pow(10,(x*1023-420)/261.5)*0.19-0.01:(x*1023-95)*0.01125/(171.2102946929-95),
  vlog:x=>x<0.181?(x-0.125)/5.6:Math.pow(10,(x-0.598206)/0.241514)-0.00873,
  logc3:x=>x>5.367655*0.010591+0.092809?(Math.pow(10,(x-0.385537)/0.247190)-0.052272)/5.555556:(x-0.092809)/5.367655,
  applelog:x=>{const R0=-0.05641088,Rt=0.01,c=47.28711236,b=0.00964052,g=0.08550479,d=0.69336945,Pt=c*(Rt-R0)*(Rt-R0);
    return x>=Pt?Math.pow(2,(x-d)/g)-b:x>=0?Math.sqrt(x/c)+R0:R0;},
};
function _lut709(L){return L<0.018?4.5*L:1.099*Math.pow(L,0.45)-0.099;}
function _lutShoulder(x){return x<=0.6?x:0.6+0.4*(1-Math.exp(-(x-0.6)/0.4));}
function _lutCam(log,gamut){const M=proGamutTo709(gamut),f=PRO_LOGS[log];
  return (r,g,b)=>{const l=[f(r),f(g),f(b)];
    return M.map(row=>_lut709(_lutShoulder(Math.max(0,row[0]*l[0]+row[1]*l[1]+row[2]*l[2]))));};}
// creative looks (display-referred, 0..1 in → 0..1 out)
const _cl=v=>Math.min(1,Math.max(0,v)),_lum=(r,g,b)=>0.2126*r+0.7152*g+0.0722*b,_sc=(x,k)=>{const s=1/(1+Math.exp(-k*(x-0.5))),a=1/(1+Math.exp(k/2));return (s-a)/(1-2*a);};
const _sat=(r,g,b,s)=>{const y=_lum(r,g,b);return [y+(r-y)*s,y+(g-y)*s,y+(b-y)*s];};
const PRO_LOOKS={
  tealorange:(r,g,b)=>{const y=_lum(r,g,b);let [R,G,B]=[r,g,b];const w=_cl((y-0.35)*2.2);   // shadows toward teal, skin/highlights toward orange
    R+=0.06*w-0.05*(1-w);G+=0.01*w+0.02*(1-w);B+=-0.07*w+0.07*(1-w);[R,G,B]=_sat(R,G,B,1.12);return [R,G,B].map(v=>_cl(_sc(_cl(v),5.2)));},
  warmfilm:(r,g,b)=>{let [R,G,B]=_sat(r,g,b,0.9);R=R*1.04+0.02;G=G*1.0+0.01;B=B*0.9+0.03;return [R,G,B].map(v=>_cl(0.04+0.93*_sc(_cl(v),4.2)));},
  coolnight:(r,g,b)=>{let [R,G,B]=_sat(r,g,b,0.75);return [_cl(R*0.82),_cl(G*0.9+0.01),_cl(B*1.02+0.05)].map(v=>_cl(Math.pow(v,1.15)));},
  bleach:(r,g,b)=>{const y=_lum(r,g,b),[R,G,B]=_sat(r,g,b,0.45),o=v=>{const m=y<0.5?2*v*y:1-2*(1-v)*(1-y);return _cl(v*0.4+m*0.6);};return [o(R),o(G),o(B)].map(v=>_cl(_sc(v,5.5)));},
  faded:(r,g,b)=>{const [R,G,B]=_sat(r,g,b,0.8);return [R,G,B].map(v=>_cl(0.1+0.82*v));},
  vivid:(r,g,b)=>{const [R,G,B]=_sat(r,g,b,1.35);return [R,G,B].map(v=>_cl(_sc(_cl(v),4.6)));},
  mono:(r,g,b)=>{const y=_cl(_sc(0.25*r+0.65*g+0.10*b,5));return [y,y,y];},
  sepia:(r,g,b)=>{const y=_sc(_lum(r,g,b),4.4);return [_cl(y*1.07+0.03),_cl(y*0.92+0.02),_cl(y*0.72+0.01)];},
};
const PRO_LUT_LIB=[
  {id:'slog3',group:'cam',name:'Sony S-Log3 (S-Gamut3.Cine) → Rec.709',fn:()=>_lutCam('slog3','sgamut3cine')},
  {id:'vlog',group:'cam',name:'Panasonic V-Log (V-Gamut) → Rec.709',fn:()=>_lutCam('vlog','vgamut')},
  {id:'logc3',group:'cam',name:'ARRI LogC3 EI 800 (AWG3) → Rec.709',fn:()=>_lutCam('logc3','awg3')},
  {id:'applelog',group:'cam',name:'Apple Log (iPhone) → Rec.709',fn:()=>_lutCam('applelog','rec2020')},
  {id:'tealorange',group:'look',name:'Teal & orange',fn:()=>PRO_LOOKS.tealorange},
  {id:'warmfilm',group:'look',name:'Warm film',fn:()=>PRO_LOOKS.warmfilm},
  {id:'coolnight',group:'look',name:'Cool night',fn:()=>PRO_LOOKS.coolnight},
  {id:'bleach',group:'look',name:'Bleach bypass',fn:()=>PRO_LOOKS.bleach},
  {id:'faded',group:'look',name:'Faded matte',fn:()=>PRO_LOOKS.faded},
  {id:'vivid',group:'look',name:'Vivid',fn:()=>PRO_LOOKS.vivid},
  {id:'mono',group:'look',name:'Black & white',fn:()=>PRO_LOOKS.mono},
  {id:'sepia',group:'look',name:'Sepia',fn:()=>PRO_LOOKS.sepia},
];
function proBuiltinLut(id){
  const B=PRO_LUT_LIB.find(x=>x.id===id);if(!B)return null;
  const f=B.fn(),N=PRO_LUT_N,d=new Float32Array(N*N*N*3);
  for(let b=0;b<N;b++)for(let g=0;g<N;g++)for(let r=0;r<N;r++){const o=f(r/(N-1),g/(N-1),b/(N-1)),k=((b*N+g)*N+r)*3;d[k]=_cl(o[0]);d[k+1]=_cl(o[1]);d[k+2]=_cl(o[2]);}
  return {name:B.name,size:N,dmin:[0,0,0],dmax:[1,1,1],data:d,builtin:id};
}
// the state.luts id of a built-in (made on first use; one per project)
function proBuiltinLutId(id){const key='lutB_'+id;if(!state.luts[key]){const L=proBuiltinLut(id);if(!L)return null;state.luts[key]=L;}return key;}
