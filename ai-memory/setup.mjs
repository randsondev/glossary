#!/usr/bin/env node
// Instala o ai-memory (versão fixada no sources.json), sobe o serviço local e liga os agentes.
//
//   node ai-memory/setup.mjs [--dry-run] [--yes] [--agents claude,cursor,hermes,openclaude]
//                            [--llm none|anthropic|anthropic-oauth] [--model claude-haiku-4-5]
//   node ai-memory/setup.mjs --uninstall [--dry-run]   (tira a ligação dos agentes e para o serviço; os dados ficam)
//
// Os dados ficam em ~/Library/Application Support/ai-memory (macOS) ou ~/.local/share/ai-memory
// (Linux) e nunca entram em repositório. Backup: ai-memory backup --to <arquivo>.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  HOME,
  REPO,
  ask,
  askSecret,
  backupFile,
  checkHermes,
  confirm,
  die,
  findClaudeBinary,
  isMain,
  localProjects,
  log,
  readJSON,
  resolveAgents,
  run,
  runLive,
  runWithAnswers,
  setAssumeYes,
  sha256File,
  tilde,
  which,
} from '../scripts/lib.mjs';

const BASE_URL = 'http://127.0.0.1:49374';
const MCP_URL = `${BASE_URL}/mcp`;
const LABEL = 'com.github.akitaonrails.ai-memory';
const MAC = process.platform === 'darwin';
const LLM_KEYS = ['AI_MEMORY_LLM_PROVIDER', 'AI_MEMORY_LLM_MODEL', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
const DEFAULT_MODEL = 'claude-haiku-4-5';

const paths = {
  install: MAC ? path.join(HOME, 'Applications', 'ai-memory') : path.join(HOME, '.local', 'opt', 'ai-memory'),
  data: MAC
    ? path.join(HOME, 'Library', 'Application Support', 'ai-memory')
    : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'ai-memory'),
  plist: path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  logs: path.join(HOME, 'Library', 'Logs', 'ai-memory'),
  unit: path.join(HOME, '.config', 'systemd', 'user', 'ai-memory.service'),
  envFile: path.join(HOME, '.config', 'ai-memory', 'env'),
};
const BIN = path.join(paths.install, 'ai-memory');

function platformAsset() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const osName = { darwin: 'macos', linux: 'linux' }[process.platform];
  if (!arch || !osName) die(`plataforma sem release do ai-memory: ${process.platform}/${process.arch}`);
  return `${osName}-${arch}`;
}

// ---------- 1. binário ----------

