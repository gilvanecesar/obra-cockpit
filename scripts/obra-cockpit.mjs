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
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { lerAtividade } from "./obra-stream.mjs";
import {
  projetosDisponiveis, acharProjeto, conflitoDeProjeto,
  adicionarProjeto, reposCandidatos, slugificar, RAIZ_DEV, definirUrlProjeto,
} from "./obra-projetos.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Versão vem do package.json (fonte única) — mostrada no header pra confirmar o deploy no ar.
const VERSAO = (() => { try { return JSON.parse(readFileSync(resolve(RAIZ, "package.json"), "utf8")).version; } catch { return "?"; } })();
const MISSOES = resolve(RAIZ, ".herdr-obra-missoes.json"); // histórico das missões encerradas
// Cada missão paralela grava num arquivo PRÓPRIO aqui — status central único faria as
// missões se atropelarem (uma sobrescrevendo o painel da outra).
const RUNS = resolve(RAIZ, ".herdr-obra-runs");
try { mkdirSync(RUNS, { recursive: true }); } catch {}
const FLUXO = resolve(RAIZ, "scripts", "obra-fluxo.mjs");
const PORTA = Number(process.env.PORTA || 4477);
// Teto de missões ao mesmo tempo: paralelo é caro (N× opus), e a máquina tem limite.
const MAX_PARALELO = Number(process.env.OBRA_MAX_PARALELO || 4);

// Paleta "herdr": carvão neutro + roxo lavanda como accent, texto quase-branco.
// CIANO agora é o ROXO (accent primário — mantive o nome pra não trocar em 100 lugares).
const MARINHO = "#17171a", CIANO = "#cba6f7", VERDE = "#37CF7C", GELO = "#eae8ee", AMBAR = "#9399b2", VERM = "#eb6e6e";

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

