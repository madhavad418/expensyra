import { readFileSync, existsSync } from 'node:fs';

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const checks = [
  ['approved JSAN logo asset exists', existsSync(new URL('../public/assets/jsan-logo.png', import.meta.url))],
  ['self-hosted brand font', existsSync(new URL('../public/assets/fonts/open-sans-var.woff2', import.meta.url)) && css.includes('font-family:"Open Sans"')],
  ['JSAN navy primary token', css.includes('--jsan-primary:#0050a9')],
  ['JSAN cyan accent token', css.includes('--jsan-accent:#00d4ff')],
  ['rounded-card design language', css.includes('--jsan-radius-lg:16px') && css.includes('--jsan-shadow-card')],
  ['editorial page header', css.includes('.page-eyebrow') && css.includes('.page-head h2')],
  ['six-stage process rail', css.includes('.process-rail') && js.includes('01</b><span>Sync') && js.includes('06</b><span>Report')],
  ['JSAN delivery language', js.includes('Mobilise · Collect · Operate · Process · Validate · Deliver')],
  ['responsive mobile navigation', css.includes('@media(max-width:920px)') && css.includes('.mobile-nav')],
  ['brand favicon wired', html.includes('/assets/jsan-logo.png')],
];
let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}`);
  if (!ok) failed = true;
}
if (failed) process.exit(1);
