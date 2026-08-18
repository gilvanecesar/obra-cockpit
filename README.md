# Obra Cockpit

Um time de agentes de IA (engenheiro → QA → revisor → PR) que trabalha nos seus projetos,
com painel no navegador e chat do Boss.

```bash
node scripts/obra-cockpit.mjs      # → http://localhost:4477
```

- **Painel** (`localhost:4477`): dispara missões, vê os agentes ao vivo, custo por missão,
  histórico e o heatmap "onde o dinheiro queimou".
- **Chat do Boss** (💬 boss): um Claude com sessão dedicada que responde e despacha missões.
- **Multi-projeto**: opera em repositórios irmãos (QueroFretes, TMS, AGB…) — cada missão roda
  numa cópia isolada (git worktree) e abre um PR no repo certo.
- **Trava do projeto errado**: antes de gastar, confere se a tarefa é do projeto escolhido.

O motor é `claude -p` (usa sua assinatura). Não tem dependência npm — só Node.
