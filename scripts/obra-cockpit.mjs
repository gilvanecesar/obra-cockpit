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
import { lerAtividade } from "./obra-stream.mjs";
import {
  projetosDisponiveis, acharProjeto, conflitoDeProjeto,
  adicionarProjeto, reposCandidatos, slugificar, RAIZ_DEV,
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
const listaProjetos = () => projetosDisponiveis().map((p) => ({ slug: p.slug, nome: p.nome }));

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
      guardarMissao({
        objetivo: s.objetivo || s.task, projeto: s.projeto || "?",
        comecou: s.comecou || null, fim: s.fim || null,
        custo: s.custoTotal ?? null, veredito: s.veredito || "terminou",
      });
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

/** Dispara uma missão. Não bloqueia as outras — cada uma roda no seu worktree e status. */
function dispararMissao({ objetivo, projeto, time, forcar }) {
  const rodando = retrato().ativas;
  if (rodando >= MAX_PARALELO) throw new Error(`limite de ${MAX_PARALELO} missões ao mesmo tempo — espere uma terminar`);
  const obj = String(objetivo || "").trim();
  if (!obj) throw new Error("escreva o objetivo");
  if (obj.length > 4000) throw new Error("objetivo grande demais");

  const proj = acharProjeto(projeto) || projetosDisponiveis()[0];
  if (!proj) throw new Error("nenhum projeto disponível");

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
  if (time === "rapido") { env.OBRA_MODELO_ENG = "sonnet"; env.OBRA_MODELO_QA = "haiku"; env.OBRA_MODELO_REVISOR = "sonnet"; }

  const args = [FLUXO, obj];
  if (proj.dir !== RAIZ) args.push("--projeto", proj.dir);
  const filho = spawn("node", args, { cwd: RAIZ, env, detached: false });
  filho.on("error", () => {}); // não derruba o cockpit se o spawn falhar
  return { pid: filho.pid, projeto: proj.nome };
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
const BOSS = resolve(RAIZ, ".herdr-obra-boss.json"); // { sessionId, mensagens: [{de,texto,em}] }
const lerBoss = () => { try { return JSON.parse(readFileSync(BOSS, "utf8")); } catch { return { sessionId: null, mensagens: [] }; } };
const salvarBoss = (b) => writeFileSync(BOSS, JSON.stringify(b, null, 2));

const BOSS_PROMPT = [
  "Você é o BOSS da obra do Gilvane (dono do QueroFretes/TMS), falando com ele no chat do cockpit.",
  "Você COORDENA um time de agentes (engenheiro→QA→revisor→PR) que roda em projetos separados.",
  "Projetos disponíveis (slug): " + projetosDisponiveis().map((p) => `${p.slug} (${p.nome})`).join(", ") + ".",
  "Leia o CLAUDE.md e a pasta memory/ quando precisar de contexto do projeto (tem as regras da casa).",
  "REGRA DE ROTEAMENTO (você decide, não pergunte toda vez):",
  "- Tarefa de CÓDIGO fechada (feature, fix, teste) que vira PR → DESPACHE pra obra terminando a resposta",
  "  com um marcador em UMA linha: [MISSAO: <slug-do-projeto> | <objetivo claro e completo>].",
  "- Dúvida, conversa, arquitetura, algo rápido → responda você mesmo, curto, sem marcador.",
  "Antes do marcador, escreva 1-2 linhas dizendo o que vai despachar e pra qual projeto.",
  "Seja conciso e direto, em português do Brasil. Não invente número nem promessa.",
].join("\n");

/** Roda o Claude como Boss (assíncrono, não trava o event loop). Devolve texto + sessionId. */
function rodarBoss(mensagem, sessionId) {
  return new Promise((ok) => {
    const args = ["-p", mensagem, "--append-system-prompt", BOSS_PROMPT,
      "--allowedTools", "Read,Grep,Glob", "--model", "sonnet",
      "--output-format", "stream-json", "--verbose"];
    if (sessionId) args.push("--resume", sessionId);
    let buf = "";
    const cp = spawn("claude", args, { cwd: RAIZ, env: process.env });
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

/** Uma mensagem do dono → resposta do Boss (+ despacho se ele decidir que é obra). */
async function bossChat(mensagem) {
  const msg = String(mensagem || "").trim();
  if (!msg) throw new Error("escreva a mensagem");
  if (msg.length > 4000) throw new Error("mensagem grande demais");
  const b = lerBoss();
  b.mensagens.push({ de: "voce", texto: msg, em: new Date().toISOString() });

  const r = await rodarBoss(msg, b.sessionId);
  if (r.sessionId) b.sessionId = r.sessionId; // fixa a sessão dedicada na 1ª resposta

  // O Boss decidiu despachar? [MISSAO: slug | objetivo]
  let texto = r.texto, despachos = [];
  const re = /\[MISSAO:\s*([^\|\]]+?)\s*\|\s*([^\]]+?)\s*\]/gi;
  let m;
  while ((m = re.exec(r.texto))) {
    const slug = m[1].trim(), objetivo = m[2].trim();
    try {
      const d = dispararMissao({ objetivo, projeto: slug, forcar: true }); // o Boss já escolheu o projeto
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
#conta{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:11px;color:#6d8299;white-space:nowrap}
#conta b{font-weight:700}
#conta .plano{color:var(--ciano);letter-spacing:.06em}
#relogio{font-size:11px;color:#6d8299}

/* chat do Boss — gaveta lateral */
.chat{position:fixed;top:0;right:0;width:min(420px,92vw);height:100vh;background:var(--painel);
 border-left:1px solid var(--ambar);display:flex;flex-direction:column;transform:translateX(100%);
 transition:transform .18s;z-index:20}
.chat.on{transform:translateX(0)}
.chatcab{padding:14px 16px;border-bottom:1px solid var(--linha);font-size:12px;letter-spacing:.14em;
 color:var(--ambar);font-weight:700;display:flex;align-items:center;gap:10px}
.chatsub{font-size:10px;letter-spacing:.06em;color:#6d8299;font-weight:400;text-transform:none}
.chatcab button{margin-left:auto;background:transparent;border:0;color:#6d8299;cursor:pointer;font-size:16px}
.chatmsgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:88%;padding:9px 12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg.voce{align-self:flex-end;background:#0e2233;border:1px solid var(--linha);color:var(--gelo)}
.msg.boss{align-self:flex-start;background:#12202f;border:1px solid #23384d;color:var(--gelo)}
.msg.pensando{align-self:flex-start;color:#6d8299;font-style:italic}
.chatvazio{color:#6d8299;text-align:center;margin:auto;font-size:12px;padding:20px}
.chatentrada{border-top:1px solid var(--linha);padding:12px;display:flex;gap:8px}
.chatentrada textarea{flex:1;min-height:44px;max-height:140px;resize:vertical;background:#0b1420;
 border:1px solid var(--linha);color:var(--gelo);padding:9px 11px;font:13px/1.4 "SF Mono",Menlo,monospace}
.chatentrada textarea:focus{outline:none;border-color:var(--ambar)}
.chatentrada button{background:transparent;border:1px solid var(--ambar);color:var(--ambar);padding:0 16px;
 cursor:pointer;font:11px/1 "SF Mono",monospace;letter-spacing:.1em;text-transform:uppercase}
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
.hrow .ho{flex:1;color:var(--gelo);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hrow .hp{color:#6d8299;flex:none}
.hrow .hc{color:var(--verde);flex:none}
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
  <button class="aba mais" id="btNovo" title="Adicionar ou criar um projeto">+ novo</button>
  <button class="aba boss" id="btBoss" title="Falar com o Boss">💬 boss</button>
  <span id="conta"></span>
  <span id="relogio"></span>
</header>
<div class="chat" id="chat">
  <div class="chatcab">💬 BOSS <span class="chatsub">sessão dedicada · conhece o projeto</span>
    <button id="chatFechar" title="Fechar">✕</button></div>
  <div class="chatmsgs" id="chatmsgs"></div>
  <div class="chatentrada">
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
    <button data-t="caprichado" class="on">Caprichado</button>
    <button data-t="rapido">Rápido</button>
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
let time="caprichado", projeto=(PROJETOS[0]||{}).slug;
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

function missaoCard(m){
  return '<div class="mcard'+(m.rodando?" rodando":"")+'">'+
    '<div class="mhead"><span class="proj">'+esc(m.projeto)+'</span>'+
      '<span class="obj">'+esc(m.objetivo)+'</span>'+
      '<span class="badge '+(m.rodando?"b-on":"b-off")+'">'+(m.rodando?"rodando":"encerrada")+'</span>'+
      '<span class="custo">'+dinheiro(m.custoTotal)+'</span></div>'+
    '<div class="roles">'+m.paineis.map(role).join("")+'</div></div>';
}

function quando(iso){ if(!iso) return ""; const m=Math.floor((Date.now()-new Date(iso))/60000);
  return m<1?"agora":m<60?"há "+m+"min":m<1440?"há "+Math.floor(m/60)+"h":"há "+Math.floor(m/1440)+"d"; }

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
  document.getElementById("historico").innerHTML=hist.map(function(h){
    return '<div class="hrow"><span class="hv hv-'+esc(h.veredito)+'">'+esc(h.veredito)+'</span>'+
      '<span class="ho">'+esc(h.objetivo)+'</span>'+
      '<span class="hp">'+esc(h.projeto)+'</span>'+
      '<span class="hp">'+quando(h.fim)+'</span>'+
      '<span class="hc">'+dinheiro(h.custo)+'</span></div>';
  }).join("");
  mapaGasto(d.gasto);
}

// ---- chat do Boss ----
const chat=document.getElementById("chat");
function pintarChat(msgs){
  const box=document.getElementById("chatmsgs");
  if(!msgs||!msgs.length){ box.innerHTML='<div class="chatvazio">Fala com o Boss. Ele responde na hora, e quando for código ele despacha pra obra sozinho.</div>'; return; }
  box.innerHTML=msgs.map(m=>'<div class="msg '+(m.de==="voce"?"voce":"boss")+'">'+esc(m.texto)+'</div>').join("");
  box.scrollTop=box.scrollHeight;
}
async function abrirChat(){
  chat.classList.add("on");
  try{ pintarChat((await (await fetch("/boss/historico")).json()).mensagens); }catch{}
  document.getElementById("chatobj").focus();
}
document.getElementById("btBoss").onclick=abrirChat;
document.getElementById("chatFechar").onclick=()=>chat.classList.remove("on");
async function enviarBoss(){
  const inp=document.getElementById("chatobj"), bt=document.getElementById("chatEnviar");
  const msg=inp.value.trim(); if(!msg) return;
  const box=document.getElementById("chatmsgs");
  // pinta a sua msg + "pensando" na hora (a resposta demora alguns segundos)
  box.insertAdjacentHTML("beforeend",'<div class="msg voce">'+esc(msg)+'</div><div class="msg pensando" id="pensando">Boss pensando…</div>');
  box.scrollTop=box.scrollHeight; inp.value=""; bt.disabled=true;
  try{
    const r=await fetch("/boss/chat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({mensagem:msg})});
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

createServer(async (req, res) => {
  const json = (c, o) => { res.writeHead(c, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST" && req.url === "/missao") {
    try { return json(201, dispararMissao(await lerCorpo(req))); }
    catch (e) {
      // Conflito de projeto (409) devolve a sugestão para a tela perguntar "rodar mesmo assim?".
      if (e.code === 409) return json(409, { erro: e.message, conflito: e.conflito });
      return json(400, { erro: e.message });
    }
  }
  if (req.url === "/retrato") return json(200, retrato());
  if (req.url === "/projetos/candidatos") return json(200, { candidatos: reposCandidatos() });
  if (req.url === "/boss/historico") return json(200, { mensagens: lerBoss().mensagens.slice(-60) });
  if (req.method === "POST" && req.url === "/boss/chat") {
    try { return json(200, await bossChat((await lerCorpo(req, 8192)).mensagem)); }
    catch (e) { return json(400, { erro: e.message }); }
  }
  if (req.method === "POST" && req.url === "/projetos") {
    try { return json(201, novoProjeto(await lerCorpo(req))); }
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
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGINA);
  // Só loopback: o cockpit DISPARA processo e não tem login — não pode ouvir a rede.
}).listen(PORTA, "127.0.0.1", () => console.log(`cockpit da obra: http://localhost:${PORTA}`));
