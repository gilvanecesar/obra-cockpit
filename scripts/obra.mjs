#!/usr/bin/env node
/**
 * OBRA — o boss distribuindo trabalho para agentes em painéis do herdr.
 *
 * A ideia (pedido do dono, ago/2026): em vez de eu fazer tudo sozinho numa janela,
 * abrir um painel por agente e deixar a obra VISÍVEL — engenheiro implementando,
 * testador tentando quebrar, revisor procurando defeito — cada um no seu terminal,
 * com o herdr mostrando quem está trabalhando, quem travou e quem terminou.
 *
 * Cada engenheiro trabalha numa CÓPIA ISOLADA do repositório (git worktree, criado
 * pelo próprio herdr). Assim dois agentes não se atropelam e um erro não toca na
 * `main`. O que volta é o galho pronto, para revisão antes de entrar.
 *
 * ⚠️ O worktree isola o GIT, não a máquina. Um agente rodando sem pedir permissão
 * ainda alcança qualquer arquivo do Mac — inclusive o repositório principal e o
 * `.env`. É decisão consciente do dono; está escrito aqui para não virar surpresa.
 *
 * Uso:
 *   node scripts/obra.mjs abrir  <nome> "<tarefa>" [papel] [projeto] [T-id]
 *   node scripts/obra.mjs abrir  <nome> T-3 [papel]  # pega uma tarefa do quadro
 *   node scripts/obra.mjs estado                     # o que cada agente está fazendo
 *   node scripts/obra.mjs ler    <nome> [linhas]     # lê o que o agente produziu
 *   node scripts/obra.mjs falar  <nome> "<texto>"    # manda uma instrução nova
 *   node scripts/obra.mjs fechar <nome>              # remove a cópia e fecha o painel
 *   node scripts/obra.mjs tarefa nova "<titulo>" [projeto]
 *   node scripts/obra.mjs tarefa lista
 *   node scripts/obra.mjs tarefa mover <id> <estado>
 */
import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  ESTADOS,
  ESTADO_POR_PAPEL,
  buscarTarefa,
  criarTarefa,
  lerRegistro,
  listarTarefas,
  moverTarefa,
  projetoPadrao,
  salvarRegistro,
  soltarAgente,
} from "./obra-tarefas.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Modelo por tarefa (multi-modelos): `--modelo claude|sonnet|opus|codex|...` no comando.
// Fica no escopo do módulo; a dispatch lá embaixo tira do argv e preenche antes de abrir().
let MODELO = null;

/** herdr responde JSON numa linha só; erro vem em texto. */
function herdr(...args) {
  const saida = execFileSync("herdr", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  try {
    const j = JSON.parse(saida);
    if (j.error) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error));
    return j.result ?? j;
  } catch (e) {
    if (e instanceof SyntaxError) return { texto: saida };
    throw e;
  }
}

/**
 * Instruções que TODO agente recebe. É o que separa "escreveu código" de "entregou":
 * as regras do projeto já vivem no CLAUDE.md do repositório (o agente lê sozinho),
 * então aqui fica só o que o CLAUDE.md não diz — como se comportar dentro da obra.
 */
const REGRAS_DA_CASA = `
Você é um agente de uma equipe. Trabalhe SÓ dentro desta cópia do repositório.

1. Leia o CLAUDE.md antes de mexer em qualquer coisa — ele tem as regras que impedem
   estrago neste projeto (limite de texto em toda porta de escrita, fail-closed no que
   libera dinheiro, e-mail sempre minúsculo, hook antes de qualquer return, admin
   conferido no backend e não só no menu).
2. NÃO comite na main e NÃO faça push. Deixe o trabalho no galho desta cópia.
3. Prove o que fez: rode \`npm run check\`, os testes e, quando a mudança for de tela,
   abra e confira. Compilar não é testar.
4. Ao terminar, escreva um resumo curto começando com "ENTREGA:" dizendo o que mudou,
   o que você VERIFICOU e o que ficou de fora.
`.trim();

