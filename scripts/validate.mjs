#!/usr/bin/env node
// Valida as skills de todas as raízes.
//
//   node scripts/validate.mjs [--skills-ref] [--no-extra]
//
// Skills próprias (skills/ e raízes do roots.json): regras estritas, erro.
// Skills de vendor/: as mesmas regras só avisam, mas o conteúdo tem de bater com o lock.
// Em todas: nenhum nome repetido entre raízes nem com skills embutidas dos agentes.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CODEX_POLICY_FILE,
  REPO,
  hashDir,
  isMain,
  listSkills,
  log,
  needsCodexPolicy,
  parseFrontmatter,
  readJSON,
  run,
  skillRoots,
  which,
} from './lib.mjs';

const SPEC_FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const EXTRA_FIELDS = ['disable-model-invocation', 'argument-hint'];
const ALLOWED = new Set([...SPEC_FIELDS, ...EXTRA_FIELDS]);
const MAX_LINES = 500;

export function checkSkill(skill) {
  const problems = [];
  const file = path.join(skill.dir, 'SKILL.md');
  const text = fs.readFileSync(file, 'utf8');
  const fm = parseFrontmatter(text);
  if (!fm) return ['SKILL.md sem frontmatter (--- no topo)'];
  const extra = fm.keys.filter((k) => !ALLOWED.has(k));
  if (extra.length) problems.push(`campo(s) não permitido(s): ${extra.join(', ')}`);
  const { name, description } = fm.data;
  if (typeof name !== 'string' || !name) problems.push('falta "name"');
  else {
    if (name !== skill.name) problems.push(`"name" (${name}) diferente do nome da pasta (${skill.name})`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) problems.push(`"name" fora do padrão a-z0-9- : ${name}`);
    if (name.length > 64) problems.push(`"name" com ${name.length} caracteres (máx. 64)`);
  }
  if (typeof description !== 'string' || !description.trim()) problems.push('falta "description"');
  else if (description.length > 1024) problems.push(`"description" com ${description.length} caracteres (máx. 1024)`);
  const lines = text.split(/\r?\n/).length;
  if (lines > MAX_LINES) problems.push(`SKILL.md com ${lines} linhas (máx. ${MAX_LINES})`);
  return problems;
}

// Validador oficial (agentskills.io). Ele não conhece os dois campos extras que
// aceitamos de propósito; esse aviso específico é ignorado, o resto vira erro.
function skillsRef(skill) {
  const bin = which('skills-ref') || which('agentskills');
  if (!bin) return null;
  const r = run(bin, ['validate', skill.dir]);
  if (r.code === 0) return [];
  return (r.stdout + r.stderr)
    .split(/\r?\n/)
    .filter((l) => /^\s+-\s/.test(l))
    .map((l) => l.replace(/^\s+-\s/, '').trim())
    .filter((l) => {
      const m = /^Unexpected fields in frontmatter: ([^.]+)\./.exec(l);
      return !(m && m[1].split(',').every((f) => EXTRA_FIELDS.includes(f.trim())));
    });
}

export function validate({ useSkillsRef = false, includeExtra = true } = {}) {
  let errors = 0;
  let warnings = 0;
  const error = (s) => (errors++, log.err(s));
  const warn = (s) => (warnings++, log.warn(s));

  const roots = skillRoots({ includeExtra });
  const seen = new Map();
  const lock = readJSON(path.join(REPO, 'sources.lock.json'), { skills: {} });
  let refMissing = false;

  for (const root of roots) {
    if (root.extra && !fs.existsSync(root.dir)) {
      error(`raiz do roots.json não existe: ${root.label}`);
      continue;
    }
    const skills = listSkills(root.dir);
    for (const skill of skills) {
      const where = `${root.label}/${skill.name}`;
      if (seen.has(skill.name)) error(`nome repetido: ${where} e ${seen.get(skill.name)}`);
      else seen.set(skill.name, where);
      for (const p of checkSkill(skill)) (root.own ? error : warn)(`${where}: ${p}`);
      // Só nas skills do repositório: nas raízes privadas o link.mjs cria o arquivo sozinho.
      if (root.label === 'skills' && needsCodexPolicy(skill.dir))
        error(`${where}: falta ${CODEX_POLICY_FILE} (o Codex ignora disable-model-invocation); rode node scripts/link.mjs`);
      if (useSkillsRef && root.own) {
        const ref = skillsRef(skill);
        if (ref === null) refMissing = true;
        else for (const p of ref) error(`${where}: skills-ref: ${p}`);
      }
    }
    if (root.source) {
      const locked = lock.skills?.[root.source]?.skills || {};
      const names = new Set(skills.map((s) => s.name));
      for (const skill of skills) {
        if (!locked[skill.name]) error(`${root.label}/${skill.name}: não está no sources.lock.json (rode scripts/sync.mjs)`);
        else if (hashDir(skill.dir) !== locked[skill.name].sha256)
          error(`${root.label}/${skill.name}: conteúdo difere do lock. vendor/ é cópia fiel; edite na fonte ou rode scripts/sync.mjs`);
      }
      for (const name of Object.keys(locked)) if (!names.has(name)) error(`${root.label}/${name}: está no lock mas a pasta sumiu`);
    }
  }
  if (refMissing) error('--skills-ref pedido, mas skills-ref não está instalado (uv tool install skills-ref)');

  // Skills embutidas: um nome igual esconderia a do agente (ou seria escondido por ela).
  const conf = readJSON(path.join(REPO, 'link.json'));
  for (const [agent, builtins] of Object.entries(conf.builtins || {})) {
    for (const name of builtins) {
      if (!seen.has(name)) continue;
      const leaking = conf.targets.filter(
        (t) => (t.agents.includes(agent) || (t.alsoReadBy || []).includes(agent)) && !(t.exclude || []).includes(name),
      );
      for (const t of leaking)
        error(`${seen.get(name)}: mesmo nome da skill embutida "${name}" do ${agent} e iria para ${t.dir}; exclua em link.json`);
    }
  }

  const total = seen.size;
  if (errors) log.err(`validate: ${errors} erro(s), ${warnings} aviso(s) em ${total} skill(s)`);
  else log.ok(`validate: ${total} skill(s), ${warnings} aviso(s) em vendor`);
  return errors ? 1 : 0;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { 'skills-ref': { type: 'boolean' }, 'no-extra': { type: 'boolean' } } });
  process.exit(validate({ useSkillsRef: values['skills-ref'], includeExtra: !values['no-extra'] }));
}
