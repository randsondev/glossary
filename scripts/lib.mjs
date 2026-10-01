// Funções compartilhadas pelos scripts do glossary. Sem dependências: só Node 20+.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();
export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'glossary');

// Verdadeiro quando o módulo foi chamado direto ("node arquivo.mjs"), não importado.
export function isMain(url) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

export const AGENTS = ['claude', 'cursor', 'hermes', 'openclaude'];

// ---------- saída ----------

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const log = {
  step: (s) => console.log(`\n${paint('1;36', '==>')} ${paint('1', s)}`),
  info: (s) => console.log(`    ${s}`),
  ok: (s) => console.log(`    ${paint('32', 'ok')} ${s}`),
  warn: (s) => console.log(`    ${paint('33', 'aviso')} ${s}`),
  err: (s) => console.error(`    ${paint('31', 'erro')} ${s}`),
  dry: (s) => console.log(`    ${paint('35', '[dry-run]')} ${s}`),
};

export function die(msg, code = 1) {
  log.err(msg);
  process.exit(code);
}

// ---------- caminhos e arquivos ----------

export function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

// Mostra um caminho com ~ no lugar da home (para logs e relatórios).
export function tilde(p) {
  return p === HOME || p.startsWith(HOME + path.sep) ? '~' + p.slice(HOME.length) : p;
}

export function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// Copia o arquivo para "<arquivo>.glossary-bak-AAAAMMDD-HHMMSS" e devolve o caminho do backup.
export function backupFile(file, { dryRun = false } = {}) {
  if (!fs.existsSync(file)) return null;
  const dest = `${file}.glossary-bak-${timestamp()}`;
  if (dryRun) {
    log.dry(`backup ${tilde(file)} -> ${tilde(dest)}`);
    return dest;
  }
  fs.copyFileSync(file, dest);
  fs.chmodSync(dest, fs.statSync(file).mode & 0o777);
  log.info(`backup: ${tilde(dest)}`);
  return dest;
}

// Lista recursiva de arquivos (caminhos relativos, ordenados, separador "/").
export function walkFiles(dir) {
  const out = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(r);
      else if (entry.isFile()) out.push(r);
    }
  };
  visit('');
  return out.sort();
}

// sha256 do conteúdo de uma pasta: caminho relativo + bytes de cada arquivo.
export function hashDir(dir) {
  const h = createHash('sha256');
  for (const rel of walkFiles(dir)) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true, preserveTimestamps: false, verbatimSymlinks: true });
}

// ---------- processos ----------

