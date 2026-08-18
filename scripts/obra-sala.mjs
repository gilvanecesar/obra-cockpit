/**
 * A SALA DA OBRA — layout de guerra dentro do herdr.
 *
 * Cria um tab "OBRA" dividido em 5 painéis, tudo visível de uma vez:
 *
 *   +----------------+------------------+------------------+
 *   |                |   ENGENHEIRO     |       QA         |
 *   |     BOSS       +------------------+------------------+
 *   |    (chat)      |    REVISOR       |       PR         |
 *   +----------------+------------------+------------------+
 *
 * Aqui é SÓ o layout (as janelas nomeadas, cada uma com seu banner). A fiação do
 * fluxo (Boss aciona engenheiro → QA → revisor → PR, um por um) é a parte 2.
 *
 * Uso:
 *   node scripts/obra-sala.mjs            → cria/recria a sala
 *   node scripts/obra-sala.mjs fechar     → fecha o tab OBRA
 */
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function h(...args) {
  const out = execFileSync("herdr", args, { encoding: "utf8", maxBuffer: 8e6 });
  const j = JSON.parse(out);
  return j.result ?? j;
}

// Procura o pane_id dentro de qualquer forma de resposta do split/create.
function acharPane(res) {
  if (!res) return null;
  if (res.pane_id) return res.pane_id;
  if (res.pane?.pane_id) return res.pane.pane_id;
  if (res.new_pane?.pane_id) return res.new_pane.pane_id;
  if (res.root_pane?.pane_id) return res.root_pane.pane_id;
  return null;
}

function split(pane, direction, ratio, cwd) {
  const args = ["pane", "split", pane, "--direction", direction];
  if (ratio) args.push("--ratio", String(ratio));
  if (cwd) args.push("--cwd", cwd);
  return acharPane(h(...args));
}

function nomear(pane, nome) {
  try { h("pane", "rename", pane, nome); } catch {}
}

// Banner colorido no painel, pra ficar claro qual é qual mesmo parado.
function banner(pane, titulo, cor, sub) {
  const cmd =
    `clear; printf '\\033[1;${cor}m╔══════════════════════════╗\\n║  ${titulo}\\033[0m\\033[1;${cor}m\\n╚══════════════════════════╝\\033[0m\\n\\n\\033[2m${sub}\\033[0m\\n'`;
  try { h("pane", "run", pane, "bash", "-lc", cmd); } catch {}
}

const QF = "/Users/gilvanecesar/Documents/DEV/querofretes-ofc";

function tabsObra() {
  const tabs = h("tab", "list")?.tabs || [];
  return tabs.filter((t) => (t.label || "").toUpperCase() === "OBRA");
}

function fechar() {
  for (const t of tabsObra()) {
    try { h("tab", "close", t.tab_id); } catch {}
  }
  console.log("tab(s) OBRA fechado(s).");
}

function criar() {
  // limpa qualquer OBRA anterior pra não acumular
  fechar();
  const ws = (h("workspace", "list")?.workspaces || []).find((w) => w.focused) ||
             (h("workspace", "list")?.workspaces || [])[0];
  const wsId = ws?.workspace_id || "w9";

  const tab = h("tab", "create", "--workspace", wsId, "--label", "OBRA", "--cwd", QF);
  const boss = acharPane(tab);
  if (!boss) { console.error("não consegui criar o tab OBRA"); process.exit(1); }

  // Boss à esquerda (fica com ~40%); direita = área dos agentes
  const eng = split(boss, "right", 0.6, QF);          // Boss 40% | direita 60%
  const revisor = split(eng, "down", 0.5, QF);        // direita vira topo(ENG) / baixo(REVISOR)
  const qa = split(eng, "right", 0.5, QF);            // topo: ENG | QA
  const pr = split(revisor, "right", 0.5, QF);        // baixo: REVISOR | PR

  nomear(boss, "BOSS");
  nomear(eng, "ENGENHEIRO");
  nomear(qa, "QA");
  nomear(revisor, "REVISOR");
  nomear(pr, "PR");

  // O painel BOSS vira o QUADRO DE TAREFAS (TUI ao vivo), não um shell.
  try { h("pane", "run", boss, "node", resolve(RAIZ, "scripts/obra-quadro.mjs")); } catch {}
  // Cada painel de agente roda a SUA TUI (mesmo estilo do BOSS), não mais banner.
  const tui = resolve(RAIZ, "scripts/obra-agente.mjs");
  try { h("pane", "run", eng, "node", tui, "eng"); } catch {}
  try { h("pane", "run", qa, "node", tui, "qa"); } catch {}
  try { h("pane", "run", revisor, "node", tui, "revisor"); } catch {}
  try { h("pane", "run", pr, "node", tui, "pr"); } catch {}

  // Persiste os IDs pra o maestro (obra-fluxo.mjs) saber onde acionar cada agente.
  const mapa = { tab: tab.tab_id || tab.root_pane?.tab_id, boss, eng, qa, revisor, pr, em: new Date().toISOString() };
  writeFileSync(resolve(RAIZ, ".herdr-obra-sala.json"), JSON.stringify(mapa, null, 2));

  console.log("SALA_OBRA_PRONTA");
  console.log(JSON.stringify(mapa));
}

const acao = process.argv[2];
if (acao === "fechar") fechar();
else criar();
