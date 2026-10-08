# glossary

Skills e memória compartilhadas por **Claude Code, Cursor, Hermes e OpenClaude**, montadas de uma vez só.

- **Skills**: as próprias (`skills/`) e as de terceiros (`vendor/`, cópia fiel com lockfile) numa pasta só, ligadas por symlink onde cada agente lê. Atualizar é `git pull`.
- **Memória**: o [ai-memory](https://github.com/akitaonrails/ai-memory) captura as sessões de todos os agentes num servidor local. Dá para largar uma tarefa num agente e continuar em outro.
- **Navegação de código**: o [Serena](https://github.com/oraios/serena) busca e edita símbolos via language server, em vez de ler arquivos inteiros.

As três partes são independentes. O passo a passo está em [docs/PASSO-A-PASSO.md](docs/PASSO-A-PASSO.md), e os detalhes em [docs/AVANCADO.md](docs/AVANCADO.md).

## Começo rápido

```bash
git clone https://github.com/randsondev/glossary.git ~/projetos/glossary
cd ~/projetos/glossary
./install.sh
```

O instalador confere os pré-requisitos (git e Node 20+), faz as poucas perguntas no começo, roda tudo na ordem certa e termina com uma conferência. O passo a passo, com o que responder em cada pergunta, está em [docs/PASSO-A-PASSO.md](docs/PASSO-A-PASSO.md). Para conferir depois: `node glossary.mjs --check`. Para atualizar: `git pull && ./install.sh --yes`.

## Onde cada agente lê

| Agente | Skills | Memória (ai-memory) | Serena |
|---|---|---|---|
| Claude Code | `~/.claude/skills` | MCP + hooks | MCP, contexto `claude-code` |
| Cursor | `~/.agents/skills` (e `~/.claude/skills`) | MCP + hooks | MCP, contexto `ide` |
| Hermes | `~/.agents/skills` via `skills.external_dirs` | só MCP | MCP, contexto `ide` |
| OpenClaude | `~/.openclaude/skills` | só MCP | MCP, contexto `claude-code` |

## Estrutura

```
skills/<nome>/SKILL.md          skills próprias (ex.: comandos do Cursor portados)
vendor/<fonte>/<nome>/          cópia fiel das fontes + LICENSE + NOTICE.md
sources.json                    fontes de skills e versões fixadas do ai-memory e do Serena
sources.lock.json               commit de cada fonte e sha256 de cada skill e de cada binário
link.json                       pastas de destino por agente e exclusões
install.sh                      instalação guiada (chama scripts/install.mjs)
glossary.mjs                    roda tudo em sequência (idempotente, --dry-run, --check)
scripts/check.mjs               confere a instalação inteira, sem alterar nada
scripts/private.mjs             repositório privado: cria e leva para outro computador (--export/--import)
scripts/validate.mjs            regras das skills (estritas nas próprias)
scripts/link.mjs                symlinks nas pastas dos agentes (--unlink desfaz)
scripts/sync.mjs                atualiza vendor/ e as versões (o PR semanal usa este)
scripts/guard.mjs               trava contra vazamento (pre-commit e CI)
scripts/port-cursor-commands.mjs, scripts/port-memories.mjs
ai-memory/setup.mjs             instala, sobe o serviço e liga os agentes
ai-memory/history.mjs           leva para a memória as conversas e memórias que o Claude Code já guardou
ai-memory/dedupe.mjs            corrige o histórico importado mais de uma vez
serena/setup.mjs                ajusta a config do Serena e registra o MCP
templates/skill/SKILL.md        modelo para skill nova
```

## Fontes de terceiros

| Fonte | Licença | O que entra |
|---|---|---|
| [dietrichgebert/ponytail](https://github.com/dietrichgebert/ponytail) | MIT | as skills de `skills/` |
| [mattpocock/skills](https://github.com/mattpocock/skills) | MIT | as do `plugin.json` (engineering + productivity) |
| [github/awesome-copilot](https://github.com/github/awesome-copilot) | MIT | só `salesforce-apex-quality`, `salesforce-component-standards`, `salesforce-flow-design` |

Cada pasta de `vendor/` traz a LICENSE original e um NOTICE.md com o commit de origem. Não edite `vendor/` à mão: o `validate.mjs` confere o conteúdo pelo lock.
