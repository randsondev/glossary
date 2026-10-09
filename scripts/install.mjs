#!/usr/bin/env node
// Instalação guiada: faz as poucas perguntas no começo e depois roda tudo, na ordem certa,
// sem interromper. Termina com a conferência (scripts/check.mjs).
//
//   ./install.sh                 (chama este script)
//   ./install.sh --yes           aceita as respostas padrão, sem perguntar
//   ./install.sh --agents claude,cursor
//   ./install.sh --export        empacota o repositório privado e a config local (para outro computador)
//   ./install.sh --import <arq>  desempacota esse pacote aqui e segue com a instalação
//
// Numa máquina nova, cria o repositório privado (glossary-internal, só local) ao lado do glossary.
// Pode rodar de novo quando quiser: o que já está certo não é refeito.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { discoverHistory, importHistory, showHistory } from '../ai-memory/history.mjs';
import { readServiceEnv, setup as aiMemorySetup, unwireCodex, unwireOpenclaudeHooks } from '../ai-memory/setup.mjs';
import { findSerena, setup as serenaSetup } from '../serena/setup.mjs';
import { INSTALL_FILE, check } from './check.mjs';
import { link } from './link.mjs';
import { DENY_FILE, exportPrivate, importPrivate, setupPrivateRepo, writeDenyTerms } from './private.mjs';
import {
  CONFIG_DIR,
  REPO,
  ask,
  die,
  expandHome,
  extraRoots,
  isMain,
  localProjects,
  log,
  readJSON,
  resolveAgents,
  run,
  runQuiet,
  setAssumeYes,
  tilde,
  which,
  writeJSON,
} from './lib.mjs';
import { validate } from './validate.mjs';

const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

