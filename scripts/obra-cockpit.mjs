#!/usr/bin/env node
/**
 * COCKPIT — a janela única da obra, no navegador. UM lugar, não mais três.
 *
 * O painel antigo (obra-painel.mjs) era um kanban: bom pra ver o que está na fila, mas
 * não mostrava os agentes TRABALHANDO ao vivo com custo, e não deixava DISPARAR a missão
 * pela tela — pra isso era preciso terminal + herdr. O cockpit fecha esse buraco:
 *
 *   · você escreve o objetivo e escolhe o time → a missão começa (sem herdr nenhum)
 *   · cada papel vira um PAINEL: o que está fazendo agora, modelo, e quanto já custou
 *   · no rodapé, o custo da missão inteira — o número que diz se valeu acionar o time
 *
 * O motor é o mesmo `obra-fluxo.mjs` (eng → QA → revisor → PR), rodado como processo
 * filho; ele grava `.herdr-obra-status.json` a cada passo e os logs em stream-json, que
 * é o que esta tela lê. Nada de estado paralelo: a fonte da verdade é o motor.
 *
 *   node scripts/obra-cockpit.mjs      → http://localhost:4477
 */
import { createServer } from "http";
import { spawn, execFileSync, execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { lerAtividade } from "./obra-stream.mjs";
import {
  projetosDisponiveis, acharProjeto, conflitoDeProjeto,
  adicionarProjeto, reposCandidatos, slugificar, RAIZ_DEV, definirUrlProjeto,
} from "./obra-projetos.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MISSOES = resolve(RAIZ, ".herdr-obra-missoes.json"); // histórico das missões encerradas
// Cada missão paralela grava num arquivo PRÓPRIO aqui — status central único faria as
// missões se atropelarem (uma sobrescrevendo o painel da outra).
const RUNS = resolve(RAIZ, ".herdr-obra-runs");
try { mkdirSync(RUNS, { recursive: true }); } catch {}
const FLUXO = resolve(RAIZ, "scripts", "obra-fluxo.mjs");
const PORTA = Number(process.env.PORTA || 4477);
// Teto de missões ao mesmo tempo: paralelo é caro (N× opus), e a máquina tem limite.
const MAX_PARALELO = Number(process.env.OBRA_MAX_PARALELO || 4);

const MARINHO = "#071119", CIANO = "#35C1EF", VERDE = "#37CF7C", GELO = "#EAF3F8", AMBAR = "#e8b339", VERM = "#eb6e6e";

// A ordem e o rótulo dos painéis. É a linha de montagem da obra, da esquerda pra direita.
const PAPEIS = [
  { chave: "eng", emoji: "🔧", nome: "Engenheiro", desc: "implementa" },
  { chave: "qa", emoji: "🧪", nome: "QA", desc: "tenta quebrar" },
  { chave: "revisor", emoji: "🔍", nome: "Revisor", desc: "aprova ou reprova" },
  { chave: "pr", emoji: "🚀", nome: "PR", desc: "fecha a entrega" },
];

// As abas de cima = os projetos que existem no disco (fonte única em obra-projetos.mjs).
// Lista FRESCA a cada chamada — senão um projeto novo só apareceria ao reiniciar o cockpit.
const listaProjetos = () => projetosDisponiveis().map((p) => ({ slug: p.slug, nome: p.nome, url: p.url || null }));

// ---- estado: a VERDADE são os arquivos de .herdr-obra-runs/ (e o legado), não a memória ----
// Assim o cockpit vê TODA missão da obra, inclusive as lançadas por fora (obra-fluxo direto).
const LEGADO = resolve(RAIZ, ".herdr-obra-status.json"); // onde caía a missão lançada sem OBRA_STATUS
const jaNoHistorico = new Set(); // runIds já arquivados (o cockpit não recebe "exit" de missão externa)

/** Histórico das missões encerradas — persiste em arquivo (sobrevive a reiniciar o cockpit). */
function lerMissoes() {
  try { return JSON.parse(readFileSync(MISSOES, "utf8")); } catch { return []; }
}
function guardarMissao(m) {
  const hist = lerMissoes();
  // Dedup: a mesma missão (objetivo+comecou) não entra duas vezes — protege contra
  // re-arquivar o arquivo legado a cada reinício do cockpit (a memória em RAM zera).
  const chave = (x) => (x.objetivo || "") + "|" + (x.comecou || "");
  if (hist.some((h) => chave(h) === chave(m))) return;
  hist.unshift(m);
  writeFileSync(MISSOES, JSON.stringify(hist.slice(0, 40), null, 2)); // guarda as 40 últimas
}

const lerStatus = (arquivo) => { try { return JSON.parse(readFileSync(arquivo, "utf8")); } catch { return null; } };

/** O link do PR, garimpado do resultado do passo PR (ex.: "PR: https://github.com/.../pull/12"). */
const prDoStatus = (s) => (String(s?.agents?.pr?.result || "").match(/https:\/\/github\.com\/\S+?\/pull\/\d+/) || [null])[0];

/**
 * O registro RICO de uma missão pro histórico: além de custo/veredito, guarda o PR, o nível
 * escolhido (tier), o motivo do veredito e o CUSTO POR PAPEL — pra você abrir e ver o que
 * cada agente fez e gastou, sem precisar do arquivo de status (que some em 30s).
 */
function registroRico(s) {
  const ag = s.agents || {};
  return {
    objetivo: s.objetivo || s.task, projeto: s.projeto || "?",
    comecou: s.comecou || null, fim: s.fim || null,
    custo: s.custoTotal ?? null, veredito: s.veredito || "terminou",
    tier: s.tier || null, tierMotivo: s.tierMotivo || null,
    prUrl: prDoStatus(s),
    vereditoMotivo: String(ag.revisor?.result || "").slice(0, 300) || null,
    papeis: PAPEIS.map((p) => {
      const a = ag[p.chave] || {};
      return { chave: p.chave, nome: p.nome, emoji: p.emoji,
        modelo: a.modelo || null, custo: a.custo ?? null, turnos: a.turnos ?? null,
        resultado: String(a.result || "").slice(0, 300) || null };
    }).filter((x) => x.modelo || x.custo != null || x.resultado),
  };
}

/**
 * CONTA (assinatura) que está rodando os agentes. `claude auth status` demora ~200ms — nunca
 * chamar isso dentro de retrato() (o SSE lê retrato ~1×/s e travaria o servidor pra todo mundo
 * conectado). Busca em background, ASSÍNCRONA, e serve sempre do cache.
 * ⚠️ Não existe "saldo de créditos" pra consultar aqui: no plano por assinatura (Max) não é
 * consumo por crédito, é limite de uso — por isso mostramos plano + o que a OBRA gastou (isso
 * sim é medido, em gastoObra()), nunca um número de crédito que a gente não tem como saber.
 */
let conta = { plano: null, email: null };
function atualizarConta() {
  execFile("claude", ["auth", "status", "--json"], { timeout: 5000 }, (erro, stdout) => {
    if (erro) return; // fica com o valor anterior (ou vazio, na 1ª falha) — nunca derruba o cockpit
    try {
      const s = JSON.parse(stdout);
      conta = { plano: s.subscriptionType || null, email: s.email || null };
    } catch {}
  });
}
atualizarConta();
setInterval(atualizarConta, 10 * 60 * 1000); // a assinatura não muda no meio da sessão; só refresca de leve

/** O processo do motor ainda existe? (sinal 0 não mata, só testa). Sem pid, assume vivo. */
function motorVivo(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Missão "morta": não encerrou, mas o processo do motor sumiu (a sessão que a lançou foi
 * interrompida). Sem isto, ela ficaria "rodando" pra sempre no cockpit e travaria um slot.
 * Verificação por PID, não por tempo — um passo do opus demora minutos e não é morte.
 */
const morreuNoMeio = (s) => s && !s.encerrada && s.pid && !motorVivo(s.pid);

/** Todos os arquivos de missão: os de .herdr-obra-runs/ + o legado, se existir. */
function arquivosDeRun() {
  let nomes = [];
  try { nomes = readdirSync(RUNS).filter((n) => n.endsWith(".json")).map((n) => join(RUNS, n)); } catch {}
  if (existsSync(LEGADO)) nomes.push(LEGADO);
  return nomes;
}

/** Uma missão montada a partir do arquivo de status dela (a fonte da verdade). */
function missaoDeArquivo(arquivo) {
  const s = lerStatus(arquivo);
  if (!s) return null;
  const paineis = PAPEIS.map((p) => {
    const a = (s.agents || {})[p.chave] || {};
    return {
      ...p,
      step: a.step || "aguardando",
      modelo: a.modelo || null, effort: a.effort || null,
      custo: a.custo ?? null, turnos: a.turnos ?? null,
      resultado: a.result || null,
      atividade: a.log && existsSync(a.log) ? lerAtividade(a.log, 6) : [],
    };
  });
  const morta = morreuNoMeio(s);
  return {
    id: s.runId || arquivo, arquivo,
    objetivo: s.objetivo || s.task || "(sem título)",
    projeto: s.projeto || "?",
    rodando: !s.encerrada && !morta,
    morta,
    comecou: s.comecou || null, fim: s.fim || null,
    veredito: s.veredito || (morta ? "interrompida" : null),
    tier: s.tier || null, tierMotivo: s.tierMotivo || null,
    prUrl: prDoStatus(s),
    custoTotal: s.custoTotal ?? paineis.reduce((t, p) => t + (p.custo || 0), 0),
    paineis,
  };
}

/**
 * GASTO DA OBRA por dia × hora — para o heatmap "onde o dinheiro queimou". Cada missão do
 * histórico entra na hora em que COMEÇOU (fuso do Brasil, -03:00). Só o gasto da obra: o
 * cockpit não conhece a conta inteira do Claude, só o que as missões custaram.
 */
function gastoObra(dias = 14) {
  const porDia = new Map(); // 'YYYY-MM-DD' -> { total, horas:[24] }
  for (const m of lerMissoes()) {
    const quando = m.comecou || m.fim; // fim como reserva: missão antiga pode não ter início
    if (quando == null || m.custo == null) continue;
    const br = new Date(new Date(quando).getTime() - 3 * 3600 * 1000); // UTC -> BRT
    const data = br.toISOString().slice(0, 10);
    const h = br.getUTCHours();
    if (!porDia.has(data)) porDia.set(data, { total: 0, horas: Array(24).fill(0) });
    const d = porDia.get(data);
    d.total += m.custo; d.horas[h] += m.custo;
  }
  // últimos N dias em ordem (mesmo os vazios, pra grade não ter buraco)
  const hoje = new Date(Date.now() - 3 * 3600 * 1000);
  const linhas = [];
  let pico = 0, total = 0;
  for (let i = dias - 1; i >= 0; i--) {
    const dt = new Date(hoje.getTime() - i * 86400000).toISOString().slice(0, 10);
    const d = porDia.get(dt) || { total: 0, horas: Array(24).fill(0) };
    linhas.push({ data: dt, total: d.total, horas: d.horas });
    total += d.total;
    for (const v of d.horas) if (v > pico) pico = v;
  }
  return { linhas, pico, total };
}

/** O retrato de agora: TODAS as missões (de qualquer porta) + histórico. */
function retrato() {
  const missoes = arquivosDeRun().map(missaoDeArquivo).filter(Boolean)
    .sort((a, b) => (String(a.comecou) < String(b.comecou) ? 1 : -1)); // mais recente em cima
  return {
    missoes,
    ativas: missoes.filter((m) => m.rodando).length,
    max: MAX_PARALELO,
    projetos: listaProjetos(),
    historico: lerMissoes().slice(0, 12),
    gasto: gastoObra(14),
    conta,
    em: new Date().toISOString(),
  };
}

/**
 * Varredura periódica: arquiva no histórico toda missão encerrada (mesmo a lançada por fora,
 * de que o cockpit não recebe "exit") e remove o arquivo 30s depois — tempo de você ler.
 */
function varrerEncerradas() {
  for (const arquivo of arquivosDeRun()) {
    let s = lerStatus(arquivo);
    if (!s) continue;
    // Motor morreu no meio: CARIMBA o encerramento no arquivo (assim aparece 30s como
    // "interrompida" e é arquivada uma vez, igual a uma missão que terminou normal).
    if (!s.encerrada && morreuNoMeio(s)) {
      s = { ...s, encerrada: true, veredito: "interrompida", fim: new Date().toISOString() };
      try { writeFileSync(arquivo, JSON.stringify(s, null, 2)); } catch {}
    }
    if (!s.encerrada) continue; // ainda rodando de verdade
    const id = s.runId || arquivo;
    if (!jaNoHistorico.has(id)) {
      jaNoHistorico.add(id);
      guardarMissao(registroRico(s));
    }
    // remove o arquivo 30s após o fim — INCLUSIVE o legado, senão a missão encerrada fica na
    // tela pra sempre e é re-arquivada a cada reinício. (Old-style obra-fluxo recria o legado
    // se rodar de novo; nada mais depende dele.)
    if (s.fim && Date.now() - new Date(s.fim).getTime() > 30000) {
      try { unlinkSync(arquivo); } catch {}
    }
  }
}
setInterval(varrerEncerradas, 5000);

/**
 * ROTEADOR DE CUSTO (modo Auto): um haiku barato lê o objetivo e escolhe o TIER de modelos
 * mais barato que dá conta. É o "modelo mais barato pra determinada tarefa" — dentro do Claude,
 * sem custo de assinatura nova. Na dúvida entre dois níveis, escolhe o mais barato (o revisor
 * pega o resto). Cada tier define o modelo por papel; PR é sempre haiku (só roda git).
 */
const TIERS = {
  leve:   { ENG: "haiku",  QA: "haiku",  REVISOR: "sonnet" },
  medio:  { ENG: "sonnet", QA: "haiku",  REVISOR: "sonnet" },
  pesado: { ENG: "opus",   QA: "sonnet", REVISOR: "opus" },
};
function classificarTarefa(objetivo) {
  return new Promise((ok) => {
    const prompt =
      'Classifique a tarefa de programação em UM nível e responda SÓ com JSON ' +
      '{"tier":"leve|medio|pesado","motivo":"curto"}.\n' +
      '- leve: texto/doc/README/renomear/mudança trivial.\n' +
      '- medio: feature/fix/teste comum.\n' +
      '- pesado: lógica complexa, OU toca em dinheiro/pagamento/acesso/permissão/dado sensível.\n' +
      'Na dúvida entre dois, escolha o MAIS BARATO.\nTAREFA: ' + objetivo;
    let buf = "";
    let cp;
    try { cp = spawn("claude", ["-p", prompt, "--model", "haiku", "--output-format", "stream-json", "--verbose"],
      { cwd: RAIZ, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { return ok({ tier: "medio", motivo: "classificador indisponível" }); }
    cp.stdout.on("data", (d) => { buf += d; });
    cp.on("error", () => ok({ tier: "medio", motivo: "classificador indisponível" }));
    cp.on("close", () => {
      let texto = "";
      for (const l of buf.split(/\r?\n/)) { const s = l.trim(); if (!s.startsWith("{")) continue; let ev; try { ev = JSON.parse(s); } catch { continue; } if (ev.type === "result") texto = ev.result || texto; }
      const m = texto.match(/\{[\s\S]*\}/);
      if (m) { try { const j = JSON.parse(m[0]); if (TIERS[j.tier]) return ok({ tier: j.tier, motivo: String(j.motivo || "").slice(0, 140) }); } catch {} }
      ok({ tier: "medio", motivo: "não classifiquei — usei médio" });
    });
  });
}

// Guarda os disparos recentes (chave objetivo+projeto → hora) — pega a duplicata na janela
// em que o run file ainda nem foi escrito (reenvio/clique-duplo). O check por arquivo pega o
// resto (missão já rodando). Sem isto, mandar 2× a mesma tarefa abre 2 missões e gasta dobrado.
const despachosRecentes = new Map();
const JANELA_DUP = 60000; // 1 min: cobre o reenvio "achei que não foi" (aconteceu com 27s)

/** Dispara uma missão. Não bloqueia as outras — cada uma roda no seu worktree e status. */
async function dispararMissao({ objetivo, projeto, time, forcar }) {
  const estado = retrato();
  if (estado.ativas >= MAX_PARALELO) throw new Error(`limite de ${MAX_PARALELO} missões ao mesmo tempo — espere uma terminar`);
  const obj = String(objetivo || "").trim();
  if (!obj) throw new Error("escreva o objetivo");
  if (obj.length > 4000) throw new Error("objetivo grande demais");

  const proj = acharProjeto(projeto) || projetosDisponiveis()[0];
  if (!proj) throw new Error("nenhum projeto disponível");

  // ANTI-DUPLICATA: a mesma tarefa não roda 2× ao mesmo tempo no mesmo projeto.
  const chaveDup = proj.slug + "|" + obj.toLowerCase();
  const recente = despachosRecentes.get(chaveDup);
  const jaRodando = estado.missoes.some((m) => m.rodando && m.projeto === proj.nome && (m.objetivo || "").trim().toLowerCase() === obj.toLowerCase());
  if (jaRodando || (recente && Date.now() - recente < JANELA_DUP)) {
    throw new Error("essa mesma missão já está rodando — não vou duplicar");
  }
  // marca JÁ (antes do classificador ~3s): dois pedidos concorrentes não passam os dois
  despachosRecentes.set(chaveDup, Date.now());

  /**
   * A TRAVA: antes de gastar o time, checa se o objetivo parece de OUTRO projeto. É a peça
   * que o dono pediu para poder "confiar no boss com qualquer projeto" — enfiar código no
   * repositório errado é o pior erro. Não decide sozinha: DEVOLVE o conflito para a tela
   * perguntar, e só ignora se o dono confirmar (`forcar`).
   */
  if (!forcar) {
    const conflito = conflitoDeProjeto(obj, proj.slug);
    if (conflito) { const e = new Error(conflito.motivo); e.conflito = conflito; e.code = 409; throw e; }
  }

  // Sem OBRA_STATUS: o obra-fluxo grava sozinho em .herdr-obra-runs/, que o cockpit varre —
  // a mesma porta das missões lançadas por fora. A "receita" do time vira env que ele já lê.
  const env = { ...process.env };
  let tier = null, tierMotivo = null;
  if (time === "rapido") {
    env.OBRA_MODELO_ENG = "sonnet"; env.OBRA_MODELO_QA = "haiku"; env.OBRA_MODELO_REVISOR = "sonnet";
  } else if (time === "auto") {
    const c = await classificarTarefa(obj);       // haiku barato decide o nível
    tier = c.tier; tierMotivo = c.motivo;
    const t = TIERS[tier];
    env.OBRA_MODELO_ENG = t.ENG; env.OBRA_MODELO_QA = t.QA; env.OBRA_MODELO_REVISOR = t.REVISOR;
    env.OBRA_TIER = tier; env.OBRA_TIER_MOTIVO = tierMotivo;
  } // caprichado: sem override (opus onde decide, o padrão do obra-fluxo)

  const args = [FLUXO, obj];
  if (proj.dir !== RAIZ) args.push("--projeto", proj.dir);
  const filho = spawn("node", args, { cwd: RAIZ, env, detached: false });
  filho.on("error", () => {}); // não derruba o cockpit se o spawn falhar
  return { pid: filho.pid, projeto: proj.nome, tier, tierMotivo };
}

/**
 * Cria um projeto DO ZERO: pasta em ~/Documents/DEV, git init, um scaffold mínimo (README +
 * CLAUDE.md + .gitignore) e o primeiro commit — a obra precisa de um HEAD para criar worktree.
 * Depois registra no mesmo lugar que um repo existente.
 */
function criarProjetoNovo({ nome, palavras }) {
  const slug = slugificar(nome);
  const dir = resolve(RAIZ_DEV, slug);
  if (existsSync(dir)) throw new Error(`já existe uma pasta "${slug}" em ~/Documents/DEV`);
  mkdirSync(dir, { recursive: true });
  const titulo = (nome || slug).trim();
  writeFileSync(join(dir, "README.md"), `# ${titulo}\n\nProjeto criado pelo cockpit da obra.\n`);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.env\n.DS_Store\n.herdr-obra*\n");
  writeFileSync(join(dir, "CLAUDE.md"),
    `# ${titulo}\n\nRegras da casa (a obra lê este arquivo antes de mexer):\n\n` +
    `- Não commitar na main direto; deixar o trabalho no galho e abrir PR.\n` +
    `- Provar rodando (não só compilar).\n` +
    `- Interface e textos em português do Brasil; nomes de código em inglês.\n`);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  // sem depender do git config global do dono
  execFileSync("git", ["-C", dir, "-c", "user.name=Obra", "-c", "user.email=obra@local",
    "commit", "-q", "-m", "chore: início do projeto (scaffold do cockpit)"], { encoding: "utf8" });
  return adicionarProjeto({ nome: titulo, dir, palavras });
}

/** Registra um projeto (repo existente ou novo). Devolve o projeto criado. */
function novoProjeto({ modo, nome, dir, palavras }) {
  if (modo === "novo") {
    if (!String(nome || "").trim()) throw new Error("dê um nome ao projeto");
    return criarProjetoNovo({ nome, palavras });
  }
  // existente: o dir tem que ser um dos candidatos (repo git em ~/Documents/DEV), não um caminho
  // qualquer digitado — senão a tela viraria uma porta para apontar o motor a qualquer pasta.
  const cand = reposCandidatos().find((c) => c.dir === dir);
  if (!cand) throw new Error("escolha um repositório da lista");
  return adicionarProjeto({ nome: nome || cand.nome, dir: cand.dir, palavras });
}

// ================== CHAT DO BOSS (um Claude no navegador) ==================
// Sessão DEDICADA: o contexto cresce sozinho (resume a mesma sessão) e conhece o projeto
// pela memória/CLAUDE.md — sem se misturar com a conversa do terminal.
// UM CHEFE-DOS-CHEFES: um boss só, com sessão dedicada (contexto cresce/persiste), que conhece
// TODOS os projetos (inclusive os novos) e despacha pra qualquer um. Você diz "melhora X no TMS"
// ou "cria Y no cockpit" e ELE roteia — pela aba em que você está (dica) ou pelo que você disser.
const BOSS = resolve(RAIZ, ".herdr-obra-boss.json"); // { sessionId, mensagens: [{de,texto,anexos,em}] }
const lerBoss = () => { try { const b = JSON.parse(readFileSync(BOSS, "utf8")); return (b && Array.isArray(b.mensagens)) ? b : { sessionId: null, mensagens: [] }; } catch { return { sessionId: null, mensagens: [] }; } };
const salvarBoss = (b) => writeFileSync(BOSS, JSON.stringify(b, null, 2));

// Arquivos que o dono anexa no chat do Boss. Ficam FORA do worktree de qualquer missão (isto
// aqui é a raiz do cockpit, não um projeto-alvo) — mas ainda assim gitignorados (.herdr-obra*),
// igual a todo outro arquivo de runtime.
const ANEXOS = resolve(RAIZ, ".herdr-obra-anexos");
try { mkdirSync(ANEXOS, { recursive: true }); } catch {}
const TETO_ANEXO = 4 * 1024 * 1024; // 4MB por arquivo — chat, não repositório de mídia

/** Nome de arquivo sem caminho e sem caractere que preste pra path traversal. */
function nomeSeguro(nome) {
  const base = String(nome || "arquivo").split(/[\\/]/).pop();
  const limpo = base.replace(/[^\w.\-() ]/g, "_").slice(0, 120).trim();
  return limpo || "arquivo";
}

/** Salva um anexo do chat (base64) em disco e devolve o caminho absoluto — nunca o conteúdo. */
function salvarAnexo({ nome, dados }) {
  if (!dados) throw new Error("arquivo vazio");
  let buf;
  try { buf = Buffer.from(String(dados), "base64"); } catch { throw new Error("arquivo inválido"); }
  if (!buf.length) throw new Error("arquivo vazio");
  if (buf.length > TETO_ANEXO) throw new Error("arquivo passa de 4MB");
  const limpo = nomeSeguro(nome);
  const caminho = join(ANEXOS, `${randomUUID()}-${limpo}`);
  writeFileSync(caminho, buf);
  return { caminho, nome: limpo, tamanho: buf.length };
}

/**
 * O prompt do CHEFE-DOS-CHEFES: conhece todos os projetos e roteia. `dica` é o projeto da aba
 * em que o dono está — o default quando ele não disser a qual projeto a tarefa pertence.
 */
function bossPrompt(dica) {
  const lista = projetosDisponiveis().map((p) => `- ${p.slug} (${p.nome}) → ${p.dir}`).join("\n");
  return [
    "Você é o CHEFE-DOS-CHEFES da obra do Gilvane, falando com ele no cockpit.",
    "Você conhece TODOS os projetos e COORDENA um time (engenheiro→QA→revisor→PR) que roda em qualquer um deles:",
    lista,
    "Pode ler o CLAUDE.md e a pasta memory/ de qualquer projeto (use Read no caminho acima) quando precisar de contexto.",
    "REGRA DE ROTEAMENTO (você decide, não pergunte toda vez):",
    "- Tarefa de CÓDIGO fechada (feature, fix, teste) que vira PR → DESPACHE terminando a resposta",
    "  com um marcador em UMA linha: [MISSAO: <slug-do-projeto-certo> | <objetivo claro e completo>].",
    "- Escolha o projeto pelo que o dono disser; se ele NÃO disser, assuma o projeto da aba atual: " + (dica || "(nenhuma)") + ".",
    "- Dúvida, conversa, arquitetura, algo rápido → responda você mesmo, curto, sem marcador.",
    "Antes do marcador, escreva 1-2 linhas dizendo o que vai despachar e pra qual projeto.",
    "Quando a mensagem trouxer 'Arquivos anexados pelo dono', são caminhos locais no disco —",
    "leia com Read se o conteúdo importar para a resposta ou para o objetivo que vai despachar.",
    "Seja conciso e direto, em português do Brasil. Não invente número nem promessa.",
  ].join("\n");
}

/** Roda o Claude como chefe-dos-chefes (assíncrono, não trava o event loop). */
function rodarBoss(mensagem, sessionId, dica) {
  return new Promise((ok) => {
    const args = ["-p", mensagem, "--append-system-prompt", bossPrompt(dica),
      "--allowedTools", "Read,Grep,Glob", "--model", "sonnet",
      "--output-format", "stream-json", "--verbose"];
    if (sessionId) args.push("--resume", sessionId);
    let buf = "";
    const cp = spawn("claude", args, { cwd: RAIZ, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    cp.stdout.on("data", (d) => { buf += d; });
    cp.stderr.on("data", (d) => { buf += d; });
    cp.on("error", () => ok({ texto: "(não consegui falar com o Boss — o CLI do Claude está no PATH?)", sessionId }));
    cp.on("close", () => {
      let texto = "", sid = sessionId;
      for (const linha of buf.split(/\r?\n/)) {
        const s = linha.trim();
        if (!s.startsWith("{")) continue;
        let ev; try { ev = JSON.parse(s); } catch { continue; }
        if (ev.session_id) sid = ev.session_id;
        if (ev.type === "result") texto = ev.result || texto;
      }
      ok({ texto: texto || "(o Boss não respondeu)", sessionId: sid });
    });
  });
}

/** Uma mensagem do dono → resposta do chefe-dos-chefes (+ despacho se ele decidir que é obra). */
async function bossChat(mensagem, anexos, projetoDica) {
  const dica = (acharProjeto(projetoDica) || {}).slug || null; // aba atual = default de roteamento
  const msg = String(mensagem || "").trim();
  // Só aceita anexo que a GENTE salvou em /boss/anexo (caminho dentro de ANEXOS) — senão a
  // mensagem viraria uma porta para mandar o Boss (que tem Read) ler qualquer arquivo do disco.
  const validos = (Array.isArray(anexos) ? anexos : []).slice(0, 5)
    .filter((a) => a && typeof a.caminho === "string" && typeof a.nome === "string")
    .map((a) => ({ nome: a.nome, caminho: resolve(a.caminho) }))
    .filter((a) => a.caminho.startsWith(ANEXOS + "/") && existsSync(a.caminho));
  if (!msg && !validos.length) throw new Error("escreva a mensagem ou anexe um arquivo");
  if (msg.length > 4000) throw new Error("mensagem grande demais");
  const b = lerBoss();
  b.mensagens.push({ de: "voce", texto: msg, anexos: validos, em: new Date().toISOString() });

  const paraBoss = msg + (validos.length
    ? (msg ? "\n\n" : "") + "Arquivos anexados pelo dono:\n" +
      validos.map((a) => `- ${a.nome}: ${a.caminho}`).join("\n")
    : "");
  const r = await rodarBoss(paraBoss, b.sessionId, dica);
  if (r.sessionId) b.sessionId = r.sessionId; // fixa a sessão dedicada na 1ª resposta

  // O Boss decidiu despachar? [MISSAO: slug | objetivo]
  let texto = r.texto, despachos = [];
  const re = /\[MISSAO:\s*([^\|\]]+?)\s*\|\s*([^\]]+?)\s*\]/gi;
  let m;
  while ((m = re.exec(r.texto))) {
    const slug = m[1].trim(), objetivo = m[2].trim();
    try {
      const d = await dispararMissao({ objetivo, projeto: slug, time: "auto", forcar: true }); // Boss já escolheu o projeto; Auto escolhe o modelo
      despachos.push(`✅ despachei pra obra: ${d.projeto} — "${objetivo.slice(0, 60)}"`);
    } catch (e) {
      despachos.push(`⚠️ não consegui despachar (${e.message})`);
    }
  }
  texto = texto.replace(re, "").trim();
  if (despachos.length) texto += (texto ? "\n\n" : "") + despachos.join("\n");

  b.mensagens.push({ de: "boss", texto, em: new Date().toISOString() });
  b.mensagens = b.mensagens.slice(-60); // guarda as últimas 60 na tela (a sessão do Claude tem o resto)
  salvarBoss(b);
  return { resposta: texto };
}

// ---- corpo JSON com teto (porta de escrita: a lição do CLAUDE.md) ----
function lerCorpo(req, limite = 8 * 1024) {
  return new Promise((ok, erro) => {
    let bruto = "";
    req.on("data", (p) => { bruto += p; if (bruto.length > limite) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(bruto || "{}")); } catch { erro(new Error("json inválido")); } });
    req.on("error", erro);
  });
}

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cockpit · Obra</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--marinho:${MARINHO};--ciano:${CIANO};--verde:${VERDE};--gelo:${GELO};--ambar:${AMBAR};--verm:${VERM};--linha:#16283c;--painel:#0b1420}
body{background:var(--marinho);color:var(--gelo);font:14px/1.5 "SF Mono",Menlo,ui-monospace,monospace;min-height:100vh;
 background-image:linear-gradient(rgba(53,193,239,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(53,193,239,.045) 1px,transparent 1px);
 background-size:46px 46px}
header{display:flex;align-items:center;gap:16px;padding:14px 24px;border-bottom:1px solid var(--linha);flex-wrap:wrap}
h1{font-size:15px;letter-spacing:.28em;color:var(--ciano);font-weight:700}
h1 b{color:var(--verde)}
.abas{display:flex;gap:6px}
.aba{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6d8299;padding:6px 12px;border:1px solid var(--linha);
 background:transparent;cursor:pointer;font-family:inherit}
.aba.on{color:var(--marinho);background:var(--ciano);border-color:var(--ciano);font-weight:700}
.aba.mais{color:var(--verde);border-style:dashed}
.aba.mais:hover{background:var(--verde);color:var(--marinho)}
.aba.boss{color:var(--ambar);border-color:var(--ambar)}
.aba.boss:hover{background:var(--ambar);color:var(--marinho)}
.aba.ver{color:var(--verde);border-color:var(--verde)}
.aba.ver:hover{background:var(--verde);color:var(--marinho)}
.aba.fluxo{color:var(--ciano);border-color:var(--linha)}
.aba.fluxo:hover{border-color:var(--ciano)}
#conta{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:11px;color:#6d8299;white-space:nowrap}
#conta b{font-weight:700}
#conta .plano{color:var(--ciano);letter-spacing:.06em}
#relogio{font-size:11px;color:#6d8299}

/* chat do Boss — painel inferior */
.chat{position:fixed;bottom:0;left:0;right:0;width:100%;max-height:50vh;background:var(--painel);
 border-top:1px solid var(--ambar);display:flex;flex-direction:column;transform:translateY(100%);
 transition:transform .18s;z-index:20;
 font-family:"JetBrainsMono Nerd Font","JetBrains Mono NF","JetBrains Mono",ui-monospace,monospace;
 font-weight:300}
.chat.on{transform:translateY(0)}
.chatcab{padding:14px 16px;border-bottom:1px solid var(--linha);font-size:12px;letter-spacing:.14em;
 color:var(--ambar);font-weight:600;display:flex;align-items:center;gap:10px}
.chatsub{font-size:10px;letter-spacing:.06em;color:#6d8299;font-weight:300;text-transform:none}
.chatcab button{margin-left:auto;background:transparent;border:0;color:#6d8299;cursor:pointer;font-size:16px}
.chatmsgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:18px}
.msg{max-width:88%;padding:12px 14px;font-size:13px;font-weight:300;line-height:1.85;white-space:pre-wrap;word-break:break-word}
.msg.voce{align-self:flex-end;background:#0e2233;border:1px solid var(--linha);color:var(--gelo)}
.msg.boss{align-self:flex-start;background:#12202f;border:1px solid #23384d;color:var(--gelo)}
.msg.pensando{align-self:flex-start;color:#6d8299;font-style:italic}
.chatvazio{color:#6d8299;text-align:center;margin:auto;font-size:12px;padding:20px;line-height:1.7}
.anexos{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.anexo{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--gelo);
 border:1px solid #23384d;background:#0b1420;padding:3px 8px}
.chatanexos{display:none;flex-wrap:wrap;gap:6px;padding:0 12px 10px}
.chatanexos .anexo{color:var(--ciano);border-color:var(--linha)}
.chatanexos .anexo b{cursor:pointer;color:var(--verm);font-weight:700}
.chatentrada{border-top:1px solid var(--linha);padding:12px;display:flex;gap:8px}
#chatAnexar{background:transparent;border:1px solid var(--linha);color:#8ba4bb;cursor:pointer;
 font-size:15px;padding:0 12px;align-self:stretch}
#chatAnexar:hover{border-color:var(--ambar);color:var(--ambar)}
.chatentrada textarea{flex:1;min-height:44px;max-height:140px;resize:vertical;background:#0b1420;
 border:1px solid var(--linha);color:var(--gelo);padding:10px 12px;
 font:300 13px/1.7 "JetBrainsMono Nerd Font","JetBrains Mono NF","JetBrains Mono",ui-monospace,monospace}
.chatentrada textarea:focus{outline:none;border-color:var(--ambar)}
.chatentrada button{background:transparent;border:1px solid var(--ambar);color:var(--ambar);padding:0 16px;
 cursor:pointer;font:300 11px/1 "JetBrainsMono Nerd Font","JetBrains Mono NF","JetBrains Mono",ui-monospace,monospace;
 letter-spacing:.1em;text-transform:uppercase}
.chatentrada button:hover:not(:disabled){background:var(--ambar);color:var(--marinho)}
.chatentrada button:disabled{opacity:.4;cursor:default}

/* modal de novo projeto */
.modal{position:fixed;inset:0;background:rgba(3,8,15,.8);display:none;align-items:center;justify-content:center;z-index:10}
.modal.on{display:flex}
.cxmodal{background:var(--painel);border:1px solid var(--ciano);width:min(520px,92vw);padding:22px}
.mtit{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--ciano);font-weight:700;margin-bottom:16px}
.modo{display:flex;border:1px solid var(--linha);margin-bottom:16px}
.modo button{flex:1;background:transparent;color:#6d8299;border:0;padding:9px;cursor:pointer;font:11px/1 "SF Mono",monospace;letter-spacing:.08em}
.modo button.on{background:var(--ciano);color:var(--marinho);font-weight:700}
.cxmodal label{display:block;font-size:11px;color:#8ba4bb;margin:10px 0 5px}
.cxmodal .dica{color:#54708a;font-weight:400;text-transform:none;letter-spacing:0}
.cxmodal input,.cxmodal select{width:100%;background:#0b1420;border:1px solid var(--linha);color:var(--gelo);
 padding:9px 11px;font:13px/1.4 "SF Mono",Menlo,monospace}
.cxmodal input:focus,.cxmodal select:focus{outline:none;border-color:var(--ciano)}
.mbtns{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.mbtns button{border:1px solid;background:transparent;padding:9px 18px;cursor:pointer;font:11px/1 "SF Mono",monospace;letter-spacing:.12em;text-transform:uppercase}
.mbtns .cancelar{color:#6d8299;border-color:var(--linha)}
.mbtns .ok{color:var(--verde);border-color:var(--verde)}
.mbtns .ok:hover{background:var(--verde);color:var(--marinho)}
#modalAviso{font-size:11px;color:var(--ambar);margin-top:10px;min-height:0}

/* heatmap de gasto (dia × hora) */
.mapa{padding:0 24px 30px;overflow-x:auto}
.mapa table{border-collapse:collapse;font-size:10px;color:#6d8299;width:100%}
.mapa td,.mapa th{padding:0}
.mapa .dia{padding-right:10px;text-align:right;color:#8ba4bb;white-space:nowrap;font-size:11px;width:1%}
/* sem largura fixa: as 24 colunas de hora dividem a largura da tabela e enchem a linha */
.mapa .cel{height:20px;border:1px solid var(--marinho)}
.mapa .tot{padding-left:12px;text-align:right;color:var(--verde);white-space:nowrap;font-weight:700;font-size:11px;width:1%}
.mapa .eixo{color:#54708a;font-size:10px;text-align:left;padding-top:4px}
.mapa .legenda{display:flex;gap:16px;align-items:center;margin-top:12px;font-size:11px;color:#8ba4bb;flex-wrap:wrap}
.mapa .legenda i{display:inline-block;width:16px;height:12px;margin-right:6px;vertical-align:middle;border:1px solid var(--marinho)}

/* compositor */
.compositor{padding:16px 24px;border-bottom:1px solid var(--linha);display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}
.compositor textarea{flex:1 1 420px;min-width:0;min-height:52px;resize:vertical;background:var(--painel);border:1px solid var(--linha);
 color:var(--gelo);padding:10px 12px;font:13px/1.5 "SF Mono",Menlo,monospace}
.compositor textarea:focus{outline:none;border-color:var(--ciano)}
.timesel{display:flex;border:1px solid var(--linha)}
.timesel button{background:transparent;color:#6d8299;border:0;padding:9px 12px;cursor:pointer;font:11px/1 "SF Mono",monospace;letter-spacing:.1em}
.timesel button.on{background:var(--ciano);color:var(--marinho);font-weight:700}
#rodar{background:transparent;border:1px solid var(--verde);color:var(--verde);padding:10px 20px;cursor:pointer;
 font:11px/1 "SF Mono",monospace;letter-spacing:.14em;text-transform:uppercase;align-self:stretch}
#rodar:hover:not(:disabled){background:var(--verde);color:var(--marinho)}
#rodar:disabled{opacity:.4;cursor:default}
#aviso{width:100%;font-size:11px;color:var(--ambar);min-height:0}

.e-aguardando{color:#54708a;border-color:#54708a}
.e-trabalhando{color:var(--ciano);border-color:var(--ciano)}
.e-terminou{color:var(--verde);border-color:var(--verde)}
.e-reprovou{color:var(--verm);border-color:var(--verm)}
@keyframes pisca{50%{opacity:.3}}
.pisca{animation:pisca 1.1s infinite}

/* grid de MISSÕES — cada card é uma missão rodando em paralelo */
.missoes{padding:12px 24px 20px;display:flex;flex-direction:column;gap:14px}
.mcard{border:1px solid var(--linha);background:var(--painel)}
.mcard.rodando{border-color:var(--ciano)}
.mhead{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--linha);flex-wrap:wrap}
.mhead .proj{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ciano);border:1px solid var(--linha);padding:2px 8px}
.mhead .obj{flex:1 1 260px;color:var(--gelo);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mhead .badge{font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 9px;border:1px solid}
.mhead .custo{font-size:13px;color:var(--verde);font-weight:700}
.b-on{color:var(--ciano);border-color:var(--ciano)}
.b-off{color:#54708a;border-color:#54708a}
/* os 4 papéis, lado a lado dentro da missão */
.roles{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--linha)}
.role{background:var(--painel);padding:10px 12px;min-height:96px;display:flex;flex-direction:column;gap:6px}
.role.ativo{background:#0e1a28}
.role .rt{display:flex;align-items:center;gap:7px}
.role .rt .emo{font-size:14px}
.role .rt .nm{font-size:12px;font-weight:700}
.role .rt .est{margin-left:auto;font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;border:1px solid}
.role .ativ{font-size:11px;color:#8ba4bb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.role .ativ.tool{color:var(--gelo)}
.role .res{font-size:11px;color:var(--gelo);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.role .rp{margin-top:auto;display:flex;gap:8px;font-size:10px;color:#6d8299}
.role .rp .cu{margin-left:auto;color:var(--verde)}
@media(max-width:720px){.roles{grid-template-columns:repeat(2,1fr)}}
/* mini-grafo do pipeline (Eng→QA→Rev→PR) no topo do card */
.mgwrap{display:flex;align-items:center;gap:10px;padding:9px 14px 3px;border-bottom:1px solid var(--linha)}
.mgraf{height:42px;width:auto;max-width:290px;flex:0 0 auto}
.mg-lb{fill:#6b8299;font:700 8px "SF Mono",monospace;letter-spacing:.05em;text-transform:uppercase}
.mg-puls{animation:mgpulse 1.15s ease-in-out infinite}
@keyframes mgpulse{0%,100%{opacity:1}50%{opacity:.4}}
.mground{font:700 9px "SF Mono",monospace;color:var(--verm);letter-spacing:.06em;white-space:nowrap}
.vazio{color:#6d8299;text-align:center;padding:50px 24px}
.vazio b{display:block;color:var(--gelo);font-size:15px;margin-bottom:6px}
.cap{font-size:11px;color:#6d8299;margin-left:8px}
/* histórico */
h2.secao{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6d8299;padding:14px 24px 8px}
.historico{padding:0 24px 30px;display:flex;flex-direction:column;gap:6px}
.hrow{display:flex;align-items:center;gap:12px;border:1px solid var(--linha);background:var(--painel);padding:9px 13px;font-size:12px}
.hrow .hv{font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border:1px solid;flex:none}
.hv-aprovado{color:var(--verde);border-color:var(--verde)}
.hv-reprovado{color:var(--verm);border-color:var(--verm)}
.hv-terminou{color:var(--ciano);border-color:var(--ciano)}
.hv-falhou{color:var(--ambar);border-color:var(--ambar)}
.hv-interrompida{color:var(--ambar);border-color:var(--ambar)}
.hrow .ho{flex:1;color:var(--gelo);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .hp{color:#6d8299;flex:none}
.hrow .hc{color:var(--verde);flex:none}
/* histórico expansível */
.hitem{border:1px solid var(--linha);background:var(--painel)}
.hitem>summary{list-style:none;cursor:pointer}
.hitem>summary::-webkit-details-marker{display:none}
.hitem .hrow{border:0;background:transparent}
.hitem[open] .hrow{border-bottom:1px solid var(--linha)}
.hdet{padding:12px 14px;display:flex;flex-direction:column;gap:10px;font-size:12px}
.hdet .lin{color:#8ba4bb}
.hdet a{color:var(--ciano)}
.verdiff{background:transparent;border:1px solid var(--linha);color:var(--ciano);cursor:pointer;
 font:10px/1 "SF Mono",monospace;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;margin-left:8px}
.verdiff:hover{background:var(--ciano);color:var(--marinho)}
.diffbox{margin-top:8px;max-height:420px;overflow:auto;font:11px/1.45 "SF Mono",Menlo,monospace;border:1px solid var(--linha);background:#0a1219}
.diffbox:empty{display:none}
.diffbox .dl{white-space:pre;padding:0 10px}
.diffbox .add{color:var(--verde);background:rgba(55,207,124,.07)}
.diffbox .del{color:var(--verm);background:rgba(235,110,110,.07)}
.diffbox .hh{color:var(--ciano)}
.diffbox .ff{color:var(--ambar);font-weight:700;border-top:1px solid var(--linha);margin-top:4px}
.diffbox .dim{color:#54708a}
.hdet .papel{display:flex;gap:10px;align-items:baseline;border-top:1px solid #12202f;padding-top:7px}
.hdet .papel .pn{color:var(--gelo);font-weight:700;min-width:92px}
.hdet .papel .pm{color:var(--ambar);min-width:56px}
.hdet .papel .pr{flex:1;color:#8ba4bb;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.hdet .papel .pc{color:var(--verde)}
/* chip de nível (tier) */
.tier{font-size:9px;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;border:1px solid;flex:none}
.tier-leve{color:var(--verde);border-color:var(--verde)}
.tier-medio{color:var(--ciano);border-color:var(--ciano)}
.tier-pesado{color:var(--verm);border-color:var(--verm)}
/* pergunta do conflito */
.conflito{width:100%;background:#1a1206;border:1px solid var(--ambar);padding:12px 14px;margin-top:4px;font-size:13px;color:var(--gelo)}
.conflito b{color:var(--ambar)}
.conflito .btns{display:flex;gap:8px;margin-top:10px}
.conflito button{border:1px solid;background:transparent;padding:7px 14px;cursor:pointer;font:11px/1 "SF Mono",monospace;letter-spacing:.1em;text-transform:uppercase}
.conflito .sim{color:var(--verm);border-color:var(--verm)}
.conflito .nao{color:var(--ciano);border-color:var(--ciano)}
</style></head><body>
<header>
  <h1>COCKPIT<b>·</b>OBRA</h1>
  <div class="abas" id="abas"></div>
  <button class="aba fluxo" id="btFluxo" title="Ver o grafo do processo e o fluxo das tarefas" onclick="window.open('/fluxo','_blank')">📊 fluxo</button>
  <button class="aba ver" id="btVer" title="Abrir o sistema deste projeto no navegador">🌐 ver sistema</button>
  <button class="aba mais" id="btNovo" title="Adicionar ou criar um projeto">+ novo</button>
  <button class="aba boss" id="btBoss" title="Falar com o Boss">💬 boss</button>
  <span id="conta"></span>
  <span id="relogio"></span>
</header>
<div class="chat" id="chat">
  <div class="chatcab">💬 BOSS <span class="chatsub" id="chatProj">sessão dedicada · conhece o projeto</span>
    <button id="chatJanela" title="Abrir em janela inteira (outra aba)" onclick="window.open('/chat','_blank')">⛶</button>
    <button id="chatFechar" title="Fechar">✕</button></div>
  <div class="chatmsgs" id="chatmsgs"></div>
  <div class="chatanexos" id="chatAnexos"></div>
  <div class="chatentrada">
    <input type="file" id="chatArquivo" multiple style="display:none">
    <button id="chatAnexar" title="Anexar arquivo">📎</button>
    <textarea id="chatobj" maxlength="4000" placeholder="Fala com o Boss… (ele responde ou despacha pra obra)"></textarea>
    <button id="chatEnviar">Enviar</button>
  </div>
</div>
<div class="modal" id="modal">
  <div class="cxmodal">
    <div class="mtit">Novo projeto</div>
    <div class="modo" id="modo">
      <button data-m="existente" class="on">Repo que já existe</button>
      <button data-m="novo">Criar do zero</button>
    </div>
    <div id="campoExistente">
      <label>Repositório <span class="dica">(pastas git em ~/Documents/DEV)</span></label>
      <select id="selRepo"></select>
    </div>
    <div id="campoNovo" style="display:none">
      <label>Nome do projeto</label>
      <input id="nomeNovo" maxlength="40" placeholder="ex.: Prospector">
      <div class="dica">cria a pasta em ~/Documents/DEV, com git e um CLAUDE.md</div>
    </div>
    <label>Palavras-chave <span class="dica">(a trava usa pra saber que a tarefa é deste projeto — separe por vírgula)</span></label>
    <input id="palavras" maxlength="200" placeholder="ex.: prospec, lead, cnpj, receita federal">
    <div class="mbtns">
      <button class="cancelar" id="cancelar">Cancelar</button>
      <button class="ok" id="addProjeto">Adicionar</button>
    </div>
    <div id="modalAviso"></div>
  </div>
</div>
<div class="compositor">
  <textarea id="obj" maxlength="4000" placeholder="O que o time deve fazer? (ex.: adicionar um teste para X, corrigir o bug Y)"></textarea>
  <div class="timesel" id="time">
    <button data-t="auto" class="on" title="O cockpit escolhe o modelo mais barato que dá conta">Auto</button>
    <button data-t="caprichado" title="Opus onde decide (caro, robusto)">Caprichado</button>
    <button data-t="rapido" title="Tudo leve (barato)">Rápido</button>
  </div>
  <button id="rodar">Acionar time</button>
  <span class="cap" id="cap"></span>
  <div id="aviso"></div>
</div>
<div class="missoes" id="missoes"></div>
<h2 class="secao" id="hsec" style="display:none">Missões anteriores</h2>
<div class="historico" id="historico"></div>
<h2 class="secao" id="gsec" style="display:none">Onde o dinheiro da obra queimou · 14 dias × hora</h2>
<div class="mapa" id="mapa"></div>
<script>
const PAPEIS=${JSON.stringify(PAPEIS)};
let PROJETOS=${JSON.stringify(listaProjetos())};   // semente do 1º paint; atualizada a cada retrato
let time="auto", projeto=(PROJETOS[0]||{}).slug;
const esc=s=>String(s??"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
const est2cls={aguardando:"e-aguardando",trabalhando:"e-trabalhando",terminou:"e-terminou"};
const dinheiro=v=>v==null?"—":"US$ "+Number(v).toFixed(2);

// abas de projeto — REDESENHADAS quando a lista muda (projeto novo aparece sem recarregar)
let abasAssinatura="";
function pintarAbas(){
  const ass=PROJETOS.map(p=>p.slug).join("|");
  if(ass===abasAssinatura) return;   // nada mudou: não repinta (evita flicker e perder o clique)
  abasAssinatura=ass;
  if(!projeto||!PROJETOS.some(p=>p.slug===projeto)) projeto=(PROJETOS[0]||{}).slug;
  document.getElementById("abas").innerHTML=PROJETOS.map(p=>
    '<button class="aba'+(p.slug===projeto?" on":"")+'" data-p="'+esc(p.slug)+'">'+esc(p.nome)+'</button>').join("");
  document.querySelectorAll(".abas .aba").forEach(b=>b.onclick=()=>{
    projeto=b.dataset.p; document.querySelectorAll(".abas .aba").forEach(x=>x.classList.toggle("on",x===b));
    // as abas seguem sendo a lista de projetos + o alvo do "Acionar time"; pro chefe-dos-chefes
    // a aba é só a DICA de roteamento (default quando você não diz o projeto).
    const bt=document.getElementById("chatProj"); if(bt) bt.textContent="chefe-dos-chefes · aba: "+((PROJETOS.find(p=>p.slug===projeto)||{}).nome||projeto);
  });
}
pintarAbas();
document.querySelectorAll("#time button").forEach(b=>b.onclick=()=>{
  time=b.dataset.t; document.querySelectorAll("#time button").forEach(x=>x.classList.toggle("on",x===b));
});

// ---- modal: novo projeto ----
let modoProjeto="existente";
const modal=document.getElementById("modal");
async function abrirModal(){
  document.getElementById("modalAviso").textContent="";
  // carrega os repos candidatos (git em ~/Documents/DEV ainda não registrados)
  try{
    const {candidatos}=await (await fetch("/projetos/candidatos")).json();
    document.getElementById("selRepo").innerHTML = candidatos.length
      ? candidatos.map(c=>'<option value="'+esc(c.dir)+'">'+esc(c.nome)+'</option>').join("")
      : '<option value="">(nenhum repo novo em ~/Documents/DEV)</option>';
  }catch{}
  modal.classList.add("on");
}
document.getElementById("btNovo").onclick=abrirModal;
// "ver sistema": abre no navegador o site/dev-server do projeto da aba atual.
// Sem URL cadastrada, pergunta uma vez e guarda (o retrato confirma no próximo tick).
document.getElementById("btVer").onclick=()=>{
  const p=PROJETOS.find(x=>x.slug===projeto)||{};
  let url=p.url;
  if(!url){
    url=prompt("URL do sistema de "+(p.nome||projeto)+" (ex.: https://querofretes.com.br ou http://localhost:5050):","https://");
    if(!url) return;
    url=url.trim();
    if(url.indexOf("http://")!==0 && url.indexOf("https://")!==0){ alert("A URL tem que comecar com http:// ou https://"); return; }
    p.url=url;
    fetch("/projetos/url",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({slug:projeto,url:url})}).catch(function(){});
  }
  window.open(url,"_blank"); // aberto DENTRO do clique → sem bloqueio de pop-up
};
document.getElementById("cancelar").onclick=()=>modal.classList.remove("on");
modal.onclick=e=>{ if(e.target===modal) modal.classList.remove("on"); };
document.querySelectorAll("#modo button").forEach(b=>b.onclick=()=>{
  modoProjeto=b.dataset.m;
  document.querySelectorAll("#modo button").forEach(x=>x.classList.toggle("on",x===b));
  document.getElementById("campoExistente").style.display = modoProjeto==="existente"?"block":"none";
  document.getElementById("campoNovo").style.display = modoProjeto==="novo"?"block":"none";
});
document.getElementById("addProjeto").onclick=async()=>{
  const av=document.getElementById("modalAviso"); av.textContent="";
  const palavras=document.getElementById("palavras").value;
  const corpo = modoProjeto==="novo"
    ? {modo:"novo", nome:document.getElementById("nomeNovo").value, palavras}
    : {modo:"existente", dir:document.getElementById("selRepo").value, palavras};
  const r=await fetch("/projetos",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(corpo)});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){ av.textContent=j.erro||"não deu para adicionar"; return; }
  // fecha e já seleciona o projeto novo — a aba aparece no próximo retrato (~1s)
  if(j.slug) projeto=j.slug;
  modal.classList.remove("on");
  document.getElementById("palavras").value=""; document.getElementById("nomeNovo").value="";
};

async function acionar(forcar){
  const obj=document.getElementById("obj"), aviso=document.getElementById("aviso");
  aviso.innerHTML="";
  const r=await fetch("/missao",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({objetivo:obj.value,projeto,time,forcar:!!forcar})});
  const j=await r.json().catch(()=>({}));
  if(r.status===409&&j.conflito){
    // A TRAVA agiu: o texto parece de outro projeto. Pergunta em vez de decidir.
    const objTexto=obj.value;
    aviso.innerHTML='<div class="conflito">⚠️ <b>Isto parece de '+esc(j.conflito.sugeridoNome)+'</b>, não de '+
      esc(PROJETOS.find(p=>p.slug===projeto)?.nome||projeto)+'. '+esc(j.conflito.motivo)+'.'+
      '<div class="btns"><button class="nao" id="trocar">Trocar para '+esc(j.conflito.sugeridoNome)+'</button>'+
      '<button class="sim" id="forcar">Rodar em '+esc(PROJETOS.find(p=>p.slug===projeto)?.nome||projeto)+' mesmo assim</button></div></div>';
    document.getElementById("trocar").onclick=()=>{
      projeto=j.conflito.sugerido;
      document.querySelectorAll(".aba").forEach(x=>x.classList.toggle("on",x.dataset.p===projeto));
      aviso.innerHTML=""; acionar(false);
    };
    document.getElementById("forcar").onclick=()=>{ obj.value=objTexto; acionar(true); };
    return;
  }
  if(!r.ok){aviso.textContent=j.erro||"não deu para acionar";return}
  obj.value="";
}
document.getElementById("rodar").onclick=()=>acionar(false);

function role(p){
  const reprovou=p.step==="terminou"&&p.chave==="revisor"&&/REPROVADO/i.test(p.resultado||"");
  const cls=reprovou?"e-reprovou":(est2cls[p.step]||"e-aguardando");
  const ativo=p.step==="trabalhando";
  const rotulo=reprovou?"reprovou":p.step;
  let corpo;
  if(p.step==="aguardando") corpo='<div class="ativ" style="color:#3d566e">○ aguardando</div>';
  else if(p.resultado) corpo='<div class="res">'+esc(p.resultado)+'</div>';
  else { const l=p.atividade[p.atividade.length-1]||"iniciando…"; corpo='<div class="ativ'+(l.startsWith("▸")?" tool":"")+'">'+esc(l)+'</div>'; }
  return '<div class="role'+(ativo?" ativo":"")+'">'+
    '<div class="rt"><span class="emo">'+p.emoji+'</span><span class="nm">'+p.nome+'</span>'+
      '<span class="est '+cls+'">'+(ativo?'<span class="pisca">▶</span> ':"")+rotulo+'</span></div>'+
    corpo+
    '<div class="rp">'+(p.modelo?'<span>'+esc(p.modelo)+'</span>':'')+
      '<span class="cu">'+dinheiro(p.custo)+'</span></div></div>';
}

const chipTier=t=>t?'<span class="tier tier-'+esc(t)+'" title="nível escolhido pelo roteador de custo">'+esc(t)+'</span>':'';
// mini-grafo do pipeline: 4 nós Eng→QA→Rev→PR — verde=feito, ciano pulsando=rodando,
// vermelho=reprovado, cinza=ainda não começou; seta de retorno Rev→Eng quando reprova.
function miniGrafo(m){
  const st={};
  (m.paineis||[]).forEach(function(p){
    const rep=p.chave==="revisor"&&p.step==="terminou"&&/REPROVADO/i.test(p.resultado||"");
    st[p.chave]=rep?"rep":(p.step==="terminou"?"ok":(p.step==="trabalhando"?"run":"wait"));
  });
  const cor={ok:"var(--verde)",run:"var(--ciano)",rep:"var(--verm)",wait:"#24384d"};
  const nos=[["eng","Eng"],["qa","QA"],["revisor","Rev"],["pr","PR"]];
  const X=[26,96,166,236], Y=22, R=9;
  let s='<svg class="mgraf" viewBox="0 0 262 46" preserveAspectRatio="xMidYMid meet" aria-hidden="true">';
  for(let i=0;i<3;i++) s+='<line x1="'+(X[i]+R)+'" y1="'+Y+'" x2="'+(X[i+1]-R)+'" y2="'+Y+'" stroke="var(--linha)" stroke-width="2"/>';
  const reprovou=st.revisor==="rep";
  if(reprovou){
    s+='<path d="M'+X[2]+' '+(Y-R)+' C '+X[2]+' 3,'+X[0]+' 3,'+X[0]+' '+(Y-R)+'" fill="none" stroke="var(--verm)" stroke-width="1.4" stroke-dasharray="3 2"/>';
    s+='<path d="M'+(X[0]-3)+' '+(Y-R-4)+' L'+X[0]+' '+(Y-R+1)+' L'+(X[0]+3)+' '+(Y-R-4)+'" fill="var(--verm)"/>';
  }
  nos.forEach(function(n,i){
    const e=st[n[0]]||"wait";
    s+='<rect x="'+(X[i]-R)+'" y="'+(Y-R)+'" width="'+(2*R)+'" height="'+(2*R)+'" fill="'+cor[e]+'"'+(e==="run"?' class="mg-puls"':'')+'/>';
    s+='<text x="'+X[i]+'" y="'+(Y+R+11)+'" text-anchor="middle" class="mg-lb">'+n[1]+'</text>';
  });
  s+='</svg>';
  return '<div class="mgwrap">'+s+(reprovou?'<span class="mground">↻ 2ª rodada</span>':'')+'</div>';
}
function missaoCard(m){
  return '<div class="mcard'+(m.rodando?" rodando":"")+'">'+
    '<div class="mhead"><span class="proj">'+esc(m.projeto)+'</span>'+chipTier(m.tier)+
      '<span class="obj">'+esc(m.objetivo)+'</span>'+
      '<span class="badge '+(m.rodando?"b-on":"b-off")+'">'+(m.rodando?"rodando":"encerrada")+'</span>'+
      '<span class="custo">'+dinheiro(m.custoTotal)+'</span></div>'+
    miniGrafo(m)+
    '<div class="roles">'+m.paineis.map(role).join("")+'</div></div>';
}

function quando(iso){ if(!iso) return ""; const m=Math.floor((Date.now()-new Date(iso))/60000);
  return m<1?"agora":m<60?"há "+m+"min":m<1440?"há "+Math.floor(m/60)+"h":"há "+Math.floor(m/1440)+"d"; }

// histórico RICO: cada linha abre e mostra PR, nível, motivo do veredito e custo POR PAPEL
function detalheMissao(h){
  let out="";
  if(h.tier) out+='<div class="lin">nível <b style="color:var(--gelo)">'+esc(h.tier)+'</b>'+(h.tierMotivo?' — '+esc(h.tierMotivo):'')+'</div>';
  if(h.prUrl) out+='<div class="lin">PR: <a href="'+esc(h.prUrl)+'" target="_blank" rel="noreferrer">'+esc(h.prUrl)+'</a>'+
    ' <button class="verdiff" onclick="verDiff(this)" data-pr="'+esc(h.prUrl)+'">ver o que mudou</button></div>'+
    '<div class="diffbox"></div>';
  if(h.vereditoMotivo) out+='<div class="lin">revisor: '+esc(h.vereditoMotivo)+'</div>';
  (h.papeis||[]).forEach(function(p){
    out+='<div class="papel"><span class="pn">'+(p.emoji||"")+' '+esc(p.nome)+'</span>'+
      '<span class="pm">'+esc(p.modelo||"—")+'</span>'+
      '<span class="pr">'+esc(p.resultado||"")+'</span>'+
      '<span class="pc">'+dinheiro(p.custo)+'</span></div>';
  });
  return out||'<div class="lin">sem detalhes guardados (missão antiga)</div>';
}
// "ver o que mudou": busca o diff do PR e mostra colorido, aqui no navegador (toggle)
async function verDiff(btn){
  const box=btn.closest(".hdet").querySelector(".diffbox");
  if(box.getAttribute("data-aberto")){ box.innerHTML=""; box.removeAttribute("data-aberto"); btn.textContent="ver o que mudou"; return; }
  btn.textContent="buscando…"; btn.disabled=true;
  try{
    const j=await (await fetch("/missao/diff?pr="+encodeURIComponent(btn.dataset.pr))).json();
    box.innerHTML = j.diff ? pintarDiff(j.diff) : '<div class="dl dim" style="padding:8px 10px">'+esc(j.erro||"sem diff")+'</div>';
    box.setAttribute("data-aberto","1"); btn.textContent="esconder";
  }catch{ box.innerHTML='<div class="dl dim" style="padding:8px 10px">erro ao buscar o diff</div>'; }
  btn.disabled=false;
}
function pintarDiff(txt){
  return txt.split(/\\r?\\n/).map(function(l){
    var c="dim";
    if(l.startsWith("diff --git")||l.startsWith("+++")||l.startsWith("---")) c="ff";
    else if(l.startsWith("@@")) c="hh";
    else if(l[0]==="+") c="add";
    else if(l[0]==="-") c="del";
    return '<div class="dl '+c+'">'+esc(l||" ")+'</div>';
  }).join("");
}
let histAssinatura="";
function pintarHistorico(hist){
  const ass=hist.map(h=>(h.objetivo||"")+(h.fim||"")+(h.custo||"")).join("|");
  if(ass===histAssinatura) return;   // nada mudou: não repinta (mantém aberto o que você expandiu)
  histAssinatura=ass;
  document.getElementById("historico").innerHTML=hist.map(function(h){
    return '<details class="hitem"><summary><div class="hrow">'+
      '<span class="hv hv-'+esc(h.veredito)+'">'+esc(h.veredito)+'</span>'+chipTier(h.tier)+
      '<span class="ho">'+esc(h.objetivo)+'</span>'+
      '<span class="hp">'+esc(h.projeto)+'</span>'+
      '<span class="hp">'+quando(h.fim)+'</span>'+
      '<span class="hc">'+dinheiro(h.custo)+'</span></div></summary>'+
      '<div class="hdet">'+detalheMissao(h)+'</div></details>';
  }).join("");
}

// assinatura (plano) + o que a obra já gastou — não existe "saldo de créditos" pra mostrar no
// plano por assinatura (é limite de uso, não consumo por crédito); o que É medível é o gasto.
function pintarConta(c,g){
  const box=document.getElementById("conta");
  if(!c||!c.plano){ box.innerHTML=""; return; }
  const hoje=(g&&g.linhas&&g.linhas.length)?g.linhas[g.linhas.length-1].total:0;
  box.title=c.email||"";
  box.innerHTML=
    '<span class="plano">'+esc(c.plano.toUpperCase())+'</span>'+
    '<span>obra hoje <b style="color:var(--verde)">'+dinheiro(hoje)+'</b></span>'+
    '<span>14d <b style="color:var(--verde)">'+dinheiro(g&&g.total)+'</b></span>';
}
function render(d){
  if(d.projetos){ PROJETOS=d.projetos; pintarAbas(); }   // projeto novo aparece na aba sem recarregar
  document.getElementById("relogio").textContent=new Date(d.em).toLocaleTimeString("pt-BR");
  pintarConta(d.conta, d.gasto);
  const cheio=d.ativas>=d.max;
  document.getElementById("rodar").disabled=cheio;
  document.getElementById("cap").textContent=d.ativas?(d.ativas+"/"+d.max+" rodando"):"";
  document.getElementById("missoes").innerHTML = (d.missoes&&d.missoes.length)
    ? d.missoes.map(missaoCard).join("")
    : '<div class="vazio"><b>Nenhuma missão ainda</b>escreva o objetivo acima e acione o time — pode mandar várias</div>';
  const hist=d.historico||[];
  document.getElementById("hsec").style.display=hist.length?"block":"none";
  pintarHistorico(hist);
  mapaGasto(d.gasto);
}

// ---- chat do Boss ----
const chat=document.getElementById("chat");
function chipsAnexos(anexos){
  if(!anexos||!anexos.length) return "";
  return '<div class="anexos">'+anexos.map(a=>'<span class="anexo">📎 '+esc(a.nome)+'</span>').join("")+'</div>';
}
function pintarChat(msgs){
  const box=document.getElementById("chatmsgs");
  if(!msgs||!msgs.length){ box.innerHTML='<div class="chatvazio">Fala com o Boss. Ele responde na hora, e quando for código ele despacha pra obra sozinho.</div>'; return; }
  box.innerHTML=msgs.map(m=>'<div class="msg '+(m.de==="voce"?"voce":"boss")+'">'+(m.texto?esc(m.texto):"")+chipsAnexos(m.anexos)+'</div>').join("");
  box.scrollTop=box.scrollHeight;
}
async function abrirChat(){
  chat.classList.add("on");
  // UM chefe-dos-chefes: conhece todos os projetos; a aba atual é só a dica de roteamento
  const nome=(PROJETOS.find(p=>p.slug===projeto)||{}).nome||projeto||"";
  document.getElementById("chatProj").textContent="chefe-dos-chefes · aba: "+nome;
  try{ pintarChat((await (await fetch("/boss/historico")).json()).mensagens); }catch{}
  document.getElementById("chatobj").focus();
}
document.getElementById("btBoss").onclick=abrirChat;
document.getElementById("chatFechar").onclick=()=>chat.classList.remove("on");

// ---- anexos do chat: escolhe → sobe pro servidor na hora → some da lista quando a mensagem sai ----
let anexosPendentes=[];
function pintarAnexosPendentes(){
  const box=document.getElementById("chatAnexos");
  if(!anexosPendentes.length){ box.style.display="none"; box.innerHTML=""; return; }
  box.style.display="flex";
  box.innerHTML=anexosPendentes.map((a,i)=>'<span class="anexo">📎 '+esc(a.nome)+' <b data-i="'+i+'" title="remover">✕</b></span>').join("");
  box.querySelectorAll("b").forEach(b=>b.onclick=()=>{ anexosPendentes.splice(+b.dataset.i,1); pintarAnexosPendentes(); });
}
function lerComoBase64(arquivo){
  return new Promise((ok,erro)=>{
    const r=new FileReader();
    r.onload=()=>ok(String(r.result).split(",").pop());
    r.onerror=erro;
    r.readAsDataURL(arquivo);
  });
}
let contadorColado=0;
// sobe UM arquivo (do 📎 ou do colar) pro servidor e guarda como anexo pendente
async function subirArquivo(f){
  const nome=f.name||("colado-"+(++contadorColado)+"."+((f.type.split("/")[1])||"png"));
  if(f.size>4*1024*1024){ alert('"'+nome+'" passa de 4MB — não anexado'); return; }
  try{
    const dados=await lerComoBase64(f);
    const r=await fetch("/boss/anexo",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({nome,dados})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){ alert(j.erro||('não deu para anexar "'+nome+'"')); return; }
    anexosPendentes.push({nome:j.nome,caminho:j.caminho});
  }catch{ alert('erro ao anexar "'+nome+'"'); }
}
document.getElementById("chatAnexar").onclick=()=>document.getElementById("chatArquivo").click();
document.getElementById("chatArquivo").addEventListener("change",async e=>{
  const arquivos=[...e.target.files]; e.target.value="";
  for(const f of arquivos) await subirArquivo(f);
  pintarAnexosPendentes();
});
// COLAR imagem (Cmd+V) direto no chat → vira anexo (o print que você vive colando)
document.getElementById("chatobj").addEventListener("paste",async e=>{
  const imgs=[...(e.clipboardData&&e.clipboardData.items||[])].filter(it=>it.kind==="file"&&it.type.indexOf("image/")===0);
  if(!imgs.length) return; // colou texto normal: deixa seguir
  e.preventDefault();
  for(const it of imgs){ const f=it.getAsFile(); if(f) await subirArquivo(f); }
  pintarAnexosPendentes();
});

async function enviarBoss(){
  const inp=document.getElementById("chatobj"), bt=document.getElementById("chatEnviar");
  const msg=inp.value.trim();
  if(!msg&&!anexosPendentes.length) return;
  const anexos=anexosPendentes;
  const box=document.getElementById("chatmsgs");
  // pinta a sua msg + "pensando" na hora (a resposta demora alguns segundos)
  box.insertAdjacentHTML("beforeend",'<div class="msg voce">'+(msg?esc(msg):"")+chipsAnexos(anexos)+'</div><div class="msg pensando" id="pensando">Boss pensando…</div>');
  box.scrollTop=box.scrollHeight; inp.value=""; anexosPendentes=[]; pintarAnexosPendentes(); bt.disabled=true;
  try{
    const r=await fetch("/boss/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mensagem:msg,anexos,projeto})});
    const j=await r.json().catch(()=>({}));
    document.getElementById("pensando")?.remove();
    box.insertAdjacentHTML("beforeend",'<div class="msg boss">'+esc(j.resposta||j.erro||"(sem resposta)")+'</div>');
    box.scrollTop=box.scrollHeight;
  }catch{ document.getElementById("pensando")?.remove(); box.insertAdjacentHTML("beforeend",'<div class="msg boss">(erro ao falar com o Boss)</div>'); }
  bt.disabled=false; inp.focus();
}
document.getElementById("chatEnviar").onclick=enviarBoss;
document.getElementById("chatobj").addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); enviarBoss(); } });
document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ chat.classList.remove("on"); modal.classList.remove("on"); } });

// heatmap "onde o dinheiro queimou": dia (linha) × hora (coluna), cor pela intensidade
const CORGASTO=["#111a26","#3a4657","#e8b339","#eb6e6e"]; // sem gasto · baixo · médio · alto
function faixaGasto(v,pico){
  if(v<=0) return 0;
  if(pico<=0) return 1;
  const r=v/pico;
  return r>0.66?3:r>0.33?2:1;
}
function mapaGasto(g){
  const sec=document.getElementById("gsec"), box=document.getElementById("mapa");
  if(!g||!g.total){ sec.style.display="none"; box.innerHTML=""; return; }
  sec.style.display="block";
  const dia=s=>{const [,m,d]=s.split("-");return d+"/"+m;};
  let linhas="";
  for(const L of g.linhas){
    let cels="";
    for(let h=0;h<24;h++){
      const v=L.horas[h], f=faixaGasto(v,g.pico);
      const t=v>0?dia(L.data)+" "+String(h).padStart(2,"0")+"h · US$ "+v.toFixed(2):"";
      cels+='<td class="cel" style="background:'+CORGASTO[f]+'" title="'+t+'"></td>';
    }
    linhas+='<tr><td class="dia">'+dia(L.data)+'</td>'+cels+
      '<td class="tot">'+(L.total>0?dinheiro(L.total):'')+'</td></tr>';
  }
  // eixo de horas (00, 06, 12, 18)
  let eixo='<tr><td></td>';
  for(let h=0;h<24;h++) eixo+='<td class="eixo">'+(h%6===0?String(h).padStart(2,"0"):"")+'</td>';
  eixo+='<td></td></tr>';
  const lim1=(g.pico/3), lim2=(g.pico*2/3);
  box.innerHTML='<table>'+linhas+eixo+'</table>'+
    '<div class="legenda">'+
      '<span><i style="background:'+CORGASTO[0]+'"></i>sem gasto</span>'+
      '<span><i style="background:'+CORGASTO[1]+'"></i>até '+dinheiro(lim1)+'/h</span>'+
      '<span><i style="background:'+CORGASTO[2]+'"></i>'+dinheiro(lim1)+' a '+dinheiro(lim2)+'</span>'+
      '<span><i style="background:'+CORGASTO[3]+'"></i>daí pra cima</span>'+
      '<span style="margin-left:auto;color:var(--verde);font-weight:700">total 14 dias: '+dinheiro(g.total)+'</span>'+
    '</div>';
}

// Ao vivo por SSE, com DUAS redes de segurança pra nunca congelar:
//  1) se o SSE cai (ex.: servidor reiniciou), RECONECTA sozinho depois de 2s;
//  2) um cão-de-guarda: se ficar 5s sem receber nada, busca por poll — cobre o caso do
//     SSE morto silencioso (foi o que travou a aba do dono quando reiniciei o servidor).
let ultimoUpdate=0;   // 0 = a página pinta NA HORA por poll, não espera o 1º evento do SSE
async function puxar(){ try{ render(await (await fetch("/retrato")).json()); ultimoUpdate=Date.now(); }catch{} }
function conectarSSE(){
  try{
    const es=new EventSource("/eventos");
    es.onmessage=e=>{ ultimoUpdate=Date.now(); try{ render(JSON.parse(e.data)); }catch{} };
    es.onerror=()=>{ try{es.close()}catch{}; setTimeout(conectarSSE,2000); };
  }catch{ /* o cão-de-guarda abaixo assume por poll */ }
}
puxar();          // 1ª pintura imediata — as tarefas aparecem já, mesmo se o SSE demorar/cair
conectarSSE();
setInterval(()=>{ if(Date.now()-ultimoUpdate>=4000) puxar(); },2000); // cão-de-guarda: SSE mudo → poll
</script></body></html>`;

/**
 * Chat do Boss em PÁGINA INTEIRA (rota GET /chat) — pra abrir numa aba própria, janela cheia.
 * Reusa os MESMOS endpoints do servidor (/boss/historico, /boss/chat, /boss/anexo) — só a tela
 * é nova, então não há lógica de Boss duplicada. É o chefe-dos-chefes (roteia por projeto pelo
 * que você disser; sem abas aqui, não manda dica).
 */
// PÁGINA INTEIRA (/fluxo): o grafo do PROCESSO no topo + as TAREFAS fluindo por estágio ao vivo.
// Autossuficiente (lê só /retrato, sem endpoint novo). Não toca no grid — página à parte.
const FLUXO_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fluxo da Obra</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${MARINHO};color:${GELO};font:14px/1.5 "SF Mono",Menlo,ui-monospace,monospace;min-height:100vh}
header{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid #16283c}
header h1{font-size:14px;letter-spacing:.2em;color:${CIANO};font-weight:700}
header .sub{font-size:11px;color:#6d8299}
header a{margin-left:auto;color:${AMBAR};text-decoration:none;font-size:11px;letter-spacing:.08em;border:1px solid #23384d;padding:5px 12px}
.wrap{max-width:1120px;margin:0 auto;padding:18px 22px 44px}
.proc{width:100%;height:auto;margin-bottom:6px}
.pnode{fill:#0b1420;stroke:#23384d;stroke-width:1.5}
.pnode.on{stroke:${CIANO};stroke-width:2.5}
.plabel{fill:${GELO};font:700 12px "SF Mono",monospace;text-anchor:middle}
.pdesc{fill:#6d8299;font:9px "SF Mono",monospace;text-anchor:middle;text-transform:uppercase;letter-spacing:.05em}
.pcount{fill:${CIANO};font:700 10px "SF Mono",monospace;text-anchor:middle}
.plooplb{fill:${VERM};font:700 10px "SF Mono",monospace;text-anchor:middle;letter-spacing:.05em;paint-order:stroke;stroke:${MARINHO};stroke-width:4px;stroke-linejoin:round}
.cols{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:#16283c;border:1px solid #16283c;margin-top:12px}
.col{background:#0b1420;min-height:130px;min-width:0;display:flex;flex-direction:column}
.colh{padding:8px 10px;border-bottom:1px solid #16283c;display:flex;align-items:center;gap:6px}
.colh .e{font-size:15px}.colh .n{font-size:11px;font-weight:700;color:${GELO}}
.colh .c{margin-left:auto;font-size:10px;color:${CIANO}}
.colbody{padding:8px;display:flex;flex-direction:column;gap:7px;flex:1}
.chip{background:#12202f;border:1px solid #23384d;border-left:3px solid ${CIANO};padding:7px 8px;font-size:11px}
.chip.done{border-left-color:${VERDE}}.chip.rep{border-left-color:${VERM}}.chip.dead{border-left-color:#54708a}
.chip .p{color:${CIANO};font-size:9px;letter-spacing:.07em;text-transform:uppercase}
.chip .o{color:${GELO};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:2px 0}
.chip .m{display:flex;gap:8px;color:#6d8299;font-size:10px}
.chip .m .cu{margin-left:auto;color:${VERDE}}
.chip a{color:${CIANO};text-decoration:none}
.empty{color:#33485e;font-size:11px;padding:12px;text-align:center}
@media(max-width:820px){.cols{grid-template-columns:repeat(2,1fr)}.proc{display:none}}
</style></head><body>
<header><h1>📊 FLUXO DA OBRA</h1><span class="sub" id="sub">o processo e as tarefas ao vivo</span><a href="/">← painel</a></header>
<div class="wrap">
  <svg class="proc" id="proc" viewBox="0 0 1140 126" preserveAspectRatio="xMidYMid meet"></svg>
  <div class="cols" id="cols"></div>
</div>
<script>
const COLS=[
 {k:"despacho",e:"📥",n:"Despacho",d:"fila / acionado"},
 {k:"eng",e:"🔧",n:"Engenheiro",d:"implementa"},
 {k:"qa",e:"🧪",n:"QA",d:"tenta quebrar"},
 {k:"revisor",e:"🔍",n:"Revisor",d:"aprova/reprova"},
 {k:"pr",e:"🚀",n:"PR",d:"abre o PR"},
 {k:"feito",e:"✅",n:"Feito",d:"entregue"}
];
const esc=s=>String(s==null?"":s).replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
const din=v=>v==null?"—":"US$ "+Number(v).toFixed(2);
function estagio(m){
  if(!m.rodando) return "feito";
  const w=(m.paineis||[]).find(p=>p.step==="trabalhando");
  if(w) return w.chave;
  const algum=(m.paineis||[]).some(p=>p.step!=="aguardando");
  if(!algum) return "despacho";
  const ord=["eng","qa","revisor","pr"];let last=-1;
  (m.paineis||[]).forEach(p=>{if(p.step==="terminou"){const i=ord.indexOf(p.chave);if(i>last)last=i;}});
  return ord[Math.min(last+1,3)];
}
function reprovada(m){return (m.paineis||[]).some(p=>p.chave==="revisor"&&p.step==="terminou"&&/REPROVADO/i.test(p.resultado||""));}
function chip(m,tipo){
  const rep=reprovada(m)&&m.rodando;
  const cls=tipo==="feito"?(m.veredito==="interrompida"?"dead":(String(m.veredito||"").indexOf("reprov")>=0?"rep":"done")):(rep?"rep":"");
  const pr=m.prUrl?' · <a href="'+esc(m.prUrl)+'" target="_blank">PR ↗</a>':"";
  const ver=tipo==="feito"&&m.veredito?'<span>'+esc(m.veredito)+'</span>':"";
  return '<div class="chip '+cls+'"><div class="p">'+esc(m.projeto)+(rep?" · ↻ 2ª":"")+'</div>'+
    '<div class="o">'+esc(m.objetivo)+'</div>'+
    '<div class="m">'+ver+'<span class="cu">'+din(m.custoTotal)+pr+'</span></div></div>';
}
function pintarProc(cont){
  const S=1140/6, cx=i=>Math.round(S*(i+0.5)); // centro de cada uma das 6 colunas
  const CY=52, R=25; // quadrado 50×50 centrado no eixo de cada coluna
  let s="";
  for(let i=0;i<5;i++) s+='<line x1="'+(cx(i)+R)+'" y1="'+CY+'" x2="'+(cx(i+1)-R)+'" y2="'+CY+'" stroke="#3a5670" stroke-width="2" marker-end="url(#fa)"/>';
  s+='<path d="M'+cx(3)+' '+(CY-R)+' C '+cx(3)+' 8,'+cx(1)+' 8,'+cx(1)+' '+(CY-R)+'" fill="none" stroke="${VERM}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#fr)"/>';
  s+='<text class="plooplb" x="'+cx(2)+'" y="18">reprovou → volta pro Engenheiro</text>';
  COLS.forEach((c,i)=>{
    const on=(cont[c.k]||0)>0, X=cx(i);
    s+='<rect class="pnode'+(on?" on":"")+'" x="'+(X-R)+'" y="'+(CY-R)+'" width="'+(2*R)+'" height="'+(2*R)+'"/>';
    s+='<text x="'+X+'" y="'+CY+'" text-anchor="middle" dominant-baseline="central" style="font-size:22px">'+c.e+'</text>';
    s+='<text class="plabel" x="'+X+'" y="'+(CY+R+17)+'">'+c.n+'</text>';
    s+=on?'<text class="pcount" x="'+X+'" y="'+(CY+R+31)+'">'+cont[c.k]+' tarefa'+(cont[c.k]>1?"s":"")+'</text>'
        :'<text class="pdesc" x="'+X+'" y="'+(CY+R+30)+'">'+c.d+'</text>';
  });
  s+='<defs><marker id="fa" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="#3a5670"/></marker>'+
     '<marker id="fr" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="${VERM}"/></marker></defs>';
  document.getElementById("proc").innerHTML=s;
}
async function tick(){
  let d; try{ d=await (await fetch("/retrato")).json(); }catch{ return; }
  const ativas=(d.missoes||[]).filter(m=>m.rodando);
  const feitas=(d.historico||[]).map(h=>({projeto:h.projeto,objetivo:h.objetivo,custoTotal:(h.custoTotal!=null?h.custoTotal:h.custo),veredito:h.veredito,prUrl:h.prUrl,rodando:false}));
  const buckets={despacho:[],eng:[],qa:[],revisor:[],pr:[],feito:[]};
  ativas.forEach(m=>{ (buckets[estagio(m)]||buckets.despacho).push(m); });
  feitas.forEach(h=>buckets.feito.push(h));
  const cont={}; COLS.forEach(c=>cont[c.k]=buckets[c.k].length);
  pintarProc(cont);
  document.getElementById("sub").textContent=ativas.length+" rodando · "+feitas.length+" no histórico";
  document.getElementById("cols").innerHTML=COLS.map(c=>{
    const items=buckets[c.k];
    const body=items.length?items.map(m=>chip(m,c.k)).join(""):'<div class="empty">—</div>';
    return '<div class="col"><div class="colh"><span class="e">'+c.e+'</span><span class="n">'+c.n+'</span><span class="c">'+(items.length||"")+'</span></div><div class="colbody">'+body+'</div></div>';
  }).join("");
}
tick(); setInterval(tick,1500);
</script></body></html>`;

const CHAT_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Boss · Chat</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${MARINHO};color:${GELO};font:14px/1.5 "SF Mono",Menlo,ui-monospace,monospace;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #16283c;color:${AMBAR};font-weight:700;letter-spacing:.14em}
header .sub{font-size:11px;letter-spacing:.04em;color:#6d8299;font-weight:400}
#msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;max-width:900px;width:100%;margin:0 auto}
.msg{max-width:80%;padding:10px 13px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.voce{align-self:flex-end;background:#0e2233;border:1px solid #16283c}
.msg.boss{align-self:flex-start;background:#12202f;border:1px solid #23384d}
.msg.pensando{align-self:flex-start;color:#6d8299;font-style:italic}
.vazio{color:#6d8299;text-align:center;margin:auto}
.anx{display:flex;flex-wrap:wrap;gap:6px;padding:0 20px;max-width:900px;width:100%;margin:0 auto}
.anx span{font-size:11px;color:#8ba4bb;border:1px solid #16283c;padding:2px 8px}
.entrada{border-top:1px solid #16283c;padding:14px 18px;display:flex;gap:8px;max-width:900px;width:100%;margin:0 auto}
.entrada textarea{flex:1;min-height:48px;max-height:180px;resize:vertical;background:#0b1420;border:1px solid #16283c;color:${GELO};padding:10px 12px;font:14px/1.4 "SF Mono",Menlo,monospace}
.entrada textarea:focus{outline:none;border-color:${AMBAR}}
.entrada button{background:transparent;border:1px solid #16283c;color:#8ba4bb;padding:0 14px;cursor:pointer;font:13px "SF Mono",monospace}
.entrada .env{border-color:${AMBAR};color:${AMBAR};letter-spacing:.1em;text-transform:uppercase;font-size:11px}
.entrada .env:hover:not(:disabled){background:${AMBAR};color:${MARINHO}}
.entrada button:disabled{opacity:.4;cursor:default}
</style></head><body>
<header>💬 BOSS <span class="sub">chefe-dos-chefes · conhece todos os projetos · janela inteira</span></header>
<div id="msgs"></div>
<div class="anx" id="anx"></div>
<div class="entrada">
  <input type="file" id="arq" multiple style="display:none">
  <button id="anexar" title="Anexar">📎</button>
  <textarea id="obj" maxlength="4000" placeholder="Fala com o Boss… (ele responde ou despacha pra obra)"></textarea>
  <button class="env" id="enviar">Enviar</button>
</div>
<script>
const esc=s=>String(s??"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
const chips=a=>(!a||!a.length)?"":'<div style="margin-top:6px;opacity:.8">'+a.map(x=>"📎 "+esc(x.nome)).join("  ")+'</div>';
const box=document.getElementById("msgs");
function pintar(ms){
  if(!ms||!ms.length){ box.innerHTML='<div class="vazio">Fala com o Boss. Ele responde na hora, e quando for código ele despacha pra obra.</div>'; return; }
  box.innerHTML=ms.map(m=>'<div class="msg '+(m.de==="voce"?"voce":"boss")+'">'+(m.texto?esc(m.texto):"")+chips(m.anexos)+'</div>').join("");
  box.scrollTop=box.scrollHeight;
}
fetch("/boss/historico").then(r=>r.json()).then(j=>pintar(j.mensagens)).catch(()=>{});
let pend=[];
function pintarPend(){ const b=document.getElementById("anx"); b.innerHTML=pend.map((a,i)=>'<span>📎 '+esc(a.nome)+' <b data-i="'+i+'" style="cursor:pointer">✕</b></span>').join(""); b.querySelectorAll("b").forEach(x=>x.onclick=()=>{pend.splice(+x.dataset.i,1);pintarPend();}); }
const b64=f=>new Promise((ok,e)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",").pop());r.onerror=e;r.readAsDataURL(f);});
let nColado=0;
async function subir(f){
  const nome=f.name||("colado-"+(++nColado)+"."+((f.type.split("/")[1])||"png"));
  if(f.size>4*1024*1024){ alert('"'+nome+'" passa de 4MB'); return; }
  try{ const dados=await b64(f); const r=await fetch("/boss/anexo",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({nome,dados})}); const j=await r.json(); if(!r.ok){alert(j.erro||"não deu");return;} pend.push({nome:j.nome,caminho:j.caminho}); }catch{ alert("erro ao anexar"); }
}
document.getElementById("anexar").onclick=()=>document.getElementById("arq").click();
document.getElementById("arq").addEventListener("change",async e=>{
  const fs=[...e.target.files]; e.target.value="";
  for(const f of fs) await subir(f);
  pintarPend();
});
document.getElementById("obj").addEventListener("paste",async e=>{
  const imgs=[...(e.clipboardData&&e.clipboardData.items||[])].filter(it=>it.kind==="file"&&it.type.indexOf("image/")===0);
  if(!imgs.length) return;
  e.preventDefault();
  for(const it of imgs){ const f=it.getAsFile(); if(f) await subir(f); }
  pintarPend();
});
async function enviar(){
  const inp=document.getElementById("obj"), bt=document.getElementById("enviar");
  const msg=inp.value.trim(); if(!msg&&!pend.length) return;
  const anexos=pend;
  box.insertAdjacentHTML("beforeend",'<div class="msg voce">'+(msg?esc(msg):"")+chips(anexos)+'</div><div class="msg pensando" id="p">Boss pensando…</div>');
  box.scrollTop=box.scrollHeight; inp.value=""; pend=[]; pintarPend(); bt.disabled=true;
  try{ const r=await fetch("/boss/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mensagem:msg,anexos})}); const j=await r.json().catch(()=>({}));
    document.getElementById("p")?.remove();
    box.insertAdjacentHTML("beforeend",'<div class="msg boss">'+esc(j.resposta||j.erro||"(sem resposta)")+'</div>'); box.scrollTop=box.scrollHeight;
  }catch{ document.getElementById("p")?.remove(); box.insertAdjacentHTML("beforeend",'<div class="msg boss">(erro ao falar com o Boss)</div>'); }
  bt.disabled=false; inp.focus();
}
document.getElementById("enviar").onclick=enviar;
document.getElementById("obj").addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); enviar(); } });
document.getElementById("obj").focus();
</script></body></html>`;

createServer(async (req, res) => {
  const json = (c, o) => { res.writeHead(c, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && req.url === "/missao") {
    try { return json(201, await dispararMissao(await lerCorpo(req))); }
    catch (e) {
      // Conflito de projeto (409) devolve a sugestão para a tela perguntar "rodar mesmo assim?".
      if (e.code === 409) return json(409, { erro: e.message, conflito: e.conflito });
      return json(400, { erro: e.message });
    }
  }
  if (req.url === "/retrato") return json(200, retrato());
  if (req.url === "/projetos/candidatos") return json(200, { candidatos: reposCandidatos() });
  // "o que foi feito": o diff do PR da missão, pra ver NO NAVEGADOR sem ir pro GitHub.
  if (req.url.startsWith("/missao/diff")) {
    const pr = new URL(req.url, "http://x").searchParams.get("pr") || "";
    const m = pr.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!m) return json(400, { erro: "PR inválido" });
    const diff = await new Promise((ok) =>
      execFile("gh", ["pr", "diff", m[3], "--repo", `${m[1]}/${m[2]}`],
        { maxBuffer: 12e6, timeout: 20000 }, (e, out) => ok(e ? null : out)));
    return json(200, diff == null ? { erro: "não consegui buscar o diff (gh autenticado?)" } : { diff: diff.slice(0, 200000) });
  }
  if (req.url.startsWith("/boss/historico")) return json(200, { mensagens: lerBoss().mensagens.slice(-60) });
  if (req.method === "POST" && req.url === "/boss/chat") {
    try { const c = await lerCorpo(req, 8192); return json(200, await bossChat(c.mensagem, c.anexos, c.projeto)); }
    catch (e) { return json(400, { erro: e.message }); }
  }
  if (req.method === "POST" && req.url === "/boss/anexo") {
    // teto maior que o padrão: é base64 de arquivo, não texto de formulário.
    try { return json(201, salvarAnexo(await lerCorpo(req, 6 * 1024 * 1024))); }
    catch (e) { return json(400, { erro: e.message }); }
  }
  if (req.method === "POST" && req.url === "/projetos") {
    try { return json(201, novoProjeto(await lerCorpo(req))); }
    catch (e) { return json(400, { erro: e.message }); }
  }
  // grava a URL do "ver sistema" de um projeto (o botão 🌐 do header)
  if (req.method === "POST" && req.url === "/projetos/url") {
    try { const { slug, url } = await lerCorpo(req); return json(200, definirUrlProjeto(slug, url)); }
    catch (e) { return json(400, { erro: e.message }); }
  }
  /**
   * SSE: em vez de a tela perguntar de 1,5s em 1,5s, o servidor EMPURRA o retrato ~1×/s.
   * É o que dá a sensação de "ao vivo" do cockpit. Cai para o poll no cliente se o
   * EventSource falhar (navegador antigo, proxy) — nunca fica sem atualizar.
   */
  if (req.url === "/eventos") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const enviar = () => res.write(`data: ${JSON.stringify(retrato())}\n\n`);
    enviar();
    const timer = setInterval(enviar, 1000);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (req.url === "/fluxo") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(FLUXO_PAGE); // grafo do processo + fluxo das tarefas (aba própria)
  }
  if (req.url === "/chat") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(CHAT_PAGE); // chat do Boss em página inteira (aba própria)
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGINA);
  // Só loopback: o cockpit DISPARA processo e não tem login — não pode ouvir a rede.
}).listen(PORTA, "127.0.0.1", () => console.log(`cockpit da obra: http://localhost:${PORTA}`));
