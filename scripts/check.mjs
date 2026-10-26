#!/usr/bin/env node
// Confere a instalação inteira e diz o que falta. Não altera nada.
//
//   node scripts/check.mjs [--agents claude,cursor,hermes,openclaude,codex,openclaw]
//   node glossary.mjs --check
//
// Usa as escolhas gravadas pelo install (~/.config/glossary/install.json), por exemplo
// quais agentes ficaram sem a memória compartilhada.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AGENT_FILES,
  BIN,
  MCP_URL,
  OPENCLAUDE_SETTINGS,
  codexHooksTrusted,
  hasText,
  hermesAllowlist,
  hermesHooksWired,
  mcpStatus,
  wired,
} from '../ai-memory/setup.mjs';
import { CONFIG as SERENA_CONFIG, argsOk, codexTomlArgs, findSerena, readList } from '../serena/setup.mjs';
import { HERMES_HOOK, expectedLinks, isGlossaryHook, linkTarget } from './link.mjs';
import { agentsMdStatus } from './agents-md.mjs';
import {
  CODEX_HOME,
  CONFIG_DIR,
  HOME,
  REPO,
  expandHome,
  extraRoots,
  findClaudeBinary,
  hermesProfiles,
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

import { openclawConfig, openclawHooksWired } from './openclaw.mjs';

export const INSTALL_FILE = path.join(CONFIG_DIR, 'install.json');

export async function check({ agents } = {}) {
  const choices = readJSON(INSTALL_FILE, {});
  agents ||= choices.agents || resolveAgents();
  // Sem escolha registrada, vale o padrão do instalador: OpenClaude e Codex ficam fora da memória.
  const memoryAgents = (choices.memoryAgents || agents.filter((a) => !['openclaude', 'codex'].includes(a))).filter((a) => agents.includes(a));
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
    fs.existsSync(r.dir) ? ok(`privadas: ${tilde(r.dir)} (${listSkills(r.dir, { nested: true }).length} skill(s))`) : bad(`privadas: ${tilde(r.dir)} não existe (rode ./install.sh)`);
  if (!roots.length) warn('sem repositório privado (rode ./install.sh)');
  if (!fs.existsSync(DENY_FILE)) warn(`sem a lista de nomes da empresa (${tilde(DENY_FILE)}): a trava de commit só pega os padrões genéricos (rode ./install.sh)`);
  if (agents.includes('hermes')) {
    const profiles = hermesProfiles();
    if (!profiles.length) warn('hermes: não está no PATH');
    // As raízes privadas entram como pasta real: é por elas que o Hermes edita e cria skills.
    const privateDirs = roots.filter((r) => fs.existsSync(r.dir) && (!r.agents || r.agents.includes('hermes'))).map((r) => tilde(r.dir));
    const get = (h, key) => {
      try {
        return JSON.parse(run(h.bin, [...h.args, 'config', 'get', key, '--json']).stdout.trim() || 'null');
      } catch {
        return null;
      }
    };
    const same = (a, b) => path.resolve(expandHome(String(a))) === path.resolve(expandHome(String(b)));
    for (const h of profiles) {
      const v = get(h, 'skills.external_dirs');
      const dirs = Array.isArray(v) ? v : v ? [v] : [];
      const missing = ['~/.agents/skills', ...privateDirs].filter((d) => !dirs.some((c) => same(c, d)));
      if (missing.length) bad(`${h.label}: skills.external_dirs sem ${missing.join(', ')} (rode: node scripts/link.mjs)`);
      else ok(`${h.label}: lê ${['~/.agents/skills', ...privateDirs].join(' e ')}`);
      if (!privateDirs.length) continue;
      const create = get(h, 'skills.create_dir');
      if (create && same(create, privateDirs[0])) ok(`${h.label}: skills novas vão para ${privateDirs[0]}`);
      else warn(`${h.label}: skills novas vão para ${create || '~/.hermes/skills'}, fora do glossary (rode: node scripts/link.mjs)`);
      const hook = (get(h, 'hooks.post_tool_call') || []).find((x) => isGlossaryHook(String(x?.command || '')));
      if (!hook || hook.command !== HERMES_HOOK.command) warn(`${h.label}: sem o hook que refaz os links das skills novas (rode: node scripts/link.mjs)`);
      else if (!hasText(hermesAllowlist(h), 'hermes-hook.mjs')) warn(`${h.label}: hook das skills ligado; abra o Hermes nesse perfil e aceite o hook`);
      else ok(`${h.label}: skill nova do Hermes chega aos outros agentes sozinha`);
    }
  }

  log.step('Regras gerais (AGENTS.md)');
  for (const [label, state] of agentsMdStatus(agents)) state === true ? ok(`${label}: regras gerais em dia`) : bad(`${label}: ${state}`);

  // ---------- ai-memory ----------
  log.step('Memória compartilhada (ai-memory)');
  const version = sources.aiMemory.version.replace(/^v/, '');
  const current = fs.existsSync(BIN) ? run(BIN, ['--version']).stdout.trim() : '';
  if (current === `ai-memory ${version}`) ok(`${current}`);
  else bad(`binário ${current || 'ausente'} em ${tilde(BIN)} (esperado ${version})`);
  const status = await mcpStatus();
  if (status === 405 || status === 401) ok(`servidor no ar (${MCP_URL}${status === 401 ? ', com auth' : ''})`);
  else bad(`servidor fora do ar (${MCP_URL} respondeu ${status || 'nada'})`);
  for (const agent of ['claude', 'cursor', 'codex']) {
    if (!memoryAgents.includes(agent)) {
      if (agent === 'codex' && agents.includes('codex') && choices.memoryAgents && wired(agent, AGENT_FILES[agent]))
        warn('codex: tem a memória ligada, mas a instalação escolheu deixá-lo de fora');
      continue;
    }
    if (!wired(agent, AGENT_FILES[agent])) bad(`${agent}: MCP ou hooks do ai-memory faltando`);
    else if (agent === 'codex' && !codexHooksTrusted()) warn('codex: MCP e hooks ligados; abra o Codex e escolha "Trust all and continue" nos hooks');
    else ok(`${agent}: MCP e hooks ligados`);
  }
  if (memoryAgents.includes('hermes')) {
    const profiles = hermesProfiles();
    if (!profiles.length) bad('hermes: não está no PATH');
    for (const h of profiles) {
      const r = run(h.bin, [...h.args, 'config', 'get', 'mcp_servers.ai-memory', '--json']);
      let entry = null;
      try {
        entry = r.code === 0 ? JSON.parse(r.stdout) : null;
      } catch {}
      const hooks = hermesHooksWired(h);
      if (!entry) bad(`${h.label}: MCP do ai-memory não registrado (rode ./install.sh)`);
      else if (entry.enabled === false) warn(`${h.label}: MCP do ai-memory registrado mas desligado (hermes ${h.args.join(' ')} mcp test ai-memory)`);
      else if (!hooks) warn(`${h.label}: MCP ligado, mas sem os hooks que gravam as sessões (rode ./install.sh)`);
      else if (!hasText(hermesAllowlist(h), 'ai-memory')) warn(`${h.label}: MCP e hooks ligados; abra o Hermes nesse perfil e aceite os hooks do ai-memory`);
      else ok(`${h.label}: MCP e hooks ligados`);
    }
  }
  if (agents.includes('openclaude')) {
    const oc = which('openclaude');
    const registered = oc && run(oc, ['mcp', 'get', 'ai-memory']).code === 0;
    const hooks = hasText(OPENCLAUDE_SETTINGS, 'ai-memory');
    if (memoryAgents.includes('openclaude')) {
      if (!registered) bad('openclaude: MCP do ai-memory não registrado');
      else if (!hooks) bad('openclaude: MCP ligado, mas sem os hooks que gravam as sessões (rode ./install.sh)');
      else ok('openclaude: MCP e hooks ligados');
    }
    else if (!choices.memoryAgents) ok(registered ? 'openclaude: MCP ligado' : 'openclaude: sem memória compartilhada');
    else if (registered || hooks) warn('openclaude: tem a memória ligada, mas a instalação escolheu deixá-lo de fora');
    else ok('openclaude: sem memória compartilhada (escolha da instalação)');
  }
  if (memoryAgents.includes('openclaw')) {
    const entry = openclawConfig().mcp?.servers?.['ai-memory'];
    if (entry?.url === MCP_URL && entry.transport === 'streamable-http' && entry.enabled !== false) {
      ok('openclaw: MCP do ai-memory registrado');
      if (openclawHooksWired()) ok('openclaw: plugin de captura das sessões instalado');
      else bad('openclaw: plugin de captura ausente, desligado ou sem acesso à conversa');
    } else bad('openclaw: MCP do ai-memory ausente, desligado ou com outra URL');
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
      // O Hermes é conferido em cada perfil.
      const hermes = hermesProfiles();
      const checks = agents.flatMap((agent) =>
        agent === 'hermes' && hermes.length
          ? hermes.map((h) => [h.label, serenaRegistration(agent, h)])
          : [[agent, serenaRegistration(agent)]],
      );
      for (const [label, state] of checks) {
        if (state === true) ok(`${label}: MCP registrado`);
        else if (state === null) warn(`${label}: CLI não encontrada para conferir`);
        else bad(`${label}: ${state}`);
      }
    }
  }

  log.step('Resultado');
  if (errors) log.err(`${errors} problema(s) e ${warnings} aviso(s). Corrija os itens acima ou rode ./install.sh de novo.`);
  else log.ok(`tudo certo${warnings ? ` (${warnings} aviso(s))` : ''}`);
  return errors ? 1 : 0;
}

