#!/usr/bin/env node
// Instrução global de todos os agentes: agents/AGENTS.md (regras do glossary)
// + o AGENTS.md do repositório privado, se houver. O texto
// junto vai para ~/.config/glossary/AGENTS.md e chega a cada agente pelo caminho que ele lê:
//   Claude Code ~/.claude/CLAUDE.md, OpenClaude ~/.openclaude/CLAUDE.md, Codex ~/.codex/AGENTS.md: symlink
//   OpenClaw: bloco no AGENTS.md de cada workspace
//   Hermes: bloco no fim do SOUL.md de cada perfil (o Hermes não lê AGENTS.md global)
//   Cursor: hook sessionStart que injeta o texto (o Cursor não lê arquivo global)
//
//   node scripts/agents-md.mjs --cursor   saída do hook do Cursor ({"additional_context": ...})
// O link.mjs chama wireAgentsMd; o check.mjs, agentsMdStatus.
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENTS,
  CODEX_HOME,
  CONFIG_DIR,
  HOME,
  REPO,
  backupFile,
  extraRoots,
  WIN,
  hermesProfiles,
  isMain,
  linkFile,
  linksTo,
  log,
  nodeCommand,
  readJSON,
  tilde,
  writeJSON,
} from './lib.mjs';

import { openclawWorkspaces } from './openclaw.mjs';

export const AGENTS_MD = path.join(CONFIG_DIR, 'AGENTS.md');
const LINKS = {
  claude: path.join(HOME, '.claude', 'CLAUDE.md'),
  openclaude: path.join(HOME, '.openclaude', 'CLAUDE.md'),
  codex: path.join(CODEX_HOME, 'AGENTS.md'),
};
const CURSOR_HOOKS = path.join(HOME, '.cursor', 'hooks.json');
export const CURSOR_HOOK = { command: nodeCommand(path.join(REPO, 'scripts', 'agents-md.mjs')) + ' --cursor', timeout: 5 };
const isOurCursorHook = (h) => String(h?.command || '').includes('agents-md.mjs');
const BEGIN = '<!-- glossary: início das regras gerais (gerado; edite agents/AGENTS.md no glossary) -->';
const END = '<!-- glossary: fim das regras gerais -->';

// Raízes privadas que valem para todos os agentes: o texto junto vai para todos, então uma raiz
// que o roots.json limita a alguns agentes fica de fora (senão as regras dela vazariam).
const privateRoots = () => extraRoots().filter((r) => fs.existsSync(r.dir) && (!r.agents || AGENTS.every((a) => r.agents.includes(a))));

