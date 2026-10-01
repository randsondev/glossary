#!/usr/bin/env node
// Agrupa memórias (arquivos .md) em skills: um SKILL.md curto + references/<memória>.md sem alteração.
//
//   node scripts/port-memories.mjs --map <mapa.json> --to <repo privado>/skills [--force] [--dry-run]
//
// Mapa (fica no repositório privado, nunca neste):
//   {
//     "from": "~/caminho/da/pasta/de/memorias",
//     "skills": {
//       "nome-da-skill": { "description": "Quando usar...", "memories": ["arquivo-sem-extensao", "..."] }
//     }
//   }
// As memórias originais não são movidas nem alteradas.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, expandHome, isMain, log, parseFrontmatter, readJSON, tilde } from './lib.mjs';

function summary(text) {
  const fm = parseFrontmatter(text);
  if (fm?.data.description) return String(fm.data.description).trim();
  const body = fm ? text.split(/\r?\n/).slice(fm.bodyStart) : text.split(/\r?\n/);
  return (body.find((l) => l.trim() && !l.startsWith('#')) || '').trim().slice(0, 200);
}

export function buildSkill(name, conf, memories) {
  const items = memories.map((m) => `- [${m.name}](references/${m.name}.md): ${m.summary}`);
  let description = conf.description;
  if (!description) {
    description = `Regras e contexto curados: ${memories.map((m) => m.summary).join(' ')}`;
    if (description.length > 1024) description = description.slice(0, 1021).trimEnd() + '...';
  }
  return [
    '---',
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    `# ${name}`,
    '',
    'Regras curadas a partir de memórias. Antes de agir, leia a referência que se aplica à tarefa.',
    '',
    ...items,
    '',
  ].join('\n');
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      map: { type: 'string' },
      to: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'allow-public': { type: 'boolean' },
    },
  });
  if (!values.map || !values.to) {
    console.log('uso: node scripts/port-memories.mjs --map <mapa.json> --to <repo privado>/skills [--force] [--dry-run]');
    process.exit(2);
  }
  const to = path.resolve(expandHome(values.to));
  if ((to === REPO || to.startsWith(REPO + path.sep)) && !values['allow-public']) {
    log.err('o destino está dentro deste repositório público; memórias vão para o repositório privado');
    process.exit(1);
  }
  const map = readJSON(path.resolve(expandHome(values.map)));
  const from = path.resolve(expandHome(map.from));
  let failed = false;
  for (const [name, conf] of Object.entries(map.skills)) {
    const dir = path.join(to, name);
    if (fs.existsSync(dir) && !values.force) {
      log.warn(`${tilde(dir)} já existe; use --force para refazer`);
      continue;
    }
    const memories = [];
    for (const m of conf.memories) {
      const src = path.join(from, `${m}.md`);
      if (!fs.existsSync(src)) {
        log.err(`${name}: memória não encontrada: ${tilde(src)}`);
        failed = true;
        continue;
      }
      memories.push({ name: m, src, summary: summary(fs.readFileSync(src, 'utf8')) });
    }
    if (values['dry-run']) {
      log.dry(`${tilde(dir)}: ${memories.length} referência(s)`);
      continue;
    }
    fs.rmSync(path.join(dir, 'references'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    for (const m of memories) fs.copyFileSync(m.src, path.join(dir, 'references', `${m.name}.md`));
    fs.writeFileSync(path.join(dir, 'SKILL.md'), buildSkill(name, conf, memories));
    log.ok(`${name}: ${memories.length} referência(s)`);
  }
  log.info('Confira com node scripts/validate.mjs (as raízes do roots.json entram na validação).');
  process.exit(failed ? 1 : 0);
}
