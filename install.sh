#!/bin/sh
# Instala tudo: skills, memória compartilhada (ai-memory) e Serena.
#
#   git clone https://github.com/randsondev/glossary.git ~/projetos/glossary
#   cd ~/projetos/glossary && ./install.sh
#
# ./install.sh --yes aceita as respostas padrão. Pode rodar de novo quando quiser.
set -e
cd "$(dirname "$0")"

falta() {
  printf '\n  Falta %s.\n  %s\n\n' "$1" "$2"
  exit 1
}

command -v git >/dev/null 2>&1 || falta "o git" "macOS: xcode-select --install"
command -v node >/dev/null 2>&1 || falta "o Node.js 20 ou mais novo" "macOS: brew install node (ou https://nodejs.org)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || falta "um Node.js mais novo (este é o $major)" "macOS: brew upgrade node"
command -v curl >/dev/null 2>&1 || falta "o curl" "macOS: já vem instalado; Linux: sudo apt install curl"

exec node scripts/install.mjs "$@"