// true se o registro do Serena no agente está como o glossary grava; texto com o problema; null se não deu para conferir.
function serenaRegistration(agent, h) {
  if (agent === 'openclaw') {
    const entry = openclawConfig().mcp?.servers?.serena;
    return (entry?.enabled !== false && entry?.command && argsOk((entry.args || []).join(' '), agent)) || 'MCP do Serena ausente, desligado ou com outros argumentos';
  }
  if (agent === 'cursor') {
    const entry = readJSON(path.join(HOME, '.cursor', 'mcp.json'), {}).mcpServers?.serena;
    if (!entry) return 'MCP do Serena não registrado';
    return argsOk((entry.args || []).join(' '), agent) || 'Serena registrado com outros argumentos';
  }
  if (agent === 'hermes') {
    if (!h) return null;
    const r = run(h.bin, [...h.args, 'config', 'get', 'mcp_servers.serena', '--json']);
    let entry = null;
    try {
      entry = r.code === 0 ? JSON.parse(r.stdout) : null;
    } catch {}
    if (!entry) return 'MCP do Serena não registrado';
    return argsOk((entry.args || []).join(' '), agent) || 'Serena registrado com outros argumentos';
  }
  const cli = agent === 'claude' ? findClaudeBinary() : which(agent);
  if (!cli && agent === 'codex') {
    // Só o aplicativo do Codex (sem o comando no terminal): confere no config.toml.
    const args = codexTomlArgs(path.join(CODEX_HOME, 'config.toml'));
    return args === null ? 'MCP do Serena não registrado' : argsOk(args, agent) || 'Serena registrado com outros argumentos';
  }
  if (!cli) return null;
  const r = run(cli, ['mcp', 'get', 'serena']);
  if (r.code !== 0) return 'MCP do Serena não registrado';
  const args = /^\s*Args:\s*(.*)$/im.exec(r.stdout)?.[1]?.trim() || '';
  return argsOk(args, agent) || 'Serena registrado com outros argumentos';
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { agents: { type: 'string' } } });
  process.exit(await check({ agents: values.agents ? resolveAgents(values.agents) : undefined }));
}
