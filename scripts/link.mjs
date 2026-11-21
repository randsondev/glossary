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
  CODEX_POLICY_FILE,
  CONFIG_DIR,
  REPO,
  backupFile,
  confirm,
  expandHome,
  hermesHooks,
  hermesProfiles,
  isMain,
  linkDir,
  listSkills,
  log,
  needsCodexPolicy,
  nodeCommand,
  readJSON,
  replaceHermesHooks,
  resolveAgents,
  run,
  setAssumeYes,
  skillRoots,
  tilde,
  writeCodexPolicy,
  writeJSON,
} from './lib.mjs';
import { wireAgentsMd } from './agents-md.mjs';

const HERMES_DIR = '~/.agents/skills';
// Hook do Hermes que refaz os links quando ele cria ou apaga uma skill (scripts/hermes-hook.mjs).
export const HERMES_HOOK = {
  command: nodeCommand(path.join(REPO, 'scripts', 'hermes-hook.mjs')),
  matcher: '^skill_manage$',
  timeout: 60,
};
export const isGlossaryHook = (command) => command.includes('hermes-hook.mjs');

function collectSkills(roots) {
  const byName = new Map();
  const dupes = [];
  for (const root of roots) {
    for (const skill of listSkills(root.dir, { nested: root.extra })) {
      if (byName.has(skill.name)) dupes.push(`${skill.name}: ${root.label} e ${byName.get(skill.name).root}`);
      else byName.set(skill.name, { ...skill, root: root.label, rootAgents: root.agents });
    }
  }
  return { byName, dupes };
}

// Skills que devem estar linkadas numa pasta de destino. Uma raiz com "agents" no
// roots.json só entra se todos que leem a pasta estiverem na lista.
function wantedFor(t, byName) {
  const exclude = new Set(t.exclude || []);
  const readers = [...t.agents, ...(t.alsoReadBy || [])];
  const allowed = (skill) => !skill.rootAgents || readers.every((a) => skill.rootAgents.includes(a));
  return new Map([...byName].filter(([name, skill]) => !exclude.has(name) && allowed(skill)));
}

// Para cada pasta lida pelos agentes, o que deveria estar lá (usado pela conferência).
export function expectedLinks(agents) {
  const conf = readJSON(path.join(REPO, 'link.json'));
  const { byName } = collectSkills(skillRoots().filter((r) => fs.existsSync(r.dir)));
  return conf.targets
    .filter((t) => t.agents.some((a) => agents.includes(a)))
    .map((t) => ({ target: t, dir: expandHome(t.dir), wanted: wantedFor(t, byName) }));
}

export function linkTarget(linkPath) {
  return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
}

function isUnder(p, roots) {
  return roots.some((r) => p === r || p.startsWith(r + path.sep));
}

