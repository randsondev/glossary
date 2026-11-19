# Salesforce

Como cada camada fica num projeto Salesforce. Rodar teste ou Apex anônimo na org exige pedido de testar, validar ou corrigir; pergunta de status não basta.

## Regressão (camada 1)

- Classes alteradas: `git diff main...HEAD --name-only` mais o que está staged e não staged, só `.cls` e `.trigger`.
- Para cada uma, **todas** as classes de teste que a exercitam, não só a de mesmo nome: `grep -l "<NomeDaClasse>" force-app/main/default/classes/*Test*.cls`.
- A base é a org antes do deploy, não uma worktree: rode todas num comando só, na org de validação (sandbox), antes de subir a mudança (base) e depois (mudança):

```bash
sf apex run test -o <alias> --tests TesteA,TesteB --code-coverage --result-format human --wait 30
```

- Anote por classe de teste: métodos, falhas e a cobertura de cada classe alterada. Classe nova de teste ou cobertura a subir é outra tarefa, só com pedido.

## Ambiente

- Antes de subir, compare a classe ou o fluxo da sandbox com o git, e suba só a mudança com `--test-level NoTestRun`.
- Escolha registros reais da sandbox para cada caso e anote os Ids e o estado antes.

## Serviço (camada 2)

Apex anônimo chamando o ponto de entrada real (invocable, controller, service). Quando gravar não for necessário, `Savepoint` e `Database.rollback`; depois confirme com SOQL que nada ficou.

## Integração (camada 3)

- `Database.rollback` não segura chamada assíncrona já enfileirada (callout, queueable, evento). Rode o caso inteiro numa transação que termina com `throw new DmlException('ROLLBACK proposital do teste')`, leia o resultado no `System.debug` antes do throw (`sf apex run --json`, campo `data.logs`) e confira depois que não ficou registro nem `AsyncApexJob`.
- Flows, triggers e jobs que a mudança aciona: confira pelo registro depois (SOQL, histórico, debug log).
- Sistemas externos (automações, webhooks, mensageria): use o ambiente de teste deles, conforme as skills do projeto.

## Ponta a ponta (camada 4)

A tela (LWC, Lightning) no navegador, com o clique que o usuário faria e o perfil de quem usa; confira pela leitura da página ou screenshot e pelo registro gravado.
