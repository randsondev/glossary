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
export const WIN = process.platform === 'win32';
// Rodando a partir do PowerShell 7, o PSModulePath dele chega ao powershell.exe (5.1), que então não carrega
// os próprios módulos (instalador do uv, entrada de logon). Sem a variável, cada PowerShell monta a sua.
if (WIN) delete process.env.PSModulePath;
// Comando de instalação mostrado nas mensagens.
export const INSTALL = WIN ? 'install.cmd' : './install.sh';
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

export const AGENTS = ['claude', 'cursor', 'hermes', 'openclaude', 'codex', 'openclaw'];
// Pasta de config do Codex (CODEX_HOME muda o padrão ~/.codex).
export const CODEX_HOME = process.env.CODEX_HOME ? path.resolve(expandHome(process.env.CODEX_HOME)) : path.join(HOME, '.codex');

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
  if (p.startsWith('~/') || (WIN && p.startsWith('~\\'))) return path.join(HOME, p.slice(2));
  return p;
}

// Link para uma pasta. No Windows, junction: não exige modo de desenvolvedor nem administrador,
// e o Node a trata como symlink (lstat, readlink e unlink funcionam igual).
export function linkDir(target, dest) {
  fs.symlinkSync(target, dest, WIN ? 'junction' : 'dir');
}

// Link para um arquivo. No Windows sem modo de desenvolvedor o symlink de arquivo é negado (EPERM):
// fica um hard link, que acompanha o original enquanto ele for regravado no lugar (writeFileSync).
export function linkFile(target, dest) {
  try {
    fs.symlinkSync(target, dest, 'file');
  } catch (e) {
    if (!WIN || e.code !== 'EPERM') throw e;
    fs.linkSync(target, dest);
  }
}

// true se dest é um link (symlink ou, no Windows, hard link) para target.
export function linksTo(dest, target) {
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) return path.resolve(path.dirname(dest), fs.readlinkSync(dest)) === target;
    if (!WIN || !st.isFile()) return false;
    const a = fs.statSync(dest, { bigint: true });
    const b = fs.statSync(target, { bigint: true });
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

// Pacote da release do ai-memory por plataforma (ex.: linux-x86_64); o do Windows é zip.
export const aiMemoryAsset = (platform) => `ai-memory-${platform}${platform.startsWith('windows-') ? '.zip' : '.tar.gz'}`;

// O tar do Windows (bsdtar, em System32) lê zip e entende C:\; o do Git Bash, se vier antes no PATH, não.
export const TAR = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

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

// No Windows o Node não roda .cmd/.bat sem shell (EINVAL), e os CLIs instalados pelo npm são .cmd.
// Passa pelo cmd.exe com cada argumento escapado, como o cross-spawn faz.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;
function cmdArg(arg) {
  let a = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${a}"`.replace(cmdMeta, '^$1');
}
export function spawnArgs(cmd, args, opts = {}) {
  if (!WIN || !/\.(cmd|bat)$/i.test(cmd)) return [cmd, args, opts];
  const line = [cmd.replace(cmdMeta, '^$1'), ...args.map(cmdArg)].join(' ');
  return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true }];
}
const spawnCmd = (cmd, args, opts) => spawnSync(...spawnArgs(cmd, args, opts));

export function run(cmd, args = [], opts = {}) {
  const r = spawnCmd(cmd, args, { encoding: 'utf8', ...opts });
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
  const r = spawnCmd(cmd, args, { stdio: 'inherit', cwd, env: env ? { ...process.env, ...env } : process.env });
  if (r.error) {
    log.err(`${cmd}: ${r.error.message}`);
    return 127;
  }
  return r.status;
}