export async function install({ yes = false, agents: agentsFlag, importFile } = {}) {
  const yesNo = async (question, def) => {
    if (yes) return def;
    const a = (await ask(`${question} ${def ? '[S/n]' : '[s/N]'}`)).toLowerCase();
    return a ? ['s', 'sim', 'y', 'yes'].includes(a) : def;
  };

  log.step('Instalação do glossary');
  if (importFile) importPrivate(importFile);
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
  const added = [];
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
    added.push(dir);
    log.ok(`${tilde(dir)} -> workspace "${workspace}"${entry.serena ? ' (Salesforce: Serena com typescript)' : ''}`);
  }

  // Termos da empresa para a trava de commit: ficam só nesta máquina, nunca no repositório.
  let denyTerms = [];
  if (!fs.existsSync(DENY_FILE)) {
    log.info('A trava de commit impede que nomes da empresa entrem no repositório público. A lista fica só nesta máquina.');
    const def = workspace || '';
    const answer = yes ? def : await ask(`Nomes da empresa para bloquear, separados por vírgula${def ? ` [${def}]` : ' (Enter para pular)'}:`, def);
    denyTerms = answer.split(',').map((t) => t.trim()).filter(Boolean);
  }

  let memoryAgents = agents;
  if (agents.includes('openclaude')) {
    log.info('O OpenClaude costuma usar modelos de outros provedores. Com acesso, ele lê o histórico de todos os agentes e as skills privadas.');
    const before = Boolean(previous?.memoryAgents?.includes('openclaude'));
    const on = await yesNo('Dar ao OpenClaude a memória compartilhada e as skills privadas? Só se ele usar um provedor confiável.', before);
    if (!on) memoryAgents = agents.filter((a) => a !== 'openclaude');
  }
  if (agents.includes('codex')) {
    log.info('O Codex manda ao modelo da OpenAI o que lê: as skills e a memória. Ele lê a mesma pasta de skills do Cursor e do Hermes (~/.agents/skills).');
    log.info('Se o Codex não for confiável, as skills privadas saem dessa pasta, e o Cursor e o Hermes também deixam de vê-las.');
    const before = Boolean(previous?.memoryAgents?.includes('codex'));
    const on = await yesNo('Dar ao Codex a memória compartilhada e as skills privadas? Só com conta confiável (API, Team ou Enterprise, sem treino com seus dados).', before);
    if (!on) memoryAgents = memoryAgents.filter((a) => a !== 'codex');
  }

  const uvOrSerena = which('uv') || findSerena();
  let serena = false;
  if (uvOrSerena)
    serena = await yesNo('Instalar o Serena (o agente busca código por símbolo em vez de ler arquivos inteiros)?', previous?.serena ?? true);
  else log.info('Serena pulado: falta o uv (brew install uv). Dá para instalar depois com ./install.sh.');

  const company = projects.projects.filter((p) => p.aiMemory).map((p) => path.resolve(expandHome(p.dir)));
  // O que os agentes já guardaram neste computador: oferecido uma vez por computador, e de novo
  // para cada projeto da empresa adicionado. Não duplica (ver ai-memory/history.mjs).
  const history = discoverHistory().map((e) => ({ ...e, company: company.includes(e.dir) }));
  let importList = [];
  if (!previous?.history && history.length) {
    log.info(`Os agentes já guardaram conversas em ${history.length} pasta(s) deste computador:`);
    showHistory(history);
    log.info('Um projeto da empresa que ainda não foi adicionado (pergunta acima) entraria na memória pessoal.');
    if (await yesNo('Levar tudo isso para a memória compartilhada?', true)) importList = history;
  } else if (added.length && (await yesNo('Importar para a memória o histórico de conversas desses projetos?', true))) {
    importList = added.map((dir) => history.find((e) => e.dir === dir) || { dir, sessions: 0, memories: [] });
  }

  // ---------- resumo ----------
  log.step('Vou fazer');
  log.info(`skills nos agentes: ${agents.join(', ')}`);
  log.info(`memória compartilhada (ai-memory) em: ${memoryAgents.join(', ')}`);
  if (company.length) log.info(`workspace separado em: ${company.map(tilde).join(', ')}`);
  log.info(`Serena: ${serena ? 'sim' : 'não'}`);
  if (!extraRoots().length) log.info('criar o repositório privado (só nesta máquina) ao lado do glossary');
  if (denyTerms.length) log.info(`trava de commit com ${denyTerms.length} nome(s) da empresa`);
  if (importList.length) log.info(`levar para a memória o histórico de ${importList.length} pasta(s)`);
  if (!(await yesNo('Pode começar?', true))) return 1;
  setAssumeYes(true);

  // ---------- execução ----------
  if (projects.projects.length) writeJSON(PROJECTS_FILE, projects);
  if (denyTerms.length) writeDenyTerms(denyTerms);

  log.step('Skills');
  // Sem o OpenClaude nesta rodada, a pergunta não foi feita: a escolha anterior fica como está.
  const answered = (a) => (agents.includes(a) ? memoryAgents.includes(a) : undefined);
  setupPrivateRepo({ trust: { openclaude: answered('openclaude'), codex: answered('codex') } });
  if (validate() !== 0) die('há skills inválidas; corrija antes de continuar (node scripts/validate.mjs)');
  if ((await link({ agents, quiet: true })) !== 0) die('o link das skills falhou');
  if (run('git', ['-C', REPO, 'config', '--get', 'core.hooksPath']).stdout.trim() !== '.githooks') {
    run('git', ['-C', REPO, 'config', 'core.hooksPath', '.githooks']);
    log.ok('trava de pre-commit ativada neste repositório');
  }

  log.step('Memória compartilhada');
  const llm = readServiceEnv().AI_MEMORY_LLM_PROVIDER ? undefined : 'none';
  if ((await aiMemorySetup({ agents: memoryAgents, llm, summary: false })) !== 0) die('a instalação do ai-memory falhou; veja as mensagens acima');
  // "Não" para o OpenClaude também tira a memória que uma rodada anterior tinha ligado nele.
  const oc = agents.includes('openclaude') && !memoryAgents.includes('openclaude') && which('openclaude');
  if (oc && run(oc, ['mcp', 'get', 'ai-memory']).code === 0) {
    log.info('openclaude: desligando a memória compartilhada');
    runQuiet(oc, ['mcp', 'remove', '--scope', 'user', 'ai-memory']);
  }
  if (oc) unwireOpenclaudeHooks();
  // Idem para o Codex: tira o MCP e os hooks que uma rodada anterior tinha ligado.
  if (agents.includes('codex') && !memoryAgents.includes('codex')) unwireCodex();

  if (serena) {
    log.step('Serena');
    await serenaSetup({ agents, memories: 'off', summary: false });
  }

  if (importList.length) {
    log.step('Histórico dos agentes');
    importHistory(importList);
  }

  const asked = Boolean(previous?.history || history.length);
  writeJSON(INSTALL_FILE, { agents, memoryAgents, serena, history: asked, updated: new Date().toISOString().slice(0, 10) });

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
  const { values } = parseArgs({
    options: { yes: { type: 'boolean' }, agents: { type: 'string' }, export: { type: 'boolean' }, import: { type: 'string' } },
  });
  if (values.export) process.exit(exportPrivate());
  process.exit(await install({ yes: values.yes, agents: values.agents, importFile: values.import }));
}
