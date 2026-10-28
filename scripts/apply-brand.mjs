#!/usr/bin/env node
// Re-skin the instructor app for another brand at deploy time.
//
// One codebase, one Netlify site per brand. Pacific Discovery deploys `public/`
// exactly as committed; the Unearthed site sets BRAND=ue and this script lays
// brands/ue/ over `public/` before Netlify publishes it:
//
//   copy        brand assets (logo, icons, fonts, manifest) over the PD ones
//   appendCss   the brand's token/type layer onto the end of app.css
//   replace     the handful of brand strings in index.html, app.js and sw.js
//
// Every replacement declares how many times it must match. If app.js or
// index.html changes so a string no longer matches, the BUILD FAILS rather than
// shipping Unearthed leaders a screen that says Pacific Discovery. Fix the
// string in brands/<brand>/brand.json and redeploy.
//
// With BRAND unset (the PD site) this exits 0 and touches nothing.
//
// It rewrites files in place, which is fine in a Netlify build checkout but
// would leave a branded working tree locally — so outside Netlify it refuses
// unless you pass --force (and then don't commit the result):
//
//   BRAND=ue node scripts/apply-brand.mjs --force && npm run dev

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = String(process.env.BRAND || '').trim().toLowerCase();

if (!brand || brand === 'pd') {
  console.log('apply-brand: BRAND not set — publishing public/ unchanged (Pacific Discovery).');
  process.exit(0);
}
if (!/^[a-z0-9-]+$/.test(brand)) fail(`BRAND "${brand}" is not a valid brand folder name.`);
if (process.env.NETLIFY !== 'true' && !process.argv.includes('--force')) {
  fail('refusing to rewrite public/ outside a Netlify build. Re-run with --force for local testing, and do not commit the result.');
}

const dir = path.join(root, 'brands', brand);
const cfgPath = path.join(dir, 'brand.json');
if (!fs.existsSync(cfgPath)) fail(`no brands/${brand}/brand.json`);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const inRoot = (rel) => {
  const p = path.resolve(root, rel);
  if (!p.startsWith(root + path.sep)) fail(`${rel} points outside the repo`);
  return p;
};

// Check every replacement before writing anything, so a failed build never
// leaves a half-branded tree behind.
const edits = new Map();
for (const [rel, rules] of Object.entries(cfg.replace || {})) {
  let text = fs.readFileSync(inRoot(rel), 'utf8');
  for (const r of rules) {
    const pattern = r.regex ? new RegExp(r.regex, 'g') : null;
    const n = pattern ? (text.match(pattern) || []).length : text.split(r.find).length - 1;
    if (n !== r.count) {
      fail(`${rel}: expected ${r.count} match(es) of ${JSON.stringify(r.regex || r.find)}, found ${n}. ` +
           `The shared file changed — update brands/${brand}/brand.json.`);
    }
    text = pattern ? text.replace(pattern, r.with) : text.split(r.find).join(r.with);
  }
  edits.set(rel, text);
}

for (const [from, to] of Object.entries(cfg.copy || {})) {
  const src = path.join(dir, from);
  if (!fs.existsSync(src)) fail(`brands/${brand}/${from} is missing`);
  const dest = inRoot(to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
for (const [rel, text] of edits) fs.writeFileSync(inRoot(rel), text);
for (const [from, to] of Object.entries(cfg.appendCss || {})) {
  fs.appendFileSync(inRoot(to), '\n' + fs.readFileSync(path.join(dir, from), 'utf8'));
}

console.log(`apply-brand: applied ${cfg.name || brand} — ` +
  `${Object.keys(cfg.copy || {}).length} files copied, ${edits.size} files edited.`);

function fail(msg) {
  console.error(`apply-brand: ${msg}`);
  process.exit(1);
}