// Roda capturando a saída: mostra o comando e só imprime o que ele disse se falhar.
// Para CLIs com saída longa (o OpenClaude imprime um banner a cada comando).
export function runQuiet(cmd, args, { dryRun = false, env } = {}) {
  const shown = [cmd, ...args].map((a) => tilde(a)).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (dryRun) {
    log.dry(shown);
    return 0;
  }
  log.info(`$ ${shown}`);
  const r = run(cmd, args, env ? { env: { ...process.env, ...env } } : {});
  if (r.code === 0) log.ok('feito');
  else log.err(`falhou (código ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  return r.code;
}

// Para CLIs interativas com perguntas previsíveis: as respostas vão pelo stdin.
export function runWithAnswers(cmd, args, answers, { dryRun = false } = {}) {
  const shown = [cmd, ...args].map((a) => tilde(a)).join(' ');
  if (dryRun) {
    log.dry(`${shown}  (respostas: ${JSON.stringify(answers)})`);
    return 0;
  }
  log.info(`$ ${shown}`);
  // A saída fica guardada: quem chama confere o resultado (ex.: checkHermes) e mostra o que importa.
  const r = spawnCmd(cmd, args, { input: answers, encoding: 'utf8' });
  if (r.error) {
    log.err(`${cmd}: ${r.error.message}`);
    return 127;
  }
  if (r.status !== 0) log.err(`falhou (código ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  return r.status;
}

// Perfis do Hermes: o padrão (~/.hermes) e cada ~/.hermes/profiles/<nome>. Cada perfil tem config,
// sessões e aprovação de hooks próprias, então skills, memória e Serena são ligados em todos.
// "-p default" fixa o padrão mesmo quando outro perfil foi escolhido com "hermes profile use".
// Uso: run(h.bin, [...h.args, 'config', 'path']).
export function hermesProfiles() {
  const bin = which('hermes');
  if (!bin) return [];
  const base = path.join(HOME, '.hermes');
  const dir = path.join(base, 'profiles');
  const names = fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'config.yaml')))
        .map((e) => e.name)
        .sort()
    : [];
  return [
    { bin, args: ['-p', 'default'], label: 'hermes', home: base },
    ...names.map((n) => ({ bin, args: ['-p', n], label: `hermes (${n})`, home: path.join(dir, n) })),
  ];
}

// Comando "node <script>" para hook de agente (Hermes, Cursor), que roda sem shell e fora deste
// terminal. O node de uma versão instalada pelo mise/asdf/nvm/fnm/volta some na próxima
// atualização, então fica o shim ou o do sistema que estiver no PATH. Caminho com espaço vai
// entre aspas (o Hermes divide o comando com shlex).
const versioned = (p) => /[/\\](mise|asdf|\.nvm|nvm|fnm|volta)[/\\](.*[/\\])?(installs|versions|node-versions)[/\\]/.test(p);
const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);
export function nodeCommand(script) {
  const node = versioned(process.execPath)
    ? (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, WIN ? 'node.exe' : 'node')).find((p) => !versioned(p) && fs.existsSync(p))
    : null;
  if (!WIN) return [node || process.execPath, script].map(quote).join(' ');
  // Windows: o mesmo texto tem de servir ao cmd, ao PowerShell e ao shlex do Hermes. Barra normal
  // (o shlex come a invertida) e aspas duplas só se houver espaço; um caminho entre aspas no começo
  // o PowerShell lê como texto e não roda, então o node com espaço no caminho (C:\Program Files)
  // vai pelo nome, que está no PATH.
  const slash = (p) => p.replaceAll('\\', '/');
  const exe = slash(node || process.execPath);
  const head = !/\s/.test(exe) ? exe : which('node') ? 'node' : `"${exe}"`;
  const s = slash(script);
  return `${head} ${/\s/.test(s) ? `"${s}"` : s}`;
}