// ---- "Boss (direto)": trabalho que o EU faz direto (não via crew) aparece no painel ----
const DIRETOS = resolve(RAIZ, ".herdr-obra-diretos.json");
const lerDiretos = () => { try { const a = JSON.parse(readFileSync(DIRETOS, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; } };
const salvarDiretos = (a) => writeFileSync(DIRETOS, JSON.stringify(a.slice(-30), null, 2));
// só os que interessam: trabalhando + os que terminaram nos últimos 90s
const diretosVivos = () => lerDiretos().filter((d) => d.status !== "terminou" || (d.fim && Date.now() - new Date(d.fim).getTime() < 90000));

// ---- Torre de tarefas: o dono lança uma tarefa "solo" (um eu fazedor num pane), escolhe o
//      modelo, vê o card ao vivo e pode falar com ela. Reusa o obra.mjs (que lida com o herdr). ----
const OBRA = resolve(RAIZ, "scripts/obra.mjs");
const NODE = process.execPath;
// roda o obra.mjs e devolve {code, out} — o obra cria o worktree/pane e sobe o agente
function rodarObra(args) {
  return new Promise((ok) => {
    const cp = spawn(NODE, [OBRA, ...args], { cwd: RAIZ, env: process.env });
    let out = "";
    cp.stdout.on("data", (d) => { out += d; });
    cp.stderr.on("data", (d) => { out += d; });
    cp.on("close", (code) => ok({ code, out: out.trim() }));
    cp.on("error", (e) => ok({ code: 1, out: String(e && e.message || e) }));
  });
}
// status ao vivo de cada workspace do herdr (trabalhando/pronto/…), atualizado em segundo plano
let wsStatusCache = {};
let wsStatusRodando = false;
function atualizarStatusTarefas() {
  if (wsStatusRodando) return; wsStatusRodando = true;
  const cp = spawn("herdr", ["workspace", "list"], { env: process.env });
  let out = "";
  cp.stdout.on("data", (d) => { out += d; });
  cp.on("close", () => {
    wsStatusRodando = false;
    try { const j = JSON.parse(out); const ws = (j.result || j).workspaces || []; const m = {}; ws.forEach((w) => { m[w.workspace_id] = w.agent_status || null; }); wsStatusCache = m; } catch { /* herdr fora do ar: mantém o último */ }
  });
  cp.on("error", () => { wsStatusRodando = false; });
}
setInterval(atualizarStatusTarefas, 4000);
try { atualizarStatusTarefas(); } catch { /* ok */ }

// tarefas "subindo"/"erro" (criação em andamento) — em memória; some quando o registro assume
const lancando = new Map();
function extrairErro(out) {
  const m = String(out || "").match(/erro:\s*(.+)/i);
  return (m ? m[1] : String(out || "").slice(-200)).replace(/\s+/g, " ").trim().slice(0, 200);
}
// os agentes vivos da obra (registro em disco) + os que estão subindo viram os cards da torre
function lerTarefas() {
  let doReg = [];
  try {
    const r = JSON.parse(readFileSync(resolve(RAIZ, ".herdr-obra.json"), "utf8"));
    const ag = r.agentes || {};
    doReg = Object.entries(ag).map(([nome, a]) => ({
      nome, projeto: a.projeto || null, modelo: a.modelo || null, papel: a.papel || null,
      tarefa: a.tarefa || "", pane: a.pane || null, workspace: a.workspace || null,
      status: (a.workspace && wsStatusCache[a.workspace]) || null, erro: null, aberto_em: a.aberto_em || null,
    }));
  } catch { doReg = []; }
  const nomes = new Set(doReg.map((t) => t.nome));
  const doLanc = [...lancando.values()].filter((l) => !nomes.has(l.nome)).map((l) => ({
    nome: l.nome, projeto: l.projeto, modelo: l.modelo, papel: "solo",
    tarefa: l.tarefa, pane: null, workspace: null, status: l.estado, erro: l.erro || null, aberto_em: l.em,
  }));
  return [...doLanc, ...doReg].sort((x, y) => String(y.aberto_em).localeCompare(String(x.aberto_em)));
}

// ================== AUTO-DESCOBERTA (a virada da torre de controle) ==================
// Em vez de conhecer só o que ELE mesmo despachou, o cockpit espelha o estado do herdr:
// TODO pane rodando um agente, em QUALQUER workspace (inclusive o que você abriu na mão).
// `herdr agent list` dá status/projeto/pane/título-ao-vivo/UUID; o UUID linka no
// ~/.claude/projects/<slug>/<uuid>.jsonl, de onde sai o MODELO, os tokens e a última atividade.
const HOME = process.env.HOME || "/home/saturno";
const PROJETOS_CLAUDE = resolve(HOME, ".claude", "projects");
const sessaoCache = new Map(); // uuid -> { mtime, model, out, cacheRead, lastTs } (recalcula só quando o arquivo muda)
function enriquecerSessao(cwd, uuid) {
  if (!cwd || !uuid) return null;
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-"); // igual ao slug do claude p/ ~/.claude/projects
  const arq = resolve(PROJETOS_CLAUDE, slug, uuid + ".jsonl");
  let st; try { st = statSync(arq); } catch { return sessaoCache.get(uuid) || null; }
  const cache = sessaoCache.get(uuid);
  if (cache && cache.mtime === st.mtimeMs) return cache; // nada mudou: reusa (evita reparsear MBs a cada tick)
  let model = null, out = 0, cacheRead = 0, lastTs = null;
  try {
    for (const ln of readFileSync(arq, "utf8").split("\n")) {
      if (!ln) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.timestamp) lastTs = o.timestamp;
      const m = o.message;
      if (m && m.model) model = m.model;
      const u = m && m.usage;
      if (u) { out += u.output_tokens || 0; cacheRead += u.cache_read_input_tokens || 0; }
    }
  } catch { return cache || null; }
  const dado = { mtime: st.mtimeMs, model, out, cacheRead, lastTs };
  sessaoCache.set(uuid, dado);
  return dado;
}

let agentesCache = [];
let agentesRodando = false;
function descobrirAgentes() {
  if (agentesRodando) return; agentesRodando = true;
  const cp = spawn("herdr", ["agent", "list"], { env: process.env });
  let out = "";
  cp.stdout.on("data", (d) => { out += d; });
  cp.on("close", () => {
    agentesRodando = false;
    let lista;
    try { lista = ((JSON.parse(out).result) || {}).agents || []; } catch { return; /* herdr fora do ar: mantém o último */ }
    // o registro da obra dá o PAPEL (engenheiro/qa/revisor) e o nome de quem foi DESPACHADO pela torre
    let reg = {};
    try { reg = (JSON.parse(readFileSync(resolve(RAIZ, ".herdr-obra.json"), "utf8")).agentes) || {}; } catch {}
    const porPane = {};
    for (const [nome, a] of Object.entries(reg)) if (a && a.pane) porPane[a.pane] = { nome, papel: a.papel || null };
    agentesCache = lista.map((a) => {
      const cwd = a.cwd || a.foreground_cwd || "";
      const uuid = a.agent_session && a.agent_session.value;
      const s = enriquecerSessao(cwd, uuid);
      const desp = porPane[a.pane_id] || null;
      return {
        pane: a.pane_id, workspace: a.workspace_id, casa: a.agent || "claude",
        projeto: cwd ? cwd.split("/").pop() : "?", cwd,
        status: a.agent_status || "unknown", focado: !!a.focused,
        titulo: a.terminal_title_stripped || "",
        modelo: (s && s.model) || null,
        out: (s && s.out) || 0, cacheRead: (s && s.cacheRead) || 0,
        ultima: (s && s.lastTs) || null,
        papel: desp ? desp.papel : null, despachado: !!desp, nome: desp ? desp.nome : null,
      };
    }).sort((x, y) => {
      const rank = (v) => (v.status === "working" ? 0 : v.status === "idle" ? 1 : 2);
      return rank(x) - rank(y) || String(y.ultima || "").localeCompare(String(x.ultima || ""));
    });
  });
  cp.on("error", () => { agentesRodando = false; });
}
setInterval(descobrirAgentes, 4000);
try { descobrirAgentes(); } catch { /* ok */ }

// falar/ler direto num pane (agente auto-descoberto, não só os despachados pela obra)
function herdrCmd(args) {
  return new Promise((ok) => {
    const cp = spawn("herdr", args, { env: process.env });
    let out = ""; cp.stdout.on("data", (d) => { out += d; }); cp.stderr.on("data", (d) => { out += d; });
    cp.on("close", (code) => ok({ code, out }));
    cp.on("error", (e) => ok({ code: 1, out: String(e.message || e) }));
  });
}

// ---- status do hardware do saturno (a máquina onde o cockpit roda) ----
// Lê /proc (CPU/RAM, instantâneo) e nvidia-smi (GPU, async). Cache de ~3s pra não spammar.
let maquinaCache = null;
function atualizarMaquina() {
  const m = { cpu: null, mem: null, gpu: null, em: Date.now() };
  try {
    const load = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
    const cores = (readFileSync("/proc/cpuinfo", "utf8").match(/^processor/gm) || []).length || 1;
    const l1 = parseFloat(load[0]) || 0;
    m.cpu = { load1: l1, cores, pct: Math.min(100, Math.round((l1 / cores) * 100)) };
  } catch {}
  try {
    const mi = readFileSync("/proc/meminfo", "utf8");
    const kb = (k) => { const x = mi.match(new RegExp("^" + k + ":\\s+(\\d+)", "m")); return x ? parseInt(x[1]) : 0; };
    const total = kb("MemTotal"), avail = kb("MemAvailable"), used = total - avail;
    if (total) m.mem = { usedGB: (used / 1048576).toFixed(1), totalGB: (total / 1048576).toFixed(0), pct: Math.round((used / total) * 100) };
  } catch {}
  if (!maquinaCache) maquinaCache = m; // já mostra CPU/RAM enquanto a GPU (async) não volta
  execFile("nvidia-smi",
    ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
    { timeout: 4000 }, (e, out) => {
      if (!e && out) {
        const p = out.trim().split("\n")[0].split(",").map((s) => s.trim());
        const n = (v) => (/^\d+$/.test(v) ? parseInt(v) : null);
        m.gpu = { nome: (p[0] || "GPU").replace("NVIDIA GeForce ", ""), util: n(p[1]), memUsed: n(p[2]), memTotal: n(p[3]), temp: n(p[4]),
          aviso: /reset|error/i.test(out) ? "requer reset" : (p[1] && p[1].includes("N/A") ? "leitura parcial" : null) };
      }
      maquinaCache = m; // fixa o retrato completo (com GPU, ou sem se deu erro)
    });
}
atualizarMaquina();
setInterval(atualizarMaquina, 3000);

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
    maquina: maquinaCache,
    diretos: diretosVivos(),
    tarefas: lerTarefas(),
    agentes: agentesCache, // TODOS os agentes vivos do herdr (auto-descobertos), não só os despachados
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
    "MEMÓRIA VIVA: você tem as ferramentas do ai-memory (mcp__ai-memory) — memory_query/search. Sua memória",
    "injetada é um retrato do INÍCIO da sessão e pode estar velha; quando o dono perguntar de algo recente,",
    "de uma decisão, de um documento/entregável ou 'o que a gente combinou', CONSULTE o ai-memory ao vivo antes de dizer que não sabe.",
    "Pode consultar a internet (WebFetch pra abrir um link, WebSearch pra pesquisar) — é SÓ LEITURA e já está",
    "liberado: quando o dono mandar uma URL ou pedir algo da web, faça direto, NÃO peça aprovação nem diga que não consegue.",
    "Você NÃO controla o navegador do dono (sem clicar/logar/tirar print) — pra ler uma página, use WebFetch.",
    "REGRA DE ROTEAMENTO (você decide, não pergunte toda vez):",
    "- Tarefa de CÓDIGO fechada (feature, fix, teste) que vira PR → DESPACHE terminando a resposta",
    "  com um marcador em UMA linha: [MISSAO: <slug-do-projeto-certo> | <objetivo claro e completo>].",
    "- Escolha o projeto pelo que o dono disser; se ele NÃO disser, assuma o projeto da aba atual: " + (dica || "(nenhuma)") + ".",
    "- Dúvida, conversa, arquitetura, algo rápido → responda você mesmo, curto, sem marcador.",
    "Antes do marcador, escreva 1-2 linhas dizendo o que vai despachar e pra qual projeto.",
    "IMAGEM/ARTE/DESIGN: a casa faz imagem com HTML + puppeteer usando a marca (custo zero) — NUNCA gerador de",
    "IA pago (Higgsfield/DALL-E/etc.). O agente da missão roda numa cópia SEM a memória, só com o que você escreve;",
    "então, ao despachar arte, PONHA no objetivo: usar os scripts da casa (querofretes: scripts/gerar-artes-social.mjs,",
    "scripts/gerar-og-arte.mjs) ou HTML+puppeteer com as cores/fontes da marca, e proibir gerador externo.",
    "Quando a mensagem trouxer 'Arquivos anexados pelo dono', são caminhos locais no disco —",
    "leia com Read se o conteúdo importar para a resposta ou para o objetivo que vai despachar.",
    "Seja conciso e direto, em português do Brasil. Não invente número nem promessa.",
  ].join("\n");
}

