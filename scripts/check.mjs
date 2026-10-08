#!/usr/bin/env node
// Confere a instalação inteira e diz o que falta. Não altera nada.
//
//   node scripts/check.mjs [--agents claude,cursor,hermes,openclaude]
//   node glossary.mjs --check
//
// Usa as escolhas gravadas pelo install (~/.config/glossary/install.json), por exemplo
// quais agentes ficaram sem a memória compartilhada.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENT_FILES, BIN, MCP_URL, httpStatus, wired } from '../ai-memory/setup.mjs';
import { CONFIG as SERENA_CONFIG, argsOk, findSerena, readList } from '../serena/setup.mjs';
import { expectedLinks, linkTarget } from './link.mjs';
import {
  CONFIG_DIR,
  HOME,
  REPO,
  extraRoots,
  findClaudeBinary,
  isMain,
  listSkills,
  localProjects,
  log,
  readJSON,
  resolveAgents,
  run,
  tilde,
  which,
} from './lib.mjs';
import { DENY_FILE } from './private.mjs';

export const INSTALL_FILE = path.join(CONFIG_DIR, 'install.json');

export async function check({ agents } = {}) {
  const choices = readJSON(INSTALL_FILE, {});
  agents ||= choices.agents || resolveAgents();
  // Sem escolha registrada, vale o padrão do instalador: o OpenClaude fica fora da memória.
  const memoryAgents = (choices.memoryAgents || agents.filter((a) => a !== 'openclaude')).filter((a) => agents.includes(a));
  const sources = readJSON(path.join(REPO, 'sources.json'));
  let errors = 0;
  let warnings = 0;
  const ok = (s) => log.ok(s);
  const bad = (s) => (errors++, log.err(s));
  const warn = (s) => (warnings++, log.warn(s));

  log.step(`Agentes: ${agents.join(', ') || '(nenhum)'}`);

  // ---------- skills ----------
  log.step('Skills');
  for (const { target, dir, wanted } of expectedLinks(agents)) {
    let missing = 0;
    for (const [name, skill] of wanted) {
      const dest = path.join(dir, name);
      try {
        if (!fs.lstatSync(dest).isSymbolicLink() || linkTarget(dest) !== skill.dir) missing++;
      } catch {
        missing++;
      }
    }
    if (missing) bad(`${target.dir}: ${missing} de ${wanted.size} skill(s) sem link (rode: node scripts/link.mjs)`);
    else ok(`${target.dir}: ${wanted.size} skill(s)`);
  }
  const roots = extraRoots();
  for (const r of roots)
    fs.existsSync(r.dir) ? ok(`privadas: ${tilde(r.dir)} (${listSkills(r.dir).length} skill(s))`) : bad(`privadas: ${tilde(r.dir)} não existe (rode ./install.sh)`);
  if (!roots.length) warn('sem repositório privado (rode ./install.sh)');
  if (!fs.existsSync(DENY_FILE)) warn(`sem a lista de nomes da empresa (${tilde(DENY_FILE)}): a trava de commit só pega os padrões genéricos (rode ./install.sh)`);
  if (agents.includes('hermes')) {
    const hermes = which('hermes');
    const r = hermes ? run(hermes, ['config', 'get', 'skills.external_dirs', '--json']) : { stdout: '' };
    if (!hermes) warn('hermes: não está no PATH');
    else if (r.stdout.includes('.agents/skills')) ok('hermes: lê ~/.agents/skills');
    else bad('hermes: skills.external_dirs sem ~/.agents/skills (rode: node scripts/link.mjs)');
  }

  // ---------- ai-memory ----------
  log.step('Memória compartilhada (ai-memory)');
  const version = sources.aiMemory.version.replace(/^v/, '');
  const current = fs.existsSync(BIN) ? run(BIN, ['--version']).stdout.trim() : '';
  if (current === `ai-memory ${version}`) ok(`${current}`);
  else bad(`binário ${current || 'ausente'} em ${tilde(BIN)} (esperado ${version})`);
  const status = await httpStatus(MCP_URL);
  if (status === 405) ok(`servidor no ar (${MCP_URL})`);
  else bad(`servidor fora do ar (${MCP_URL} respondeu ${status || 'nada'})`);
  for (const agent of ['claude', 'cursor']) {
    if (!memoryAgents.includes(agent)) continue;
    if (wired(agent, AGENT_FILES[agent])) ok(`${agent}: MCP e hooks ligados`);
    else bad(`${agent}: MCP ou hooks do ai-memory faltando`);
  }
  if (memoryAgents.includes('hermes')) {
    const hermes = which('hermes');
    const r = hermes ? run(hermes, ['config', 'get', 'mcp_servers.ai-memory', '--json']) : { code: 1, stdout: '' };
    let entry = null;
    try {
      entry = r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {}
    if (!entry) bad('hermes: MCP do ai-memory não registrado');
    else if (entry.enabled === false) warn('hermes: MCP do ai-memory registrado mas desligado (hermes mcp test ai-memory)');
    else ok('hermes: MCP ligado');
  }
  if (agents.includes('openclaude')) {
    const oc = which('openclaude');
    const registered = oc && run(oc, ['mcp', 'get', 'ai-memory']).code === 0;
    if (memoryAgents.includes('openclaude')) registered ? ok('openclaude: MCP ligado') : bad('openclaude: MCP do ai-memory não registrado');
    else if (!choices.memoryAgents) ok(registered ? 'openclaude: MCP ligado' : 'openclaude: sem memória compartilhada');
    else if (registered) warn('openclaude: tem a memória ligada, mas a instalação escolheu deixá-lo de fora');
    else ok('openclaude: sem memória compartilhada (escolha da instalação)');
  }
  for (const p of localProjects().filter((p) => p.aiMemory)) {
    const marker = path.join(p.dir, '.ai-memory.toml');
    if (!fs.existsSync(p.dir)) warn(`${tilde(p.dir)}: pasta não existe`);
    else if (!fs.existsSync(marker) || !fs.readFileSync(marker, 'utf8').includes(`workspace = "${p.aiMemory.workspace}"`))
      bad(`${tilde(p.dir)}: sem workspace "${p.aiMemory.workspace}" (rode: node glossary.mjs --only ai-memory)`);
    else ok(`${tilde(p.dir)}: workspace "${p.aiMemory.workspace}"`);
  }

  // ---------- Serena ----------
  if (choices.serena !== false) {
    log.step('Serena');
    const bin = findSerena();
    const v = bin ? run(bin, ['--version']).stdout.trim().replace(/^Serena\s+/, '') : '';
    if (!bin) warn('não instalado (opcional; rode: node glossary.mjs --only serena)');
    else {
      if (v === sources.serena.version) ok(`Serena ${v}`);
      else warn(`Serena ${v}, versão fixada ${sources.serena.version}`);
      const lines = fs.existsSync(SERENA_CONFIG) ? fs.readFileSync(SERENA_CONFIG, 'utf8').split('\n') : [];
      const central = lines.some((l) => l.startsWith('project_serena_folder_location:') && l.includes(path.join(HOME, '.serena', 'projects')));
      const quiet = lines.some((l) => /^web_dashboard_open_on_launch:\s*false/i.test(l));
      if (central && quiet) ok(`config ajustada (${readList(lines, 'base_modes').join(', ')})`);
      else bad('config do Serena sem os ajustes (rode: node glossary.mjs --only serena)');
      for (const agent of agents) {
        const state = serenaRegistration(agent);
        if (state === true) ok(`${agent}: MCP registrado`);
        else if (state === null) warn(`${agent}: CLI não encontrada para conferir`);
        else bad(`${agent}: ${state}`);
      }
    }
  }

  log.step('Resultado');
  if (errors) log.err(`${errors} problema(s) e ${warnings} aviso(s). Corrija os itens acima ou rode ./install.sh de novo.`);
  else log.ok(`tudo certo${warnings ? ` (${warnings} aviso(s))` : ''}`);
  return errors ? 1 : 0;
}

// true se o registro do Serena no agente está como o glossary grava; texto com o problema; null se não deu para conferir.
function serenaRegistration(agent) {
  if (agent === 'cursor') {
    const entry = readJSON(path.join(HOME, '.cursor', 'mcp.json'), {}).mcpServers?.serena;
    if (!entry) return 'MCP do Serena não registrado';
    return argsOk((entry.args || []).join(' '), agent) || 'Serena registrado com outros argumentos';
  }
  if (agent === 'hermes') {
    const hermes = which('hermes');
    if (!hermes) return null;
    const r = run(hermes, ['config', 'get', 'mcp_servers.serena', '--json']);
    let entry = null;
    try {
      entry = r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {}
    if (!entry) return 'MCP do Serena não registrado';
    return argsOk((entry.args || []).join(' '), agent) || 'Serena registrado com outros argumentos';
  }
  const cli = agent === 'claude' ? findClaudeBinary() : which('openclaude');
  if (!cli) return null;
  const r = run(cli, ['mcp', 'get', 'serena']);
  if (r.code !== 0) return 'MCP do Serena não registrado';
  const args = /^\s*Args:\s*(.*)$/m.exec(r.stdout)?.[1]?.trim() || '';
  return argsOk(args, agent) || 'Serena registrado com outros argumentos';
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { agents: { type: 'string' } } });
  process.exit(await check({ agents: values.agents ? resolveAgents(values.agents) : undefined }));
}
