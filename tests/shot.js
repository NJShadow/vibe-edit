// dev helper: screenshot the app with a small demo timeline. node shot.js out.png [theme] [file]
const { launch, close } = require('./browser');
const path = require('path');
(async () => {
  const out = process.argv[2] || '/tmp/shot.png', theme = process.argv[3] || 'obsidian';
  const file = process.argv[4] || path.resolve(__dirname, '..', 'vibe-edit.html');
  const b = await launch({ viewport: { width: 1600, height: 950 } });
  const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + file); await new Promise(r => setTimeout(r, 700));
  await p.evaluate(async (theme) => {
    document.getElementById('restoreBar')?.remove();
    if (typeof applyTheme === 'function') applyTheme(theme); else document.body.dataset.theme = theme;
    const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
    const g = cv.getContext('2d'); const gr = g.createLinearGradient(0, 0, 1920, 1080);
    gr.addColorStop(0, '#1e3c72'); gr.addColorStop(.5, '#b06ab3'); gr.addColorStop(1, '#f7b267');
    g.fillStyle = gr; g.fillRect(0, 0, 1920, 1080);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.arc(1300, 420, 180, 0, 7); g.fill();
    state.media = [{ id: 'm1', type: 'image', name: 'sunset-demo.png', duration: 5, w: 1920, h: 1080, el: cv, thumb: cv.toDataURL('image/jpeg', .5) }];
    const c1 = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, name: 'sunset-demo.png', mediaId: 'm1' });
    const c2 = makeClip({ type: 'text', track: TRACKS.find(t => t.kind === 'text').id, start: 1, duration: 3, name: 'Hello' });
    c2.text.content = 'Hello world';
    const au = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 6, name: 'voiceover.wav', mediaId: 'ma' });
    state.media.push({ id: 'ma', type: 'audio', name: 'voiceover.wav', duration: 6, peaks: (()=>{const N=360,pk=new Float32Array(N),rm=new Float32Array(N);for(let i=0;i<N;i++){const v=Math.abs(Math.sin(i/7))*(.4+.6*Math.abs(Math.sin(i/31)));pk[i]=v;rm[i]=v*.6;}return {peak:pk,rms:rm,dur:6};})() });
    state.clips = [c1, c2, au];
    renderBin && renderBin(); renderTimeline(); state.time = 2; state.selection = c1.id; state.inspTab='clip'; renderInspector(); drawFrame();
  }, theme);
  await new Promise(r => setTimeout(r, 500));
  await p.screenshot({ path: out });
  if (errs.length) console.log('pageerrors', errs);
  await close(b);
})();
