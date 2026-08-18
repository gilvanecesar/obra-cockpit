# CLAUDE.md — Obra Cockpit

Ferramenta de orquestração de agentes. **Não é um app de produção** — é o cockpit que
comanda o time da obra nos OUTROS projetos.

## O que é
- `scripts/obra-cockpit.mjs` — o painel web (localhost:4477) + chat do Boss + endpoints.
- `scripts/obra-fluxo.mjs` — o MAESTRO: roda eng→QA→revisor→PR, cada um um `claude -p`.
- `scripts/obra-projetos.mjs` — registro dos projetos que a obra alcança + a TRAVA.
- `scripts/obra-stream.mjs` — leitura do log stream-json (custo + atividade).
- `scripts/obra-tarefas.mjs` — o quadro (kanban) e o registro em `.herdr-obra.json`.
- `scripts/obra-agente.mjs`, `obra-quadro.mjs`, `obra-sala.mjs`, `obra.mjs` — fluxo antigo do herdr.

## Regras da casa
- O cockpit é **dependency-free** (só Node built-in). As MISSÕES rodam nos repos-alvo, que têm
  os próprios node_modules.
- Cada missão sai da **branch de integração (main)** do projeto-alvo e abre PR — nunca commita direto.
- Arquivos de runtime (`.herdr-obra*`) são gitignored.
- Os projetos são **repos irmãos** em `~/Documents/DEV/` — o QueroFretes/TMS/AGB têm `dir` explícito
  em `obra-projetos.mjs`.
