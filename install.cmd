@echo off
rem Instala tudo no Windows: skills, memoria compartilhada (ai-memory) e Serena. Equivale ao install.sh.
rem
rem   git clone https://github.com/randsondev/glossary.git %USERPROFILE%\projetos\glossary
rem   cd %USERPROFILE%\projetos\glossary
rem   install.cmd            (no PowerShell: .\install.cmd)
rem
rem install.cmd --yes aceita as respostas padrao. Pode rodar de novo quando quiser.
setlocal
rem UTF-8 no console: as mensagens do instalador tem acento.
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>&1 || (call :falta "o git" "winget install Git.Git" & exit /b 1)
where node >nul 2>&1 || (call :falta "o Node.js 20 ou mais novo" "winget install OpenJS.NodeJS.LTS" & exit /b 1)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set major=%%v
if %major% LSS 20 (call :falta "um Node.js mais novo (este e o %major%)" "winget upgrade OpenJS.NodeJS.LTS" & exit /b 1)
where curl >nul 2>&1 || (call :falta "o curl" "vem com o Windows 10 1803 ou mais novo" & exit /b 1)

node scripts\install.mjs %*
exit /b %errorlevel%

:falta
echo.
echo   Falta %~1.
echo   %~2
echo.
exit /b 0