function installBinary({ dryRun }) {
  log.step('Binário do ai-memory');
  const { version } = readJSON(path.join(REPO, 'sources.json')).aiMemory;
  const lock = readJSON(path.join(REPO, 'sources.lock.json'), {}).aiMemory;
  const platform = platformAsset();
  const expected = lock?.version === version ? lock.assets?.[platform] : null;
  if (!expected) die(`sources.lock.json sem sha256 de ${version}/${platform}; rode node scripts/sync.mjs --only ai-memory`);

  const current = fs.existsSync(BIN) ? run(BIN, ['--version']).stdout.trim() : '';
  if (current === `ai-memory ${version.replace(/^v/, '')}`) {
    log.ok(`${current} em ${tilde(paths.install)}`);
    return false;
  }

  const asset = `ai-memory-${platform}.tar.gz`;
  const url = `${readJSON(path.join(REPO, 'sources.json')).aiMemory.repo}/releases/download/${version}/${asset}`;
  if (dryRun) {
    log.dry(`baixaria ${url}, conferiria o sha256 e extrairia em ${tilde(paths.install)}`);
    return true;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-memory-'));
  try {
    const file = path.join(tmp, asset);
    log.info(`baixando ${url}`);
    if (run('curl', ['-fsSL', '--retry', '3', '-o', file, url]).code !== 0) die('download falhou');
    const got = sha256File(file);
    if (got !== expected) die(`sha256 não confere (esperado ${expected}, veio ${got}); nada foi instalado`);
    log.ok('sha256 confere com o sources.lock.json');
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    if (run('tar', ['-xzf', file, '-C', out]).code !== 0) die('não consegui extrair o tar.gz');
    if (!fs.existsSync(path.join(out, 'ai-memory'))) die('o pacote não tem o binário ai-memory na raiz');
    fs.mkdirSync(paths.install, { recursive: true });
    for (const entry of fs.readdirSync(out)) {
      fs.rmSync(path.join(paths.install, entry), { recursive: true, force: true });
      fs.cpSync(path.join(out, entry), path.join(paths.install, entry), { recursive: true });
    }
    fs.chmodSync(BIN, 0o755);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log.ok(`${run(BIN, ['--version']).stdout.trim()} instalado em ${tilde(paths.install)} (hooks/ ao lado do binário)`);
  return true;
}

function initData({ dryRun }) {
  log.step('Pasta de dados');
  if (fs.existsSync(path.join(paths.data, 'config.toml'))) return log.ok(`já existe: ${tilde(paths.data)}`);
  if (runLive(BIN, ['init'], { dryRun }) !== 0) die('ai-memory init falhou');
}

// ---------- 2. LLM ----------

// Variáveis que nós mesmos gravamos no plist (macOS) ou no arquivo env (Linux).
function readServiceEnv() {
  const env = {};
  if (MAC && fs.existsSync(paths.plist)) {
    const xml = fs.readFileSync(paths.plist, 'utf8');
    const block = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(xml)?.[1] || '';
    for (const m of block.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)) env[m[1]] = xmlUnescape(m[2]);
  } else if (!MAC && fs.existsSync(paths.envFile)) {
    for (const line of fs.readFileSync(paths.envFile, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const OAUTH_WARNING = [
  'O anthropic-oauth usa o token da sua assinatura Claude (claude setup-token) fora do Claude Code.',
  'A própria documentação do ai-memory chama isso de "não oficial e contra as políticas de uso da Anthropic":',
  'a conta pode sofrer limite ou bloqueio. A Anthropic descreve o OAuth da assinatura como destinado ao',
  'uso do Claude Code e dos apps nativos dela (code.claude.com/docs/en/legal-and-compliance).',
  'A alternativa suportada é --llm anthropic, com chave de API do Claude Console (cobrança por uso).',
  'Sem LLM (--llm none) o ai-memory continua capturando sessões e buscando; só não gera páginas destiladas.',
];

async function configureLlm({ dryRun, llm, model }) {
  log.step('LLM do ai-memory');
  const prev = readServiceEnv();
  let provider = llm || prev.AI_MEMORY_LLM_PROVIDER;
  if (!provider) {
    if (dryRun) {
      log.dry('perguntaria o provedor (none, anthropic, anthropic-oauth); padrão none');
      return {};
    }
    log.info('Provedores: none (sem LLM), anthropic (chave de API), anthropic-oauth (assinatura Claude, ver aviso)');
    provider = (await ask('Provedor de LLM? [none]', 'none')).toLowerCase();
  }
  if (!['none', 'anthropic', 'anthropic-oauth'].includes(provider)) die(`provedor não suportado por este setup: ${provider}`);
  if (provider === 'none') return log.ok('sem LLM: captura e busca funcionam, sem destilação'), {};

  const env = { AI_MEMORY_LLM_PROVIDER: provider, AI_MEMORY_LLM_MODEL: model || prev.AI_MEMORY_LLM_MODEL || DEFAULT_MODEL };
  const secretKey = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_OAUTH_TOKEN';

  if (provider === 'anthropic-oauth') {
    for (const l of OAUTH_WARNING) log.warn(l);
    if (dryRun) {
      log.dry('pediria confirmação, rodaria "claude setup-token" e pediria o token (sem eco)');
      return env;
    }
    if (!(await confirm('Usar anthropic-oauth mesmo assim?'))) return configureLlm({ dryRun, llm: 'none', model });
  }
  if (dryRun) {
    log.dry(`pediria ${secretKey} (sem eco) e rodaria ai-memory llm-test`);
    return env;
  }

  if (prev[secretKey] && prev.AI_MEMORY_LLM_PROVIDER === provider && (await confirm(`Reaproveitar o ${secretKey} já configurado?`))) {
    env[secretKey] = prev[secretKey];
  } else if (provider === 'anthropic-oauth') {
    const claude = findClaudeBinary();
    if (!claude) die('não achei o binário claude (PATH ou extensão do VS Code) para rodar setup-token');
    log.info('O setup-token abre o navegador para login e imprime um token. Copie o token ao final.');
    if (await confirm(`Rodar "${tilde(claude)} setup-token" agora?`)) runLive(claude, ['setup-token']);
    env[secretKey] = await askSecret('Cole o token (não aparece na tela):');
  } else {
    env[secretKey] = await askSecret('Cole a ANTHROPIC_API_KEY (não aparece na tela):');
  }
  if (!env[secretKey]) die(`${secretKey} vazio`);

  log.info(`testando com ai-memory llm-test (${provider}, ${env.AI_MEMORY_LLM_MODEL})`);
  const code = runLive(BIN, ['llm-test', '--provider', provider, '--model', env.AI_MEMORY_LLM_MODEL, '--prompt', 'Responda apenas: ok'], {
    env: { [secretKey]: env[secretKey] },
  });
  if (code !== 0 && !(await confirm('llm-test falhou. Gravar a configuração mesmo assim?'))) die('LLM não configurado');
  return env;
}

// ---------- 3. serviço ----------

export function renderPlist(env) {
  const template = path.join(paths.install, 'packaging', 'launchd', `${LABEL}.plist`);
  let xml = fs.readFileSync(template, 'utf8').replaceAll('__AI_MEMORY_BIN__', xmlEscape(BIN)).replaceAll('__HOME__', xmlEscape(HOME));
  const keys = Object.keys(env);
  if (keys.length) {
    const block = [
      '  <key>EnvironmentVariables</key>',
      '  <dict>',
      ...keys.flatMap((k) => [`    <key>${k}</key>`, `    <string>${xmlEscape(env[k])}</string>`]),
      '  </dict>',
      '',
    ].join('\n');
    xml = xml.replace(/<\/dict>\s*<\/plist>\s*$/, `${block}</dict>\n</plist>\n`);
  }
  return xml;
}

function renderUnit() {
  return [
    '[Unit]',
    'Description=ai-memory MCP server (user service)',
    'Documentation=https://github.com/akitaonrails/ai-memory',
    '',
    '[Service]',
    'Type=simple',
    'EnvironmentFile=-%h/.config/ai-memory/env',
    `ExecStart="${BIN}" serve --transport http --enable-web`,
    'Restart=on-failure',
    'RestartSec=5s',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function launchdLoaded() {
  return run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).code === 0;
}

function startService(env, { dryRun, binaryChanged }) {
  log.step(MAC ? 'Serviço (launchd)' : 'Serviço (systemd --user)');
  if (MAC) {
    const xml = renderPlist(env);
    const same = fs.existsSync(paths.plist) && fs.readFileSync(paths.plist, 'utf8') === xml;
    if (same && !binaryChanged && launchdLoaded()) return log.ok(`${LABEL} já carregado com a mesma definição`);
    if (dryRun) return log.dry(`gravaria ${tilde(paths.plist)} (chmod 600) e rodaria launchctl bootstrap gui/$(id -u)`);
    fs.mkdirSync(paths.logs, { recursive: true });
    writePrivate(paths.plist, xml);
    log.ok(`${tilde(paths.plist)} (chmod 600)`);
    if (launchdLoaded()) runLive('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    if (runLive('launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.plist]) !== 0) die('launchctl bootstrap falhou');
    return;
  }
  const prev = fs.existsSync(paths.envFile) ? fs.readFileSync(paths.envFile, 'utf8').split(/\r?\n/) : [];
  const kept = prev.filter((l) => l && !LLM_KEYS.some((k) => l.startsWith(`${k}=`)));
  const envText = [...kept, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
  const unchanged =
    prev.join('\n') === envText && fs.existsSync(paths.unit) && fs.readFileSync(paths.unit, 'utf8') === renderUnit();
  if (unchanged && !binaryChanged && run('systemctl', ['--user', 'is-active', '--quiet', 'ai-memory']).code === 0)
    return log.ok('ai-memory.service já ativo com a mesma definição');
  if (dryRun) return log.dry(`gravaria ${tilde(paths.envFile)} (chmod 600), ${tilde(paths.unit)} e rodaria systemctl --user enable --now ai-memory`);
  writePrivate(paths.envFile, envText);
  fs.mkdirSync(path.dirname(paths.unit), { recursive: true });
  fs.writeFileSync(paths.unit, renderUnit());
  log.ok(`${tilde(paths.envFile)} (chmod 600) e ${tilde(paths.unit)}`);
  const sc = (args) => runLive('systemctl', ['--user', ...args]);
  if (sc(['daemon-reload']) !== 0 || sc(['enable', 'ai-memory']) !== 0 || sc(['restart', 'ai-memory']) !== 0) {
    log.warn('systemd --user indisponível. Rode o servidor à mão em outro terminal:');
    log.info(`set -a; . ${tilde(paths.envFile)}; set +a; ${tilde(BIN)} serve --transport http --enable-web`);
    return 'manual';
  }
}

function httpStatus(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => (res.resume(), resolve(res.statusCode)));
    req.on('error', () => resolve(0));
    req.setTimeout(2000, () => (req.destroy(), resolve(0)));
  });
}

async function waitHealthy(seconds = 30) {
  for (let i = 0; i < seconds; i++) {
    if ((await httpStatus(MCP_URL)) === 405) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ---------- 4. agentes ----------

// MCP registrado e algum hook chamando o ai-memory: o agente já está ligado.
function wired(agent, files) {
  const [mcpFile, hooksFile] = files;
  const mcp = readJSON(mcpFile, {});
  const hooks = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile, 'utf8') : '';
  return Boolean(mcp.mcpServers?.['ai-memory']) && hooks.includes('ai-memory');
}

async function wireAgents(agents, { dryRun, binaryChanged }) {
  log.step('Ligar os agentes ao ai-memory');
  const ai = (args) => runLive(BIN, args, { dryRun });
  const files = {
    claude: [path.join(HOME, '.claude.json'), path.join(HOME, '.claude', 'settings.json')],
    cursor: [path.join(HOME, '.cursor', 'mcp.json'), path.join(HOME, '.cursor', 'hooks.json')],
  };
  for (const [agent, client] of [['claude', 'claude-code'], ['cursor', 'cursor']]) {
    if (!agents.includes(agent)) continue;
    if (!binaryChanged && wired(agent, files[agent])) {
      log.ok(`${agent}: MCP e hooks do ai-memory já ligados`);
      continue;
    }
    if (!dryRun && !(await confirm(`${agent}: gravar MCP e hooks do ai-memory em ${files[agent].map(tilde).join(' e ')}?`))) continue;
    for (const f of files[agent]) backupFile(f, { dryRun });
    ai(['install-mcp', '--client', client, '--apply']);
    ai(['install-hooks', '--agent', client, '--apply']);
  }

  if (agents.includes('hermes')) {
    const hermes = which('hermes');
    if (!hermes) log.warn('hermes não está no PATH; pulei');
    else if (/\bai-memory\b/.test(run(hermes, ['mcp', 'list']).stdout)) log.ok('hermes: ai-memory já registrado');
    else if (dryRun || (await confirm('hermes: registrar o MCP do ai-memory (hermes mcp add)?'))) {
      backupFile(run(hermes, ['config', 'path']).stdout.trim(), { dryRun });
      // Perguntas do Hermes: "exige autenticação?" -> n; "habilitar todas as ferramentas?"
      // (ou, se a conexão falhar, "salvar mesmo assim?") -> y.
      runWithAnswers(hermes, ['mcp', 'add', 'ai-memory', '--url', MCP_URL], 'n\ny\n', { dryRun });
      if (!dryRun) checkHermes(hermes, 'ai-memory');
    }
  }

  if (agents.includes('openclaude')) {
    const oc = which('openclaude');
    if (!oc) log.warn('openclaude não está no PATH; pulei');
    else if (run(oc, ['mcp', 'get', 'ai-memory']).code === 0) log.ok('openclaude: ai-memory já registrado');
    else if (dryRun || (await confirm('openclaude: registrar o MCP do ai-memory no escopo de usuário?'))) {
      backupFile(path.join(HOME, '.openclaude.json'), { dryRun });
      runLive(oc, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'ai-memory', MCP_URL], { dryRun });
    }
  }

  // Skills gerenciadas do ai-memory (ai-memory-*): pastas reais, que o link.mjs não toca.
  const claude = agents.includes('claude');
  const agentsDir = agents.includes('cursor') || agents.includes('hermes');
  const family = claude && agentsDir ? 'both' : claude ? 'claude-code' : agentsDir ? 'agents' : null;
  const targets = [family && `--agent ${family}`, agents.includes('openclaude') && '~/.openclaude/skills'].filter(Boolean);
  const dirs = [
    ...(family === 'both' || family === 'claude-code' ? ['.claude/skills'] : []),
    ...(family === 'both' || family === 'agents' ? ['.agents/skills'] : []),
    ...(agents.includes('openclaude') ? ['.openclaude/skills'] : []),
  ];
  const present = dirs.every((d) => fs.existsSync(path.join(HOME, d, 'ai-memory-handoff', 'SKILL.md')));
  if (targets.length && present && !binaryChanged) log.ok('skills gerenciadas do ai-memory já instaladas');
  else if (targets.length && (dryRun || (await confirm(`Instalar as skills gerenciadas do ai-memory (${targets.join(', ')})?`)))) {
    if (family) ai(['install-skills', '--scope', 'global', '--agent', family]);
    if (agents.includes('openclaude')) ai(['install-skills', '--target-dir', path.join(HOME, '.openclaude', 'skills')]);
  }
}

// ---------- 5. projetos com captura isolada ----------

function markerFor(conf) {
  const lines = ['# Gerado pelo glossary (ai-memory/setup.mjs). Fica fora do git via .git/info/exclude.', `workspace = "${conf.workspace}"`];
  if (conf.project) lines.push(`project = "${conf.project}"`);
  if (conf.ignore_paths?.length) lines.push('', '[capture]', `ignore_paths = ${JSON.stringify(conf.ignore_paths)}`);
  return lines.join('\n') + '\n';
}

async function isolateProjects({ dryRun }) {
  const projects = localProjects().filter((p) => p.aiMemory);
  if (!projects.length) return;
  log.step('Projetos com workspace isolado (~/.config/glossary/projects.json)');
  for (const p of projects) {
    const conf = p.aiMemory;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(conf.workspace || '')) {
      log.err(`${tilde(p.dir)}: workspace inválido (use a-z0-9._-)`);
      continue;
    }
    if (!fs.existsSync(p.dir)) {
      log.warn(`${tilde(p.dir)} não existe; pulei`);
      continue;
    }
    const marker = path.join(p.dir, '.ai-memory.toml');
    const content = markerFor(conf);
    const same = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === content;
    const gitPath = run('git', ['-C', p.dir, 'rev-parse', '--git-path', 'info/exclude']);
    const exclude = gitPath.code === 0 ? path.resolve(p.dir, gitPath.stdout.trim()) : null;
    const excluded = exclude && fs.existsSync(exclude) && fs.readFileSync(exclude, 'utf8').split(/\r?\n/).includes('.ai-memory.toml');
    if (same && (excluded || !exclude)) {
      log.ok(`${tilde(p.dir)}: workspace "${conf.workspace}" já configurado`);
      continue;
    }
    if (dryRun) {
      log.dry(`gravaria ${tilde(marker)} (workspace "${conf.workspace}", ${conf.ignore_paths?.length || 0} ignore_paths) e incluiria em .git/info/exclude`);
      continue;
    }
    if (!(await confirm(`Gravar .ai-memory.toml em ${tilde(p.dir)} (workspace "${conf.workspace}")?`))) continue;
    if (!same) {
      backupFile(marker);
      fs.writeFileSync(marker, content);
    }
    if (exclude && !excluded) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const prev = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      fs.writeFileSync(exclude, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + '.ai-memory.toml\n');
    }
    const status = exclude ? run('git', ['-C', p.dir, 'status', '--porcelain', '--', '.ai-memory.toml']).stdout.trim() : '';
    if (status) log.warn(`${tilde(p.dir)}: git ainda vê o .ai-memory.toml (${status})`);
    else log.ok(`${tilde(p.dir)}: workspace "${conf.workspace}", fora do git status`);
  }
}

