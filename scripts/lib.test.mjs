import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WIN, linkDir, linkFile, linksTo, nodeCommand, run, which } from './lib.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-lib-'));

test('links de pasta e de arquivo: criados, reconhecidos e removidos sem tocar no original', () => {
  const dir = tmp();
  try {
    const skill = path.join(dir, 'skill');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'x');
    const link = path.join(dir, 'link');
    linkDir(skill, link);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(path.resolve(dir, fs.readlinkSync(link)), skill);
    assert.ok(fs.existsSync(path.join(link, 'SKILL.md')));
    fs.unlinkSync(link);
    assert.ok(fs.existsSync(path.join(skill, 'SKILL.md')));

    const original = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(original, 'a');
    const copy = path.join(dir, 'CLAUDE.md');
    linkFile(original, copy);
    assert.ok(linksTo(copy, original));
    // Regravado no lugar (como o agents-md.mjs faz), o link acompanha, seja symlink ou hard link.
    fs.writeFileSync(original, 'b');
    assert.equal(fs.readFileSync(copy, 'utf8'), 'b');
    fs.writeFileSync(path.join(dir, 'outro.md'), 'b');
    assert.ok(!linksTo(path.join(dir, 'outro.md'), original));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: which acha o .cmd e ignora o script de sh sem extensão', { skip: !WIN }, () => {
  const dir = tmp();
  const PATH = process.env.PATH;
  try {
    fs.writeFileSync(path.join(dir, 'ferramenta'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'ferramenta.ps1'), '');
    fs.writeFileSync(path.join(dir, 'ferramenta.cmd'), '@echo off\r\n');
    process.env.PATH = `${dir}${path.delimiter}${PATH}`;
    assert.equal(which('ferramenta'), path.join(dir, 'ferramenta.cmd'));
    assert.equal(which('nao-existe-em-lugar-nenhum'), null);
  } finally {
    process.env.PATH = PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: .cmd recebe os argumentos intactos, com espaço, aspas e metacaracteres do cmd', { skip: !WIN }, () => {
  const dir = tmp();
  try {
    // O .cmd repassa os argumentos a um node que os imprime em JSON: é o caminho dos CLIs do npm.
    const echo = path.join(dir, 'echo.mjs');
    fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const cmd = path.join(dir, 'com espaço.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${echo}" %*\r\n`);
    const args = ['mcp', 'add', '--', 'C:\\Program Files\\x.exe', '{"url":"http://a/b"}', 'a&b|c', '100%', 'fim\\'];
    const r = run(cmd, args);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), args);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows: comando de hook com barras normais, sem aspas no começo', { skip: !WIN }, () => {
  const c = nodeCommand('C:\\projetos\\glossary\\scripts\\agents-md.mjs');
  assert.ok(!c.includes('\\'), c);
  assert.ok(!c.startsWith('"'), c);
  assert.ok(c.endsWith(' C:/projetos/glossary/scripts/agents-md.mjs'), c);
  assert.ok(nodeCommand('C:\\com espaço\\x.mjs').endsWith(' "C:/com espaço/x.mjs"'));
});