const PAPEIS = {
  // "solo" = o modo LEVE: um fazedor completo (o "eu" do dono) num pane só, que faz a
  // tarefa de ponta a ponta e FICA disponível pro dono entrar e continuar conversando.
  solo: (tarefa) => `${REGRAS_DA_CASA}

SUA FUNÇÃO: fazer a tarefa inteira, sozinho — você é o assistente do dono neste painel.
Ao terminar, NÃO encerre: fique disponível. O dono pode entrar aqui e continuar
conversando sobre esta tarefa (pedir ajuste, ver o diff, mudar o rumo).

TAREFA:\n${tarefa}`,
  engenheiro: (tarefa) => `${REGRAS_DA_CASA}\n\nSUA FUNÇÃO: implementar.\n\nTAREFA:\n${tarefa}`,
  testador: (tarefa) => `${REGRAS_DA_CASA}

SUA FUNÇÃO: tentar QUEBRAR o que foi implementado — você não escreve a solução, você
procura onde ela falha. Entrada vazia, valor absurdo, usuário sem permissão, dois
cliques seguidos, campo que não existe. Rode de verdade; não julgue por leitura.

O QUE FOI FEITO:\n${tarefa}`,
  revisor: (tarefa) => `${REGRAS_DA_CASA}

SUA FUNÇÃO: revisar como quem vai dizer NÃO. Procure: guard que ficou só no frontend,
dado sensível voltando na resposta, número que mente, hook depois de return, porta de
escrita sem limite, promessa no texto que o código não cumpre. Aponte o defeito com
arquivo e linha; não reescreva o código.

O QUE REVISAR:\n${tarefa}`,
};

/**
 * MAPA DE PROJETOS — como o boss sabe para onde escalar sem o dono dizer.
 *
 * O dono fala "corrige o CT-e" e não repete a qual sistema se refere. As palavras da
 * tarefa dizem: cada projeto tem vocabulário próprio, e ambiguidade se resolve
 * perguntando, nunca chutando (mexer no repositório errado é estrago de verdade).
 */
const MAPA = {
  "querofretes-ofc": {
    o_que: "app principal: marketplace de fretes, motorista, embarcador",
    palavras: ["frete", "motorista", "embarcador", "agregamento", "rota cheia", "proposta",
               "assinatura", "abacatepay", "sos estrada", "fornecedor", "documento do motorista"],
  },
  TMS: {
    o_que: "sistema de gestão de transporte — emissão fiscal",
    palavras: ["ct-e", "cte", "mdf-e", "mdfe", "manifesto", "sefaz", "tms", "romaneio fiscal"],
  },
  "agb-projetos": { o_que: "site/energia solar (AGB)", palavras: ["agb", "solar", "energia"] },
  jarvis: { o_que: "orquestrador de agentes no saturno", palavras: ["jarvis", "saturno", "orquestrador"] },
};

/**
 * Em que repositório o agente vai trabalhar.
 *
 * Sem `projeto`, é este aqui. Com `projeto` ("TMS", "agb-projetos" ou um caminho), é o
 * workspace do herdr aberto naquele repositório — assim a mesma obra serve os outros
 * projetos do dono, e cada agente herda o CLAUDE.md DAQUELE código, que é o que o
 * ensina a não fazer besteira lá dentro.
 */
