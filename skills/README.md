# skills/

Skills próprias do glossary, uma pasta por skill com um `SKILL.md`.

- Comandos do Cursor entram aqui com `node scripts/port-cursor-commands.mjs`.
- Skill nova: copie `templates/skill/` para `skills/<nome>/`, ajuste `name` (igual ao nome da pasta) e `description`, e rode `node scripts/validate.mjs`.
- Nada com dado da empresa: isso vai para o repositório privado, ligado pelo `~/.config/glossary/roots.json`. O pre-commit bloqueia se escapar.
