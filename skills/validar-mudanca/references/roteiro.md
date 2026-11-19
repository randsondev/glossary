# Roteiro

Os casos do passo 3, com um lugar para marcar cada um. Status: `ok`, `falha`, `bloq` ou vazio (pendente). A nota leva a evidência: `Claude: <o que rodou e o que voltou>` quando você roda, `Usuário: <o que viu>` quando é ele.

## Com a ferramenta `Artifact` (Claude Code, claude.ai)

Uma página com checklist que o usuário e outras pessoas marcam, e onde você grava o que rodou.

1. `Artifact` `quickstart` (intent `other`, `design_systems: false`) e carregue a skill `artifact-capabilities` antes de declarar as capabilities.
2. Copie [`roteiro-template.html`](roteiro-template.html) para o scratchpad e troque o cabeçalho (sistema, ambiente, branch, aviso), `PHASES`, `CASES` (`[n, fase, camada, título, como, esperado]`, HTML permitido) e a seção "Já coberto".
3. Publique com `capabilities: {db: {}, user: {}}`, icon `checklist` e título "Roteiro: <mudança>". Cada caso vira o documento `resultados/cNN` com `{status, nota, por, em}`.
4. Para gravar: `ArtifactData` `list` (collection `resultados`) e depois, num `batch` só, `set` nos casos ainda sem documento e `update` com o `if_version` lido nos que já existem, em `resultados/cNN` com `{status, nota: "Claude: <o que rodou e o que voltou>", por: "", em: <ISO>}`. Se o caso já tem nota do usuário, junte a sua à dele em vez de substituir.
5. A página nasce privada. Para outra pessoa marcar, o usuário compartilha como **Colaborador** (Visualizador só lê).

## Sem a ferramenta `Artifact` (Codex, Cursor, Hermes, OpenClaw, OpenClaude)

Um arquivo Markdown numa pasta temporária fora do projeto (`validacao-<branch>.md`). Mostre o caminho completo. O arquivo é a fonte do andamento: marque `[x]` passou, `[!]` falhou, `[~]` bloqueado; o usuário também pode marcar à mão.

```markdown
# Roteiro: <mudança> (<branch>, <data>)

> Aviso: <sistema real tocado, se houver>

## Fase 1

- [ ] **1. [Unidade] <título>**
  - Como: ...
  - Esperado: ... (conferir em ...)
  - Resultado: _(preencher)_

## Já coberto por teste automatizado

- ...
```
