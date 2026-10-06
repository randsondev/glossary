#!/usr/bin/env node
// Corrige o histórico importado mais de uma vez na memória dos projetos da empresa.
//
// O ai-memory não reconhece conversas repetidas: cada "backfill --force" importa de novo todas as
// conversas antigas da pasta, e uma sessão que os hooks já tinham capturado também entra outra vez.
// Para cada projeto do projects.json, este script apaga as sessões que têm a conversa original no
// disco e importa cada uma de novo, uma vez só. Antes de mudar qualquer coisa, faz um backup completo.
//
//   node ai-memory/dedupe.mjs           mostra o que faria (não altera nada)
//   node ai-memory/dedupe.mjs --apply   faz o backup e corrige
//
// Feche as sessões do Claude Code e do Cursor nessas pastas antes de rodar com --apply.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HOME, confirm, die, exists, isMain, localProjects, log, run, setAssumeYes, tilde } from '../scripts/lib.mjs';
import { BIN } from './setup.mjs';

const observations = () => /observations:\s+(\d+)/.exec(run(BIN, ['status']).stdout)?.[1] ?? '?';

// Sessões que estão na memória e têm a conversa original no disco. O reparo de horários, em modo de
// simulação, cruza as duas coisas pelo id da sessão sem alterar nada.
function sessionsWithTranscript(cwd) {
  const r = run(BIN, ['repair-backfill-timestamps', '--json'], { cwd });
  if (r.code !== 0) return null;
  const [report] = JSON.parse(r.stdout);
  return [
    ...report.repaired.map((s) => s.session_id),
    ...report.skipped.filter((s) => s.reason !== 'not_found').map((s) => s.session_id),
  ];
}

export async function dedupe({ apply = false } = {}) {
  if (!exists(BIN)) die('ai-memory não instalado (rode ./install.sh)');
  const projects = localProjects().filter((p) => p.aiMemory && exists(p.dir));
  if (!projects.length) {
    log.info('nenhum projeto da empresa no projects.json');
    return 0;
  }

  log.step('Sessões para importar de novo');
  const plan = [];
  for (const p of projects) {
    const ids = sessionsWithTranscript(p.dir);
    if (!ids) die(`não consegui listar as sessões de ${tilde(p.dir)} (o servidor está no ar? node glossary.mjs --check)`);
    log.info(`${tilde(p.dir)}: ${ids.length}`);
    if (ids.length) plan.push({ dir: p.dir, ids });
  }
  const before = observations();
  log.info(`observações na memória agora: ${before}`);
  if (!plan.length) return 0;
  if (!apply) {
    log.info('Nada foi alterado. Para corrigir: node ai-memory/dedupe.mjs --apply');
    return 0;
  }

  log.warn('Feche as sessões do Claude Code e do Cursor nessas pastas antes de continuar.');
  if (!(await confirm('Fazer o backup e corrigir agora?'))) return 1;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const backup = path.join(HOME, `ai-memory-backup-${stamp}.tar.gz`);
  if (exists(backup)) die(`${tilde(backup)} já existe; rode de novo em alguns segundos`);
  const b = run(BIN, ['backup', '--to', backup]);
  if (b.code !== 0) die(`o backup falhou, nada foi alterado: ${(b.stderr || b.stdout).trim().split('\n').pop()}`);
  log.ok(`backup em ${tilde(backup)}`);

  let failed = 0;
  for (const { dir, ids } of plan) {
    log.step(tilde(dir));
    for (const [i, id] of ids.entries()) {
      // Só importa de novo o que conseguiu apagar; se o apagar falhar, a sessão fica como estava.
      let r = run(BIN, ['purge-session', '--session-id', id, '--confirm'], { cwd: dir });
      if (r.code === 0) r = run(BIN, ['backfill', '--session', id, '--force'], { cwd: dir });
      if (r.code !== 0) {
        failed++;
        log.err(`sessão ${id}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
      } else if (process.stdout.isTTY) process.stdout.write(`\r    ${i + 1}/${ids.length}`);
    }
    if (process.stdout.isTTY) process.stdout.write('\n');
    log.ok(`${ids.length - failed} sessão(ões) importadas uma vez só`);
  }
  log.info(`observações na memória: ${before} -> ${observations()}`);
  if (failed) {
    log.err(`${failed} sessão(ões) falharam. O backup está em ${tilde(backup)}; para voltar a ele, veja "Desfazer" em docs/AVANCADO.md.`);
    return 1;
  }
  log.ok(`pronto. Quando conferir que está tudo certo, pode apagar o backup: rm ${tilde(backup)}`);
  return 0;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean' }, yes: { type: 'boolean' } } });
  if (values.yes) setAssumeYes(true);
  process.exit(await dedupe({ apply: values.apply }));
}
