/**
 * O QUADRO DE TAREFAS — uma TUI de verdade, rodando CONTÍNUA no painel BOSS.
 *
 *   CONCLUÍDAS (✓ verde) · EM ANDAMENTO (⏳ ciano, etapa) · NA FILA (○ cinza)
 *   cada tarefa mostra o REPOSITÓRIO dela.
 *
 * Diferente da versão antiga (que repintava rodando um script a cada mudança, deixando
 * o `❯ bash …` à mostra), esta ENTRA no buffer alternativo do terminal, esconde o cursor
 * e redesenha NO LUGAR — como htop/lazygit. Fica rodando até levar Ctrl-C.
 *
 * Roda no painel BOSS:  herdr pane run <boss> node scripts/obra-quadro.mjs
 * (a sala já sobe assim). Pra testar no seu terminal:  node scripts/obra-quadro.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REG = process.env.OBRA_REGISTRO || resolve(RAIZ, ".herdr-obra.json");

// cores QF em truecolor
const CIANO = "\x1b[1;38;2;53;193;239m";
const VERDE = "\x1b[1;38;2;55;207;124m";
const DIM   = "\x1b[38;2;109;130;153m";
const TXT   = "\x1b[38;2;234;243;248m";
const R     = "\x1b[0m";

const EM_ANDAMENTO = ["implementando", "teste", "revisao"];
const CONCLUIDAS = ["pronto", "arquivado"];
const ETAPA = { implementando: "engenheiro", teste: "QA", revisao: "revisor" };

function tarefas() {
  try { return JSON.parse(readFileSync(REG, "utf8")).tarefas || []; } catch { return []; }
}
const corta = (s, n) => (s || "").length > n ? (s || "").slice(0, n - 1) + "…" : (s || "");
const repo = (t) => `[${corta(t.projeto || "?", 16)}]`;

function linhas() {
  const ts = tarefas();
  const and = ts.filter((t) => EM_ANDAMENTO.includes(t.estado));
  const fila = ts.filter((t) => t.estado === "fila");
  const feitas = ts.filter((t) => CONCLUIDAS.includes(t.estado));
  const L = [];
  L.push(`${CIANO} 🧭 QUADRO DA OBRA${R}`);
  L.push(`${DIM} ${feitas.length} concluída(s) · ${and.length} em andamento · ${fila.length} na fila${R}`);
  L.push("");

  L.push(`${CIANO} ── EM ANDAMENTO ──${R}`);
  if (and.length) for (const t of and)
    L.push(`  ${CIANO}⏳ ${t.id}${R}  ${TXT}${corta(t.titulo, 40)}${R}  ${DIM}${repo(t)} · ${ETAPA[t.estado] || t.estado}${R}`);
  else L.push(`  ${DIM}—${R}`);
  L.push("");

  L.push(`${DIM} ── NA FILA ──${R}`);
  if (fila.length) for (const t of fila)
    L.push(`  ${DIM}○ ${t.id}${R}  ${TXT}${corta(t.titulo, 44)}${R}  ${DIM}${repo(t)}${R}`);
  else L.push(`  ${DIM}—${R}`);
  L.push("");

  L.push(`${VERDE} ── CONCLUÍDAS ──${R}`);
  if (feitas.length) for (const t of feitas.slice(-10))
    L.push(`  ${VERDE}✓ ${t.id}${R}  ${DIM}${corta(t.titulo, 44)} ${repo(t)}${R}`);
  else L.push(`  ${DIM}—${R}`);

  return L;
}

function render() {
  let out = "\x1b[H"; // cursor pro topo
  for (const l of linhas()) out += l + "\x1b[K\n"; // limpa até o fim da linha
  out += "\x1b[J"; // limpa o resto da tela
  process.stdout.write(out);
}

// entra na "tela cheia" do terminal (buffer alternativo) + esconde cursor
process.stdout.write("\x1b[?1049h\x1b[?25l");
render();
const timer = setInterval(render, 1000);

function sair() {
  clearInterval(timer);
  process.stdout.write("\x1b[?25h\x1b[?1049l"); // mostra cursor + sai do buffer alternativo
  process.exit(0);
}
process.on("SIGINT", sair);
process.on("SIGTERM", sair);
