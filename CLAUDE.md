# CLAUDE.md — Obra Cockpit

Fonte de contexto para qualquer agente de IA (inclusive os agentes da própria obra) que for
mexer neste repositório. Leia antes de alterar código.

**Isto é FERRAMENTA, não produto.** O cockpit comanda um time de agentes `claude` que trabalha
nos SEUS OUTROS projetos (QueroFretes, TMS, AGB…). Nada aqui roda em produção nem vai para
servidor — é 100% local, no Mac do dono.

---

## O que faz

Você descreve uma tarefa; um time de quatro papéis (Engenheiro → QA → Revisor → PR) a
implementa, testa, revisa e abre um Pull Request — cada missão numa **cópia isolada** do
repositório-alvo (git worktree), rodando **em paralelo** com as outras. Você acompanha tudo no
navegador (`localhost:4477`): grid de missões, custo ao vivo, chat do Boss, heatmap de gasto.

```bash
node scripts/obra-cockpit.mjs      # → http://localhost:4477
```

O motor é `claude -p` (usa a assinatura do dono). **Sem dependência npm** — só Node built-in.

---

## As peças (arquivos)

| Arquivo | Papel |
|---|---|
| `scripts/obra-cockpit.mjs` | O painel web + chat do Boss + endpoints. É o servidor HTTP (porta 4477). |
| `scripts/obra-fluxo.mjs` | O **MAESTRO**: roda a sequência eng→QA→revisor→PR, cada papel um `claude -p`. |
| `scripts/obra-projetos.mjs` | Registro dos projetos que a obra alcança + **a TRAVA** do projeto errado. |
| `scripts/obra-stream.mjs` | Lê o log `stream-json` do claude → custo + atividade (compartilhado maestro/TUI). |
| `scripts/obra-tarefas.mjs` | O quadro (kanban) e o registro em `.herdr-obra.json`. |
| `scripts/obra-agente.mjs` | TUI de status de um papel (fluxo antigo do herdr). |
| `scripts/obra-quadro.mjs`, `obra-sala.mjs`, `obra.mjs` | Fluxo antigo do herdr (terminal). Menos usados; o cockpit web os substituiu. |

O cockpit é a evolução do fluxo herdr: hoje tudo acontece no navegador, e o herdr virou legado.

---

## Como uma missão roda (o maestro)

`obra-fluxo.mjs "<objetivo>" [--projeto <dir>]`:

1. Cria uma **cópia isolada** (git worktree) a partir da **branch de integração (main)** do repo-alvo.
2. **Engenheiro** (`opus`) implementa → **QA** (`sonnet`) tenta quebrar → **Revisor** (`opus`) aprova ou reprova.
3. Revisor é uma **porta**: reprovou → volta pro Engenheiro (máx **2 rodadas**); na 2ª reprovação, a missão fica **bloqueada** sem PR.
4. Aprovou → passo **PR** (`haiku`): `git add -A`, commit, push, `gh pr create`. Nada é mesclado sozinho.

Cada papel grava seu estado num arquivo de status (ver runtime abaixo); o cockpit lê isso ao vivo.

### Receita de modelo por papel
Quem **decide** usa modelo forte; quem varre ou executa comando pronto usa o barato:

| Papel | Modelo | Override |
|---|---|---|
| Engenheiro | `opus` | `OBRA_MODELO_ENG` |
| QA | `sonnet` | `OBRA_MODELO_QA` |
| Revisor | `opus` | `OBRA_MODELO_REVISOR` |
| PR | `haiku` | `OBRA_MODELO_PR` |

Modo **Rápido** no cockpit = tudo `sonnet`/`haiku` (custa ~10× menos; use p/ README, teste, doc).

---

## Multi-projeto + a TRAVA

Os projetos são **repos git irmãos** em `~/Documents/DEV/`, definidos em `obra-projetos.mjs`.
⚠️ Depois que o cockpit virou repo próprio, **a raiz (RAIZ) é o obra-cockpit — NÃO um projeto**;
por isso o QueroFretes tem `dir` explícito (`resolve(DEV, "querofretes-ofc")`), igual TMS/AGB.

A **trava** (`conflitoDeProjeto`) confere, antes de gastar, se o objetivo casa com o projeto
escolhido. Se o texto casa forte com OUTRO projeto e não com o escolhido, ela devolve a sugestão
(a tela pergunta "trocar ou rodar mesmo assim?"). Conservadora de propósito: objetivo genérico
passa. Cada projeto tem `palavras`-chave próprias.

Adicionar projeto: botão **+ Novo** no cockpit — repo git que já existe OU criado do zero
(git init + scaffold). Persiste em `.herdr-obra-projetos.json` (o built-in é só semente).

---

## Duas portas para despachar

1. **Botão "Acionar time"** — objetivo + projeto + time (Caprichado/Rápido).
2. **💬 Chat do Boss** — um `claude -p` com **sessão dedicada** (`--resume`, contexto persiste).
   O Boss decide: dúvida → responde; código fechado → termina a resposta com
   `[MISSAO: <slug> | <objetivo>]`, que o cockpit dispara (reusa `dispararMissao`, com a trava).

