// Usage: npm run hash-password
// Reads a password from a hidden prompt (nothing is echoed or saved) and prints its bcrypt
// hash for OWNER_PASSWORD_HASH. The hash is safe to store; the password is not.
import bcrypt from 'bcryptjs';

const COST = 12;

function ask(label) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      fn(arg);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(resolve, value);
        if (ch === '\u0003') return done(reject, new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

if (!process.stdin.isTTY) {
  console.error('Run this in a terminal: it needs a hidden password prompt.');
  process.exit(1);
}

try {
  const password = await ask('New owner password: ');
  if (password.length < 10) throw new Error('Use at least 10 characters.');
  if (password !== (await ask('Type it again: '))) throw new Error('The two entries differ.');
  const hash = bcrypt.hashSync(password, COST);
  console.log('\nOWNER_PASSWORD_HASH (keep the single quotes in .env: the hash contains $):\n');
  console.log(`'${hash}'\n`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
