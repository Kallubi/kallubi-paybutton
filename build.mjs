// Build: src/button.js + vendored QR lib -> dist/button.js (readable) + dist/button.min.js
// v1.3.0: also dist/v/<version>/button.min.js + button.js (immutable, versioned copies) and dist/SRI.json (sha384).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
let qr = readFileSync('vendor/qrcode-generator-1.4.4.js', 'utf8');
const umd = qr.indexOf('(function (factory) {');
if (umd < 0) throw new Error('UMD footer not found');
qr = qr.slice(0, umd);                       // drop the UMD export, keep `var qrcode = function(){...}();`
const src = readFileSync('src/button.js', 'utf8');
if (!src.includes('/*__QRCODE__*/')) throw new Error('placeholder missing');
const m = /var VERSION = '(\d+\.\d+\.\d+)';/.exec(src);
if (!m) throw new Error('VERSION not found');
const version = m[1];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== version) throw new Error(`package.json version ${pkg.version} != src VERSION ${version}`);
const out = src.replace('/*__QRCODE__*/', () => qr);   // function replacer: the lib contains $ sequences
writeFileSync('dist/button.js', out);
const terser = process.env.TERSER || 'node_modules/terser/bin/terser';
if (!existsSync(terser)) throw new Error('terser not found: run "npm ci" (devDependency terser 5.51.2, see package-lock.json) or set TERSER=/path/to/terser/bin/terser');
execFileSync(process.execPath, [terser, 'dist/button.js', '-c', 'passes=2', '-m', '--comments', '/^!/', '-o', 'dist/button.min.js'], { stdio: 'inherit' });
const min = readFileSync('dist/button.min.js');
const sri = (b) => 'sha384-' + createHash('sha384').update(b).digest('base64');
const dir = `dist/v/${version}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/button.min.js`, min);
writeFileSync(`${dir}/button.js`, out);
const info = { version, 'button.min.js': sri(min), 'button.js': sri(Buffer.from(out)),
  url: `https://pay.kallubi-bsv-explorer.de/v/${version}/button.min.js` };
writeFileSync('dist/SRI.json', JSON.stringify(info, null, 2) + '\n');
console.log('dist/button.js', out.length, 'bytes; dist/button.min.js', min.length, 'bytes');
console.log('SRI', info['button.min.js'], '->', info.url);
