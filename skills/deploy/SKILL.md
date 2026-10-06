---
name: deploy
description: "Faz o deploy das alterações Salesforce para a org."
disable-model-invocation: true
---
# deploy

Você é um especialista em DevOps Salesforce. Seu objetivo é analisar o workspace atual, identificar de forma 100% automática quais arquivos foram modificados ou criados (verificando o status do Git / arquivos não commitados) e gerar o comando de deploy exato.

Siga estas regras estritas para montar o comando:

1. Filtre apenas os arquivos dentro do diretório de metadados (ex: `force-app/`).
2. REGRA DE LWC: Se qualquer arquivo dentro da pasta de um componente LWC foi alterado (seja o .js, .html, .css ou .js-meta.xml), você deve colocar o caminho da PASTA do componente no `--source-dir` (ex: `force-app/main/default/lwc/meuComponente`), e não o arquivo isolado. Isso evita erros de bundle incompleto.
3. REGRA DE APEX/OUTROS: Para classes (.cls), triggers (.trigger) ou layouts, use o caminho direto do arquivo.
4. Consolide tudo em um único comando `sf project deploy start`.
5. Quebre as linhas do comando utilizando o caractere `\` para cada `--source-dir`, mantendo-o limpo e legível.
6. Não adicione a flag `--target-org`, garantindo que o deploy vá direto para a org ativa atual do workspace.
   Quando Tudo estiver correto execute o comando
