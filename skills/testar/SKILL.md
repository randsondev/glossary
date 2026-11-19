---
name: testar
description: "Testa uma mudança funcionando de verdade, por camadas (unidade, serviço, integração, ponta a ponta), roda a regressão antes de qualquer correção e registra cada caso com evidência num roteiro com checklist. Use quando o usuário pedir para testar, validar ou conferir uma mudança ou PR, montar roteiro de testes, ou corrigir um defeito. Pedido de testar não é pedido de escrever teste: classe de teste Apex é a skill apex-testes-otimizados, só com pedido explícito."
---
# testar

Quando o usuário diz **testar**, ele quer ver a mudança funcionando como caso real: o comando rodando, o registro gravado, a tela respondendo, a integração recebendo. O entregável é o **roteiro**: os casos por camada, cada um com resultado e evidência. Pedido de testar não é pedido de escrever teste automatizado: classe ou suíte nova só quando ele pedir com essas palavras, ou no caminho de correção abaixo.

Esta skill trabalha junto com a `ponytail`: o ponytail decide o tamanho da mudança; esta skill prova que ela funciona e que nada quebrou.

Três regras valem em toda execução:

- **Regressão primeiro**: nenhuma correção antes de rodar os testes que já existem, na base e na mudança.
- **De baixo para cima**: uma camada só sobe quando passou, e passar é não ter falha nova em relação à base. O que já falhava na base vai para o relatório e não bloqueia.
- **Sistema real só com confirmação**: caso que grava em produção, manda mensagem a cliente ou aciona sistema externo real roda só depois de o usuário confirmar aquele caso.

## Camadas

| Camada | O que prova | Exemplos |
|---|---|---|
| 1. Unidade | os testes que já existem continuam passando | `node --test`, `npm test`, `pytest`, classes de teste Apex, o CI do PR |
| 2. Serviço | a regra certa pelo ponto de entrada real, sem tela | script com entrada real, Apex anônimo, chamada à API |
| 3. Integração | o que a mudança aciona fora dela | flow, trigger, job, webhook, automação externa, outro sistema, instalação |
| 4. Ponta a ponta | o usuário real conseguindo | clique na tela, comando que ele roda, sessão nova do agente |

Camada com falha nova deixa os casos acima dela **bloqueados**, com o motivo. Falha numa camada alta com as de baixo verdes aponta para a ligação entre elas.

**Evidência** é o que outra pessoa confere sem refazer o caso: Id do registro, saída do comando, trecho do log, link ou print da tela.

## Dois caminhos

- **Validar uma mudança** (testar, conferir, validar o PR): passos 1 a 7.
- **Corrigir um defeito**:
  1. Passo 1, e o passo 2 na base.
  2. Reproduza o defeito como caso que falha, na camada mais baixa que o mostra.
  3. Escolha um caso vizinho que não deve mudar: mesmo código, outra entrada.
  4. Corrija com a menor mudança que resolve a causa, como manda o ponytail.
  5. Rode de novo o defeito (agora passa), o vizinho (igual a antes) e a regressão (sem falha nova).
  6. Projeto com suíte de teste, fora do Salesforce: o defeito reproduzido vira um teste pequeno nessa suíte, o teste que o ponytail pede para lógica nova. Em Salesforce, a reprodução fica como Apex anônimo no roteiro; classe de teste só com pedido.

  A página do passo 4 só entra se o usuário pedir ou se outra pessoa for marcar; senão o placar vai na resposta.

## 1. Analisar a mudança

- `git status`, `git diff` (staged e não staged), `git log main..HEAD` e o diff da branch; num PR, `gh pr view` e `gh pr diff`.
- Para cada arquivo alterado: o comportamento que mudou, quem chama, o que grava, o que dispara depois.
- O pedido original e as correções do usuário na conversa: elas definem o que é certo.
- O que já está no ar e o que depende de deploy ou merge.
- Projeto Salesforce (`sfdx-project.json` na raiz): leia [`references/salesforce.md`](references/salesforce.md). Carregue também as skills do projeto sobre dados de produção e integrações, quando existirem.

Pronto quando: cada arquivo alterado está ligado a um comportamento visível ou dado gravado, e você sabe por onde o usuário real chega nele.

