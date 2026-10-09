const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'echo') {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks)));
} else if (mode === 'timeout') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1000);
  // A bounded backstop also prevents a broken timeout implementation from leaking a fixture. It must
  // outlast the longest timeout the tests give, or a broken kill would look like a clean exit.
  setTimeout(() => process.exit(0), 10000);
} else if (mode === 'overflow') {
  process.stdout.end(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
} else if (mode === 'exit') process.exit(7);