export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error && r.error.code !== 'ENOENT') throw r.error;
  return { code: r.error ? 127 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Executa mostrando a saída no terminal; em dry-run só imprime o comando.
export function runLive(cmd, args, { dryRun = false, cwd, env } = {}) {
  const shown = [cmd, ...args].map((a) => tilde(a)).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (dryRun) {
    log.dry(shown);
    return 0;
  }
  log.info(`$ ${shown}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: env ? { ...process.env, ...env } : process.env });
  if (r.error) {
    log.err(`${cmd}: ${r.error.message}`);
    return 127;
  }
  return r.status;
}

// Para CLIs interativas com perguntas previsíveis: as respostas vão pelo stdin.
export function runWithAnswers(cmd, args, answers, { dryRun = false } = {}) {
  const shown = [cmd, ...args].map((a) => tilde(a)).join(' ');
  if (dryRun) {
    log.dry(`${shown}  (respostas: ${JSON.stringify(answers)})`);
    return 0;
  }
  log.info(`$ ${shown}`);
  const r = spawnSync(cmd, args, { input: answers, stdio: ['pipe', 'inherit', 'inherit'] });
  return r.error ? 127 : r.status;
}

// Confere se o servidor MCP ficou registrado (e habilitado) no Hermes.
export function checkHermes(hermes, name) {
  const line = run(hermes, ['mcp', 'list']).stdout.split('\n').find((l) => new RegExp(`\\b${name}\\b`).test(l)) || '';
  if (!line) log.err(`hermes: ${name} não ficou registrado; rode "hermes mcp add" à mão`);
  else if (/disabled|desabilitado|✗/i.test(line)) log.warn(`hermes: ${name} salvo desabilitado; confira com "hermes mcp test ${name}"`);
  else log.ok(`hermes: ${name} registrado`);
}

export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

// Binário do Claude Code: primeiro o PATH, depois a extensão do VS Code (a versão mais nova).
export function findClaudeBinary() {
  const inPath = which('claude');
  if (inPath) return inPath;
  const extRoots = ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions'].map((d) => path.join(HOME, d));
  const found = [];
  for (const root of extRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const bin = path.join(root, name, 'resources', 'native-binary', 'claude');
      if (fs.existsSync(bin)) found.push({ bin, version: name.slice('anthropic.claude-code-'.length) });
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0]?.bin || null;
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

// ---------- agentes ----------

export function detectAgents() {
  const found = [];
  if (findClaudeBinary() || exists(path.join(HOME, '.claude'))) found.push('claude');
  if (which('cursor') || exists(path.join(HOME, '.cursor'))) found.push('cursor');
  if (which('hermes') || exists(path.join(HOME, '.hermes'))) found.push('hermes');
  if (which('openclaude') || exists(path.join(HOME, '.openclaude'))) found.push('openclaude');
  return found;
}

// "--agents claude,cursor" vira ['claude','cursor']; sem a flag, os agentes detectados.
export function resolveAgents(flag) {
  if (!flag) return detectAgents();
  const list = flag.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((a) => !AGENTS.includes(a));
  if (bad.length) die(`agente desconhecido: ${bad.join(', ')} (válidos: ${AGENTS.join(', ')})`);
  return list;
}

// ---------- configuração local (fora do repositório) ----------

// Raízes extras de skills, por exemplo o repositório privado da equipe.
export function extraRoots() {
  const file = path.join(CONFIG_DIR, 'roots.json');
  const data = readJSON(file, []);
  const list = Array.isArray(data) ? data : data.roots || [];
  return list.map((p) => path.resolve(expandHome(p)));
}

// Projetos com tratamento especial (workspace isolado no ai-memory, linguagem fixa no Serena).
export function localProjects() {
  const data = readJSON(path.join(CONFIG_DIR, 'projects.json'), { projects: [] });
  return (data.projects || []).map((p) => ({ ...p, dir: path.resolve(expandHome(p.dir)) }));
}

// ---------- skills ----------

// Raízes gerenciadas pelo glossary, com o rótulo de cada uma.
export function skillRoots({ includeExtra = true } = {}) {
  const roots = [{ label: 'skills', dir: path.join(REPO, 'skills'), own: true }];
  const vendor = path.join(REPO, 'vendor');
  if (fs.existsSync(vendor)) {
    for (const name of fs.readdirSync(vendor).sort()) {
      const dir = path.join(vendor, name);
      if (fs.statSync(dir).isDirectory()) roots.push({ label: `vendor/${name}`, dir, own: false, source: name });
    }
  }
  if (includeExtra) for (const dir of extraRoots()) roots.push({ label: tilde(dir), dir, own: true, extra: true });
  return roots;
}

// Pastas com SKILL.md diretamente dentro da raiz.
export function listSkills(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && fs.existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => ({ name: e.name, dir: path.join(root, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Frontmatter YAML simplificado: chaves de primeiro nível, escalares simples,
// aspas, blocos "|" e ">" e continuação indentada. Basta para SKILL.md.
export function parseFrontmatter(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return null;
  const data = {};
  const order = [];
  let key = null;
  let buf = [];
  const flush = () => {
    if (key === null) return;
    data[key] = scalar(buf);
    key = null;
    buf = [];
  };
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*)|\s*)$/.exec(line);
    if (m && !/^\s/.test(line)) {
      flush();
      key = m[1];
      order.push(key);
      buf = [m[2] ?? ''];
    } else if (key !== null) {
      buf.push(line);
    }
  }
  flush();
  return { data, keys: order, bodyStart: end + 1 };
}

function scalar(buf) {
  const [first, ...rest] = buf;
  const head = first.trim();
  const cont = rest.filter((l, i) => l.trim() !== '' || i < rest.length - 1);
  if (/^[|>][-+]?$/.test(head)) {
    const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    const body = cont.map((l) => l.slice(indent));
    const text = head[0] === '|' ? body.join('\n') : body.join(' ').replace(/\s+\n/g, '\n');
    return text.replace(/\s+$/, '');
  }
  if (cont.some((l) => /^\s+-\s/.test(l)) && head === '') return cont.map((l) => l.replace(/^\s+-\s*/, '').trim());
  if (head === '' && cont.length) return { _nested: cont.join('\n') };
  let value = [head, ...cont.map((l) => l.trim())].join(' ').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.startsWith('"') ? JSON.parse(value) : value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// ---------- interação ----------

let assumeYes = false;
export function setAssumeYes(v) {
  assumeYes = Boolean(v);
}

export async function ask(question, fallback = '') {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`    ${question} `, resolve));
  rl.close();
  return answer.trim() || fallback;
}

// Pergunta sim/não. Com --yes responde sim; sem terminal interativo responde não.
export async function confirm(question) {
  if (assumeYes) {
    log.info(`${question} [sim: --yes]`);
    return true;
  }
  if (!process.stdin.isTTY) {
    log.warn(`${question} -> pulado (sem terminal interativo; use --yes para aceitar)`);
    return false;
  }
  const a = (await ask(`${question} [s/N]`)).toLowerCase();
  return a === 's' || a === 'sim' || a === 'y' || a === 'yes';
}

// Lê um segredo sem ecoar no terminal.
export async function askSecret(question) {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  rl._writeToOutput = (s) => {
    if (!muted || s === '\r\n' || s === '\n') rl.output.write(s);
  };
  const answer = await new Promise((resolve) => {
    rl.question(`    ${question} `, resolve);
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}
