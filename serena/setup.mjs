#!/usr/bin/env node
// Ajusta o Serena (versão fixada no sources.json) e registra o MCP nos agentes.
//
//   node serena/setup.mjs [--dry-run] [--yes] [--agents claude,cursor,hermes,openclaude]
//                         [--memories keep|off] [--trusted "<glob>"]
//   node serena/setup.mjs --uninstall [--dry-run]   (remove o MCP dos agentes; config e projetos ficam)
//
// O Serena não expande "~" nos caminhos da config; por isso tudo é gravado com caminho absoluto.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  HOME,
  REPO,
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
  tilde,
  which,
  writeJSON,
} from '../scripts/lib.mjs';

const SERENA_HOME = path.join(HOME, '.serena');
const CONFIG = path.join(SERENA_HOME, 'serena_config.yml');
const FOLDER_LOCATION = path.join(SERENA_HOME, 'projects', '$projectFolderName', '.serena');
const CONTEXT = { claude: 'claude-code', openclaude: 'claude-code', cursor: 'ide', hermes: 'ide' };

function serenaArgs(agent) {
  return ['start-mcp-server', `--context=${CONTEXT[agent]}`, '--project-from-cwd'];
}

// ---------- binário ----------

function findSerena() {
  return which('serena') || [path.join(HOME, '.local', 'bin', 'serena')].find((p) => fs.existsSync(p)) || null;
}

async function ensureBinary({ dryRun }) {
  log.step('Binário do Serena');
  const { package: pkg, version } = readJSON(path.join(REPO, 'sources.json')).serena;
  let bin = findSerena();
  const current = bin ? run(bin, ['--version']).stdout.trim().replace(/^Serena\s+/, '') : null;
  if (current === version) {
    log.ok(`Serena ${version} em ${tilde(bin)}`);
    return bin;
  }
  const uv = which('uv');
  if (!uv) die('uv não encontrado (https://docs.astral.sh/uv/). Instale o uv e rode de novo.');
  const msg = current ? `Serena ${current} -> ${version}` : `instalar Serena ${version}`;
  if (!dryRun && !(await confirm(`${msg} com "uv tool install --force ${pkg}==${version}"?`))) return bin;
  if (runLive(uv, ['tool', 'install', '--force', `${pkg}==${version}`], { dryRun }) !== 0) die('uv tool install falhou');
  if (dryRun) return bin || path.join(HOME, '.local', 'bin', 'serena');
  bin = findSerena();
  if (!bin) die('serena instalado, mas fora do PATH; rode "uv tool update-shell" e abra outro terminal');
  log.ok(`Serena ${run(bin, ['--version']).stdout.trim()} em ${tilde(bin)}`);
  return bin;
}

// ---------- serena_config.yml ----------

// Edição mínima de YAML no nível de topo: localiza o bloco de uma chave (a linha
// "chave:" e as linhas de continuação) e troca só esse bloco, preservando o resto.
function findBlock(lines, key) {
  const start = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && /^(\s+\S|-\s|-$)/.test(lines[end])) end++;
  return { start, end };
}

