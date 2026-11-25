// Build: src/button.js + vendored QR lib -> dist/button.js (readable) + dist/button.min.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
let qr = readFileSync('vendor/qrcode-generator-1.4.4.js', 'utf8');
const umd = qr.indexOf('(function (factory) {');
if (umd < 0) throw new Error('UMD footer not found');
qr = qr.slice(0, umd);                       // drop the UMD export, keep `var qrcode = function(){...}();`
const src = readFileSync('src/button.js', 'utf8');
if (!src.includes('/*__QRCODE__*/')) throw new Error('placeholder missing');
const out = src.replace('/*__QRCODE__*/', () => qr);   // function replacer: the lib contains $ sequences
writeFileSync('dist/button.js', out);
const terser = process.env.TERSER || 'node_modules/terser/bin/terser';
if (!existsSync(terser)) throw new Error('terser not found: run "npm install" (devDependency terser 5.51.2) or set TERSER=/path/to/terser/bin/terser');
execFileSync(process.execPath, [terser, 'dist/button.js', '-c', 'passes=2', '-m', '--comments', '/^!/', '-o', 'dist/button.min.js'], { stdio: 'inherit' });
const min = readFileSync('dist/button.min.js', 'utf8');
console.log('dist/button.js', out.length, 'bytes; dist/button.min.js', min.length, 'bytes');
