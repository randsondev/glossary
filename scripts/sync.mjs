#!/usr/bin/env node
// Atualiza as cópias de vendor/, o lock e as versões fixadas do ai-memory e do Serena.
//
//   node scripts/sync.mjs [--dry-run] [--only ponytail,mattpocock,ai-memory,serena] [--summary arquivo.md]
//
// Cada fonte de skills: clone raso e esparso, cópia fiel das skills listadas,
// LICENSE + NOTICE.md e sha256 de cada skill no sources.lock.json. No fim roda o
// guard em vendor/; se algo bater, sai com erro (a Action não abre o PR).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { guard } from './guard.mjs';
import { REPO, compareVersions, copyDir, hashDir, isMain, listSkills, log, readJSON, run, writeJSON } from './lib.mjs';

const SOURCES = path.join(REPO, 'sources.json');
const LOCK = path.join(REPO, 'sources.lock.json');

function git(args, cwd) {
  const r = run('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function curl(url) {
  const r = run('curl', ['-fsSL', '--retry', '3', url], { maxBuffer: 16 * 1024 * 1024 });
  return r.code === 0 ? r.stdout : null;
}

function fetchSource(src, tmp) {
  const dir = path.join(tmp, src.id);
  git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', src.ref, src.repo, dir]);
  let paths;
  if (src.dir) {
    git(['sparse-checkout', 'set', src.dir], dir);
    paths = listSkills(path.join(dir, src.dir)).map((s) => `${src.dir}/${s.name}`);
  } else if (src.pluginJson) {
    git(['sparse-checkout', 'set', path.posix.dirname(src.pluginJson)], dir);
    const plugin = JSON.parse(fs.readFileSync(path.join(dir, src.pluginJson), 'utf8'));
    paths = plugin.skills.map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''));
    git(['sparse-checkout', 'add', ...paths], dir);
  } else {
    paths = src.paths;
    git(['sparse-checkout', 'set', ...paths], dir);
  }
  const commit = git(['rev-parse', 'HEAD'], dir);
  const committed = git(['log', '-1', '--format=%cs'], dir);
  const license = fs.readdirSync(dir).find((f) => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(f));
  return { dir, paths, commit, committed, license };
}

function notice(src, fetched, skills) {
  const url = src.repo.replace(/\.git$/, '');
  const copyright = fetched.license
    ? fs.readFileSync(path.join(fetched.dir, fetched.license), 'utf8').split(/\r?\n/).find((l) => /copyright/i.test(l))?.trim()
    : null;
  return [
    `# ${src.id}`,
    '',
    `Cópia fiel, sem alterações, de skills de ${url}.`,
    '',
    `- Fonte: ${url}`,
    `- Commit: ${fetched.commit} (${fetched.committed})`,
    `- Licença: ${src.license}${copyright ? `, ${copyright}` : ''}. Texto completo em LICENSE.`,
    '- Atualizado por `scripts/sync.mjs`. Não edite à mão: o `validate.mjs` confere cada skill pelo `sources.lock.json`.',
    '',
    '| Skill | Caminho na fonte |',
    '|---|---|',
    ...skills.map((s) => `| ${s.name} | \`${s.path}\` |`),
    '',
  ].join('\n');
}