function workspaceDoProjeto(projeto) {
  const alvo = projeto ? String(projeto) : RAIZ;
  const base = alvo.split("/").pop();
  const bate = (cwd) =>
    cwd === alvo || cwd.endsWith("/" + alvo) || cwd.toLowerCase().endsWith("/" + alvo.toLowerCase());
  // preferir o workspace cujo RÓTULO (raiz) É o projeto — esse é git de verdade (evita pegar
  // um "~" só porque um pane dele deu `cd` pra dentro → worktree create daria not_git_worktree).
  const acharWs = () => (herdr("workspace", "list").workspaces || []).find((w) => { const l = String(w.label || ""); return l === base || l.split("/").pop() === base; });
  let ws = acharWs();
  // fallback: pela cwd de algum pane
  if (!ws) {
    const p = (herdr("pane", "list").panes || []).find((p) => bate(p.cwd || ""));
    if (p) ws = (herdr("workspace", "list").workspaces || []).find((w) => w.workspace_id === p.workspace_id) || { workspace_id: p.workspace_id };
  }
  // AUTO-ABRIR (todo projeto é automático): se não está aberto, abre como workspace apontando
  // pra pasta do projeto (~/Documents/DEV/<projeto>). Assim TMS/torre/AGB funcionam sem o dono
  // abrir na mão no herdr — pedido do dono 25/08.
  const dir = alvo.includes("/") ? alvo : resolve(process.env.HOME || "/home/saturno", "Documents/DEV", base);
  if (!ws && existsSync(dir)) {
    try { herdr("workspace", "create", "--cwd", dir, "--label", base, "--no-focus"); } catch (e) { /* segue e tenta achar */ }
    ws = acharWs();
  }
  if (!ws) {
    throw new Error(`não consegui abrir o projeto "${base}" (pasta ${dir}). Existe no saturno e é um repositório git?`);
  }
  const paineis = herdr("pane", "list").panes || [];
  const pane = paineis.find((p) => p.workspace_id === ws.workspace_id && bate(p.cwd || ""))
            || paineis.find((p) => p.workspace_id === ws.workspace_id);
  return { workspace: ws.workspace_id, repo: (pane && pane.cwd) || dir };
}

/** Os repositórios que a obra alcança agora (um workspace aberto = um projeto disponível). */
function projetos() {
  const paineis = herdr("pane", "list").panes || [];
  // Cópias de trabalho (~/.herdr/worktrees) não são projetos — são obras em andamento.
  const repos = [...new Set(paineis.map((p) => p.cwd).filter(Boolean))].filter((r) => !r.includes("/.herdr/worktrees/"));
  console.log("PROJETOS QUE A OBRA ALCANÇA (workspaces abertos no herdr)\n");
  for (const r of repos) {
    const nome = r.split("/").pop();
    const m = MAPA[nome];
    console.log("  " + (r === RAIZ ? "★ " : "  ") + nome.padEnd(18) + (m ? m.o_que : r));
  }
  console.log("\nuso: node scripts/obra.mjs abrir <nome> \"<tarefa>\" [papel] [projeto]");
}

/** O painel demora um instante para ter shell pronto depois de criado. */
function esperarShell(pane, tentativas = 12) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const p = herdr("pane", "get", pane);
      const st = (p.pane || p).agent_status;
      if (st && st !== "unknown") return;
    } catch {}
    execFileSync("sleep", ["0.5"]);
  }
}

const ehIdDeTarefa = (s) => /^T-\d+$/i.test(String(s || "").trim());

/**
 * Abrir um agente. O 4º e o 5º argumento são o projeto e a tarefa do quadro, em qualquer
 * ordem — quem digita não devia ter que lembrar a posição, e "T-3" nunca é nome de
 * projeto. O texto da tarefa também aceita o id direto (`abrir eng-1 T-3`), que é como o
 * dono fala: o quadro já tem o título escrito, repetir à mão só abriria espaço para
 * divergir do que está na coluna.
 */