function readList(lines, key) {
  const b = findBlock(lines, key);
  if (!b) return [];
  const inline = lines[b.start].slice(key.length + 1).trim();
  if (inline && inline !== '[]') {
    try {
      return JSON.parse(inline);
    } catch {
      return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  }
  return lines
    .slice(b.start + 1, b.end)
    .map((l) => l.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function setBlock(lines, key, block) {
  const b = findBlock(lines, key);
  if (b) lines.splice(b.start, b.end - b.start, ...block);
  else lines.push(...block);
}

const yamlList = (key, items) => (items.length ? [`${key}:`, ...items.map((i) => `- ${JSON.stringify(i)}`)] : [`${key}: []`]);

async function configure(bin, { dryRun, memories, trusted }) {
  log.step(`Config global (${tilde(CONFIG)})`);
  if (!fs.existsSync(CONFIG)) {
    if (dryRun) log.dry(`${tilde(bin || 'serena')} init (cria a config padrão)`);
    else if (runLive(bin, ['init']) !== 0) die('serena init falhou');
  }
  if (!fs.existsSync(CONFIG)) return log.dry('aplicaria os 4 ajustes depois do init');

  const original = fs.readFileSync(CONFIG, 'utf8');
  const lines = original.split('\n');
  setBlock(lines, 'project_serena_folder_location', [`project_serena_folder_location: ${JSON.stringify(FOLDER_LOCATION)}`]);
  setBlock(lines, 'web_dashboard_open_on_launch', ['web_dashboard_open_on_launch: false']);

  const modes = readList(lines, 'base_modes');
  let mem = memories;
  if (!mem && !modes.includes('no-memories')) {
    log.info('A memória fica com o ai-memory; o modo no-memories tira as ferramentas de memória do Serena.');
    mem = dryRun ? 'off' : (await confirm('Ativar o modo no-memories no Serena?')) ? 'off' : 'keep';
  }
  const nextModes = mem === 'off' ? [...new Set([...modes, 'no-memories'])] : mem === 'keep' ? modes.filter((m) => m !== 'no-memories') : modes;
  setBlock(lines, 'base_modes', yamlList('base_modes', nextModes));

  const patterns = readList(lines, 'trusted_project_path_patterns');
  setBlock(lines, 'trusted_project_path_patterns', yamlList('trusted_project_path_patterns', [...new Set([...patterns, trusted])]));

  const next = lines.join('\n');
  if (next === original) return log.ok('já ajustada');
  for (const [k, v] of [
    ['project_serena_folder_location', tilde(FOLDER_LOCATION)],
    ['web_dashboard_open_on_launch', 'false'],
    ['base_modes', nextModes.join(', ')],
    ['trusted_project_path_patterns', [...new Set([...patterns, trusted])].map(tilde).join(', ')],
  ])
    log.info(`${k}: ${v}`);
  if (dryRun) return log.dry(`gravaria ${tilde(CONFIG)}`);
  backupFile(CONFIG);
  fs.writeFileSync(CONFIG, next);
  log.ok('config ajustada');
}

// ---------- projetos com linguagem fixa ----------

async function configureProjects(bin, { dryRun }) {
  const projects = localProjects().filter((p) => p.serena?.language_servers?.length);
  if (!projects.length) return;
  log.step('Projetos com linguagem fixa (~/.config/glossary/projects.json)');
  for (const p of projects) {
    const langs = p.serena.language_servers;
    const yml = path.join(FOLDER_LOCATION.replace('$projectFolderName', path.basename(p.dir)), 'project.yml');
    if (!fs.existsSync(p.dir)) {
      log.warn(`${tilde(p.dir)} não existe; pulei`);
      continue;
    }
    if (fs.existsSync(path.join(p.dir, '.serena'))) log.warn(`${tilde(p.dir)}/.serena existe e tem prioridade sobre a pasta central; remova-a`);
    if (!fs.existsSync(yml)) {
      if (dryRun) {
        log.dry(`serena project create ${tilde(p.dir)} ${langs.map((l) => `--language ${l}`).join(' ')}`);
        continue;
      }
      if (runLive(bin, ['project', 'create', p.dir, ...langs.flatMap((l) => ['--language', l])]) !== 0) log.err('serena project create falhou');
      continue;
    }
    const lines = fs.readFileSync(yml, 'utf8').split('\n');
    const current = readList(lines, 'language_servers');
    if (JSON.stringify(current) === JSON.stringify(langs)) {
      log.ok(`${path.basename(p.dir)}: language_servers ${langs.join(', ')}`);
      continue;
    }
    if (dryRun) {
      log.dry(`${tilde(yml)}: language_servers ${current.join(', ') || '(vazio)'} -> ${langs.join(', ')}`);
      continue;
    }
    backupFile(yml);
    setBlock(lines, 'language_servers', yamlList('language_servers', langs));
    fs.writeFileSync(yml, lines.join('\n'));
    log.ok(`${path.basename(p.dir)}: language_servers ${langs.join(', ')}`);
  }
}

// ---------- agentes ----------

async function wireAgents(bin, agents, { dryRun }) {
  log.step('Registrar o MCP do Serena nos agentes');
  for (const agent of ['claude', 'openclaude']) {
    if (!agents.includes(agent)) continue;
    const cli = agent === 'claude' ? findClaudeBinary() : which('openclaude');
    if (!cli) {
      log.warn(`${agent}: CLI não encontrada; pulei`);
      continue;
    }
    if (run(cli, ['mcp', 'get', 'serena']).code === 0) {
      log.ok(`${agent}: serena já registrado`);
      continue;
    }
    const cfg = path.join(HOME, agent === 'claude' ? '.claude.json' : '.openclaude.json');
    if (!dryRun && !(await confirm(`${agent}: registrar o serena no escopo de usuário (${tilde(cfg)})?`))) continue;
    backupFile(cfg, { dryRun });
    runLive(cli, ['mcp', 'add', '--scope', 'user', 'serena', '--', bin, ...serenaArgs(agent)], { dryRun });
  }

  if (agents.includes('cursor')) {
    const file = path.join(HOME, '.cursor', 'mcp.json');
    const data = readJSON(file, {});
    data.mcpServers ||= {};
    const entry = { command: bin, args: serenaArgs('cursor') };
    if (JSON.stringify(data.mcpServers.serena) === JSON.stringify(entry)) log.ok('cursor: serena já registrado');
    else if (dryRun) log.dry(`${tilde(file)}: mcpServers.serena = ${JSON.stringify(entry)} (mantém os outros servidores)`);
    else if (await confirm(`cursor: gravar mcpServers.serena em ${tilde(file)} (mantém os outros servidores)?`)) {
      backupFile(file);
      data.mcpServers.serena = entry;
      writeJSON(file, data);
      log.ok(`cursor: ${Object.keys(data.mcpServers).join(', ')}`);
    }
  }

  if (agents.includes('hermes')) {
    const hermes = which('hermes');
    if (!hermes) log.warn('hermes não está no PATH; pulei');
    else if (/\bserena\b/.test(run(hermes, ['mcp', 'list']).stdout)) log.ok('hermes: serena já registrado');
    else if (dryRun || (await confirm('hermes: registrar o serena (hermes mcp add)?'))) {
      backupFile(run(hermes, ['config', 'path']).stdout.trim(), { dryRun });
      // Pergunta do Hermes: "habilitar todas as ferramentas?" (ou "salvar mesmo assim?") -> y.
      runWithAnswers(hermes, ['mcp', 'add', 'serena', '--command', bin, '--args', ...serenaArgs('hermes')], 'y\n', { dryRun });
      if (!dryRun) checkHermes(hermes, 'serena');
    }
  }
}

async function uninstall(agents, { dryRun }) {
  log.step('Remover o MCP do Serena dos agentes');
  for (const agent of ['claude', 'openclaude']) {
    const cli = agents.includes(agent) && (agent === 'claude' ? findClaudeBinary() : which('openclaude'));
    if (cli) runLive(cli, ['mcp', 'remove', '--scope', 'user', 'serena'], { dryRun });
  }
  if (agents.includes('cursor')) {
    const file = path.join(HOME, '.cursor', 'mcp.json');
    const data = readJSON(file, {});
    if (data.mcpServers?.serena) {
      if (dryRun) log.dry(`removeria mcpServers.serena de ${tilde(file)}`);
      else {
        backupFile(file);
        delete data.mcpServers.serena;
        writeJSON(file, data);
        log.ok(`cursor: serena removido de ${tilde(file)}`);
      }
    }
  }
  const hermes = agents.includes('hermes') && which('hermes');
  if (hermes) runWithAnswers(hermes, ['mcp', 'remove', 'serena'], 'y\n', { dryRun });
  log.info(`config e projetos mantidos em ${tilde(SERENA_HOME)}; para desinstalar: uv tool uninstall serena-agent`);
  return 0;
}

export async function setup({ dryRun = false, agents, memories, trusted, uninstall: off = false } = {}) {
  if (off) return uninstall(agents, { dryRun });
  if (memories && !['keep', 'off'].includes(memories)) die('--memories aceita keep ou off');
  const bin = await ensureBinary({ dryRun });
  if (!bin && !dryRun) return 1;
  await configure(bin, { dryRun, memories, trusted: trusted || path.join(HOME, 'projetos', '**') });
  await configureProjects(bin, { dryRun });
  await wireAgents(bin || 'serena', agents, { dryRun });

  log.step('Para conferir');
  log.info('serena --version');
  log.info('Claude Code: /mcp mostra "serena"; /context mostra quanto as ferramentas ocupam');
  log.info('Painel: http://127.0.0.1:24282/dashboard/ (não abre sozinho)');
  log.info('Custo: compare o uso de tokens de uma tarefa típica com e sem o Serena antes de decidir mantê-lo ligado.');
  return 0;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      agents: { type: 'string' },
      memories: { type: 'string' },
      trusted: { type: 'string' },
      uninstall: { type: 'boolean' },
    },
  });
  setAssumeYes(values.yes);
  const agents = resolveAgents(values.agents);
  log.info(`agentes: ${agents.join(', ') || '(nenhum detectado)'}`);
  process.exit(
    await setup({ dryRun: values['dry-run'], agents, memories: values.memories, trusted: values.trusted, uninstall: values.uninstall }),
  );
}
