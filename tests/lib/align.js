/* align.js — score a transcript against ground truth.
 * Word-level Needleman–Wunsch on normalized tokens, then timing error on matches. */
const norm = w => String(w).toLowerCase().replace(/[^a-z0-9']/g, '');
function align(truth, hyp) {
  const A = truth.map(x => norm(x.w)), B = hyp.map(x => norm(x.w));
  const n = A.length, m = B.length, D = [];
  for (let i = 0; i <= n; i++) { D.push(new Array(m + 1).fill(0)); D[i][0] = i; }
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  const pairs = []; let i = n, j = m;
  while (i > 0 && j > 0) {
    if (D[i][j] === D[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)) { if (A[i - 1] === B[j - 1]) pairs.push([i - 1, j - 1]); i--; j--; }
    else if (D[i][j] === D[i - 1][j] + 1) i--; else j--;
  }
  pairs.reverse();
  const ds = pairs.map(([a, b]) => Math.abs(truth[a].s - hyp[b].s)), de = pairs.map(([a, b]) => Math.abs(truth[a].e - hyp[b].e));
  const med = v => { const s = [...v].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const p90 = v => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * .9)] : NaN; };
  return { wer: D[n][m] / Math.max(1, n), matched: pairs.length, truthWords: n, hypWords: m,
    startErrMed: med(ds), startErrP90: p90(ds), endErrMed: med(de), endErrP90: p90(de), pairs };
}
module.exports = { align, norm };
