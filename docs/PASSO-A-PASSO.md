# Passo a passo

O setup de IA do time na sua máquina, com um comando. Funciona com **Claude Code, Cursor, Hermes e OpenClaude**, no macOS (e no Linux).

Você ganha três coisas:

- **Skills**: as mesmas instruções prontas (`/ponytail-review`, `/tdd`, `/deploy`...) em todos os agentes.
- **Memória compartilhada**: comece uma tarefa no Claude Code e continue no Cursor sem explicar tudo de novo.
- **Serena** (opcional): o agente acha métodos e referências pelo nome, em vez de ler arquivos inteiros.

## Antes de começar

- `git` e Node.js 20 ou mais novo. No macOS: `xcode-select --install` e `brew install node`.
- Pelo menos um dos quatro agentes instalado.
- Para o Serena: `brew install uv`. Sem ele, o resto funciona normalmente.

## Instalar

```bash
git clone https://github.com/randsondev/glossary.git ~/projetos/glossary
cd ~/projetos/glossary
./install.sh
```

As perguntas vêm todas no começo. Depois disso a instalação roda sozinha, em poucos minutos.

| Pergunta | O que responder |
|---|---|
| **Pasta de um projeto da empresa** | O caminho de cada projeto da empresa, um por vez (ex.: `~/projetos/meu-projeto`). Enter quando acabar. Esses projetos ficam com a memória separada dos pessoais. |
| **Nome do workspace da empresa** | Um nome curto, em minúsculas (ex.: `minhaempresa`). Só aparece na primeira vez. |
| **Ligar a memória no OpenClaude?** | Enter (não). Só responda `s` se ele usar apenas provedores confiáveis. |
| **Instalar o Serena?** | Enter (sim). Só aparece se você tiver o `uv`. |
| **Importar o histórico?** | Enter (sim). As conversas antigas desses projetos entram na memória. |
| **Pode começar?** | Enter. |

No fim aparece uma conferência. O esperado é **"tudo certo"**.

> Rode o instalador **antes** de abrir um agente num projeto da empresa que você ainda não configurou. Assim as conversas já caem no lugar certo.

## Depois de instalar

1. Recarregue o VS Code ("Developer: Reload Window") e reinicie o Cursor.
2. Abra uma sessão nova. As skills aparecem pelo nome, ex.: `/ponytail-review`.
3. Teste a memória: peça algo pequeno no Claude Code numa pasta, feche a sessão, abra o Cursor na mesma pasta e pergunte "o que já foi feito aqui?".

## Dia a dia

| Para | Rode |
|---|---|
| Conferir se está tudo certo | `node glossary.mjs --check` |
| Atualizar skills e ferramentas | `git pull && ./install.sh --yes` |
| Adicionar um projeto da empresa | `./install.sh` e informe a pasta nova |
| Ver o que a memória guardou | abra http://127.0.0.1:49374/web |

A memória grava sozinha no Claude Code e no Cursor. A página de cada sessão aparece quando a sessão termina (`/exit` ou fechar a aba). O resumo dela entra no começo da próxima sessão na mesma pasta.

## Se algo der errado

Rode `node glossary.mjs --check`. Ele aponta o que falta e qual comando resolve. Na maioria dos casos, rodar `./install.sh --yes` de novo corrige.

- **"Falta o Node.js"**: `brew install node` e rode o instalador de novo.
- **"servidor fora do ar"**: o serviço sobe sozinho no login. Rode `./install.sh --yes` para religá-lo.
- **Hermes: "streamable_http is not available"**: falta o suporte a MCP via HTTP no Hermes. Reinstale com o extra `mcp` (ex.: `uv tool install --force 'hermes-agent[mcp]'`).
- **Skill aparecendo duas vezes no Cursor**: veja "Problemas comuns" em [AVANCADO.md](AVANCADO.md).

Projetos da empresa em detalhe, LLM para a memória, criar e enviar skills, desfazer a instalação: tudo em [AVANCADO.md](AVANCADO.md).