function abrir(nome, texto, papel = "engenheiro", a4, a5) {
  let idTarefa = null;
  let projeto;
  for (const a of [a4, a5]) {
    if (!a) continue;
    if (ehIdDeTarefa(a)) idTarefa = String(a).trim().toUpperCase();
    else projeto = a;
  }
  if (!idTarefa && ehIdDeTarefa(texto)) {
    idTarefa = String(texto).trim().toUpperCase();
    texto = null;
  }

  const doQuadro = idTarefa ? buscarTarefa(idTarefa) : null;
  if (idTarefa && !doQuadro) throw new Error(`não existe a tarefa ${idTarefa} (veja: obra.mjs tarefa lista)`);
  const tarefa = texto || (doQuadro && `${doQuadro.id} — ${doQuadro.titulo}`);
  // A tarefa carrega o projeto dela; um projeto dito na linha de comando ganha.
  if (!projeto && doQuadro?.projeto && doQuadro.projeto !== projetoPadrao()) projeto = doQuadro.projeto;

  if (!nome || !tarefa) throw new Error('uso: obra.mjs abrir <nome> "<tarefa>" [papel] [projeto] [T-id]');
  const monta = PAPEIS[papel];
  if (!monta) throw new Error(`papel desconhecido: ${papel} (use ${Object.keys(PAPEIS).join(", ")})`);

  /**
   * 1) cópia isolada do repositório, já aberta como workspace no herdr.
   *
   * ⚠️ `worktree create` sem `--workspace` usa o painel EM FOCO como origem — e isso
   * criou uma cópia do TMS quando o foco estava lá. A origem é descoberta aqui: o
   * workspace de algum painel cujo diretório é a raiz DESTE repositório.
   */
  const { workspace: origem, repo } = workspaceDoProjeto(projeto);
  const wt = herdr("worktree", "create", "--workspace", origem);
  const workspace = wt.workspace.workspace_id;
  const pane = wt.root_pane.pane_id;
  const caminho = wt.worktree.path;

  // 2) o agente sobe NO painel, sem parar para pedir permissão (está isolado no galho)
  esperarShell(pane);
  const extraClaude = ["--dangerously-skip-permissions"];
  if (MODELO) extraClaude.push("--model", MODELO); // multi-modelos: cada tarefa pode ter o seu
  // ⚠️ o claude agora carrega ai-memory (MCP) + skills no boot e passa dos 30s padrão do herdr
  // ("timed out waiting for agent startup"). Damos 120s (o herdr aceita até 300s).
  herdr("agent", "start", nome, "--kind", "claude", "--pane", pane, "--timeout", "120000", "--", ...extraClaude);

  // 3) a tarefa
  /**
   * ⚠️ O alvo dos comandos de agente é o PAINEL (wR:p1), não o nome passado no
   * `agent start` — `herdr agent read eng-1` responde "agent not found". O nome serve
   * de rótulo; quem endereça é o painel, que fica guardado no registro.
   */
  herdr("agent", "prompt", pane, monta(tarefa));

  const reg = lerRegistro();
  reg.agentes[nome] = {
    papel,
    modelo: MODELO || null,
    projeto: repo.split("/").pop(),
    workspace,
    pane,
    caminho,
    tarefa,
    tarefaId: doQuadro?.id || null,
    aberto_em: new Date().toISOString(),
  };
  salvarRegistro(reg);

  // A tarefa anda sozinha: o papel de quem pegou diz para qual coluna ela vai.
  if (doQuadro) moverTarefa(doQuadro.id, ESTADO_POR_PAPEL[papel], nome);

  console.log(`✓ ${nome} (${papel}) trabalhando em ${repo.split("/").pop()}`);
  if (doQuadro) console.log(`  tarefa: ${doQuadro.id} → ${ESTADO_POR_PAPEL[papel]}`);
  console.log(`  cópia:  ${caminho}`);
  console.log(`  painel: ${pane}  ·  workspace ${workspace}`);
}

