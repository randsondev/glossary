#!/usr/bin/env node
// Converte comandos do Cursor (~/.cursor/commands/<nome>.md) em skills, sem reescrever o conteúdo.
//
//   node scripts/port-cursor-commands.mjs [--from ~/.cursor/commands] [--to skills] [--only a,b] [--force] [--dry-run]
//
// O corpo é copiado sem alteração e o nome continua o mesmo (/deploy continua /deploy).
// O frontmatter ganha name, uma description curta tirada do próprio texto e
// disable-model-invocation: true (a skill só roda quando chamada pelo nome).
// Depois de portar, rode o guard: comando com dado da empresa vai para o repositório privado (--to).
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { guard } from './guard.mjs';
import { REPO, expandHome, isMain, log, parseFrontmatter, tilde } from './lib.mjs';

const KEEP = ['description', 'argument-hint', 'allowed-tools', 'license', 'compatibility', 'metadata'];

// Primeira frase do primeiro parágrafo que não é título; sem parágrafo, o primeiro título.
export function deriveDescription(body) {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const text = lines.find((l) => l && !l.startsWith('#') && !l.startsWith('```') && !/^[-*_]{3,}$/.test(l));
  const heading = lines.find((l) => l.startsWith('#'));
  let d = (text || heading || '').replace(/^#+\s*/, '').replace(/^[-*>]\s+/, '');
  d = d.replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const sentence = /^(.{20,}?[.!?])(\s|$)/.exec(d)?.[1] || d;
  return sentence.length > 200 ? sentence.slice(0, 197).trimEnd() + '...' : sentence;
}

function yamlString(s) {
  return /^[\w ,()/-]+$/.test(s) && !/^\d/.test(s) ? s : JSON.stringify(s);
}

export function portCommand(text, name) {
  const fm = parseFrontmatter(text);
  const body = fm ? text.split(/\r?\n/).slice(fm.bodyStart).join('\n') : text;
  const kept = fm ? fm.keys.filter((k) => KEEP.includes(k) && typeof fm.data[k] === 'string') : [];
  const dropped = fm ? fm.keys.filter((k) => !KEEP.includes(k)) : [];
  const description = (fm?.data.description || deriveDescription(body)).trim();
  const head = ['---', `name: ${name}`, `description: ${yamlString(description)}`];
  for (const k of kept) if (k !== 'description') head.push(`${k}: ${yamlString(fm.data[k])}`);
  head.push('disable-model-invocation: true', '---');
  return { content: head.join('\n') + '\n' + (body.startsWith('\n') ? body.slice(1) : body), description, dropped };
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: '~/.cursor/commands' },
      to: { type: 'string', default: path.join(REPO, 'skills') },
      only: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  const from = path.resolve(expandHome(values.from));
  const to = path.resolve(expandHome(values.to));
  if (!fs.existsSync(from)) {
    log.err(`pasta não encontrada: ${tilde(from)}`);
    process.exit(1);
  }
  const only = values.only?.split(',');
  const files = fs.readdirSync(from).filter((f) => f.endsWith('.md') && (!only || only.includes(f.slice(0, -3))));
  const written = [];
  for (const file of files.sort()) {
    const raw = file.slice(0, -3);
    const name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (name !== raw) log.warn(`${raw}: nome normalizado para ${name} (o comando muda de /${raw} para /${name})`);
    const dest = path.join(to, name, 'SKILL.md');
    if (fs.existsSync(dest) && !values.force) {
      log.warn(`${tilde(dest)} já existe; use --force para sobrescrever`);
      continue;
    }
    const { content, description, dropped } = portCommand(fs.readFileSync(path.join(from, file), 'utf8'), name);
    if (dropped.length) log.warn(`${name}: campos do frontmatter descartados: ${dropped.join(', ')}`);
    if (values['dry-run']) {
      log.dry(`${tilde(dest)}  description: ${description}`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written.push(path.dirname(dest));
    log.ok(`${name}: ${description}`);
  }
  if (written.length && to.startsWith(REPO + path.sep)) {
    log.step('guard nas skills portadas');
    if (guard({ mode: 'paths', paths: written }) !== 0) {
      log.info('Essas skills não podem ir para o repositório público. Apague a pasta e porte de novo com --to <repo privado>/skills.');
      process.exit(1);
    }
  }
  log.info('Revise as descriptions geradas e rode node scripts/validate.mjs.');
}