// Desce os títulos markdown n níveis (# -> ##), fora de bloco de código: o texto de outra fonte
// vira seção do arquivo geral, que tem um título só.
export const demote = (text, n) => {
  let fence = false;
  return text
    .split('\n')
    .map((l) => ((fence = /^\s*```/.test(l) ? !fence : fence), !fence && /^#{1,5} /.test(l) ? '#'.repeat(n) + l : l))
    .join('\n');
};

export function buildAgentsMd() {
  const roots = privateRoots();
  const own = fs
    .readFileSync(path.join(REPO, 'agents', 'AGENTS.md'), 'utf8')
    .replaceAll('{{SKILLS_DIR}}', tilde(roots[0]?.dir || path.join(REPO, 'skills')))
    .replaceAll('{{GLOSSARY}}', tilde(REPO));
  // O AGENTS.md do repositório privado fica ao lado da pasta skills/ dele.
  const priv = roots
    .map((r) => path.join(path.dirname(r.dir), 'AGENTS.md'))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8').trim());
  return [
    `${GENERATED}${tilde(path.join(REPO, 'scripts', 'link.mjs'))}: edite agents/AGENTS.md no glossary, não este arquivo. -->`,
    '# Regras gerais dos agentes',
    own.trim(),
    ...(priv.length ? [`## Regras do repositório interno\n\n${priv.map((t) => demote(t, 1)).join('\n\n')}`] : []),
  ].join('\n\n') + '\n';
}

const isOurLink = (p) => linksTo(p, AGENTS_MD);
// Hard link (Windows sem symlink) que se soltou do original, por exemplo porque o AGENTS.md foi
// apagado e recriado: o texto ainda é o gerado por nós, então pode ser trocado por um link novo.
const GENERATED = '<!-- Gerado por ';
const isStaleCopy = (p) => {
  try {
    return WIN && fs.lstatSync(p).isFile() && fs.readFileSync(p, 'utf8').startsWith(GENERATED);
  } catch {
    return false;
  }
};

function soulBlock(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  return start >= 0 && end > start ? { start, end: end + END.length } : null;
}

// Grava (ou, com unlink, tira) as regras gerais em cada agente.
export function wireAgentsMd({ agents, dryRun = false, unlink = false }) {
  log.step('Regras gerais dos agentes (AGENTS.md)');
  const text = unlink ? '' : buildAgentsMd();
  const act = (msg, fn) => (dryRun ? log.dry(msg) : (fn(), log.ok(msg)));
  if (!unlink && (!fs.existsSync(AGENTS_MD) || fs.readFileSync(AGENTS_MD, 'utf8') !== text))
    act(`${tilde(AGENTS_MD)} atualizado (${text.split('\n').length} linhas)`, () => (fs.mkdirSync(CONFIG_DIR, { recursive: true }), fs.writeFileSync(AGENTS_MD, text)));

  for (const [agent, file] of Object.entries(LINKS)) {
    if (!agents.includes(agent)) continue;
    const stale = isStaleCopy(file) && !isOurLink(file);
    if (unlink) {
      if (isOurLink(file) || stale) act(`${agent}: ${tilde(file)} removido`, () => fs.unlinkSync(file));
    } else if (isOurLink(file)) log.ok(`${agent}: ${tilde(file)} já aponta para as regras gerais`);
    else if (fs.lstatSync(file, { throwIfNoEntry: false }) && !stale)
      log.warn(`${agent}: ${tilde(file)} já existe e não é do glossary; não mexo (junte o conteúdo em agents/AGENTS.md e apague-o)`);
    else
      act(`${agent}: ${tilde(file)} -> ${tilde(AGENTS_MD)}`, () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (stale) fs.unlinkSync(file);
        linkFile(AGENTS_MD, file);
      });
  }

  const workspaces = agents.includes('openclaw') ? openclawWorkspaces().map((home) => ({ home, label: 'openclaw', file: 'AGENTS.md' })) : [];
  for (const h of [...(agents.includes('hermes') ? hermesProfiles() : []), ...workspaces]) {
    const soul = path.join(h.home, h.file || 'SOUL.md');
    const before = fs.existsSync(soul) ? fs.readFileSync(soul, 'utf8') : '';
    const b = soulBlock(before);
    const rest = (b ? before.slice(0, b.start) + before.slice(b.end) : before).trimEnd();
    const after = unlink ? `${rest.trimEnd()}\n` : `${rest ? `${rest}\n\n` : ''}${BEGIN}\n${text}${END}\n`;
    if (after === before || (unlink && !b)) {
      if (!unlink) log.ok(`${h.label}: ${h.file || 'SOUL.md'} já tem as regras gerais`);
      continue;
    }
    if (!dryRun && fs.existsSync(soul)) backupFile(soul);
    act(`${h.label}: regras gerais ${unlink ? 'tiradas do' : 'no fim do'} ${tilde(soul)}`, () => (fs.mkdirSync(h.home, { recursive: true }), fs.writeFileSync(soul, after)));
  }

  if (agents.includes('cursor') && (fs.existsSync(CURSOR_HOOKS) || !unlink)) {
    const conf = readJSON(CURSOR_HOOKS, { version: 1, hooks: {} });
    const current = conf.hooks?.sessionStart || [];
    const others = current.filter((x) => !isOurCursorHook(x));
    const wanted = unlink ? others : [...others, CURSOR_HOOK];
    // A ordem não importa: o ai-memory acrescenta o hook dele depois do nosso, e reordenar a cada instalação
    // regravava o hooks.json (com backup) toda vez.
    const ours = current.filter(isOurCursorHook);
    const same = unlink ? !ours.length : ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(CURSOR_HOOK);
    if (same) {
      if (!unlink) log.ok('cursor: hook sessionStart das regras gerais já ligado');
    } else {
      if (!dryRun && fs.existsSync(CURSOR_HOOKS)) backupFile(CURSOR_HOOKS);
      conf.hooks = { ...conf.hooks, sessionStart: wanted };
      if (!wanted.length) delete conf.hooks.sessionStart;
      act(`cursor: hook sessionStart das regras gerais ${unlink ? 'removido de' : 'em'} ${tilde(CURSOR_HOOKS)}`, () => writeJSON(CURSOR_HOOKS, conf));
    }
  }
}

// Para o check: [rótulo, true | texto do problema] por agente.
export function agentsMdStatus(agents) {
  const text = buildAgentsMd();
  const out = [];
  const fresh = fs.existsSync(AGENTS_MD) && fs.readFileSync(AGENTS_MD, 'utf8') === text;
  out.push([tilde(AGENTS_MD), fresh || 'desatualizado ou ausente (rode: node scripts/link.mjs)']);
  for (const [agent, file] of Object.entries(LINKS))
    if (agents.includes(agent)) out.push([agent, isOurLink(file) || `${tilde(file)} não aponta para as regras gerais`]);
  const workspaces = agents.includes('openclaw') ? openclawWorkspaces().map((home) => ({ home, label: 'openclaw', file: 'AGENTS.md' })) : [];
  for (const h of [...(agents.includes('hermes') ? hermesProfiles() : []), ...workspaces]) {
    const soul = path.join(h.home, h.file || 'SOUL.md');
    const s = fs.existsSync(soul) ? fs.readFileSync(soul, 'utf8') : '';
    const b = soulBlock(s);
    out.push([h.label, (b && s.slice(b.start, b.end) === `${BEGIN}\n${text}${END}`) || `${h.file || 'SOUL.md'} sem as regras gerais atuais`]);
  }
  if (agents.includes('cursor')) {
    const hooks = readJSON(CURSOR_HOOKS, {}).hooks?.sessionStart || [];
    out.push(['cursor', hooks.some((x) => x.command === CURSOR_HOOK.command) || 'sem o hook sessionStart das regras gerais']);
  }
  return out;
}

// Hook sessionStart do Cursor: ele lê o stdout como JSON e guarda additional_context na conversa.
if (isMain(import.meta.url) && process.argv.includes('--cursor')) {
  try {
    process.stdout.write(JSON.stringify({ additional_context: fs.readFileSync(AGENTS_MD, 'utf8') }));
  } catch {}
}