---

## Endpoints (obra-cockpit.mjs)

| Rota | O que faz |
|---|---|
| `GET /` | O painel (HTML). |
| `GET /retrato` | Estado atual: missões (de qualquer porta), projetos, histórico, gasto. |
| `GET /eventos` | SSE — empurra o retrato ~1×/s. |
| `POST /missao` | Dispara missão `{objetivo, projeto, time, forcar}`. 409 = conflito da trava. |
| `GET /projetos/candidatos` | Repos git em `~/Documents/DEV` ainda não registrados. |
| `POST /projetos` | Registra projeto (existente ou cria do zero). |
| `POST /boss/chat` | Manda mensagem ao Boss `{mensagem, anexos}` → resposta (+ despacho se for código). |
| `GET /boss/historico` | Mensagens do chat do Boss. |
| `POST /boss/anexo` | Sobe um arquivo (base64, teto 4MB) pro chat do Boss; devolve `{caminho, nome}`. |

**Só escuta em `127.0.0.1`** — o cockpit dispara processo e não tem login; não pode ouvir a rede.

---

## Arquivos de runtime (gitignored — `.herdr-obra*`)

| Arquivo/pasta | Conteúdo |
|---|---|
| `.herdr-obra-runs/run-<nonce>.json` | Status de CADA missão (a fonte da verdade que o cockpit varre). |
| `.herdr-obra-status.json` | Legado: onde caía missão lançada sem `OBRA_STATUS` (ainda lido). |
| `.herdr-obra-missoes.json` | Histórico das missões encerradas (últimas 40). |
| `.herdr-obra-projetos.json` | Projetos adicionados pelo dono. |
| `.herdr-obra-boss.json` | `{sessionId, mensagens}` do chat do Boss (mensagens carregam `anexos: [{nome,caminho}]`). |
| `.herdr-obra-anexos/` | Arquivos que o dono anexou no chat do Boss (nome saneado + prefixo `randomUUID()`). |
| `.herdr-obra.json` | Quadro de tarefas (kanban, fluxo antigo). |

---

## ⚠️ Regras críticas / armadilhas (pagas na prática)

- **PR não pode carregar lixo do motor.** O `git add -A` do passo PR já engoliu `.obra-prompt/.obra-role` e o symlink `node_modules`. Cura: os arquivos de trabalho vivem no **TMP** (fora da cópia) e o **symlink node_modules é removido antes do PR**. Nunca colocar arquivo de trabalho dentro do worktree.
- **Missão sai SEMPRE da branch de integração (main) do repo-alvo**, nunca da branch em que você está sentado — senão o PR herda trabalho não mesclado (foi o bug do PR #14, veio com 5 arquivos a mais).
- **O cockpit vê TODA missão** lendo os arquivos de `.herdr-obra-runs/`, não só as que ele lançou. Missão lançada por fora (`obra-fluxo` direto de outra sessão) também aparece.
- **Motor morto não trava o cockpit.** O motor grava o próprio `pid`; o cockpit checa se ele vive (`process.kill(pid, 0)`). Sem isso, missão cujo processo morre fica "rodando" pra sempre. Verificação por PID, **não por tempo** (um passo do opus demora minutos e não é morte).
- **Missão encerrada some da tela** (a varredura remove o arquivo 30s após o fim, inclusive o legado) e **não duplica no histórico** (`guardarMissao` deduplica por objetivo+início — a memória de "já arquivei" zera a cada reinício).
- **O cliente não pode congelar.** SSE **reconecta sozinho** (2s) e há um **cão-de-guarda** que cai pro poll se ficar 4s sem update; a **1ª pintura é imediata** (poll no load), não espera o SSE.
- **NONCE tem o pid** — duas missões no mesmo milissegundo colidiriam no nome do branch/worktree.
- **Custo é limite, não fatura.** O dono está no Claude Max: o `US$` mostrado é o equivalente-API do que a missão consumiu do LIMITE dele, não dinheiro cobrado. Nunca mostrar "saldo de créditos" (não existe esse número). O que se mede é o gasto da OBRA (`gastoObra`), pro heatmap.
- **Regra de negócio do gasto:** Caprichado (opus) com uma rodada de correção passa fácil de US$ 5–30. Usar Caprichado só p/ código que decide lógica/dinheiro/acesso; o resto em Rápido.

---

## Convenções

- **Dependency-free**: só Node built-in (`http`, `fs`, `child_process`…). As MISSÕES rodam nos repos-alvo, que têm os próprios `node_modules` (o motor faz symlink temporário).
- Interface e textos ao usuário em **português do Brasil**; nomes de código em **inglês**.
- `claude` e `gh` precisam estar no PATH e autenticados (o passo PR usa `gh`).
- Ao mexer no `obra-cockpit.mjs`: rodar `node --check` antes de dar como pronto (não há build).
- Ao adicionar endpoint que grava `req.body`: pôr teto de tamanho (a régua do `lerCorpo`).
