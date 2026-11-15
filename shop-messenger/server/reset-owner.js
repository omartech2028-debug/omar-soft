// استعادة كلمة سر صاحب المحل. تُشغَّل على الحاسوب الرئيسي فقط:
//   node server/reset-owner.js            (يسأل عن كلمة السر الجديدة)
//   node server/reset-owner.js <كلمة السر الجديدة>
const path = require('node:path');
const readline = require('node:readline');
const { openDb } = require('./db');
const { createAuth } = require('./auth');

async function main() {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const auth = createAuth(openDb(dataDir));
  const names = auth.adminNames();
  if (!names.length) {
    console.error('لا يوجد حساب لصاحب المحل بعد. شغّل المركز وافتحه لإنشائه.');
    process.exit(1);
  }
  const name = names[0];
  let secret = process.argv[2];
  if (!secret) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    secret = await new Promise(r => rl.question(`Owner / صاحب المحل: ${name}\nNew password (8+) / كلمة السر الجديدة: `, a => { rl.close(); r(a.trim()); }));
  }
  try {
    auth.recoverAdmin(name, secret);
  } catch (e) {
    console.error(e.message === 'bad_pin' ? 'Too short: 8 characters or more. / كلمة السر قصيرة: 8 أحرف على الأقل.' : String(e.message));
    process.exit(1);
  }
  console.log(`Done. تم تغيير كلمة سر «${name}». ادخل الآن بالكلمة الجديدة.`);
}

main();
