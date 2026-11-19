#!/usr/bin/env node
// Teste de instalação: roda o ./install.sh --yes numa cópia do repositório, com uma pasta pessoal
// temporária, outra porta e o servidor do ai-memory como processo. A instalação real não é tocada.
//
//   node scripts/e2e.mjs                 instala a versão atual (os arquivos como estão agora)
//   node scripts/e2e.mjs --from main     instala <ref> primeiro e depois atualiza para a versão atual
//   node scripts/e2e.mjs --keep          mantém a pasta temporária para olhar depois
//
// Confere: a instalação termina sem erro e com o painel, a conferência --deep passa (chamada MCP real e
// o Claude Code conectando os servidores), um hook do Claude Code grava na memória, e rodar de novo
// não muda nenhum arquivo.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, log, which } from './lib.mjs';

const { values } = parseArgs({ options: { from: { type: 'string' }, keep: { type: 'boolean' } } });
const AGENTS = 'claude,cursor,codex,openclaw';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-e2e-')));
const home = path.join(tmp, 'home');
const repo = path.join(tmp, 'projetos', 'glossary');
const data = path.join(home, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : ['.local', 'share']), 'ai-memory');
// Pastas de config de agentes sem o programa (openclaw): a instalação tem de pular, não quebrar.
for (const d of ['.claude', '.cursor', '.codex', '.openclaw', 'bin']) fs.mkdirSync(path.join(home, d), { recursive: true });

// PATH só com o que a instalação usa, sem os agentes desta máquina. O claude entra porque o registro
// do Serena e a conferência --deep passam pela CLI dele; com HOME temporário ele grava só ali.
const shim = path.join(tmp, 'bin');
fs.mkdirSync(shim);
for (const [name, bin] of [['node', process.execPath], ['uv', which('uv')], ['claude', which('claude')]])
  if (bin) fs.symlinkSync(bin, path.join(shim, name));
const uvCache = which('uv') && run('uv', ['cache', 'dir'], { env: process.env }).stdout.trim();
const env = {
  HOME: home,
  USER: os.userInfo().username,
  LANG: process.env.LANG || 'C.UTF-8',
  TMPDIR: os.tmpdir(),
  PATH: [shim, path.join(home, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  GLOSSARY_AI_MEMORY_BIND: `127.0.0.1:${await freePort()}`,
  GLOSSARY_AI_MEMORY_SERVICE: 'process',
  ...(uvCache && { UV_CACHE_DIR: uvCache }),
};

let failed = 0;
const pass = (s) => log.ok(s);
const fail = (s) => (failed++, log.err(s));

try {
  // Uma base sem o modo de teste usaria a porta e o serviço reais desta máquina: nesse caso pula.
  const isolated = values.from && run('git', ['-C', REPO, 'grep', '-q', 'GLOSSARY_AI_MEMORY_SERVICE', values.from, '--', 'ai-memory/setup.mjs']).code === 0;
  if (values.from && !isolated) log.warn(`${values.from} ainda não tem o modo de teste do ai-memory; pulei a instalação da base`);
  if (isolated) {
    log.step(`Instalar ${values.from} (antes da atualização)`);
    copyRepo(values.from);
    install('instalação da base', { base: true });
  }
  log.step(values.from ? 'Atualizar para a versão atual' : 'Instalar a versão atual');
  copyRepo(null);
  const first = install('instalação');
  if (failed) throw new Error('a instalação falhou');
  first.includes('Painel da memória') ? pass('o fim da instalação mostra o painel da memória') : fail('o fim da instalação não mostra o painel da memória');

  log.step('Hook do Claude Code grava na memória');
  await hookCaptures();

  log.step('Rodar de novo não muda nada');
  const before = snapshot(home);
  install('segunda instalação');
  const after = snapshot(home);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((f) => before.get(f) !== after.get(f));
  if (changed.length) fail(`a segunda instalação mudou ${changed.length} arquivo(s): ${changed.slice(0, 10).join(', ')}`);
  else pass(`nenhum arquivo mudou (${after.size} conferidos)`);
} catch (e) {
  fail(e.message);
} finally {
  const pidFile = path.join(data, 'serve.pid');
  if (fs.existsSync(pidFile)) {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
    } catch {}
  }
  log.step('Resultado');
  if (failed) log.err(`${failed} falha(s). Pasta mantida: ${tmp}`);
  else log.ok('instalação, conferência, captura e repetição sem erro');
  if (!failed && !values.keep) fs.rmSync(tmp, { recursive: true, force: true });
  else if (!failed) log.info(`pasta mantida: ${tmp}`);
}
process.exit(failed ? 1 : 0);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20 * 60 * 1000, ...opts });
  return { code: r.error ? 127 : r.status, stdout: (r.stdout || '') + (r.stderr || '') };
}