// ---------- desinstalar ----------

async function uninstall(agents, { dryRun }) {
  log.step('Desligar o ai-memory');
  if (fs.existsSync(BIN)) runLive(BIN, dryRun ? ['uninstall'] : ['uninstall', '--apply', '--yes']);
  else log.warn(`binário não encontrado em ${tilde(BIN)}`);
  const hermes = agents.includes('hermes') && which('hermes');
  if (hermes) runWithAnswers(hermes, ['mcp', 'remove', 'ai-memory'], 'y\n', { dryRun });
  const oc = agents.includes('openclaude') && which('openclaude');
  if (oc) runLive(oc, ['mcp', 'remove', '--scope', 'user', 'ai-memory'], { dryRun });
  if (MAC) {
    if (launchdLoaded()) runLive('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { dryRun });
    log.info(`plist mantido em ${tilde(paths.plist)} (tem o token, se houver; apague se não for usar mais)`);
  } else {
    runLive('systemctl', ['--user', 'disable', '--now', 'ai-memory'], { dryRun });
  }
  log.info(`dados mantidos em ${tilde(paths.data)}; para apagar: ${tilde(BIN)} reset`);
  return 0;
}

// ---------- principal ----------

export async function setup({ dryRun = false, agents, llm, model, uninstall: off = false } = {}) {
  if (off) return uninstall(agents, { dryRun });
  const binaryChanged = installBinary({ dryRun });
  if (!dryRun || fs.existsSync(BIN)) initData({ dryRun });
  const env = await configureLlm({ dryRun, llm, model });
  const manual = startService(env, { dryRun, binaryChanged }) === 'manual';
  if (manual) log.info('esperando o servidor subir (até 2 min)...');
  if (dryRun) {
    log.dry(`esperaria ${MCP_URL} responder 405`);
  } else if (await waitHealthy(manual ? 120 : 30)) {
    log.ok(`${MCP_URL} respondeu 405 (servidor no ar)`);
  } else {
    log.err(`${MCP_URL} não respondeu; veja ${MAC ? tilde(path.join(paths.logs, 'stderr.log')) : 'journalctl --user -u ai-memory'}`);
    return 1;
  }
  await wireAgents(agents, { dryRun, binaryChanged });
  await isolateProjects({ dryRun });

  log.step('Para conferir');
  if (MAC) log.info(`launchctl print gui/$(id -u)/${LABEL} | grep state`);
  else log.info('systemctl --user status ai-memory');
  log.info(`curl -s -o /dev/null -w '%{http_code}\\n' ${MCP_URL}    # 405`);
  log.info(`${tilde(BIN)} status`);
  if (env.AI_MEMORY_LLM_PROVIDER) log.info(`${tilde(BIN)} llm-test --provider ${env.AI_MEMORY_LLM_PROVIDER} --model ${env.AI_MEMORY_LLM_MODEL} --prompt ok`);
  return 0;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      agents: { type: 'string' },
      llm: { type: 'string' },
      model: { type: 'string' },
      uninstall: { type: 'boolean' },
    },
  });
  setAssumeYes(values.yes);
  const agents = resolveAgents(values.agents);
  log.info(`agentes: ${agents.join(', ') || '(nenhum detectado)'}`);
  process.exit(await setup({ dryRun: values['dry-run'], agents, llm: values.llm, model: values.model, uninstall: values.uninstall }));
}