## 2. Rodar a regressão

Rode as suítes da camada 1 que já existem, sem escrever teste novo:

- Ache-as no ambiente: scripts do `package.json`, `scripts/`, os passos do CI em `.github/workflows/` e o status do CI do PR (`gh pr checks`, `gh run list --branch`).
- **Base**: o último CI verde da base serve de placar quando roda as mesmas suítes; senão, rode na base (`main`, numa worktree à parte). Em Salesforce a base é a org antes do deploy: siga o `salesforce.md`.
- **Mudança**: rode na branch.
- O que falha nas duas já vinha quebrado: relate à parte, fora da correção.

Pronto quando: cada suíte existente tem placar da base e da mudança. Sem suíte nenhuma, diga isso: a regressão passa a ser os casos da camada 2.

## 3. Montar os casos

Cada caso tem **camada**, **título**, **como provocar** (ação, registro, entrada), **esperado** (com onde conferir) e **fase**: 1, testável agora; 2, depois do deploy ou merge.

Cubra:

- **Caminho principal**: o caso real que motivou a mudança, com um dado real.
- **Caso que deve ficar de fora**: o que a regra deve ignorar ou recusar.
- **Correções do usuário**: cada correção feita na conversa vira um caso.
- **Bordas**: vazio, limite, lote, reexecução.
- **Regressão**: o comportamento antigo que outros pontos do mesmo código esperam.
- **Efeitos em cadeia** e **perfil de acesso**, quando a regra depende deles.

Marque os casos que tocam sistema real (terceira regra) e liste à parte o que já é coberto por teste automatizado e o que é difícil de provocar.

Pronto quando: cada arquivo alterado e cada correção do usuário têm pelo menos um caso, e todo caso tem camada e fase.

## 4. Publicar o roteiro

Siga [`references/roteiro.md`](references/roteiro.md): página com checklist compartilhada quando você tem a ferramenta `Artifact`; senão, checklist em Markdown numa pasta temporária fora do projeto. Mostre o link (ou o caminho) e os casos.

Pronto quando: o roteiro tem todos os casos e o usuário recebeu o link ou o caminho.

## 5. Preparar o ambiente

- Use o ambiente de teste do projeto: sandbox, worktree, pasta pessoal temporária, porta alternativa. Suba só a mudança.
- Escolha dados reais para cada caso e anote os Ids.
- Antes de gravar, anote o estado do que será tocado para restaurar depois. Preserve alterações manuais do usuário.
- Mudança em configuração compartilhada (credencial, metadado, agendamento, serviço) só com confirmação, e volte ao original no fim.

Pronto quando: a mudança está no ambiente de teste e cada caso da fase 1 tem seus dados escolhidos, com o estado anterior anotado.

## 6. Rodar os casos, de baixo para cima

Rode você mesmo, camada por camada, todo caso que não exige a mão do usuário, pelo caminho mais próximo do uso real. Prefira simulação ou rollback quando gravar não for necessário, e confirme depois que nada ficou.

Grave cada caso no roteiro com a evidência: `Claude: <o que rodou e o que voltou>`. Marque `ok` só depois de ver o esperado acontecer. O que você não alcança fica para o usuário, com o motivo; ele marca com `Usuário: <o que viu>`.

Caso que falhou: investigue a causa e relate. Corrija só o que faz parte do pedido, com a regressão do passo 2 já rodada; depois rode de novo o caso e a regressão. Ação bloqueada pelo controle de permissões vai para o usuário, com o comando.

Pronto quando: todo caso da fase 1 está marcado com evidência, bloqueado com o motivo ou atribuído ao usuário.

## 7. Relatar

A resposta é curta, como no ponytail: o placar e as pendências; o detalhe fica no roteiro.

- O link do roteiro e o placar por camada: passou, falhou, bloqueado, pendente (e com quem).
- A regressão: base contra mudança, e o que já vinha quebrado.
- O que ficou sem verificar e por quê.
- Dados alterados no ambiente de teste e se foram restaurados.
- Se houver PR, atualize a descrição com o que foi testado e com os casos da fase 2 como checklist pendente.

Pronto quando: o usuário tem o placar e, havendo PR, a descrição dele lista o testado e a fase 2 pendente.