/** O quadro pela linha de comando (o painel faz o mesmo, no navegador). */
function tarefa(args) {
  const [sub, ...resto] = args;
  if (sub === "nova") {
    const t = criarTarefa({ titulo: resto[0], projeto: resto[1] });
    return console.log(`✓ ${t.id} na fila · ${t.projeto} · ${t.titulo}`);
  }
  if (sub === "mover") {
    const t = moverTarefa(resto[0], resto[1]);
    return console.log(`✓ ${t.id} → ${t.estado}`);
  }
  if (sub === "lista" || !sub) {
    const tarefas = listarTarefas();
    if (!tarefas.length) return console.log('quadro vazio · crie com: obra.mjs tarefa nova "<titulo>"');
    console.log("ID".padEnd(6) + "ESTADO".padEnd(15) + "AGENTE".padEnd(10) + "PROJETO".padEnd(18) + "TAREFA");
    for (const t of tarefas) {
      console.log(
        t.id.padEnd(6) +
          t.estado.padEnd(15) +
          String(t.agente || "—").padEnd(10) +
          String(t.projeto || "").padEnd(18) +
          t.titulo,
      );
    }
    return;
  }
  throw new Error(`uso: obra.mjs tarefa nova "<titulo>" [projeto] | lista | mover <id> <${ESTADOS.join("|")}>`);
}

function estado() {
  const reg = lerRegistro();
  const nomes = Object.keys(reg.agentes);
  if (!nomes.length) return console.log("nenhum agente na obra");
  let agentes = [];
  try {
    agentes = herdr("agent", "list").agents || [];
  } catch {}
  const porPainel = new Map(agentes.map((a) => [a.pane_id, a]));
  console.log("AGENTE".padEnd(10) + "PROJETO".padEnd(18) + "PAPEL".padEnd(12) + "ESTADO".padEnd(10) + "ENTREGA / TAREFA");
  for (const n of nomes) {
    const r = reg.agentes[n];
    const a = porPainel.get(r.pane);
    const st = a?.agent_status || "—";
    // O título do painel é o melhor resumo do que o agente está fazendo agora:
    // o Claude Code o atualiza sozinho conforme a conversa.
    const titulo = a?.terminal_title_stripped || r.tarefa;
    console.log(n.padEnd(10) + String(r.projeto || "querofretes-ofc").padEnd(18) + r.papel.padEnd(12) + st.padEnd(10) + titulo.slice(0, 52).replace(/\n/g, " "));
  }
}

const ler = (nome, linhas = "150") => {
  const r = lerRegistro().agentes[nome];
  if (!r) throw new Error(`não conheço o agente ${nome}`);
  const saida = herdr("agent", "read", r.pane, "--source", "recent-unwrapped", "--lines", String(linhas));
  console.log(saida.text || saida.texto || "(sem saída)");
};

const falar = (nome, texto) => {
  const r = lerRegistro().agentes[nome];
  if (!r) throw new Error(`não conheço o agente ${nome}`);
  herdr("agent", "prompt", r.pane, texto);
  console.log(`✓ instrução enviada para ${nome}`);
};

function fechar(nome) {
  const reg = lerRegistro();
  const r = reg.agentes[nome];
  if (!r) throw new Error(`não conheço o agente ${nome}`);
  try {
    herdr("worktree", "remove", "--workspace", r.workspace, "--force");
  } catch (e) {
    console.error("aviso ao remover a cópia:", e.message);
  }
  delete reg.agentes[nome];
  salvarRegistro(reg);
  // A tarefa fica onde parou, só sem ninguém — devolver para a fila apagaria o trabalho.
  soltarAgente(nome);
  console.log(`✓ ${nome} encerrado e cópia removida`);
}

const [cmd, ...args] = process.argv.slice(2);
// tira `--modelo <m>` de qualquer posição pra não bagunçar o parse posicional do abrir
{
  const i = args.indexOf("--modelo");
  if (i >= 0) { MODELO = args[i + 1] || null; args.splice(i, 2); }
}
try {
  if (cmd === "abrir") abrir(args[0], args[1], args[2], args[3], args[4]);
  else if (cmd === "tarefa") tarefa(args);
  else if (cmd === "projetos") projetos();
  else if (cmd === "estado") estado();
  else if (cmd === "ler") ler(args[0], args[1]);
  else if (cmd === "falar") falar(args[0], args[1]);
  else if (cmd === "fechar") fechar(args[0]);
  else {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0].split("Uso:")[1] || "");
    process.exit(1);
  }
} catch (e) {
  console.error("erro:", e.message);
  process.exit(1);
}
