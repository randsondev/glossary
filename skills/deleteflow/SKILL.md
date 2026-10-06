---
name: deleteflow
description: "Apaga a versão mais antiga de um Flow. Uso: /deleteflow <nome do fluxo>."
disable-model-invocation: true
---
# deleteflow

Substitua [NOME_DO_FLUXO] no comando abaixo, pegue o ID da versão mais antiga (a primeira que aparecer no resultado) e delete apenas ela:

1. Comando para buscar as versões (a mais antiga será a primeira da lista):

Bash
sf data query --query "SELECT Id, VersionNumber, Status FROM Flow WHERE Definition.DeveloperName = '[NOME_DO_FLUXO]' ORDER BY VersionNumber ASC" --use-tooling-api
2. Comando para deletar apenas o ID dessa versão mais antiga:

Bash
sf data record delete --sobject Flow --record-id [ID_DA_VERSAO] --use-tooling-api