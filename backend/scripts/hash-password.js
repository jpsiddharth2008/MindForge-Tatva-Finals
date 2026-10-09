// Prints a bcrypt hash for ADMIN_PASSWORD_HASH.   echo "my password" | npm run hash-password --silent
// Reading from stdin keeps the password out of your shell history.
const bcrypt = require('bcryptjs');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
    const password = input.replace(/\r?\n$/, '');
    if (password.length < 12) { console.error('Use a password of at least 12 characters.'); process.exit(1); }
    console.log(bcrypt.hashSync(password, 12));
});
