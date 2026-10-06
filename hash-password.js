// Makes a hashed admin password for hosting.
//   node hash-password.js
// Type the password when asked (it is not shown). Copy the printed line into the
// ADMIN_PASSWORD_HASH setting of your host. The password itself is never stored.
const crypto = require('crypto');

function ask(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    if (!stdin.isTTY) { // piped input, e.g. echo pw | node hash-password.js
      let data = ''; stdin.on('data', c => data += c); stdin.on('end', () => resolve(data.replace(/[\r\n]+$/, ''))); return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = ch => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); return resolve(value); }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }                // Ctrl+C
        if (c === '\u007f' || c === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } }   // backspace
        else { value += c; process.stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pw = await ask('New admin password: ');
  if (pw.length < 10) { console.error('Use at least 10 characters. A long random password is best.'); process.exit(1); }
  const again = process.stdin.isTTY ? await ask('Type it again:       ') : pw;
  if (pw !== again) { console.error('The two passwords do not match.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
    if (err) throw err;
    console.log('\nPut this in the ADMIN_PASSWORD_HASH setting of your host:\n');
    console.log(`scrypt$${salt.toString('hex')}$${key.toString('hex')}\n`);
  });
})();