export async function link({ dryRun = false, agents, noClaudeDir = false, unlink = false, quiet = false } = {}) {
  const conf = readJSON(path.join(REPO, 'link.json'));
  const roots = skillRoots();
  // Raízes de execuções anteriores também contam: assim os links de uma raiz
  // que saiu do roots.json viram órfãos e são removidos.
  const statePath = path.join(CONFIG_DIR, 'link-state.json');
  const state = readJSON(statePath, { roots: [] });
  const managed = [...new Set([...roots.map((r) => r.dir), ...state.roots])];
  for (const r of roots.filter((r) => r.extra && !fs.existsSync(r.dir))) log.warn(`raiz do roots.json não existe: ${r.label}`);

  const { byName, dupes } = collectSkills(roots.filter((r) => fs.existsSync(r.dir)));
  // Skills próprias (públicas e privadas) que só rodam quando chamadas pelo nome ganham a regra do Codex.
  if (!dryRun && !unlink)
    for (const root of roots.filter((r) => r.own && fs.existsSync(r.dir)))
      for (const skill of listSkills(root.dir, { nested: root.extra }))
        if (needsCodexPolicy(skill.dir)) {
          writeCodexPolicy(skill.dir);
          log.info(`${root.label}/${skill.name}: ${CODEX_POLICY_FILE} (o Codex não roda sozinho)`);
        }
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

  // quiet: só a contagem por pasta, sem uma linha por skill (usado pelo install).
  const act = (msg, fn) => (dryRun ? log.dry(msg) : (fn(), quiet || log.info(msg)));
  let skipped = 0;
  for (const t of targets) {
    const dir = expandHome(t.dir);
    const off = unlink || (noClaudeDir && t.dir === '~/.claude/skills');
    const wanted = off ? new Map() : wantedFor(t, byName);
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
        act(`+ ${name} -> ${tilde(skill.dir)}`, () => linkDir(skill.dir, dest));
        counts.criados++;
      } else if (st.isSymbolicLink()) {
        const cur = linkTarget(dest);
        if (cur === skill.dir) counts.iguais++;
        else if (isUnder(cur, managed)) {
          act(`~ ${name} -> ${tilde(skill.dir)}`, () => (fs.unlinkSync(dest), linkDir(skill.dir, dest)));
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
  wireAgentsMd({ agents, dryRun, unlink });
  if (agents.includes('hermes') && !unlink) {
    log.step('Hermes: skills.external_dirs e skills.create_dir');
    // Raízes privadas que o Hermes pode ler: entram como pasta real, não pelos links de ~/.agents/skills.
    const privateDirs = roots
      .filter((r) => r.extra && fs.existsSync(r.dir) && (!r.agents || r.agents.includes('hermes')))
      .map((r) => tilde(r.dir));
    const profiles = hermesProfiles();
    if (!profiles.length) log.warn(`hermes não está no PATH; adicione ${HERMES_DIR} em skills.external_dirs do ~/.hermes/config.yaml`);
    for (const h of profiles) await ensureHermesSkills(h, privateDirs, { dryRun });
  }
  if (unlink && agents.includes('hermes')) {
    for (const h of hermesProfiles())
      if (hermesHooks(h, 'post_tool_call').some((x) => isGlossaryHook(String(x?.command || ''))))
        replaceHermesHooks(h, 'post_tool_call', isGlossaryHook, [], { dryRun }) && !dryRun && log.ok(`${h.label}: hook das skills removido`);
    log.info(`Hermes: ${HERMES_DIR}, o repositório privado e skills.create_dir continuam na config (remova com "hermes config edit" se quiser).`);
  }
  if (skipped) log.warn(`${skipped} entrada(s) existente(s) preservada(s); confira os avisos acima`);
  return 0;
}

// Configura as skills num perfil do Hermes:
// - skills.external_dirs com ~/.agents/skills e as raízes privadas. O Hermes procura a skill que vai
//   editar sem seguir symlink, então as privadas entram pela pasta real; sem isso ele não acha as
//   skills do glossary para editar e cria outra com o mesmo nome em ~/.hermes/skills.
// - skills.create_dir na primeira raiz privada: skill nova que o Hermes criar já nasce no glossary.
// Mantém o que já estiver em external_dirs; create_dir de outra pasta não é trocado.
async function ensureHermesSkills(h, privateDirs, { dryRun }) {
  const hermes = (args) => run(h.bin, [...h.args, ...args]);
  const cmd = `hermes ${h.args.join(' ')}`;
  const get = (key) => {
    const r = hermes(['config', 'get', key, '--json']);
    try {
      return { value: JSON.parse(r.stdout.trim() || 'null') };
    } catch {
      return { error: r.stderr.trim() || r.stdout.trim() };
    }
  };
  const same = (a, b) => path.resolve(expandHome(String(a))) === path.resolve(expandHome(String(b)));
  const cfg = hermes(['config', 'path']).stdout.trim();
  let backedUp = false;
  const backup = () => backedUp || ((backedUp = true), cfg && backupFile(cfg, { dryRun }));

  const dirs = get('skills.external_dirs');
  if (dirs.error) log.warn(`${h.label}: não consegui ler skills.external_dirs (${dirs.error}); configure à mão`);
  else {
    const v = dirs.value;
    const current = v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
    const missing = [HERMES_DIR, ...privateDirs].filter((d) => !current.some((c) => same(c, d)));
    if (!missing.length) log.ok(`${h.label}: skills.external_dirs = ${JSON.stringify(current)}`);
    else if (dryRun || (await confirm(`${h.label}: acrescentar ${missing.join(', ')} em skills.external_dirs?`))) {
      backup();
      const list = [...current, ...missing];
      const literal = JSON.stringify(list);
      if (dryRun) log.dry(`${cmd} config set skills.external_dirs '${literal}'`);
      else {
        // Hermes 0.21+ exige lista e aceita literal JSON; versões antigas gravam o literal como
        // texto, mas aceitam o caminho puro (só serve quando é uma pasta só).
        let set = hermes(['config', 'set', 'skills.external_dirs', literal]);
        let value = get('skills.external_dirs').value;
        if (!Array.isArray(value) && list.length === 1) {
          set = hermes(['config', 'set', 'skills.external_dirs', HERMES_DIR]);
          value = get('skills.external_dirs').value;
        }
        const got = Array.isArray(value) ? value : [value];
        if (list.every((d) => got.some((g) => g && same(g, d)))) log.ok(`${h.label}: skills.external_dirs = ${JSON.stringify(value)}`);
        else log.err(`${h.label}: ${cmd} config set falhou: ${(set.stderr || set.stdout).trim()}`);
      }
    }
  }

  if (!privateDirs.length) return;

  // Skill nova ou apagada pelo Hermes chega aos outros agentes sem rodar o link.mjs à mão.
  const hooks = hermesHooks(h, 'post_tool_call').filter((x) => isGlossaryHook(String(x?.command || '')));
  if (hooks.length === 1 && hooks[0].command === HERMES_HOOK.command && hooks[0].matcher === HERMES_HOOK.matcher)
    log.ok(`${h.label}: hook que refaz os links das skills já ligado`);
  else if (dryRun || (await confirm(`${h.label}: ligar o hook que refaz os links quando o Hermes cria ou apaga uma skill?`))) {
    backup();
    if (replaceHermesHooks(h, 'post_tool_call', isGlossaryHook, [HERMES_HOOK], { dryRun }) && !dryRun) {
      log.ok(`${h.label}: hook das skills ligado`);
      log.info('Na primeira vez que abrir o Hermes nesse perfil, ele pergunta se aceita o hook: responda sim.');
    } else if (!dryRun) log.err(`${h.label}: o hook das skills não ficou gravado; confira com "${cmd} hooks list"`);
  }

  const target = privateDirs[0];
  const create = get('skills.create_dir');
  const now = create.error ? null : create.value;
  if (create.error) log.warn(`${h.label}: não consegui ler skills.create_dir (${create.error}); configure à mão`);
  else if (now && same(now, target)) log.ok(`${h.label}: skills.create_dir = ${now}`);
  else if (now) log.warn(`${h.label}: skills.create_dir já aponta para ${now}; para as skills novas irem ao glossary: ${cmd} config set skills.create_dir ${target}`);
  else if (dryRun || (await confirm(`${h.label}: criar as skills novas do Hermes em ${target} (skills.create_dir)?`))) {
    backup();
    if (dryRun) return log.dry(`${cmd} config set skills.create_dir ${target}`);
    const set = hermes(['config', 'set', 'skills.create_dir', target]);
    const value = get('skills.create_dir').value;
    if (value && same(value, target)) log.ok(`${h.label}: skills.create_dir = ${value}`);
    else log.err(`${h.label}: ${cmd} config set falhou: ${(set.stderr || set.stdout).trim()}`);
  }
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
