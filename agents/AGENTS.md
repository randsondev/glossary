## Pedido e execução

- Use a correção mais recente do usuário para atualizar o requisito e retirar a interpretação anterior do código, dos scripts e da validação afetados.
- Preserve o significado do pedido. Se faltar uma informação que decide a regra, investigue a fonte existente; se continuar indefinida, faça uma pergunta objetiva antes de implementar essa parte.
- Faça a menor mudança que cumpra o pedido inteiro. Um atalho documentado só serve quando preserva o comportamento solicitado.
- Preserve a finalidade e o comportamento existente de cada tela e documento. Ao investigar uma divergência, confirme se ela é um defeito antes de igualar comportamentos. Se a correção depender de uma decisão de negócio indefinida, pergunte antes de alterar essa parte.
- Conclua o trabalho autorizado. Descobertas fora do escopo devem ser relatadas separadamente, sem alterar cadastros ou ampliar a tarefa por conta própria.

## Verificação

- Antes de concluir, confronte o resultado com o pedido vigente: um caso que deve entrar, um que deve ficar de fora e os casos corrigidos pelo usuário, quando aplicável.
- Diga o que foi realmente verificado. Compilar, publicar ou comparar um arquivo não comprova o funcionamento completo.
- Respeite a ordem de trabalho combinada, inclusive testes deixados para o final. Até executá-los, informe essa pendência.
- Ao testar scripts que gravam dados, preserve alterações manuais do usuário; prefira simulação ou rollback quando isso atender à verificação.
- Ao testar, validar ou corrigir um bug, carregue a skill `validar-mudanca` antes da primeira edição: ela cuida da verificação (regressão antes de corrigir, teste por camada); o tamanho da correção continua com o `ponytail`.
- Após duas tentativas sem progresso, troque a checagem. Use um subagente crítico somente em leitura quando houver hipótese central sem evidência ou decisão difícil de reverter; o principal verifica os apontamentos e decide.
- Ao concluir, informe o resultado, a verificação e as pendências, de forma curta.

## Memória e skills

- Antes de responder sobre trabalho anterior, propor arquitetura ou mudar comportamento existente, consulte `memory_query` do ai-memory. Sem saber o projeto, use `global=true`.
- Confirme a memória nos arquivos atuais e no pedido vigente: ela é histórico, não autoridade para contrariar o usuário.
- Registre decisões reutilizáveis com `memory_write_page`; contexto temporário de continuidade segue a skill de handoff ao encerrar ou transferir a sessão.
- Carregue as skills pertinentes à tarefa. Em código, siga a skill `ponytail`; as regras de simplicidade preservam todos os requisitos do pedido.

- Crie skills em `{{SKILLS_DIR}}/<nome>/SKILL.md`, nunca na pasta do próprio agente. Depois rode `node {{GLOSSARY}}/scripts/link.mjs`.
- Script avulso, referência ou documento reutilizável que você criar não fica solto no projeto em que está trabalhando: vai para a skill certa em `{{SKILLS_DIR}}/<nome>/` (`scripts/` ou `references/`), com uma linha no `SKILL.md`, e depois rode o link. Saída temporária (planilha, CSV, relatório) vai para uma pasta temporária fora do projeto. No projeto ficam só os arquivos do próprio produto que o pedido mandou criar ou alterar; se o usuário disser onde salvar, siga o usuário.
