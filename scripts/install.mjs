#!/usr/bin/env node
// Instalação guiada: faz as poucas perguntas no começo e depois roda tudo, na ordem certa,
// sem interromper. Termina com a conferência (scripts/check.mjs).
//
//   ./install.sh                 (chama este script)
//   ./install.sh --yes           aceita as respostas padrão, sem perguntar
//   ./install.sh --agents claude,cursor
//
// Pode rodar de novo quando quiser: o que já está certo não é refeito.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BIN, readServiceEnv, setup as aiMemorySetup } from '../ai-memory/setup.mjs';
import { findSerena, setup as serenaSetup } from '../serena/setup.mjs';
import { INSTALL_FILE, check } from './check.mjs';
import { link } from './link.mjs';
import {
  CONFIG_DIR,
  REPO,
  ask,
  die,
  expandHome,
  isMain,
  localProjects,
  log,
  readJSON,
  resolveAgents,
  run,
  runLive,
  setAssumeYes,
  tilde,
  which,
  writeJSON,
} from './lib.mjs';
import { validate } from './validate.mjs';

const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

export async function install({ yes = false, agents: agentsFlag } = {}) {
  const yesNo = async (question, def) => {
    if (yes) return def;
    const a = (await ask(`${question} ${def ? '[S/n]' : '[s/N]'}`)).toLowerCase();
    return a ? ['s', 'sim', 'y', 'yes'].includes(a) : def;
  };

  log.step('Instalação do glossary');
  // Numa nova rodada, as respostas padrão repetem as escolhas anteriores.
  const previous = readJSON(INSTALL_FILE, null);
  const agents = resolveAgents(agentsFlag);
  if (!agents.length) die('nenhum agente encontrado (Claude Code, Cursor, Hermes ou OpenClaude). Instale um e rode de novo.');
  log.info(`Agentes encontrados: ${agents.join(', ')}`);
  log.info('Responda as perguntas abaixo; depois disso a instalação roda sozinha.');

  // ---------- perguntas ----------
  log.step('Perguntas');
  const projects = readJSON(PROJECTS_FILE, { projects: [] });
  projects.projects ||= [];
  const known = new Set(localProjects().map((p) => p.dir));
  if (projects.projects.length) {
    log.info('Projetos da empresa já configurados:');
    for (const p of localProjects()) log.info(`  ${tilde(p.dir)}  (workspace "${p.aiMemory?.workspace || '-'}")`);
  }
  log.info('Projetos da empresa ficam com a memória separada dos projetos pessoais.');
  let workspace = localProjects().find((p) => p.aiMemory)?.aiMemory.workspace;
  for (;;) {
    if (yes) break;
    const answer = await ask('Pasta de um projeto da empresa para adicionar (Enter para pular):');
    if (!answer) break;
    const dir = path.resolve(expandHome(answer));
    if (!fs.existsSync(dir)) {
      log.warn(`${tilde(dir)} não existe`);
      continue;
    }
    if (known.has(dir)) {
      log.info(`${tilde(dir)} já está configurado`);
      continue;
    }
    while (!workspace) {
      const w = (await ask('Nome do workspace da empresa (letras minúsculas, ex.: minhaempresa):')).toLowerCase();
      if (/^[a-z0-9][a-z0-9._-]*$/.test(w)) workspace = w;
      else log.warn('use só a-z, 0-9, ponto, hífen e sublinhado');
    }
    const entry = { dir: tilde(dir), aiMemory: { workspace, ignore_paths: [] } };
    // Projeto Salesforce: o Serena não tem servidor de linguagem para Apex; fixa o do JavaScript dos LWC.
    if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) entry.serena = { language_servers: ['typescript'] };
    projects.projects.push(entry);
    known.add(dir);
    log.ok(`${tilde(dir)} -> workspace "${workspace}"${entry.serena ? ' (Salesforce: Serena com typescript)' : ''}`);
  }

  let memoryAgents = agents;
  if (agents.includes('openclaude')) {
    log.info('O OpenClaude costuma usar modelos de outros provedores. Ligado à memória, ele pode ler o histórico de todos os agentes.');
    const before = Boolean(previous?.memoryAgents?.includes('openclaude'));
    const on = await yesNo('Ligar a memória compartilhada no OpenClaude? Só se ele usar um provedor confiável.', before);
    if (!on) memoryAgents = agents.filter((a) => a !== 'openclaude');
  }

  const uvOrSerena = which('uv') || findSerena();
  let serena = false;
  if (uvOrSerena)
    serena = await yesNo('Instalar o Serena (o agente busca código por símbolo em vez de ler arquivos inteiros)?', previous?.serena ?? true);
  else log.info('Serena pulado: falta o uv (brew install uv). Dá para instalar depois com ./install.sh.');

  const company = projects.projects.filter((p) => p.aiMemory).map((p) => path.resolve(expandHome(p.dir)));
  // O histórico só precisa ser importado uma vez; depois disso a captura é automática.
  const backfill = company.length
    ? await yesNo('Importar para a memória o histórico de conversas dos projetos da empresa?', !previous)
    : false;

  // ---------- resumo ----------
  log.step('Vou fazer');
  log.info(`skills nos agentes: ${agents.join(', ')}`);
  log.info(`memória compartilhada (ai-memory) em: ${memoryAgents.join(', ')}`);
  if (company.length) log.info(`workspace separado em: ${company.map(tilde).join(', ')}`);
  log.info(`Serena: ${serena ? 'sim' : 'não'}`);
  if (backfill) log.info('importar o histórico desses projetos');
  if (!(await yesNo('Pode começar?', true))) return 1;
  setAssumeYes(true);

  // ---------- execução ----------
  if (projects.projects.length) writeJSON(PROJECTS_FILE, projects);

  log.step('Skills');
  if (validate() !== 0) die('há skills inválidas; corrija antes de continuar (node scripts/validate.mjs)');
  if ((await link({ agents, quiet: true })) !== 0) die('o link das skills falhou');
  if (run('git', ['-C', REPO, 'config', '--get', 'core.hooksPath']).stdout.trim() !== '.githooks') {
    run('git', ['-C', REPO, 'config', 'core.hooksPath', '.githooks']);
    log.ok('trava de pre-commit ativada neste repositório');
  }

  log.step('Memória compartilhada');
  const llm = readServiceEnv().AI_MEMORY_LLM_PROVIDER ? undefined : 'none';
  if ((await aiMemorySetup({ agents: memoryAgents, llm, summary: false })) !== 0) die('a instalação do ai-memory falhou; veja as mensagens acima');

  if (serena) {
    log.step('Serena');
    await serenaSetup({ agents, memories: 'off', summary: false });
  }

  if (backfill) {
    log.step('Histórico dos projetos da empresa');
    for (const dir of company.filter((d) => fs.existsSync(d))) {
      runLive(BIN, ['backfill', '--force', '--max-sessions', '50'], { cwd: dir });
    }
  }

  writeJSON(INSTALL_FILE, { agents, memoryAgents, serena, updated: new Date().toISOString().slice(0, 10) });

  log.step('Conferência');
  const result = await check({ agents });

  log.step('Próximos passos');
  log.info('1. Recarregue o VS Code ("Developer: Reload Window") e reinicie o Cursor.');
  log.info('2. Abra uma sessão nova: as skills aparecem pelo nome (ex.: /ponytail-review).');
  log.info('3. Para conferir de novo a qualquer momento: node glossary.mjs --check');
  log.info('4. Para atualizar: git pull && ./install.sh --yes');
  return result;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { yes: { type: 'boolean' }, agents: { type: 'string' } } });
  process.exit(await install({ yes: values.yes, agents: values.agents }));
}
