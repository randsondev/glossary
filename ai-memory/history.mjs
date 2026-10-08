// Leva para o ai-memory o que os agentes já guardaram neste computador:
// - as conversas do Claude Code (terminal e VS Code) de cada pasta de projeto;
// - as memórias do Claude Code (~/.claude/projects/<pasta>/memory/*.md), como páginas duráveis
//   que todos os agentes acham pela busca da memória.
//
// O ./install.sh oferece isso uma vez por computador. Pode rodar de novo à mão sem duplicar:
// conversas só entram num projeto que ainda não tem nenhuma, e cada memória atualiza a mesma página.
//
//   node ai-memory/history.mjs           mostra o que encontrou (não altera nada)
//   node ai-memory/history.mjs --apply   importa
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HOME, isMain, localProjects, log, parseFrontmatter, run, tilde } from '../scripts/lib.mjs';
import { BIN } from './setup.mjs';

const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

// A pasta de cada conversa está no campo "cwd" das primeiras linhas do arquivo.
function cwdOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } finally {
    fs.closeSync(fd);
  }
}

// Uma entrada por pasta de projeto que ainda existe: quantas conversas e quais memórias.
export function discoverHistory() {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return [];
  const byDir = new Map();
  for (const name of fs.readdirSync(CLAUDE_PROJECTS)) {
    const dir = path.join(CLAUDE_PROJECTS, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const transcripts = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const cwd = transcripts.map(cwdOf).find(Boolean);
    if (!cwd || !fs.existsSync(cwd)) continue;
    const memDir = path.join(dir, 'memory');
    // MEMORY.md é só o índice que o Claude Code monta; as memórias são os outros arquivos.
    const memories = fs.existsSync(memDir)
      ? fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').map((f) => path.join(memDir, f))
      : [];
    const entry = byDir.get(cwd) || { dir: cwd, sessions: 0, memories: [] };
    entry.sessions += transcripts.length;
    entry.memories.push(...memories);
    byDir.set(cwd, entry);
  }
  const company = new Set(localProjects().filter((p) => p.aiMemory).map((p) => p.dir));
  return [...byDir.values()]
    .map((e) => ({ ...e, company: company.has(e.dir) }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function showHistory(list, { max = 15 } = {}) {
  for (const e of list.slice(0, max)) {
    const parts = [`${e.sessions} conversa(s)`, e.memories.length && `${e.memories.length} memória(s)`].filter(Boolean);
    log.info(`  ${tilde(e.dir)}: ${parts.join(', ')}${e.company ? '  (empresa)' : ''}`);
  }
  if (list.length > max) log.info(`  e mais ${list.length - max} pasta(s)`);
}

// Memória do Claude Code -> página durável do projeto (o mesmo caminho a cada rodada: atualiza, não duplica).
function writeMemory(file, cwd) {
  const text = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(text);
  const body = (fm ? text.split(/\r?\n/).slice(fm.bodyStart).join('\n') : text).trim();
  const stem = path.basename(file, '.md');
  const title = String(fm?.data.name || stem).trim();
  const desc = fm?.data.description ? `${String(fm.data.description).trim()}\n\n` : '';
  const args = ['write-page', '--path', `notes/claude-memory/${stem}.md`, '--title', title, '--body', '-', '--tag', 'claude-memory'];
  return run(BIN, args, { cwd, input: `${desc}${body}\n` }).code === 0;
}

export function importHistory(list) {
  let sessions = 0;
  let pages = 0;
  let failed = 0;
  for (const e of list) {
    // Sem --force: se o projeto já tem conversas na memória, o ai-memory não importa de novo.
    const r = run(BIN, ['backfill', '--max-sessions', '50', '--json'], { cwd: e.dir });
    let report = null;
    try {
      report = JSON.parse(r.stdout);
    } catch {}
    if (r.code !== 0 || !report) {
      failed++;
      log.err(`${tilde(e.dir)}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
      continue;
    }
    const written = e.memories.filter((m) => writeMemory(m, e.dir)).length;
    if (written < e.memories.length) failed++;
    sessions += report.imported_sessions;
    pages += written;
    const what = [
      report.skipped_non_empty ? 'conversas já estavam na memória' : `${report.imported_sessions} conversa(s)`,
      e.memories.length && `${written} memória(s)`,
    ].filter(Boolean);
    log.ok(`${tilde(e.dir)}: ${what.join(', ')}`);
  }
  log.info(`total: ${sessions} conversa(s) e ${pages} memória(s) importadas`);
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' } } });
  const list = discoverHistory();
  log.step('Histórico dos agentes neste computador');
  if (!list.length) {
    log.info('nenhuma conversa do Claude Code encontrada');
    process.exit(0);
  }
  if (!values.apply) {
    showHistory(list, { max: Infinity });
    log.info('Nada foi alterado. Para importar: node ai-memory/history.mjs --apply');
    process.exit(0);
  }
  process.exit(importHistory(list));
}
