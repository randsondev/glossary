import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('OpenClaw: workspaces, regras preservadas, idempotência e raízes restritas', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-openclaw-'));
  // O registro em dry-run não roda o OpenClaw, mas exige o programa no PATH: um falso basta,
  // e o teste não depende de o OpenClaw estar instalado (no CI não está).
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'openclaw'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // No Windows o which() procura pelas extensões do PATHEXT.
  fs.writeFileSync(path.join(dir, 'bin', 'openclaw.cmd'), '@exit /b 0\r\n');
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { OPENCLAW_HOME, OPENCLAW_CONFIG, openclawWorkspaces, openclawHooksWired, wireOpenclawMcp } from './scripts/openclaw.mjs';
      import { wireAgentsMd, agentsMdStatus } from './scripts/agents-md.mjs';
      import { expectedLinks } from './scripts/link.mjs';
      import { CONFIG_DIR, resolveAgents } from './scripts/lib.mjs';
      const first = path.join(OPENCLAW_HOME, 'one');
      const second = path.join(OPENCLAW_HOME, 'two');
      fs.mkdirSync(first, { recursive: true });
      fs.mkdirSync(second, { recursive: true });
      const original = '# Minhas regras\n\nPreserve esta instrução.\n';
      for (const dir of [first, second]) fs.writeFileSync(path.join(dir, 'AGENTS.md'), original);
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify({
        agents: { defaults: { workspace: first }, entries: { main: {}, other: { workspace: second }, duplicate: { workspace: second } } },
        mcp: { servers: { unrelated: { command: 'preserve-me' } } }
      }));
      assert.deepEqual(resolveAgents('openclaw'), ['openclaw']);
      assert.deepEqual(openclawWorkspaces(), [first, second]);
      const before = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
      wireOpenclawMcp('ai-memory', { url: 'http://localhost/mcp', transport: 'streamable-http' }, { dryRun: true });
      assert.equal(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'), before);
      const plugin = path.join(OPENCLAW_HOME, 'plugin');
      fs.mkdirSync(plugin);
      fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify({ id: 'ai-memory' }));
      fs.writeFileSync(path.join(plugin, 'index.ts'), '// fixture');
      const config = JSON.parse(before);
      config.plugins = { load: { paths: [plugin] }, entries: { 'ai-memory': { enabled: true } } };
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config));
      assert.equal(openclawHooksWired(), false);
      config.plugins.entries['ai-memory'].hooks = { allowConversationAccess: true };
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config));
      assert.equal(openclawHooksWired(), true);
      config.plugins.allow = ['other'];
      fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config));
      assert.equal(openclawHooksWired(), false);
      wireAgentsMd({ agents: ['openclaw'], dryRun: true });
      assert.equal(fs.readFileSync(path.join(first, 'AGENTS.md'), 'utf8'), original);
      wireAgentsMd({ agents: ['openclaw'] });
      const wired = fs.readFileSync(path.join(first, 'AGENTS.md'), 'utf8');
      assert.ok(wired.startsWith(original));
      assert.ok(agentsMdStatus(['openclaw']).every(([, state]) => state === true));
      wireAgentsMd({ agents: ['openclaw'] });
      assert.equal(fs.readFileSync(path.join(first, 'AGENTS.md'), 'utf8'), wired);
      wireAgentsMd({ agents: ['openclaw'], unlink: true });
      for (const dir of [first, second]) assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), original);
      const restricted = path.join(OPENCLAW_HOME, 'restricted');
      fs.mkdirSync(path.join(restricted, 'private-fixture'), { recursive: true });
      fs.writeFileSync(path.join(restricted, 'private-fixture', 'SKILL.md'), '---\nname: private-fixture\ndescription: fixture\n---\n');
      fs.writeFileSync(path.join(CONFIG_DIR, 'roots.json'), JSON.stringify([{ dir: restricted, agents: ['claude'] }]));
      const links = expectedLinks(['openclaw']);
      assert.equal(links.length, 1);
      assert.ok(links[0].wanted.has('ponytail'));
      assert.ok(!links[0].wanted.has('private-fixture'));
      assert.equal(links[0].dir, path.join(process.env.HOME, '.agents', 'skills'));
    `], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), OPENCLAW_STATE_DIR: path.join(dir, '.openclaw'), OPENCLAW_CONFIG_PATH: path.join(dir, '.openclaw', 'openclaw.json') },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