// Hooks de um evento num perfil do Hermes (pre_tool_call, post_tool_call...), lidos e gravados pelo
// CLI dele como lista JSON. O bloco hooks: é dividido entre ai-memory e glossary: cada um troca só
// as próprias entradas (mine) e mantém as outras. Devolve true se gravou e conferiu.
export function hermesHooks(h, event) {
  try {
    const v = JSON.parse(run(h.bin, [...h.args, 'config', 'get', `hooks.${event}`, '--json']).stdout.trim() || 'null');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function replaceHermesHooks(h, event, mine, entries, { dryRun = false } = {}) {
  const list = [...hermesHooks(h, event).filter((e) => !mine(String(e?.command || ''))), ...entries];
  const literal = JSON.stringify(list);
  if (dryRun) return log.dry(`hermes ${h.args.join(' ')} config set hooks.${event} '${literal}'`), true;
  run(h.bin, [...h.args, 'config', 'set', `hooks.${event}`, literal]);
  const commands = (l) => l.map((e) => e?.command).join('\n');
  return commands(hermesHooks(h, event)) === commands(list);
}

// Confere se o servidor MCP ficou registrado (e habilitado) num perfil do Hermes.
export function checkHermes(h, name) {
  const line = run(h.bin, [...h.args, 'mcp', 'list']).stdout.split('\n').find((l) => new RegExp(`\\b${name}\\b`).test(l)) || '';
  const cmd = `hermes ${h.args.join(' ')}`;
  if (!line) log.err(`${h.label}: ${name} não ficou registrado; rode "${cmd} mcp add" à mão`);
  else if (/disabled|desabilitado|✗/i.test(line)) log.warn(`${h.label}: ${name} salvo desabilitado; confira com "${cmd} mcp test ${name}"`);
  else log.ok(`${h.label}: ${name} registrado`);
}

// No Windows, o nome sem extensão vira cmd.exe, cmd.cmd... (PATHEXT). O arquivo sem extensão que o
// npm põe ao lado do .cmd é script de sh e não roda daqui; o .ps1 também não, então nenhum dos dois conta.
const EXTS = WIN
  ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e && e.toUpperCase() !== '.PS1')
  : [''];
export function which(cmd) {
  const names = WIN && path.extname(cmd) ? [cmd] : EXTS.map((e) => cmd + e.toLowerCase());
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = path.join(dir.replace(/^"|"$/g, ''), name);
      try {
        fs.accessSync(p, WIN ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// Binário do Claude Code: primeiro o PATH, depois a extensão do VS Code e o app desktop (a versão mais nova).
export function findClaudeBinary() {
  const inPath = which('claude');
  if (inPath) return inPath;
  const extRoots = ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions'].map((d) => path.join(HOME, d));
  const found = [];
  for (const root of extRoots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.startsWith('anthropic.claude-code-')) continue;
      const bin = path.join(root, name, 'resources', 'native-binary', WIN ? 'claude.exe' : 'claude');
      if (fs.existsSync(bin)) found.push({ bin, version: name.slice('anthropic.claude-code-'.length) });
    }
  }
  // App desktop do Claude no macOS: claude-code/<versão>/<hash>/claude.app/Contents/MacOS/claude.
  const desktop = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  if (fs.existsSync(desktop))
    for (const version of fs.readdirSync(desktop, { withFileTypes: true }).filter((d) => d.isDirectory()))
      for (const hash of fs.readdirSync(path.join(desktop, version.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
        const bin = path.join(desktop, version.name, hash.name, 'claude.app', 'Contents', 'MacOS', 'claude');
        if (fs.existsSync(bin)) found.push({ bin, version: version.name });
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
  if (which('codex') || exists(CODEX_HOME)) found.push('codex');
  if (which('openclaw') || exists(expandHome(process.env.OPENCLAW_STATE_DIR || '~/.openclaw'))) found.push('openclaw');
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

// Raízes extras de skills, por exemplo o repositório privado da equipe. Cada item é
// um caminho ou {"dir": caminho, "agents": [...]}; com "agents", as skills daquela raiz
// só vão para as pastas lidas exclusivamente por esses agentes.
export function extraRoots() {
  const file = path.join(CONFIG_DIR, 'roots.json');
  const data = readJSON(file, []);
  const list = Array.isArray(data) ? data : data.roots || [];
  return list.map((item) => {
    const entry = typeof item === 'string' ? { dir: item } : item;
    if (!entry?.dir) die(`${tilde(file)}: item sem "dir": ${JSON.stringify(item)}`);
    const bad = (entry.agents || []).filter((a) => !AGENTS.includes(a));
    if (bad.length) die(`${tilde(file)}: agente desconhecido em ${entry.dir}: ${bad.join(', ')}`);
    return { dir: path.resolve(expandHome(entry.dir)), agents: entry.agents };
  });
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
  if (includeExtra)
    for (const { dir, agents } of extraRoots()) roots.push({ label: tilde(dir), dir, own: true, extra: true, agents });
  return roots;
}

// O Codex ignora "disable-model-invocation" do frontmatter: a regra dele fica em agents/openai.yaml.
// Sem esse arquivo, o Codex pode rodar sozinho uma skill feita para só rodar quando chamada pelo nome.
export const CODEX_POLICY_FILE = 'agents/openai.yaml';
export const CODEX_POLICY_TEXT = 'policy:\n  allow_implicit_invocation: false\n';

export function needsCodexPolicy(skillDir) {
  const fm = parseFrontmatter(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
  return String(fm?.data['disable-model-invocation']) === 'true' && !fs.existsSync(path.join(skillDir, CODEX_POLICY_FILE));
}

export function writeCodexPolicy(skillDir) {
  const file = path.join(skillDir, CODEX_POLICY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, CODEX_POLICY_TEXT);
}

// Pastas com SKILL.md diretamente dentro da raiz. Com nested, também <raiz>/<categoria>/<nome>:
// é como o Hermes cria skill com categoria no repositório privado (skills.create_dir).
export function listSkills(root, { nested = false } = {}) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = path.join(root, e.name);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push({ name: e.name, dir });
    // Pasta com ponto (.archive, .git) nunca é categoria.
    else if (nested && !e.name.startsWith('.') && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) out.push(...listSkills(dir));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
    log.info(`${question} [sim]`);
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
