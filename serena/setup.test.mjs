import assert from 'node:assert/strict';
import test from 'node:test';
import { readList } from './setup.mjs';

test('Serena: lista do YAML lida de volta igual ao que foi gravado', () => {
  // O setup grava cada item com JSON.stringify; no Windows a barra vira "\\" e precisa voltar a ser uma só.
  const win = ['trusted_project_path_patterns:', `- ${JSON.stringify('C:\\projetos\\**')}`, ''];
  assert.deepEqual(readList(win, 'trusted_project_path_patterns'), ['C:\\projetos\\**']);
  // Sem aspas ou com aspas simples, como o próprio Serena grava: fica como está.
  const plain = ['base_modes:', '- interactive', "- 'editing'", '- "projetos/**"', ''];
  assert.deepEqual(readList(plain, 'base_modes'), ['interactive', 'editing', 'projetos/**']);
});
