// Repositório privado (skills com dado da empresa) e config local: criar numa máquina nova e
// levar de um computador para outro. Nada disso passa por servidor: fica só nas máquinas.
//
//   ./install.sh --export             gera ~/glossary-privado.tar.gz (repositório privado + config local)
//   ./install.sh --import <arquivo>   desempacota esse pacote neste computador e segue com a instalação
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, CONFIG_DIR, HOME, REPO, die, expandHome, extraRoots, listSkills, log, readJSON, run, tilde, writeJSON } from './lib.mjs';

// Os repositórios ficam ao lado do glossary (ex.: ~/projetos/glossary-internal).
const BASE = path.dirname(REPO);
export const PRIVATE_DIR = path.join(BASE, 'glossary-internal');
export const ROOTS_FILE = path.join(CONFIG_DIR, 'roots.json');
export const DENY_FILE = path.join(CONFIG_DIR, 'guard-deny.txt');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

const README = `# glossary-internal

Skills com dado da empresa. Este repositório fica só nesta máquina: não adicione remote e não envie
para servidor nenhum. Para levar a outro computador: \`./install.sh --export\` no glossary.

- Uma pasta por skill: \`skills/<nome>/SKILL.md\` (modelo em \`templates/skill\` do glossary).
- Depois de criar ou remover uma skill, rode \`node scripts/link.mjs\` no glossary.
- As skills daqui só vão para os agentes listados em \`~/.config/glossary/roots.json\`.
`;

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// Agentes que podem receber dados da empresa: o OpenClaude só entra se for confiável.
const trustedAgents = (openclaude) => (openclaude ? AGENTS : AGENTS.filter((a) => a !== 'openclaude'));

// Garante um repositório privado registrado no roots.json. Numa máquina nova, cria um vazio.
// openclaude: true/false aplica a resposta da instalação; undefined mantém o que já está gravado.
export function setupPrivateRepo({ openclaude } = {}) {
  const roots = extraRoots();
  const agents = trustedAgents(Boolean(openclaude));
  if (roots.length) {
    for (const r of roots.filter((r) => !fs.existsSync(r.dir))) {
      fs.mkdirSync(r.dir, { recursive: true });
      log.warn(`${tilde(r.dir)} não existia; criei a pasta vazia`);
    }
    // A resposta sobre o OpenClaude vale para todas as raízes privadas desta máquina.
    const key = (list) => [...(list || AGENTS)].sort().join(',');
    if (openclaude !== undefined && roots.some((r) => key(r.agents) !== key(agents))) {
      writeJSON(ROOTS_FILE, roots.map((r) => ({ dir: tilde(r.dir), agents })));
      log.ok(`skills privadas ${openclaude ? 'também no OpenClaude' : 'fora do OpenClaude'}`);
    }
    return;
  }
  const skills = path.join(PRIVATE_DIR, 'skills');
  fs.mkdirSync(skills, { recursive: true });
  if (!fs.existsSync(path.join(PRIVATE_DIR, 'README.md'))) fs.writeFileSync(path.join(PRIVATE_DIR, 'README.md'), README);
  if (!fs.existsSync(path.join(PRIVATE_DIR, '.git'))) run('git', ['init', '-q', PRIVATE_DIR]);
  writeJSON(ROOTS_FILE, [{ dir: tilde(skills), agents }]);
  log.ok(`${tilde(PRIVATE_DIR)}: repositório privado criado (só nesta máquina)`);
}

export function writeDenyTerms(terms) {
  const current = fs.existsSync(DENY_FILE) ? fs.readFileSync(DENY_FILE, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  writePrivate(DENY_FILE, [...new Set([...current, ...terms])].join('\n') + '\n');
}

// Só o README e o .git sem nenhum commit, com a pasta skills vazia: o que setupPrivateRepo cria.
function isBlankRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  const skills = path.join(dir, 'skills');
  const others = fs.readdirSync(dir).filter((e) => !['.git', 'README.md', 'skills'].includes(e));
  const noSkills = !fs.existsSync(skills) || fs.readdirSync(skills).length === 0;
  const noCommits = run('git', ['-C', dir, 'rev-parse', '-q', '--verify', 'HEAD']).code !== 0;
  return !others.length && noSkills && noCommits;
}

const tar = (args) => {
  const r = run('tar', args);
  if (r.code !== 0) die(`tar falhou: ${(r.stderr || r.stdout).trim()}`);
};

