/**
 * QUADRO DO AGENTE — a TUI de status de cada painel (ENGENHEIRO/QA/REVISOR/PR), no mesmo
 * estilo do BOSS. Fica rodando CONTÍNUA no painel (não é mais parada pra o claude rodar):
 * o claude roda como filho do maestro gravando um LOG, e esta TUI mostra
 *
 *   ○ aguardando   →   ▶ TRABALHANDO (+ tempo, + tail do log = check/test ao vivo)
 *                  →   ✓ TERMINOU / ✗ REPROVOU (+ o resultado: APROVADO, "QA: ...", etc.)
 *
 * Lê o mesmo `.herdr-obra-status.json` que o maestro (obra-fluxo) escreve a cada etapa.
 *
 * Uso:  node scripts/obra-agente.mjs <eng|qa|revisor|pr>
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { lerAtividade } from "./obra-stream.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = process.env.OBRA_STATUS || resolve(RAIZ, ".herdr-obra-status.json");

const CIANO = "\x1b[1;38;2;53;193;239m";
const VERDE = "\x1b[1;38;2;55;207;124m";
const AMBAR = "\x1b[1;38;2;232;179;71m";
const VERM  = "\x1b[1;38;2;235;110;110m";
const DIM   = "\x1b[38;2;109;130;153m";
const TXT   = "\x1b[38;2;234;243;248m";
const R     = "\x1b[0m";

const PAPEIS = {
  eng:     { nome: "🔧  ENGENHEIRO", cor: VERDE, desc: "Implementa a tarefa numa cópia isolada." },
  qa:      { nome: "🧪  QA (testador)", cor: AMBAR, desc: "Tenta QUEBRAR o que o engenheiro fez." },
  revisor: { nome: "🔍  REVISOR", cor: CIANO, desc: "Procura defeito. Aprova ou reprova." },
  pr:      { nome: "🚀  PR", cor: VERDE, desc: "Fecha a entrega aprovada em Pull Request." },
};

const arg = (process.argv[2] || "eng").toLowerCase();
const P = PAPEIS[arg] || PAPEIS.eng;

const status = () => { try { return JSON.parse(readFileSync(STATUS, "utf8")); } catch { return { agents: {} }; } };
const corta = (s, n) => (s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "");

function decorrido(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min}min ${s}s` : `${s}s`;
}

/**
 * ⚠️ Antes isto era um `tail` cru do log. Com o `stream-json` o arquivo virou JSON e o tail
 * cru encheria a tela de `{"type":"assistant","message":{...}}`. Quem sabe ler o formato é
 * o obra-stream — o mesmo módulo que o maestro usa, para os dois não divergirem.
 */
const tail = (logpath, n) => (logpath ? lerAtividade(logpath, n) : []);

function linhas() {
  const cols = process.stdout.columns || 60;
  const largura = Math.max(10, Math.min(44, cols - 2));
  const nTail = Math.max(4, (process.stdout.rows || 24) - 13);
  const a = (status().agents || {})[arg] || {};
  const tarefa = status().task || "";
  const L = [];
  L.push("");
  L.push(` ${P.cor}${P.nome}${R}`);
  L.push(` ${DIM}${P.desc}${R}`);
  L.push("");
  L.push(` ${DIM}${"─".repeat(largura)}${R}`);
  L.push("");

  // O harness deste papel (modelo/esforço) e o preço são o que separa "está rodando" de
  // "está rodando o modelo caro" — sem isso, custo só aparece na fatura.
  const harness = a.modelo ? `${a.modelo}${a.effort ? " · " + a.effort : ""}` : "";
  const preco =
    a.custo == null ? "" : ` · US$ ${Number(a.custo).toFixed(2)}${a.turnos ? ` · ${a.turnos} turno(s)` : ""}`;

  if (a.step === "trabalhando") {
    L.push(` ${AMBAR}▶ TRABALHANDO${R}  ${DIM}${decorrido(a.startedAt)}${harness ? " · " + harness : ""}${R}`);
    if (tarefa) L.push(`   ${TXT}${corta(tarefa, cols - 4)}${R}`);
    L.push("");
    const t = tail(a.log, nTail);
    if (t.length) { L.push(` ${DIM}atividade:${R}`); for (const l of t) L.push(`  ${DIM}${corta(l, cols - 3)}${R}`); }
    else L.push(` ${DIM}iniciando…${R}`);
  } else if (a.step === "terminou") {
    const reprovou = arg === "revisor" && /REPROVADO/i.test(a.result || "");
    L.push(` ${reprovou ? VERM : VERDE}${reprovou ? "✗ REPROVOU" : "✓ TERMINOU"}${R}  ${DIM}${harness}${preco}${R}`);
    if (a.result) L.push(`   ${TXT}${corta(a.result, cols - 4)}${R}`);
    L.push("");
    const t = tail(a.log, nTail);
    if (t.length) { L.push(` ${DIM}últimas linhas:${R}`); for (const l of t) L.push(`  ${DIM}${corta(l, cols - 3)}${R}`); }
  } else {
    L.push(` ${DIM}○ aguardando tarefa${R}`);
  }
  return L;
}

function render() {
  let out = "\x1b[H";
  for (const l of linhas()) out += l + "\x1b[K\n";
  out += "\x1b[J";
  process.stdout.write(out);
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
render();
const timer = setInterval(render, 1000);
function sair() { clearInterval(timer); process.stdout.write("\x1b[?25h\x1b[?1049l"); process.exit(0); }
process.on("SIGINT", sair);
process.on("SIGTERM", sair);