// Põe em `repo` a versão pedida (ref do git ou, com null, os arquivos de agora), como um git pull faria.
function copyRepo(ref) {
  fs.mkdirSync(repo, { recursive: true });
  for (const f of fs.readdirSync(repo)) if (f !== '.git') fs.rmSync(path.join(repo, f), { recursive: true, force: true });
  if (ref) {
    const archive = spawnSync('git', ['-C', REPO, 'archive', '--format=tar', ref], { maxBuffer: 1 << 30 });
    const r = spawnSync('tar', ['-x', '-C', repo], { input: archive.stdout });
    if (archive.status !== 0 || r.status !== 0) throw new Error(`não consegui extrair ${ref}`);
  } else {
    const files = run('git', ['-C', REPO, 'ls-files', '-co', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
    for (const f of files) {
      const src = path.join(REPO, f);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      fs.cpSync(src, path.join(repo, f), { verbatimSymlinks: true });
    }
  }
  const git = (...a) => run('git', ['-C', repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', ...a], { env });
  if (!fs.existsSync(path.join(repo, '.git'))) git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', ref || 'atual', '--allow-empty', '--no-verify');
}

// Falha na base não reprova o teste (já vinha de antes); o que vale é a atualização em cima dela.
function install(label, { base = false } = {}) {
  const r = run('bash', ['install.sh', '--yes', '--agents', AGENTS], { cwd: repo, env });
  if (r.code === 0) pass(`${label}: terminou sem erro`);
  else if (base) log.warn(`${label}: saiu com código ${r.code} (falha que já vinha da base; segue para a atualização)`);
  else {
    fail(`${label}: saiu com código ${r.code}`);
    console.log(r.stdout.split('\n').slice(-60).join('\n'));
  }
  return r.stdout;
}

async function hookCaptures() {
  const bin = path.join(home, ...(process.platform === 'darwin' ? ['Applications'] : ['.local', 'opt']), 'ai-memory', 'ai-memory');
  const count = () => Number(/observations:\s*(\d+)/.exec(run(bin, ['status'], { env }).stdout)?.[1] ?? NaN);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const hook = (event) => settings.hooks?.[event]?.flatMap((m) => m.hooks).find((h) => h.command.includes('ai-memory'))?.command;
  if (!hook('SessionStart') || !hook('UserPromptSubmit')) return fail('o ~/.claude/settings.json não tem os hooks SessionStart e UserPromptSubmit do ai-memory');
  const before = count();
  // Como numa sessão de verdade: SessionStart e depois o prompt.
  const session_id = `e2e-${Date.now()}`;
  let output = '';
  for (const [event, extra] of [['SessionStart', { source: 'startup' }], ['UserPromptSubmit', { prompt: 'teste de instalação' }]]) {
    const r = spawnSync('sh', ['-c', hook(event)], { input: JSON.stringify({ session_id, cwd: repo, hook_event_name: event, ...extra }), env, encoding: 'utf8', timeout: 30000 });
    output += `${event}: ${r.status} ${(r.stderr || '').trim().slice(0, 100)} `;
  }
  for (let i = 0; i < 60 && !(count() > before); i++) await new Promise((res) => setTimeout(res, 500));
  const now = count();
  if (now > before) pass(`o hook gravou na memória (observações: ${before} -> ${now})`);
  else fail(`o hook não gravou (observações: ${before} -> ${now}; ${output})`);
}

// Arquivos da pasta pessoal com o hash de cada um, fora o que muda sozinho (dados, logs, caches).
function snapshot(dir) {
  const skip = [data, path.join(home, 'Library', 'Logs'), path.join(home, 'Library', 'Caches'), path.join(home, '.cache'), path.join(home, '.local', 'share', 'uv'), path.join(home, '.serena', 'logs')];
  const out = new Map();
  const walk = (d) => {
    if (skip.includes(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) out.set(path.relative(home, p), `-> ${fs.readlinkSync(p)}`);
      else if (e.isFile()) out.set(path.relative(home, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
