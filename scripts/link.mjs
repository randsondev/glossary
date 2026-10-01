#!/usr/bin/env node
// Cria um symlink por skill nas pastas que cada agente lê.
//
//   node scripts/link.mjs [--dry-run] [--agents claude,cursor,...] [--no-claude-dir] [--unlink] [--yes]
//
// Regras: nunca toca em pasta real nem em symlink que aponte para fora das raízes
// gerenciadas; remove só symlinks órfãos que apontam para essas raízes.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CONFIG_DIR,
  REPO,
  backupFile,
  confirm,
  expandHome,
  isMain,
  listSkills,
  log,
  readJSON,
  resolveAgents,
  run,
  setAssumeYes,
  skillRoots,
  tilde,
  which,
  writeJSON,
} from './lib.mjs';

const HERMES_DIR = '~/.agents/skills';

function collectSkills(roots) {
  const byName = new Map();
  const dupes = [];
  for (const root of roots) {
    for (const skill of listSkills(root.dir)) {
      if (byName.has(skill.name)) dupes.push(`${skill.name}: ${root.label} e ${byName.get(skill.name).root}`);
      else byName.set(skill.name, { ...skill, root: root.label });
    }
  }
  return { byName, dupes };
}

function linkTarget(linkPath) {
  return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
}

function isUnder(p, roots) {
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

export async function link({ dryRun = false, agents, noClaudeDir = false, unlink = false } = {}) {
  const conf = readJSON(path.join(REPO, 'link.json'));
  const roots = skillRoots();
  // Raízes de execuções anteriores também contam: assim os links de uma raiz
  // que saiu do roots.json viram órfãos e são removidos.
  const statePath = path.join(CONFIG_DIR, 'link-state.json');
  const state = readJSON(statePath, { roots: [] });
  const managed = [...new Set([...roots.map((r) => r.dir), ...state.roots])];
  for (const r of roots.filter((r) => r.extra && !fs.existsSync(r.dir))) log.warn(`raiz do roots.json não existe: ${r.label}`);

  const { byName, dupes } = collectSkills(roots.filter((r) => fs.existsSync(r.dir)));
  if (dupes.length && !unlink) {
    log.err('nomes repetidos entre raízes; nada foi alterado:');
    for (const d of dupes) log.info(d);
    return 1;
  }

  // Com --no-claude-dir o destino do Claude continua na lista, mas vazio: os links antigos saem.
  const targets = conf.targets.filter((t) => t.agents.some((a) => agents.includes(a)));
  if (!targets.length) {
    log.warn(`nenhum destino para os agentes: ${agents.join(', ') || '(nenhum detectado)'}`);
    return 0;
  }

  const act = (msg, fn) => (dryRun ? log.dry(msg) : (fn(), log.info(msg)));
  let skipped = 0;
  for (const t of targets) {
    const dir = expandHome(t.dir);
    const exclude = new Set(t.exclude || []);
    const off = unlink || (noClaudeDir && t.dir === '~/.claude/skills');
    const wanted = off ? new Map() : new Map([...byName].filter(([name]) => !exclude.has(name)));
    const counts = { criados: 0, atualizados: 0, removidos: 0, iguais: 0 };
    log.step(`${t.dir} (${t.agents.join(', ')})`);
    if (!fs.existsSync(dir)) {
      if (off) continue;
      act(`mkdir ${tilde(dir)}`, () => fs.mkdirSync(dir, { recursive: true }));
    }

    for (const [name, skill] of wanted) {
      const dest = path.join(dir, name);
      let st = null;
      try {
        st = fs.lstatSync(dest);
      } catch {}
      if (!st) {
        act(`+ ${name} -> ${tilde(skill.dir)}`, () => fs.symlinkSync(skill.dir, dest));
        counts.criados++;
      } else if (st.isSymbolicLink()) {
        const cur = linkTarget(dest);
        if (cur === skill.dir) counts.iguais++;
        else if (isUnder(cur, managed)) {
          act(`~ ${name} -> ${tilde(skill.dir)}`, () => (fs.unlinkSync(dest), fs.symlinkSync(skill.dir, dest)));
          counts.atualizados++;
        } else {
          log.warn(`${name}: já existe symlink para ${tilde(cur)}; não mexo`);
          skipped++;
        }
      } else {
        log.warn(`${name}: já existe pasta real em ${tilde(dest)}; não mexo`);
        skipped++;
      }
    }

    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (!fs.lstatSync(p).isSymbolicLink() || wanted.has(name)) continue;
        if (isUnder(linkTarget(p), managed)) {
          act(`- ${name}`, () => fs.unlinkSync(p));
          counts.removidos++;
        }
      }
    }
    log.ok(Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
  }

  if (!dryRun) writeJSON(statePath, { roots: unlink ? [] : roots.map((r) => r.dir) });
  if (agents.includes('hermes') && !unlink) await ensureHermesDir({ dryRun });
  if (unlink && agents.includes('hermes'))
    log.info(`Hermes: ${HERMES_DIR} continua em skills.external_dirs (remova com "hermes config edit" se quiser).`);
  if (skipped) log.warn(`${skipped} entrada(s) existente(s) preservada(s); confira os avisos acima`);
  return 0;
}

// Garante ~/.agents/skills em skills.external_dirs do Hermes.
async function ensureHermesDir({ dryRun }) {
  log.step('Hermes: skills.external_dirs');
  const bin = which('hermes');
  if (!bin) {
    log.warn(`hermes não está no PATH; adicione ${HERMES_DIR} em skills.external_dirs do ~/.hermes/config.yaml`);
    return;
  }
  const r = run(bin, ['config', 'get', 'skills.external_dirs', '--json']);
  let current = [];
  try {
    const v = JSON.parse(r.stdout.trim() || 'null');
    current = v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
  } catch {
    log.warn(`não consegui ler skills.external_dirs (${r.stderr.trim() || r.stdout.trim()}); configure à mão`);
    return;
  }
  const wanted = expandHome(HERMES_DIR);
  if (current.some((d) => path.resolve(expandHome(String(d))) === wanted)) {
    log.ok(`${HERMES_DIR} já está em skills.external_dirs`);
    return;
  }
  if (current.length) {
    log.warn(`skills.external_dirs já tem ${JSON.stringify(current)}; acrescente ${HERMES_DIR} com "hermes config edit"`);
    return;
  }
  if (!dryRun && !(await confirm(`Gravar skills.external_dirs = ${HERMES_DIR} na config do Hermes?`))) return;
  const cfg = run(bin, ['config', 'path']).stdout.trim();
  if (cfg) backupFile(cfg, { dryRun });
  if (dryRun) return log.dry(`hermes config set skills.external_dirs ${HERMES_DIR}`);
  const set = run(bin, ['config', 'set', 'skills.external_dirs', HERMES_DIR]);
  if (set.code === 0) log.ok(`skills.external_dirs = ${HERMES_DIR}`);
  else log.err(`hermes config set falhou: ${set.stderr.trim()}`);
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean' },
      unlink: { type: 'boolean' },
      agents: { type: 'string' },
      'no-claude-dir': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
  });
  setAssumeYes(values.yes);
  const agents = resolveAgents(values.agents);
  log.info(`agentes: ${agents.join(', ') || '(nenhum detectado)'}`);
  process.exit(
    await link({ dryRun: values['dry-run'], agents, noClaudeDir: values['no-claude-dir'], unlink: values.unlink }),
  );
}
