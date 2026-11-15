// Run the kit's env in this process, so its own SIGTERM handler can be invoked on Windows.
//
// The env writes its state export from a SIGTERM handler. A child process cannot be signalled that way
// here: on Windows `process.kill` and `child.kill` go through TerminateProcess, which ends the process
// without running any handler, so the export would never be written. This wrapper imports the env (which
// registers its handler at startup) and, on one line of stdin, calls that same handler directly. Nothing
// is reimplemented: the export is the env's own code path.

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const server = process.env.MAKEFUN_ENV_SERVER;
if (server === undefined || server === '') {
  process.stderr.write('env-main: MAKEFUN_ENV_SERVER is not set\n');
  process.exit(2);
}

// A Windows path is not an import specifier: the default loader takes file: URLs only.
await import(pathToFileURL(server).href);

/** Ask the env to export, the way its SIGTERM handler would. */
function exportNow() {
  const handlers = process.listeners('SIGTERM');
  if (handlers.length === 0) {
    process.stderr.write('env-main: the env registered no SIGTERM handler\n');
    process.exit(1);
  }
  for (const handler of handlers) handler('SIGTERM');
}

process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  if (!pending.includes('export')) return;
  pending = '';
  exportNow();
});
process.stdin.resume();
