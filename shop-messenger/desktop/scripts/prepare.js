// خطوة ما قبل بناء المثبِّت: تجمع المركز (server + web) ومحرّك Node نفسه في مجلد واحد
// يُضمَّن داخل برنامج الحاسوب، فلا يحتاج الحاسوب الرئيسي تثبيت أي شيء آخر.
//   node scripts/prepare.js [مجلد الإخراج]
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'bundle'));

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
  console.error(`Node.js 22+ is required to build (found ${process.versions.node}).`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const dir of ['server', 'web']) fs.cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
fs.copyFileSync(process.execPath, path.join(out, process.platform === 'win32' ? 'node.exe' : 'node'));
fs.chmodSync(path.join(out, process.platform === 'win32' ? 'node.exe' : 'node'), 0o755);
console.log(`Bundled center into ${out} (Node ${process.versions.node}).`);
