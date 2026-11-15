// Run one practice trial locally, without Docker: the kit's own env, the entry, the kit's own scorer.
//
//   node tools/run-trial.mjs --kit <kit dir> --trial <practice/trial-N> [--runs <dir>] [--timeout 180]
//                            [--bot <dir>] [--label <name>] [--repeat 2]
//
// Each run gets its own directory holding the env's logs, the entry's logs, the state export and the
// score. With --repeat 2 the trial runs twice and the two exports are compared byte for byte, which is
// the replay check the final phase applies.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

const KIT = resolve(arg('kit', ''));
const TRIAL = resolve(arg('trial', ''));
const RUNS = resolve(arg('runs', join(REPO, '.runs')));
const BOT = resolve(arg('bot', REPO));
const LABEL = arg('label', '');
const SEED = arg('seed', 'practice');
const TIMEOUT_MS = Number(arg('timeout', '180')) * 1000;
const REPEAT = Number(arg('repeat', '1'));

if (arg('kit', '') === '' || arg('trial', '') === '') {
  process.stderr.write('usage: node tools/run-trial.mjs --kit <kit dir> --trial <practice/trial-N> [--repeat 2]\n');
  process.exit(2);
}

const ENV_SERVER = join(KIT, 'program/env/server.mjs');
const SCORER = join(KIT, 'program/scorer/score.mjs');
const PROMPT = join(TRIAL, 'input/prompt.txt');
const ENV_DATA = join(TRIAL, 'input/env');
const REFERENCE = join(TRIAL, 'reference');

for (const [what, path] of [
  ['the env', ENV_SERVER],
  ['the scorer', SCORER],
  ['the brief', PROMPT],
  ['the trial env data', ENV_DATA],
  ['the reference', REFERENCE],
]) {
  if (!existsSync(path)) {
    process.stderr.write(`run-trial: ${what} is missing at ${path}\n`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(check, ms, every = 50) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    const value = check();
    if (value !== undefined && value !== null && value !== false) return value;
    await sleep(every);
  }
  return null;
}

/** One child's output, streamed to a file so a hung run can be read afterwards. */
function capture(child, path) {
  const stream = [];
  const write = (chunk) => {
    stream.push(chunk);
    writeFileSync(path, stream.join('').slice(-400_000));
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  return { text: () => stream.join('') };
}

function exited(child, ms) {
  return new Promise((done) => {
    const timer = setTimeout(() => done({ timedOut: true, code: null, signal: null, ms }), ms);
    const started = Date.now();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ timedOut: false, code, signal, ms: Date.now() - started });
    });
  });
}

/** Run the trial once: env up, entry in, export written, scorer run. */
async function once(runDir) {
  rmSync(runDir, { recursive: true, force: true });
  const state = join(runDir, 'state');
  mkdirSync(state, { recursive: true });

  const envChild = spawn(process.execPath, [join(HERE, 'env-main.mjs')], {
    env: {
      ...process.env,
      MAKEFUN_ENV_SERVER: ENV_SERVER,
      MAKEFUN_ENV_DATA_DIR: ENV_DATA,
      MAKEFUN_STATE_DIR: state,
      MAKEFUN_ENV_HOST: '127.0.0.1',
      MAKEFUN_ENV_PORT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const envLog = capture(envChild, join(runDir, 'env.log'));

  const readyPath = join(state, 'ready');
  const ready = await until(() => {
    if (!existsSync(readyPath)) return null;
    try {
      return JSON.parse(readFileSync(readyPath, 'utf8'));
    } catch {
      return null;
    }
  }, 30_000);
  if (ready === null) {
    envChild.kill();
    throw new Error(`the env never became ready; its log:\n${envLog.text().slice(-2000)}`);
  }
  const envUrl = `http://${ready.host}:${ready.port}`;

  const bot = spawn(process.execPath, ['main.ts'], {
    cwd: BOT,
    env: {
      ...process.env,
      MAKEFUN_ENV_URL: envUrl,
      MAKEFUN_PROMPT_FILE: PROMPT,
      MAKEFUN_TRIAL_SEED: SEED,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const botLog = capture(bot, join(runDir, 'bot.log'));

  const botExit = await exited(bot, TIMEOUT_MS);
  if (botExit.timedOut) bot.kill();

  const exportPath = join(state, 'export', 'state.json');
  const exported = await (async () => {
    envChild.stdin.write('export\n');
    return until(() => existsSync(exportPath), 20_000);
  })();
  envChild.kill();

  const result = {
    trial: TRIAL,
    env_url: envUrl,
    bot_exit: botExit,
    exported: exported !== null,
    score: null,
    scores: null,
    error: null,
  };

  if (exported === null) {
    result.error = `no export was written; the env's log:\n${envLog.text().slice(-2000)}`;
    writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  const scorer = spawn(process.execPath, [SCORER], {
    env: {
      ...process.env,
      MAKEFUN_OUTPUT_DIR: join(state, 'export'),
      MAKEFUN_REFERENCE_DIR: REFERENCE,
      MAKEFUN_SCORES_DIR: join(runDir, 'scores'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const scorerLog = capture(scorer, join(runDir, 'scorer.log'));
  const scorerExit = await exited(scorer, 60_000);
  const scoresPath = join(runDir, 'scores', 'scores.json');
  if (existsSync(scoresPath)) {
    try {
      result.scores = JSON.parse(readFileSync(scoresPath, 'utf8'));
      result.score = result.scores.score;
    } catch {
      result.error = 'the scorer wrote an unreadable scores.json';
    }
  } else {
    result.error = `the scorer wrote no score (exit ${scorerExit.code}); its log:\n${scorerLog.text().slice(-2000)}`;
  }
  writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const results = [];
for (let pass = 1; pass <= REPEAT; pass++) {
  const name = `${TRIAL.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}${LABEL === '' ? '' : `-${LABEL}`}-run${pass}`;
  const runDir = join(RUNS, name);
  process.stdout.write(`run-trial: ${name} (${pass}/${REPEAT})\n`);
  const result = await once(runDir);
  results.push({ runDir, result });
  const line =
    result.score === null
      ? `  score: none (${result.error?.split('\n')[0] ?? 'unknown'})`
      : `  score ${result.score}: quality ${result.scores.quality}, served ${result.scores.served}, wire ${result.scores.wire}, failover ${result.scores.failover}, catalog ${result.scores.catalog}, calls ${result.scores.upstream_calls}, working ${result.scores.working}`;
  process.stdout.write(`${line}\n  entry exit: ${result.bot_exit.code}${result.bot_exit.timedOut ? ' (timed out)' : ''} after ${result.bot_exit.ms} ms\n  dir: ${runDir}\n`);
}

if (REPEAT > 1) {
  const exports = results.map(({ runDir }) => join(runDir, 'state', 'export', 'state.json'));
  const allThere = exports.every((path) => existsSync(path));
  if (!allThere) {
    process.stdout.write('replay: at least one run wrote no export, nothing to compare\n');
  } else {
    const first = readFileSync(exports[0]);
    const same = exports.every((path) => readFileSync(path).equals(first));
    process.stdout.write(`replay: the ${exports.length} exports are ${same ? 'byte-identical' : 'DIFFERENT'}\n`);
    if (!same) process.exitCode = 1;
  }
}

const worst = results.reduce((min, { result }) => (result.score === null ? -1 : Math.min(min, result.score)), 101);
process.stdout.write(`run-trial: worst score ${worst}\n`);
if (worst < 0) process.exitCode = 1;
