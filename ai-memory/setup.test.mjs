import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('MCP e ponte usam a porta configurada, mantendo o padrão sem config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glossary-memory-'));
  const homedir = os.homedir;
  // No Linux, XDG_DATA_HOME passaria na frente do home e tiraria os dados da pasta temporária.
  const xdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  // No Windows os dados ficam em %LOCALAPPDATA%, que não depende do home.
  const localAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(dir, 'AppData', 'Local');
  os.homedir = () => dir;
  try {
    const first = await import('./setup.mjs?default');
    assert.equal(first.MCP_URL, 'http://127.0.0.1:49374/mcp');
    // Primeira instalação com GLOSSARY_AI_MEMORY_BIND (teste de instalação): usa essa porta até o config existir.
    process.env.GLOSSARY_AI_MEMORY_BIND = '127.0.0.1:49399';
    assert.equal((await import('./setup.mjs?bind')).MCP_URL, 'http://127.0.0.1:49399/mcp');
    delete process.env.GLOSSARY_AI_MEMORY_BIND;
    assert.ok(first.paths.data.startsWith(dir + path.sep), 'dados do teste devem ficar na pasta temporária');
    fs.mkdirSync(first.paths.data, { recursive: true });
    const cases = [
      ['# bind = "127.0.0.1:49374"\nbind = "127.0.0.1:49375"\n[auth]\nbind = "ignored"', 'http://127.0.0.1:49375/mcp'],
      ["bind = '127.0.0.1:49376'", 'http://127.0.0.1:49376/mcp'],
      ['bind = "127.0.0.1:49375"\nserver_url = "http://localhost:49375/"', 'http://localhost:49375/mcp'],
    ];
    for (const [i, [config, url]] of cases.entries()) {
      fs.writeFileSync(path.join(first.paths.data, 'config.toml'), config);
      const setup = await import(`./setup.mjs?case=${i}`);
      assert.equal(setup.MCP_URL, url);
      assert.equal(setup.BRIDGE_ARGS.at(-1), url);
    }

    // Agente gravado com a porta antiga não conta como ligado, para o ./install.sh gravar de novo.
    const setup = await import('./setup.mjs?case=0');
    const [mcp, hooks, toml] = ['mcp.json', 'hooks.json', 'codex.toml'].map((f) => path.join(dir, f));
    for (const [port, expected] of [[49374, false], [49375, true]]) {
      const url = `http://127.0.0.1:${port}`;
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { 'ai-memory': { url: `${url}/mcp` } } }));
      fs.writeFileSync(toml, `[mcp_servers.ai-memory]\nargs = ["mcp-bridge","--server-url","${url}/mcp"]\n`);
      fs.writeFileSync(hooks, `ai-memory hook --event stop --agent claude-code --server-url ${url}`);
      assert.equal(setup.wired('claude', [mcp, hooks]), expected, `claude na porta ${port}`);
      assert.equal(setup.wired('codex', [toml, hooks]), expected, `codex na porta ${port}`);
      // O Cursor grava o hooks.json com a barra escapada.
      fs.writeFileSync(hooks, JSON.stringify({ command: `ai-memory hook --server-url ${url}` }).replaceAll('/', '\\/'));
      assert.equal(setup.wired('cursor', [mcp, hooks]), expected, `cursor (barra escapada) na porta ${port}`);
      // Instalação com token: o ai-memory grava a ponte stdio, sem o campo url.
      fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { 'ai-memory': { type: 'stdio', command: 'ai-memory', args: ['mcp-bridge', '--server-url', `${url}/mcp`] } } }));
      assert.equal(setup.wired('cursor', [mcp, hooks]), expected, `cursor (ponte stdio) na porta ${port}`);
      // Windows: o hook do Claude Code na forma exec, com o endereço no args.
      fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'C:\\ai-memory.exe', args: ['hook', '--event', 'stop', '--server-url', url] }] }] } }, null, 2));
      assert.equal(setup.wired('claude', [mcp, hooks]), expected, `claude (forma exec do Windows) na porta ${port}`);
      // Windows: o hook do Cursor numa linha só, com o caminho e o endereço entre aspas.
      fs.writeFileSync(hooks, JSON.stringify({ hooks: { stop: [{ type: 'command', command: `"C:\\ai-memory.exe" --data-dir "C:\\dados" hook --event stop --agent cursor --server-url "${url}"` }] } }));
      assert.equal(setup.wired('cursor', [mcp, hooks]), expected, `cursor (endereço entre aspas no Windows) na porta ${port}`);
    }

    // Hook do ai-memory que ficou na porta antiga sai; o da porta atual e os de outras ferramentas ficam.
    const cmd = (port) => ({ type: 'command', command: `ai-memory hook --event x --server-url http://127.0.0.1:${port}` });
    fs.writeFileSync(hooks, JSON.stringify({ hooks: {
      SubagentStart: [{ hooks: [cmd(49374)] }],
      Stop: [{ hooks: [cmd(49375), { type: 'command', command: 'outro-hook' }, cmd(49374)] }],
    } }));
    setup.dropStaleHooks(hooks);
    assert.deepEqual(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks, { Stop: [{ hooks: [cmd(49375), { type: 'command', command: 'outro-hook' }] }] });
    // O mesmo com a forma exec do Windows.
    const exec = (port) => ({ type: 'command', command: 'C:\\ai-memory.exe', args: ['hook', '--server-url', `http://127.0.0.1:${port}`] });
    fs.writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [exec(49374), exec(49375)] }] } }));
    setup.dropStaleHooks(hooks);
    assert.deepEqual(JSON.parse(fs.readFileSync(hooks, 'utf8')).hooks, { Stop: [{ hooks: [exec(49375)] }] });
  } finally {
    os.homedir = homedir;
    if (xdg !== undefined) process.env.XDG_DATA_HOME = xdg;
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