/** Roda o Claude como chefe-dos-chefes (assíncrono, não trava o event loop). */
function rodarBoss(mensagem, sessionId, dica) {
  return new Promise((ok) => {
    // Mensagem começando com "/" faz o CLI tratar como slash-command ("Unknown command").
    // Neutraliza: é texto do dono (uma resposta, um caminho tipo /calculadora-cotacao), não comando.
    const msgSegura = /^\s*\//.test(mensagem)
      ? "(o texto abaixo é do dono — trate como conteúdo literal, NÃO como comando nem skill)\n" + mensagem
      : mensagem;
    const args = ["-p", msgSegura, "--append-system-prompt", bossPrompt(dica),
      "--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch,mcp__ai-memory", "--model", "sonnet",
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Torre de Controle</title>
<style>
:root{--bg:#0b0b0f;--panel:#141419;--panel2:#1a1a21;--bd:#262630;--tx:#e8e8ee;--mut:#8a8a99;--dim:#5c5c6a;--accent:#cba6f7;--work:#56c8dc;--idle:#6b6b7a;--ok:#37cf7c;--amb:#e5c07b;--red:#eb6e6e}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--tx);font:13px/1.55 ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#2c2c37;border-radius:6px}::-webkit-scrollbar-track{background:transparent}
/* header */
header{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:18px;padding:11px 20px;background:rgba(11,11,15,.9);backdrop-filter:blur(8px);border-bottom:1px solid var(--bd)}
.marca{display:flex;align-items:center;gap:9px;font-weight:700;letter-spacing:.13em;font-size:12px}
.marca .dot{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.marca small{color:var(--dim);font-weight:400;letter-spacing:0}
.tabs{display:flex;gap:4px;margin-left:6px}
.tab{padding:6px 14px;border-radius:8px;color:var(--mut);cursor:pointer;font-size:12px;letter-spacing:.03em;border:1px solid transparent;user-select:none}
.tab:hover{color:var(--tx);background:var(--panel)}
.tab.on{color:var(--tx);background:var(--panel2);border-color:var(--bd)}
.tab .k{color:var(--dim);margin-left:6px}
.right{margin-left:auto;display:flex;align-items:center;gap:16px;color:var(--mut);font-size:12px}
.right b{color:var(--tx);font-weight:600}
.bossbtn{padding:6px 13px;border:1px solid var(--bd);border-radius:8px;color:var(--accent);cursor:pointer}
.bossbtn:hover{background:var(--panel2)}
main{padding:20px;max-width:1500px;margin:0 auto}
/* launcher */
.lanc{display:flex;gap:9px;align-items:center;background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:11px 13px;margin-bottom:18px;flex-wrap:wrap}
.lanc input,.lanc select{background:var(--panel2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:9px 11px;font:inherit;font-size:12px}
.lanc input.obj{flex:1;min-width:240px}
.lanc select{cursor:pointer;color:var(--mut)}
.lanc button{background:var(--accent);color:#17111f;border:none;border-radius:8px;padding:9px 16px;font:inherit;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap}
.lanc button:hover{filter:brightness(1.08)}
.lanc button:disabled{opacity:.5;cursor:default}
.lanc .hint{color:var(--dim);font-size:11px;width:100%;margin-top:-2px}
/* grade */
.grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:13px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:13px;padding:14px;transition:border-color .15s}
.card:hover{border-color:#33333f}
.card.work{border-color:#2a4a52}
.chead{display:flex;align-items:center;gap:9px;cursor:pointer}
.st{width:9px;height:9px;border-radius:50%;flex:none;background:var(--idle)}
.st.work{background:var(--work);box-shadow:0 0 9px var(--work);animation:pulse 1.4s ease-in-out infinite}
.st.idle{background:var(--idle)}.st.blocked{background:var(--amb)}.st.unknown{background:var(--dim)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.proj{font-weight:700;font-size:14px}
.foco{font-size:10px;color:var(--work);border:1px solid #2a4a52;border-radius:5px;padding:1px 5px}
.modelo{margin-left:auto;color:var(--mut);font-size:11px}
.caret{color:var(--dim);margin-left:4px;transition:transform .15s}
.card.aberto .caret{transform:rotate(90deg)}
.titulo{color:var(--tx);font-size:12.5px;margin:9px 0 8px;min-height:18px;word-break:break-word}
.titulo.vazio{color:var(--dim)}
.meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--mut)}
.badge{padding:1px 7px;border-radius:5px;border:1px solid var(--bd);font-size:10.5px}
.badge.papel{color:var(--accent);border-color:#3a2f4a}
.badge.direto{color:var(--dim)}
.badge.stlabel{text-transform:uppercase;letter-spacing:.05em}
.badge.stlabel.work{color:var(--work);border-color:#2a4a52}
.badge.stlabel.idle{color:var(--mut)}
.dim{color:var(--dim)}
.corpo{display:none;margin-top:12px;border-top:1px solid var(--bd);padding-top:12px}
.card.aberto .corpo{display:block}
.saida{background:#0a0a0d;border:1px solid var(--bd);border-radius:8px;padding:10px;font-size:11px;color:#b9b9c6;white-space:pre-wrap;word-break:break-word;max-height:230px;overflow:auto;line-height:1.5}
.saida.carregando{color:var(--dim)}
.fala{display:flex;gap:7px;margin-top:9px}
.fala input{flex:1;background:var(--panel2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:8px 10px;font:inherit;font-size:12px}
.fala button{background:var(--panel2);border:1px solid var(--bd);color:var(--tx);border-radius:8px;padding:8px 13px;font:inherit;font-size:12px;cursor:pointer}
.fala button:hover{border-color:var(--accent);color:var(--accent)}
.vazio-grade{color:var(--dim);text-align:center;padding:50px;border:1px dashed var(--bd);border-radius:13px}
/* sistema */
.sis{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.bloco{background:var(--panel);border:1px solid var(--bd);border-radius:13px;padding:16px}
.bloco h3{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);margin-bottom:13px;font-weight:600}
.linha{display:flex;justify-content:space-between;align-items:center;margin:9px 0;font-size:12.5px}
.linha .v{color:var(--tx);font-weight:600}
.bar{height:6px;border-radius:4px;background:#0a0a0d;overflow:hidden;margin-top:5px}
.bar > i{display:block;height:100%;background:var(--accent)}
.bar > i.hot{background:var(--amb)}.bar > i.max{background:var(--red)}
iframe.fluxo{width:100%;height:calc(100vh - 130px);border:1px solid var(--bd);border-radius:13px;background:var(--panel)}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--panel2);border:1px solid var(--bd);border-radius:10px;padding:11px 18px;font-size:12.5px;z-index:50;opacity:0;transition:opacity .2s}
.toast.on{opacity:1}
.toast.err{border-color:var(--red);color:var(--red)}
</style></head><body>
<header>
  <div class="marca"><span class="dot"></span>TORRE DE CONTROLE <small>v${VERSAO}</small></div>
  <div class="tabs" id="tabs">
    <div class="tab on" data-a="agentes">Agentes<span class="k" id="kAg"></span></div>
    <div class="tab" data-a="fluxo">Fluxo</div>
    <div class="tab" data-a="sistema">Sistema</div>
  </div>
  <div class="right">
    <span id="custo"></span>
    <span id="relogio"></span>
    <a class="bossbtn" href="/chat" target="_blank">Boss ↗</a>
  </div>
</header>
<main id="view"></main>
<div class="toast" id="toast"></div>
<script>
var R={}, aba="agentes", abertos=new Set(), saidas={};
var PROJS_CONHECIDOS=["querofretes-ofc","TMS","torre","agb-projetos","obra-cockpit"];
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
function tempo(iso){if(!iso)return"";var s=Math.floor((Date.now()-new Date(iso).getTime())/1000);if(s<0)s=0;if(s<60)return"há "+s+"s";if(s<3600)return"há "+Math.floor(s/60)+"min";if(s<86400)return"há "+Math.floor(s/3600)+"h";return"há "+Math.floor(s/86400)+"d"}
function ktok(n){n=n||0;if(n<1000)return n+"";if(n<1e6)return (n/1000).toFixed(n<1e4?1:0)+"k";return (n/1e6).toFixed(1)+"M"}
function toast(m,err){var t=document.getElementById("toast");t.textContent=m;t.className="toast on"+(err?" err":"");setTimeout(function(){t.className="toast"},2600)}
function inputFocado(){var e=document.activeElement;return e&&(e.tagName==="INPUT"||e.tagName==="TEXTAREA")&&document.getElementById("view").contains(e)}

// ---- conexão ao vivo (SSE, com poll de reserva) ----
function conectar(){
  try{
    var es=new EventSource("/eventos");
    es.onmessage=function(ev){try{R=JSON.parse(ev.data);pintar()}catch(e){}};
    es.onerror=function(){es.close();setTimeout(pollar,1500)};
  }catch(e){pollar()}
}
function pollar(){fetch("/retrato").then(function(r){return r.json()}).then(function(j){R=j;pintar()}).catch(function(){});setTimeout(pollar,2000)}

function pintar(){
  var ag=R.agentes||[];
  document.getElementById("kAg").textContent=ag.length?ag.length:"";
  var trab=ag.filter(function(a){return a.status==="working"}).length;
  document.getElementById("relogio").innerHTML="<b>"+trab+"</b> trabalhando · "+ag.length+" no ar";
  var g=R.gasto&&R.gasto.total!=null?("US$ "+Number(R.gasto.total).toFixed(2)):"";
  document.getElementById("custo").innerHTML=g?("obra "+g):"";
  if(inputFocado())return; // não repinta enquanto você digita
  renderAba();
}
function renderAba(){
  var v=document.getElementById("view");
  if(aba==="agentes")v.innerHTML=htmlAgentes();
  else if(aba==="fluxo")v.innerHTML='<iframe class="fluxo" src="/fluxo"></iframe>';
  else v.innerHTML=htmlSistema();
}
function setAba(a){aba=a;abertos.clear();
  var ts=document.querySelectorAll("#tabs .tab");for(var i=0;i<ts.length;i++)ts[i].className="tab"+(ts[i].dataset.a===a?" on":"");
  renderAba();
}

// ---- ABA AGENTES ----
function opcoesProj(){
  var set={};(R.agentes||[]).forEach(function(a){if(a.projeto&&a.projeto!=="?")set[a.projeto]=1});
  PROJS_CONHECIDOS.forEach(function(p){set[p]=1});
  return Object.keys(set).map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join("");
}
function htmlAgentes(){
  var ag=R.agentes||[];
  var lanc='<div class="lanc">'+
    '<input class="obj" id="obj" placeholder="Nova tarefa: descreva o que fazer…" onkeydown="if(event.key===\\'Enter\\')despachar()">'+
    '<select id="proj"><option value="">projeto…</option>'+opcoesProj()+'</select>'+
    '<select id="mod"><option value="">modelo (padrão)</option><option value="opus">Opus</option><option value="sonnet">Sonnet</option><option value="haiku">Haiku</option></select>'+
    '<button id="btnDesp" onclick="despachar()">Despachar</button>'+
    '<div class="hint">Despachar abre um agente novo num worktree isolado. Os agentes que você abre na mão no herdr aparecem aqui sozinhos.</div>'+
  '</div>';
  if(!ag.length)return lanc+'<div class="vazio-grade">Nenhum agente vivo no herdr agora.<br>Despache uma tarefa acima, ou abra um <b>claude</b> num pane que ele aparece aqui.</div>';
  return lanc+'<div class="grade">'+ag.map(cardAgente).join("")+'</div>';
}
function iconePapel(p){return p==="engenheiro"?"🔧":p==="qa"?"🧪":p==="revisor"?"🔍":p==="pr"?"🚀":"•"}
function cardAgente(a){
  var st=a.status||"unknown";
  var aberto=abertos.has(a.pane);
  var sub=st==="working"?"trabalhando":st==="idle"?"parado":st==="blocked"?"travado":st;
  var papel=a.despachado?('<span class="badge papel">'+iconePapel(a.papel)+" "+esc(a.papel||"obra")+'</span>'):'<span class="badge direto">direto</span>';
  var corpo="";
  if(aberto){
    var s=saidas[a.pane];
    corpo='<div class="corpo">'+
      '<div class="saida'+(s==null?" carregando":"")+'" id="sd-'+esc(a.pane)+'">'+(s==null?"lendo o terminal…":esc(s))+'</div>'+
      '<div class="fala"><input id="fl-'+esc(a.pane)+'" placeholder="dizer algo pra este agente…" onkeydown="if(event.key===\\'Enter\\')falar(\\''+esc(a.pane)+'\\')">'+
      '<button onclick="falar(\\''+esc(a.pane)+'\\')">enviar</button></div>'+
    '</div>';
  }
  return '<div class="card '+(st==="working"?"work":"")+(aberto?" aberto":"")+'">'+
    '<div class="chead" onclick="toggle(\\''+esc(a.pane)+'\\')">'+
      '<span class="st '+st+'"></span>'+
      '<span class="proj">'+esc(a.projeto)+'</span>'+
      (a.focado?'<span class="foco">em foco</span>':"")+
      '<span class="modelo">'+esc((a.modelo||"").replace("claude-","").replace(/-\\d+$/,""))+'</span>'+
      '<span class="caret">▸</span>'+
    '</div>'+
    '<div class="titulo'+(a.titulo?"":" vazio")+'">'+(a.titulo?esc(a.titulo):"— sem título —")+'</div>'+
    '<div class="meta">'+
      '<span class="badge stlabel '+(st==="working"?"work":"idle")+'">'+esc(sub)+'</span>'+
      papel+
      '<span class="dim">'+esc(a.casa||"claude")+'</span>'+
      '<span class="dim">'+ktok(a.out)+' tok</span>'+
      '<span class="dim">'+esc(a.pane)+'</span>'+
      (a.ultima?'<span class="dim" style="margin-left:auto">'+tempo(a.ultima)+'</span>':"")+
    '</div>'+corpo+
  '</div>';
}
function toggle(pane){
  if(abertos.has(pane)){abertos.delete(pane)}else{abertos.add(pane);verSaida(pane)}
  renderAba();
}
function verSaida(pane){
  fetch("/agente/saida?pane="+encodeURIComponent(pane)).then(function(r){return r.json()}).then(function(j){
    saidas[pane]=j.texto!=null?j.texto:(j.erro||"(sem saída)");
    if(abertos.has(pane))renderAba();
  }).catch(function(){saidas[pane]="(não consegui ler)";if(abertos.has(pane))renderAba()});
}
function falar(pane){
  var el=document.getElementById("fl-"+pane);if(!el)return;var texto=el.value.trim();if(!texto)return;
  el.value="";el.disabled=true;
  fetch("/agente/falar",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pane:pane,texto:texto})})
    .then(function(r){return r.json()}).then(function(j){
      el.disabled=false;
      if(j.ok){toast("enviado pra "+pane);setTimeout(function(){verSaida(pane)},1600)}
      else toast(j.erro||"não enviou",true);
    }).catch(function(){el.disabled=false;toast("falha ao enviar",true)});
}
function despachar(){
  var obj=document.getElementById("obj"),proj=document.getElementById("proj"),mod=document.getElementById("mod"),btn=document.getElementById("btnDesp");
  var texto=obj.value.trim();if(!texto)return toast("descreva a tarefa",true);
  if(!proj.value)return toast("escolha o projeto",true);
  btn.disabled=true;btn.textContent="despachando…";
  fetch("/tarefa",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({texto:texto,projeto:proj.value,modelo:mod.value||null})})
    .then(function(r){return r.json()}).then(function(j){
      btn.disabled=false;btn.textContent="Despachar";
      if(j.erro){toast(j.erro,true)}else{obj.value="";toast("despachado: "+(j.nome||"tarefa"))}
    }).catch(function(){btn.disabled=false;btn.textContent="Despachar";toast("falha ao despachar",true)});
}

// ---- ABA SISTEMA ----
function barra(pct,cls){pct=Math.max(0,Math.min(100,pct||0));var c=pct>=90?"max":pct>=70?"hot":"";return '<div class="bar"><i class="'+c+'" style="width:'+pct+'%"></i></div>'}
function htmlSistema(){
  var m=R.maquina||{},ag=R.agentes||[],g=R.gasto||{};
  var trab=ag.filter(function(a){return a.status==="working"}).length;
  var cpu=m.cpu?'<div class="linha"><span>CPU</span><span class="v">'+m.cpu.pct+'% · load '+m.cpu.load1.toFixed(2)+'/'+m.cpu.cores+'</span></div>'+barra(m.cpu.pct):"";
  var mem=m.mem?'<div class="linha"><span>RAM</span><span class="v">'+m.mem.usedGB+' / '+m.mem.totalGB+' GB</span></div>'+barra(m.mem.pct):"";
  var gpu=m.gpu?'<div class="linha"><span>GPU '+esc(m.gpu.nome)+'</span><span class="v">'+(m.gpu.util!=null?m.gpu.util+'%':"—")+(m.gpu.temp!=null?" · "+m.gpu.temp+"°":"")+'</span></div>'+(m.gpu.util!=null?barra(m.gpu.util):"")+(m.gpu.aviso?'<div class="linha"><span class="dim">'+esc(m.gpu.aviso)+'</span></div>':""):'<div class="linha"><span class="dim">GPU — sem leitura</span></div>';
  var maquina='<div class="bloco"><h3>Máquina (saturno)</h3>'+cpu+mem+gpu+'</div>';
  var frota='<div class="bloco"><h3>Frota de agentes</h3>'+
    '<div class="linha"><span>No ar</span><span class="v">'+ag.length+'</span></div>'+
    '<div class="linha"><span>Trabalhando</span><span class="v">'+trab+'</span></div>'+
    '<div class="linha"><span>Parados</span><span class="v">'+(ag.length-trab)+'</span></div>'+
    '<div class="linha"><span>Despachados pela obra</span><span class="v">'+ag.filter(function(a){return a.despachado}).length+'</span></div>'+
  '</div>';
  var custo='<div class="bloco"><h3>Gasto da obra (14d)</h3>'+
    '<div class="linha"><span>Total</span><span class="v">'+(g.total!=null?"US$ "+Number(g.total).toFixed(2):"—")+'</span></div>'+
    (R.conta&&R.conta.email?'<div class="linha"><span>Conta</span><span class="v">'+esc(R.conta.email)+'</span></div>':"")+
    '<div class="linha"><span>herdr</span><span class="v">'+(ag.length?"no ar":"sem agentes")+'</span></div>'+
  '</div>';
  return '<div class="sis">'+maquina+frota+custo+'</div>';
}

// tabs
document.getElementById("tabs").addEventListener("click",function(e){var t=e.target.closest(".tab");if(t)setAba(t.dataset.a)});
setInterval(function(){var r=document.getElementById("relogio");if(!r||!R.agentes)return;/* mantém "há X" fresco */ if(aba==="agentes"&&!inputFocado())renderAba()},15000);
conectar();
</script>
</body></html>`;
const FLUXO_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fluxo da Obra</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${MARINHO};color:${GELO};font:14px/1.5 "JetBrains Mono",Menlo,ui-monospace,monospace;min-height:100vh}
header{display:flex;align-items:center;gap:12px;padding:14px 22px;border-bottom:1px solid #35353d}
header h1{font-size:14px;letter-spacing:.2em;color:${CIANO};font-weight:700}
header .sub{font-size:11px;color:#9399b2}
header a{margin-left:auto;color:${AMBAR};text-decoration:none;font-size:11px;letter-spacing:.08em;border:1px solid #35353d;padding:5px 12px}
.wrap{max-width:1120px;margin:0 auto;padding:18px 22px 44px}
.proc{width:100%;height:auto;margin-bottom:6px}
.pnode{fill:#1e1e22;stroke:#35353d;stroke-width:1.5}
.pnode.on{stroke:${CIANO};stroke-width:2.5}
.plabel{fill:${GELO};font:700 12px "JetBrains Mono",monospace;text-anchor:middle}
.pdesc{fill:#9399b2;font:9px "JetBrains Mono",monospace;text-anchor:middle;text-transform:uppercase;letter-spacing:.05em}
.pcount{fill:${CIANO};font:700 10px "JetBrains Mono",monospace;text-anchor:middle}
.plooplb{fill:${VERM};font:700 10px "JetBrains Mono",monospace;text-anchor:middle;letter-spacing:.05em;paint-order:stroke;stroke:${MARINHO};stroke-width:4px;stroke-linejoin:round}
.cols{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:#35353d;border:1px solid #35353d;margin-top:12px}
.col{background:#1e1e22;min-height:130px;min-width:0;display:flex;flex-direction:column}
.colh{padding:8px 10px;border-bottom:1px solid #35353d;display:flex;align-items:center;gap:6px}
.colh .e{font-size:15px}.colh .n{font-size:11px;font-weight:700;color:${GELO}}
.colh .c{margin-left:auto;font-size:10px;color:${CIANO}}
.colbody{padding:8px;display:flex;flex-direction:column;gap:7px;flex:1}
.chip{background:#24242a;border:1px solid #35353d;border-left:3px solid ${CIANO};padding:7px 8px;font-size:11px}
.chip.done{border-left-color:${VERDE}}.chip.rep{border-left-color:${VERM}}.chip.dead{border-left-color:#9399b2}
.chip .p{color:${CIANO};font-size:9px;letter-spacing:.07em;text-transform:uppercase}
.chip .o{color:${GELO};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:2px 0}
.chip .m{display:flex;gap:8px;color:#9399b2;font-size:10px}
.chip .m .cu{margin-left:auto;color:${VERDE}}
.chip a{color:${CIANO};text-decoration:none}
.empty{color:#33485e;font-size:11px;padding:12px;text-align:center}
@media(max-width:820px){.cols{grid-template-columns:repeat(2,1fr)}.proc{display:none}}
</style></head><body>
<header><h1>📊 FLUXO DA OBRA</h1><span class="sub" id="sub">o processo e as tarefas ao vivo</span><a href="/">← painel</a></header>
<div class="wrap">
  <svg class="proc" id="proc" viewBox="0 0 1140 152" preserveAspectRatio="xMidYMid meet"></svg>
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
  const CY=78, R=34; // quadrados MAIORES (68×68), centrados no eixo de cada coluna
  let s="";
  for(let i=0;i<5;i++) s+='<line x1="'+(cx(i)+R)+'" y1="'+CY+'" x2="'+(cx(i+1)-R)+'" y2="'+CY+'" stroke="#3a5670" stroke-width="2" marker-end="url(#fa)"/>';
  // seta de retorno Rev→Eng por cima; o rótulo fica ACIMA do arco, então não se cruzam
  s+='<path d="M'+cx(3)+' '+(CY-R)+' C '+cx(3)+' 26,'+cx(1)+' 26,'+cx(1)+' '+(CY-R)+'" fill="none" stroke="${VERM}" stroke-width="1.6" stroke-dasharray="4 3" marker-end="url(#fr)"/>';
  s+='<text class="plooplb" x="'+cx(2)+'" y="14">reprovou → volta pro Engenheiro</text>';
  COLS.forEach((c,i)=>{
    const on=(cont[c.k]||0)>0, X=cx(i);
    s+='<rect class="pnode'+(on?" on":"")+'" x="'+(X-R)+'" y="'+(CY-R)+'" width="'+(2*R)+'" height="'+(2*R)+'"/>';
    s+='<text x="'+X+'" y="'+CY+'" text-anchor="middle" dominant-baseline="central" style="font-size:28px">'+c.e+'</text>';
    s+='<text class="plabel" x="'+X+'" y="'+(CY+R+18)+'">'+c.n+'</text>';
    s+=on?'<text class="pcount" x="'+X+'" y="'+(CY+R+32)+'">'+cont[c.k]+' tarefa'+(cont[c.k]>1?"s":"")+'</text>'
        :'<text class="pdesc" x="'+X+'" y="'+(CY+R+31)+'">'+c.d+'</text>';
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
body{background:${MARINHO};color:${GELO};font:14px/1.5 "JetBrains Mono",Menlo,ui-monospace,monospace;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid #35353d;color:${AMBAR};font-weight:700;letter-spacing:.14em}
header .sub{font-size:11px;letter-spacing:.04em;color:#9399b2;font-weight:400}
#msgs{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:12px;max-width:900px;width:100%;margin:0 auto}
.msg{max-width:80%;padding:10px 13px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.voce{align-self:flex-end;background:#0e2233;border:1px solid #35353d}
.msg.boss{align-self:flex-start;background:#24242a;border:1px solid #35353d}
.msg.pensando{align-self:flex-start;color:#9399b2;font-style:italic}
.vazio{color:#9399b2;text-align:center;margin:auto}
.anx{display:flex;flex-wrap:wrap;gap:6px;padding:0 20px;max-width:900px;width:100%;margin:0 auto}
.anx span{font-size:11px;color:#9399b2;border:1px solid #35353d;padding:2px 8px}
.entrada{border-top:1px solid #35353d;padding:14px 18px;display:flex;gap:8px;max-width:900px;width:100%;margin:0 auto}
.entrada textarea{flex:1;min-height:48px;max-height:180px;resize:vertical;background:#1e1e22;border:1px solid #35353d;color:${GELO};padding:10px 12px;font:14px/1.4 "JetBrains Mono",Menlo,monospace}
.entrada textarea:focus{outline:none;border-color:${AMBAR}}
.entrada button{background:transparent;border:1px solid #35353d;color:#9399b2;padding:0 14px;cursor:pointer;font:13px "JetBrains Mono",monospace}
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
  // "Boss (direto)": o EU registra trabalho direto aqui → vira card no painel.
  // sem id = cria (devolve o id); com id = atualiza (status "terminou" fecha o card).
  if (req.method === "POST" && req.url === "/direto") {
    try {
      const b = await lerCorpo(req);
      const lista = lerDiretos();
      const nowISO = new Date().toISOString();
      if (b.id) {
        const d = lista.find((x) => x.id === b.id);
        if (d) {
          if (b.status) d.status = b.status;
          if (b.status === "terminou") d.fim = nowISO;
          if (b.atividade != null) d.atividade = String(b.atividade).slice(0, 200);
          if (b.resultado != null) d.resultado = String(b.resultado).slice(0, 500);
        }
        salvarDiretos(lista); return json(200, d || {});
      }
      const d = { id: "d" + Date.now() + "-" + Math.floor(Math.random() * 1000),
        titulo: String(b.titulo || "(sem título)").slice(0, 200), projeto: b.projeto ? String(b.projeto).slice(0, 40) : null,
        status: "trabalhando", atividade: b.atividade ? String(b.atividade).slice(0, 200) : null, comecou: nowISO };
      lista.push(d); salvarDiretos(lista); return json(201, d);
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Torre: lança uma tarefa "solo" (um eu fazedor num pane), com modelo escolhido
  if (req.method === "POST" && req.url === "/tarefa") {
    try {
      const b = await lerCorpo(req);
      const texto = String(b.texto || "").trim();
      if (!texto) return json(400, { erro: "escreva a tarefa" });
      if (texto.length > 4000) return json(400, { erro: "tarefa grande demais" });
      const projeto = b.projeto ? String(b.projeto).slice(0, 60) : "querofretes-ofc";
      const modelo = b.modelo ? String(b.modelo).slice(0, 30) : null;
      const nome = "t" + Date.now().toString(36);
      // registra "subindo" na hora → o card aparece já; a criação corre em SEGUNDO PLANO (não trava a resposta)
      lancando.set(nome, { nome, projeto, modelo, tarefa: texto, estado: "subindo", em: new Date().toISOString() });
      const args = ["abrir", nome, texto, "solo", projeto, ...(modelo ? ["--modelo", modelo] : [])];
      rodarObra(args).then((r) => {
        if (r.code === 0) { lancando.delete(nome); atualizarStatusTarefas(); } // o registro real assume o card
        else { const c = lancando.get(nome); if (c) lancando.set(nome, { ...c, estado: "erro", erro: extrairErro(r.out) }); }
      }).catch((e) => { const c = lancando.get(nome); if (c) lancando.set(nome, { ...c, estado: "erro", erro: String((e && e.message) || e) }); });
      return json(201, { nome, estado: "subindo" });
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Torre: manda uma linha pra uma tarefa (herdr agent prompt, via obra falar)
  if (req.method === "POST" && req.url === "/tarefa/falar") {
    try {
      const b = await lerCorpo(req);
      const nome = String(b.nome || "").trim();
      const texto = String(b.texto || "").trim();
      if (!nome || !texto) return json(400, { erro: "faltou nome ou texto" });
      if (texto.length > 4000) return json(400, { erro: "texto grande demais" });
      const r = await rodarObra(["falar", nome, texto]);
      if (r.code !== 0) return json(502, { erro: "não consegui falar com a tarefa", detalhe: r.out.slice(0, 400) });
      return json(200, { ok: true });
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Torre: lê a saída recente de uma tarefa (o que ela respondeu no pane)
  if (req.method === "GET" && req.url.startsWith("/tarefa/saida")) {
    try {
      const u = new URL(req.url, "http://x");
      const nome = String(u.searchParams.get("nome") || "").trim();
      if (!nome) return json(400, { erro: "faltou nome" });
      const r = await rodarObra(["ler", nome, "30"]);
      return json(200, { texto: r.out });
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Auto-descoberta: falar direto com QUALQUER agente do herdr (por pane), despachado ou não
  if (req.method === "POST" && req.url === "/agente/falar") {
    try {
      const b = await lerCorpo(req);
      const pane = String(b.pane || "").trim();
      const texto = String(b.texto || "").trim();
      if (!pane || !texto) return json(400, { erro: "faltou pane ou texto" });
      if (texto.length > 4000) return json(400, { erro: "texto grande demais" });
      const r = await herdrCmd(["agent", "prompt", pane, texto]);
      if (r.code !== 0) return json(502, { erro: "não consegui falar com o agente", detalhe: r.out.slice(0, 400) });
      return json(200, { ok: true });
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Auto-descoberta: lê a saída recente de um pane (texto renderizado do terminal)
  if (req.method === "GET" && req.url.startsWith("/agente/saida")) {
    try {
      const pane = String(new URL(req.url, "http://x").searchParams.get("pane") || "").trim();
      if (!pane) return json(400, { erro: "faltou pane" });
      const r = await herdrCmd(["agent", "read", pane, "--source", "recent-unwrapped", "--lines", "40"]);
      return json(200, { texto: String(r.out || "").slice(-6000) });
    } catch (e) { return json(400, { erro: e.message }); }
  }
  // Torre: encerra uma tarefa (remove a cópia e o pane)
  if (req.method === "POST" && req.url === "/tarefa/fechar") {
    try {
      const b = await lerCorpo(req);
      const nome = String(b.nome || "").trim();
      if (!nome) return json(400, { erro: "faltou nome" });
      lancando.delete(nome); // descarta card de "subindo/erro" também
      const r = await rodarObra(["fechar", nome]);
      return json(200, { ok: r.code === 0, saida: r.out.slice(0, 400) });
    } catch (e) { return json(400, { erro: e.message }); }
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
