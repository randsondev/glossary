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
| **Nomes da empresa para bloquear** | Enter aceita o nome do workspace. Acrescente outros separados por vírgula (ex.: nome de cliente). A trava de commit não deixa esses nomes entrarem no repositório público. Só aparece na primeira vez. |
| **Dar ao OpenClaude a memória e as skills privadas?** | Enter (não). Só responda `s` se ele usar apenas provedores confiáveis. |
| **Instalar o Serena?** | Enter (sim). Só aparece se você tiver o `uv`. |
| **Importar o histórico?** | Enter (sim). As conversas antigas dos projetos que você acabou de adicionar entram na memória. Só aparece quando você adiciona um projeto. |
| **Pode começar?** | Enter. |

No fim aparece uma conferência. O esperado é **"tudo certo"**.

O instalador também cria o **`glossary-internal`** ao lado do glossary (ex.: `~/projetos/glossary-internal`). É o seu repositório privado, para skills com dados da empresa. Ele fica só nesta máquina: não tem remote e não vai para servidor nenhum.

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
| Levar as skills privadas e a config para outro computador | `./install.sh --export` (veja abaixo) |
| Ver o que a memória guardou | abra http://127.0.0.1:49374/web |

A memória grava sozinha no Claude Code e no Cursor. A página de cada sessão aparece quando a sessão termina (`/exit` ou fechar a aba). O resumo dela entra no começo da próxima sessão na mesma pasta.

## Outro computador

O `git clone` traz só o que é público. As skills privadas, a lista de nomes da empresa e os projetos configurados ficam só na máquina onde foram criados. Para levar:

1. No computador antigo: `./install.sh --export`. Isso gera `~/glossary-privado.tar.gz`.
2. Leve o arquivo por pendrive ou pela rede local (`scp`). **Nunca** por nuvem, e-mail ou mensageiro: ele tem dados da empresa.
3. No computador novo, depois do `git clone`: `./install.sh --import ~/glossary-privado.tar.gz`. Os projetos da empresa entram se já estiverem clonados na mesma pasta relativa (ex.: `~/projetos/x` no Mac vira `~/Projects/x` se o glossary estiver em `~/Projects`).
4. Apague o arquivo nos dois computadores.

A memória (o histórico das sessões) não vai junto: cada computador tem a sua.

## Se algo der errado

Rode `node glossary.mjs --check`. Ele aponta o que falta e qual comando resolve. Na maioria dos casos, rodar `./install.sh --yes` de novo corrige.

- **"Falta o Node.js"**: `brew install node` e rode o instalador de novo.
- **"servidor fora do ar"**: o serviço sobe sozinho no login. Rode `./install.sh --yes` para religá-lo.
- **Conversas repetidas na memória** (o histórico foi importado mais de uma vez): `node ai-memory/dedupe.mjs` mostra o que vai corrigir, e `node ai-memory/dedupe.mjs --apply` faz um backup e corrige.
- **Hermes: "streamable_http is not available"**: falta o suporte a MCP via HTTP no Hermes. Reinstale com o extra `mcp` (ex.: `uv tool install --force 'hermes-agent[mcp]'`).
- **Skill aparecendo duas vezes no Cursor**: veja "Problemas comuns" em [AVANCADO.md](AVANCADO.md).

Projetos da empresa em detalhe, LLM para a memória, criar e enviar skills, desfazer a instalação: tudo em [AVANCADO.md](AVANCADO.md).
