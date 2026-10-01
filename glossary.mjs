#!/usr/bin/env node
// Monta tudo em sequência: validate -> link -> ai-memory -> Serena (e sync, se pedido).
//
//   node glossary.mjs [--dry-run] [--yes] [--agents claude,cursor,hermes,openclaude]
//                     [--only skills|ai-memory|serena] [--sync] [--no-claude-dir]
//                     [--llm none|anthropic|anthropic-oauth] [--model <id>]
//                     [--memories keep|off] [--trusted "<glob>"]
//
// Idempotente: rodar de novo só aplica o que mudou. Pede confirmação antes de
// escrever em config de agente, de rodar o setup-token e de mexer em repositório da empresa.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { setup as aiMemorySetup } from './ai-memory/setup.mjs';
import { link } from './scripts/link.mjs';
import { REPO, CONFIG_DIR, die, extraRoots, log, resolveAgents, run, setAssumeYes, tilde } from './scripts/lib.mjs';
import { setup as serenaSetup } from './serena/setup.mjs';
import { sync } from './scripts/sync.mjs';
import { validate } from './scripts/validate.mjs';

const PARTS = ['skills', 'ai-memory', 'serena'];

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean' },
    agents: { type: 'string' },
    only: { type: 'string' },
    sync: { type: 'boolean' },
    'no-claude-dir': { type: 'boolean' },
    llm: { type: 'string' },
    model: { type: 'string' },
    memories: { type: 'string' },
    trusted: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  const header = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10);
  console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const dryRun = Boolean(values['dry-run']);
setAssumeYes(values.yes);
const only = values.only ? values.only.split(',') : PARTS;
for (const p of only) if (!PARTS.includes(p)) die(`--only aceita ${PARTS.join(', ')}`);
const agents = resolveAgents(values.agents);
if (major(process.versions.node) < 20) die(`Node ${process.versions.node}; precisa do 20 ou mais novo`);

log.step(`glossary${dryRun ? ' (dry-run: nada é alterado)' : ''}`);
log.info(`repositório: ${tilde(REPO)}`);
log.info(`agentes: ${agents.join(', ') || '(nenhum detectado; use --agents)'}`);
log.info(`partes: ${only.join(', ')}`);
const roots = extraRoots();
if (roots.length)
  log.info(
    `raízes extras (${tilde(path.join(CONFIG_DIR, 'roots.json'))}): ` +
      roots.map((r) => tilde(r.dir) + (r.agents ? ` [só ${r.agents.join(', ')}]` : '')).join(', '),
  );

const report = [];
const record = (name, code) => (report.push([name, code]), code);

if (only.includes('skills')) {
  // vendor/ é revisado no PR semanal; aqui só se sincroniza quando pedido (ou na primeira vez).
  if (values.sync || !fs.existsSync(path.join(REPO, 'vendor'))) {
    log.step('sync');
    record('sync', sync({ dryRun }));
  }
  log.step('validate');
  if (record('validate', validate()) !== 0) finish();
  log.step('link');
  record('link', await link({ dryRun, agents, noClaudeDir: values['no-claude-dir'] }));
  enableHooks();
}
if (only.includes('ai-memory')) {
  log.step('ai-memory');
  record('ai-memory', await aiMemorySetup({ dryRun, agents, llm: values.llm, model: values.model }));
}
if (only.includes('serena')) {
  // Depois do ai-memory: os dois escrevem no ~/.cursor/mcp.json.
  log.step('Serena');
  record('serena', await serenaSetup({ dryRun, agents, memories: values.memories, trusted: values.trusted }));
}
finish();

function enableHooks() {
  const current = run('git', ['-C', REPO, 'config', '--get', 'core.hooksPath']).stdout.trim();
  if (current === '.githooks') return;
  log.step('Trava de pre-commit');
  if (dryRun) return log.dry('git config core.hooksPath .githooks (trava de pre-commit, só neste repositório)');
  run('git', ['-C', REPO, 'config', 'core.hooksPath', '.githooks']);
  log.ok('trava de pre-commit ativada (core.hooksPath = .githooks)');
}

function major(v) {
  return Number(v.split('.')[0]);
}

function finish() {
  log.step('Resumo');
  for (const [name, code] of report) (code === 0 ? log.ok : log.err)(`${name}${code === 0 ? '' : ` (código ${code})`}`);
  const failed = report.some(([, code]) => code !== 0);
  if (!failed && only.includes('skills')) {
    log.info('Skills: ls -la ~/.agents/skills ~/.claude/skills ~/.openclaude/skills');
    log.info('Claude Code: /code-review continua o embutido; as skills aparecem pelo nome (ex.: /ponytail-review).');
  }
  if (dryRun) log.info('Era um dry-run. Rode sem --dry-run para aplicar.');
  process.exit(failed ? 1 : 0);
}