export function exportPrivate(out = path.join(HOME, 'glossary-privado.tar.gz')) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'));
  try {
    const manifest = { base: tilde(BASE), roots: [] };
    for (const r of extraRoots().filter((r) => fs.existsSync(r.dir))) {
      // O repositório inteiro, com o histórico do git, e não só a pasta das skills.
      const repo = path.basename(r.dir) === 'skills' ? path.dirname(r.dir) : r.dir;
      const name = path.basename(repo);
      if (!manifest.roots.some((x) => x.repo === name))
        fs.cpSync(repo, path.join(stage, 'repos', name), { recursive: true, verbatimSymlinks: true });
      manifest.roots.push({ repo: name, sub: path.relative(repo, r.dir), agents: r.agents });
    }
    // install.json fica de fora: guarda os agentes desta máquina, e no outro computador podem ser outros.
    const configs = ['guard-deny.txt', 'projects.json'].filter((f) => fs.existsSync(path.join(CONFIG_DIR, f)));
    fs.mkdirSync(path.join(stage, 'config'));
    for (const f of configs) fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(stage, 'config', f));
    if (!manifest.roots.length && !configs.length) die('nada para levar: não há repositório privado nem config local');
    writeJSON(path.join(stage, 'manifest.json'), manifest);
    tar(['czf', out, '-C', stage, '.']);
    fs.chmodSync(out, 0o600);
    const skills = manifest.roots.reduce((n, r) => n + listSkills(path.join(stage, 'repos', r.repo, r.sub)).length, 0);
    log.ok(`${tilde(out)}: ${skills} skill(s) privada(s) e ${configs.length} arquivo(s) de config`);
    log.warn('O pacote tem dados da empresa. Leve por pendrive ou pela rede local (scp), nunca por nuvem, e-mail ou mensageiro.');
    log.info(`No outro computador: ./install.sh --import ${tilde(out)}. Depois apague o pacote nos dois.`);
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function importPrivate(file) {
  file = path.resolve(expandHome(file));
  if (!fs.existsSync(file)) die(`${tilde(file)} não existe`);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-'));
  try {
    tar(['xzf', file, '-C', stage]);
    const manifest = readJSON(path.join(stage, 'manifest.json'), null);
    if (!manifest) die(`${tilde(file)} não é um pacote gerado por ./install.sh --export`);
    log.step('Importar o pacote do outro computador');

    for (const name of new Set(manifest.roots.map((r) => r.repo))) {
      const dest = path.join(BASE, name);
      // O repositório vazio que o instalador cria numa máquina nova é trocado pelo do pacote.
      // Qualquer outra coisa que já exista aqui é renomeada e fica guardada; nada é apagado.
      if (isBlankRepo(dest)) fs.rmSync(dest, { recursive: true, force: true });
      else if (fs.existsSync(dest)) {
        const aside = `${dest}.antes-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`;
        fs.renameSync(dest, aside);
        log.warn(`${tilde(dest)} já existia; guardei como ${tilde(aside)}`);
      }
      fs.cpSync(path.join(stage, 'repos', name), dest, { recursive: true, verbatimSymlinks: true });
      log.ok(`${tilde(dest)}: repositório privado`);
    }
    if (manifest.roots.length)
      writeJSON(ROOTS_FILE, manifest.roots.map((r) => ({ dir: tilde(path.join(BASE, r.repo, r.sub)), ...(r.agents && { agents: r.agents }) })));

    const deny = path.join(stage, 'config', 'guard-deny.txt');
    if (fs.existsSync(deny)) {
      writeDenyTerms(fs.readFileSync(deny, 'utf8').split(/\r?\n/).filter(Boolean));
      log.ok(`${tilde(DENY_FILE)}: termos da empresa para a trava de commit`);
    }

    // Projetos da empresa: o caminho é refeito a partir da pasta do glossary nesta máquina
    // (ex.: ~/projetos/x no Mac vira ~/Projects/x aqui). Só entram os que já existem aqui.
    const incoming = readJSON(path.join(stage, 'config', 'projects.json'), { projects: [] }).projects || [];
    const local = readJSON(PROJECTS_FILE, { projects: [] });
    local.projects ||= [];
    const have = new Set(local.projects.map((p) => path.resolve(expandHome(p.dir))));
    const from = path.resolve(expandHome(manifest.base || '~'));
    for (const p of incoming) {
      const src = path.resolve(expandHome(p.dir));
      const dir = src.startsWith(from + path.sep) ? path.join(BASE, path.relative(from, src)) : src;
      if (have.has(dir)) continue;
      if (!fs.existsSync(dir)) {
        log.warn(`${tilde(dir)} não existe aqui; clone o projeto e rode ./install.sh para adicioná-lo`);
        continue;
      }
      local.projects.push({ ...p, dir: tilde(dir) });
      have.add(dir);
      log.ok(`${tilde(dir)}: projeto da empresa`);
    }
    if (local.projects.length) writeJSON(PROJECTS_FILE, local);
    log.info(`Pode apagar o pacote: rm ${tilde(file)}`);
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
