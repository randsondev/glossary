#!/usr/bin/env node
// Trava contra vazamento de dados no repositório público.
//
//   node scripts/guard.mjs --staged         arquivos no índice (hook de pre-commit)
//   node scripts/guard.mjs --all            todos os arquivos versionados ou novos
//   node scripts/guard.mjs <caminho>...     arquivos ou pastas específicos
//
// Padrões genéricos ficam aqui. Termos da empresa ficam fora do repositório:
// ~/.config/glossary/guard-deny.txt (local) e a variável GUARD_DENY (CI).
// A saída mostra arquivo:linha e o nome do padrão, nunca o valor encontrado.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_DIR, REPO, isMain, log, run, walkFiles } from './lib.mjs';

const PATTERNS = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['dominio-com-br', /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.com\.br\b/i],
  ['cpf', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/],
  ['token-sk', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['token-github', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['token-slack', /\bxox[bp]-[A-Za-z0-9-]{10,}/],
  ['token-aws', /\bAKIA[0-9A-Z]{16}\b/],
  ['caminho-absoluto', /\/(?:Users|home)\/[A-Za-z0-9._-]+/],
];

function loadDenyTerms() {
  const terms = [];
  const file = path.join(CONFIG_DIR, 'guard-deny.txt');
  if (fs.existsSync(file)) terms.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/));
  if (process.env.GUARD_DENY) terms.push(...process.env.GUARD_DENY.split(/[\r\n,]+/));
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t && !t.startsWith('#')))].map((t) => t.toLowerCase());
}

// .guard-allow: "<glob do arquivo> <nome do padrão>" por linha; "*" vale para qualquer padrão.
function loadAllow() {
  const file = path.join(REPO, '.guard-allow');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [glob, name = '*'] = l.split(/\s+/);
      return { re: globToRegExp(glob), name };
    });
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function isAllowed(allow, file, name) {
  return allow.some((a) => a.re.test(file) && (a.name === '*' || a.name === name));
}

// Varre um texto e devolve [{line, name}] sem guardar o valor encontrado.
export function scanText(text, { deny = loadDenyTerms() } = {}) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push({ line: i + 1, name });
    const lower = line.toLowerCase();
    if (deny.some((t) => lower.includes(t))) hits.push({ line: i + 1, name: 'termo-da-empresa' });
  });
  return hits;
}

function stagedFiles() {
  const r = run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: REPO });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.split('\0').filter(Boolean).map((f) => ({ rel: f, read: () => gitShowStaged(f) }));
}

function gitShowStaged(f) {
  return run('git', ['show', `:${f}`], { cwd: REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }).stdout;
}

function allFiles() {
  const r = run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO });
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(REPO, f)) && fs.statSync(path.join(REPO, f)).isFile())
    .map((f) => ({ rel: f, read: () => fs.readFileSync(path.join(REPO, f)) }));
}

function pathFiles(paths) {
  const out = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const base = fs.statSync(abs).isDirectory() ? walkFiles(abs).map((r) => path.join(abs, r)) : [abs];
    for (const f of base) out.push({ rel: path.relative(REPO, f).split(path.sep).join('/'), read: () => fs.readFileSync(f) });
  }
  return out;
}

export function guard({ mode, paths = [], requireDeny = false, quiet = false }) {
  const deny = loadDenyTerms();
  if (!deny.length) {
    const msg = 'lista de termos da empresa não carregada (~/.config/glossary/guard-deny.txt ou GUARD_DENY)';
    if (requireDeny) {
      log.err(msg);
      return 2;
    }
    if (!quiet) log.warn(`${msg}; só os padrões genéricos foram verificados`);
  }
  const allow = loadAllow();
  const files = mode === 'staged' ? stagedFiles() : mode === 'all' ? allFiles() : pathFiles(paths);
  // O caminho também pode conter o termo; no log ele sai mascarado.
  const mask = (rel) => deny.reduce((s, t) => s.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '***'), rel);
  let total = 0;
  for (const f of files) {
    if (deny.some((t) => f.rel.toLowerCase().includes(t))) {
      console.error(`    ${mask(f.rel)}  termo-da-empresa (no caminho do arquivo)`);
      total++;
    }
    const buf = f.read();
    if (buf.includes(0)) continue; // binário
    for (const hit of scanText(buf.toString('utf8'), { deny })) {
      if (hit.name !== 'termo-da-empresa' && isAllowed(allow, f.rel, hit.name)) continue;
      console.error(`    ${mask(f.rel)}:${hit.line}  ${hit.name}`);
      total++;
    }
  }
  if (total) {
    log.err(`${total} ocorrência(s) bloqueada(s). O valor não é exibido de propósito.`);
    log.info('Remova o dado, mova o arquivo para o repositório privado ou, se for legítimo, registre em .guard-allow.');
    return 1;
  }
  if (!quiet) log.ok(`guard: ${files.length} arquivo(s) sem ocorrências`);
  return 0;
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { staged: { type: 'boolean' }, all: { type: 'boolean' }, 'require-deny': { type: 'boolean' } },
  });
  const mode = values.staged ? 'staged' : values.all ? 'all' : 'paths';
  if (mode === 'paths' && !positionals.length) {
    console.log('uso: node scripts/guard.mjs --staged | --all | <caminho>... [--require-deny]');
    process.exit(2);
  }
  process.exit(guard({ mode, paths: positionals, requireDeny: values['require-deny'] }));
}
