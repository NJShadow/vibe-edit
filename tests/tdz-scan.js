#!/usr/bin/env node
/* tdz-scan.js — temporal-dead-zone detector.
 *
 * WHY THIS EXISTS: this exact bug class shipped FOUR times, each time silently.
 * A `const`/`let` read above its own declaration throws a ReferenceError, and in
 * this codebase those reads sat inside try/catch blocks that swallowed the
 * error — so an entire probe block, or an entire IPC handler, simply stopped
 * working with no message anywhere. Symptoms were things like "nothing gets
 * proxied", "the audio note never appears", "imports fail on every file".
 *
 * THE RULE: such a read only throws when it EXECUTES before the declaration —
 * i.e. the use is in the same immediate execution context, with no function
 * boundary in between. A read inside a function that runs later is legal and
 * extremely common, which is why a naive regex produced 105 false positives.
 *
 * Usage:  node tests/tdz-scan.js
 * Exits non-zero if anything is found. Run it before every ship.
 */
const acorn = require('acorn');
const fs = require('fs');
const path = require('path');

function extractRendererJs(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const blocks = [...html.matchAll(/<script>\n([\s\S]*?)\n<\/script>/g)].map(m => m[1]);
  return blocks.join('\n');
}

function scan(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true });
  const findings = [];

  // const/let declared directly in THIS block (not nested ones)
  function blockDecls(node) {
    const m = new Map();
    const body = Array.isArray(node.body) ? node.body : [];
    for (const st of body) {
      if (st && st.type === 'VariableDeclaration' && st.kind !== 'var') {
        for (const d of st.declarations) {
          if (d.id.type === 'Identifier' && !m.has(d.id.name)) m.set(d.id.name, d.id.start);
        }
      }
    }
    return m;
  }

  function visit(node, chain, fnDepth, parentKey) {
    if (!node || typeof node.type !== 'string') return;
    const isFn = /Function(Declaration|Expression)|ArrowFunctionExpression/.test(node.type);
    let chain2 = chain;
    const depth2 = isFn ? fnDepth + 1 : fnDepth;
    if (/Program|BlockStatement/.test(node.type)) {
      chain2 = chain.concat([{ decls: blockDecls(node), fnDepth: depth2 }]);
    }
    // skip property keys and non-computed member properties: `{foo: 1}` / `a.foo`
    if (node.type === 'Identifier' && parentKey !== 'key' && parentKey !== 'property') {
      for (let i = chain2.length - 1; i >= 0; i--) {
        const sc = chain2[i];
        if (sc.decls.has(node.name)) {
          const declAt = sc.decls.get(node.name);
          if (node.start < declAt && sc.fnDepth === depth2) {
            findings.push({ name: node.name, line: node.loc.start.line });
          }
          break;
        }
      }
    }
    for (const k in node) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      const key = (node.type === 'Property' && k === 'key') ? 'key'
                : (node.type === 'MemberExpression' && k === 'property' && !node.computed) ? 'property'
                : k;
      if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && visit(c, chain2, depth2, key));
      else if (v && typeof v.type === 'string') visit(v, chain2, depth2, key);
    }
  }
  visit(ast, [], 0, null);

  const seen = new Set(), out = [];
  for (const f of findings) {
    const k = f.name + '@' + f.line;
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  }
  return out;
}

const root = path.resolve(__dirname, '..');
const targets = [
  { label: 'renderer (vibe-edit.html)', get: () => extractRendererJs(path.join(root, 'vibe-edit.html')) },
  { label: 'desktop/main.js',           get: () => fs.readFileSync(path.join(root, 'desktop/main.js'), 'utf8') },
  { label: 'desktop/preload.js',        get: () => fs.readFileSync(path.join(root, 'desktop/preload.js'), 'utf8') },
];

let bad = 0;
for (const t of targets) {
  let found;
  try { found = scan(t.get()); }
  catch (e) { console.log(t.label + ': could not scan — ' + e.message); continue; }
  console.log(t.label + ': ' + found.length + ' dead-zone read(s)');
  found.forEach(f => console.log('    line ' + f.line + '  ' + f.name));
  bad += found.length;
}
console.log(bad ? 'FAIL — fix these before shipping' : 'PASS — no dead-zone reads');
process.exit(bad ? 1 : 0);