function syncSkills(src, lock, { dryRun, tmp, changes }) {
  log.step(`${src.id} (${src.repo})`);
  const fetched = fetchSource(src, tmp);
  const skills = fetched.paths.map((p) => ({ name: path.posix.basename(p), path: p, abs: path.join(fetched.dir, p) }));
  const missing = skills.filter((s) => !fs.existsSync(path.join(s.abs, 'SKILL.md')));
  if (missing.length) throw new Error(`sem SKILL.md: ${missing.map((s) => s.path).join(', ')}`);
  const names = skills.map((s) => s.name);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  if (dup.length) throw new Error(`nomes repetidos ao achatar: ${dup.join(', ')}`);

  const staging = path.join(tmp, `${src.id}-out`);
  fs.mkdirSync(staging);
  for (const s of skills) copyDir(s.abs, path.join(staging, s.name));
  if (fetched.license) fs.copyFileSync(path.join(fetched.dir, fetched.license), path.join(staging, 'LICENSE'));
  else log.warn('fonte sem arquivo LICENSE na raiz');
  fs.writeFileSync(path.join(staging, 'NOTICE.md'), notice(src, fetched, skills));

  const before = lock.skills[src.id]?.skills || {};
  const after = Object.fromEntries(skills.map((s) => [s.name, { path: s.path, sha256: hashDir(path.join(staging, s.name)) }]));
  const added = names.filter((n) => !before[n]);
  const removed = Object.keys(before).filter((n) => !after[n]);
  const changed = names.filter((n) => before[n] && before[n].sha256 !== after[n].sha256);
  const oldCommit = lock.skills[src.id]?.commit;
  log.info(`commit ${oldCommit ? oldCommit.slice(0, 7) + ' -> ' : ''}${fetched.commit.slice(0, 7)} (${fetched.committed})`);
  log.info(`${skills.length} skill(s): ${added.length} nova(s), ${changed.length} alterada(s), ${removed.length} removida(s)`);
  if (added.length || changed.length || removed.length)
    changes.push(
      `### ${src.id}\n\n${src.repo.replace(/\.git$/, '')}/compare/${oldCommit || fetched.commit}...${fetched.commit}\n\n` +
        [...added.map((n) => `- nova: \`${n}\``), ...changed.map((n) => `- alterada: \`${n}\``), ...removed.map((n) => `- removida: \`${n}\``)].join('\n'),
    );

  if (dryRun) return log.dry(`substituiria vendor/${src.id}/`);
  const dest = path.join(REPO, 'vendor', src.id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyDir(staging, dest);
  lock.skills[src.id] = { repo: src.repo, ref: src.ref, commit: fetched.commit, committed: fetched.committed, skills: after };
}

function latestTag(repo) {
  const out = git(['ls-remote', '--tags', '--refs', repo]);
  const tags = out
    .split('\n')
    .map((l) => l.split('refs/tags/')[1])
    .filter((t) => t && /^v\d+\.\d+\.\d+$/.test(t));
  return tags.sort(compareVersions).at(-1);
}

function syncAiMemory(sources, lock, { dryRun, changes }) {
  const conf = sources.aiMemory;
  log.step(`ai-memory (${conf.repo})`);
  const latest = latestTag(conf.repo) || conf.version;
  const candidates = compareVersions(latest, conf.version) > 0 ? [latest, conf.version] : [conf.version];
  for (const version of candidates) {
    if (version === lock.aiMemory?.version && version === conf.version) {
      log.ok(`${version} já fixada`);
      return;
    }
    const assets = {};
    for (const p of conf.platforms) {
      const name = `ai-memory-${p}.tar.gz`;
      const body = curl(`${conf.repo}/releases/download/${version}/${name}.sha256`);
      const hash = body && /^([0-9a-f]{64})\s/.exec(body)?.[1];
      if (!hash) {
        log.warn(`${version}: sem ${name}.sha256 (release ainda sem assets?)`);
        break;
      }
      assets[p] = hash;
    }
    if (Object.keys(assets).length !== conf.platforms.length) continue;
    if (version !== conf.version) changes.push(`### ai-memory\n\n${conf.version} -> ${version}: ${conf.repo}/releases/tag/${version}`);
    log.info(`${conf.version === version ? 'fixando' : `${conf.version} ->`} ${version}`);
    if (dryRun) return log.dry('atualizaria sources.json e sources.lock.json');
    conf.version = version;
    lock.aiMemory = { version, assets };
    return;
  }
  throw new Error('não consegui os sha256 de nenhuma release do ai-memory');
}

function syncSerena(sources, lock, { dryRun, changes }) {
  const conf = sources.serena;
  log.step(`Serena (${conf.package} no PyPI)`);
  const body = curl(`https://pypi.org/pypi/${conf.package}/json`);
  const latest = body ? JSON.parse(body).info.version : null;
  if (!latest) throw new Error('PyPI não respondeu');
  if (latest === conf.version && lock.serena?.version === latest) return log.ok(`${latest} já fixada`);
  if (latest !== conf.version) changes.push(`### Serena\n\n${conf.version} -> ${latest}: https://pypi.org/project/${conf.package}/${latest}/`);
  log.info(`${conf.version} -> ${latest}`);
  if (dryRun) return log.dry('atualizaria sources.json e sources.lock.json');
  conf.version = latest;
  lock.serena = { version: latest };
}

export function sync({ dryRun = false, only, summary } = {}) {
  const sources = readJSON(SOURCES);
  const lock = readJSON(LOCK, { skills: {} });
  lock.skills ||= {};
  const want = (id) => !only || only.includes(id);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-sync-'));
  const changes = [];
  try {
    for (const src of sources.skills) if (want(src.id)) syncSkills(src, lock, { dryRun, tmp, changes });
    // Fontes que saíram do sources.json: some a pasta e a entrada no lock.
    for (const id of Object.keys(lock.skills)) {
      if (sources.skills.some((s) => s.id === id) || !want(id)) continue;
      changes.push(`### ${id}\n\nfonte removida do sources.json`);
      if (dryRun) log.dry(`removeria vendor/${id}/`);
      else {
        fs.rmSync(path.join(REPO, 'vendor', id), { recursive: true, force: true });
        delete lock.skills[id];
      }
    }
    if (want('ai-memory')) syncAiMemory(sources, lock, { dryRun, changes });
    if (want('serena')) syncSerena(sources, lock, { dryRun, changes });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!dryRun) {
    writeJSON(SOURCES, sources);
    writeJSON(LOCK, lock);
  }
  if (summary) fs.writeFileSync(summary, changes.length ? changes.join('\n\n') + '\n' : 'Nada mudou.\n');
  log.step(changes.length ? `${changes.length} fonte(s) com mudança` : 'nada mudou');

  if (dryRun || !fs.existsSync(path.join(REPO, 'vendor'))) return 0;
  log.step('guard em vendor/');
  const g = guard({ mode: 'paths', paths: [path.join(REPO, 'vendor')], quiet: false });
  if (g !== 0) log.info('As cópias ficaram em vendor/ para inspeção. Para desfazer: git checkout -- vendor sources.json sources.lock.json');
  return g;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: { 'dry-run': { type: 'boolean' }, only: { type: 'string' }, summary: { type: 'string' } },
  });
  try {
    process.exit(sync({ dryRun: values['dry-run'], only: values.only?.split(','), summary: values.summary }));
  } catch (e) {
    log.err(e.message);
    process.exit(1);
  }
}
