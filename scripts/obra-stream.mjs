/**
 * LEITURA DO LOG DO AGENTE — o formato `stream-json` do Claude Code, um evento por linha.
 *
 * Por que existe: o agente rodava com saída de TEXTO, que só imprime a resposta final —
 * sem preço e sem nada do percurso. Não dava para responder "quanto custou esta obra"
 * nem mostrar o agente trabalhando ao vivo. Com `--output-format stream-json --verbose`
 * o log passa a trazer cada chamada de ferramenta e um evento final com o custo.
 *
 * Mora aqui porque DOIS lados leem o mesmo arquivo e não podem divergir: o maestro
 * (obra-fluxo) quer o texto final e o custo; a TUI do painel (obra-agente) quer o
 * caminho para mostrar na tela.
 *
 * ⚠️ Erro do CLI (autenticação, flag inválida) NÃO sai em JSON — sai como texto solto.
 * Por isso linha que não começa com "{" é preservada nos dois casos: sem isso, uma falha
 * de execução viraria "(sem saída)" e pareceria que o agente simplesmente não respondeu.
 */
import { readFileSync } from "fs";

/** Percorre o log devolvendo cada evento já decodificado; texto solto vem como string. */
function* eventos(logfile) {
  let bruto = "";
  try { bruto = readFileSync(logfile, "utf8"); } catch { return; }
  for (const linha of bruto.split(/\r?\n/)) {
    const s = linha.trim();
    if (!s) continue;
    if (!s.startsWith("{")) { yield s; continue; }
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    yield ev;
  }
}

/**
 * O resultado do agente: o que ele respondeu, quanto custou e em quantos turnos.
 * Sem o evento "result" (o processo morreu no meio), o que ele chegou a dizer ainda serve
 * — é melhor entregar meia resposta do que uma tela vazia sem explicação.
 */
export function lerResultado(logfile) {
  let texto = "", custo = 0, turnos = 0, dur = 0;
  const solto = [];
  for (const ev of eventos(logfile)) {
    if (typeof ev === "string") { solto.push(ev); continue; }
    if (ev.type === "result") {
      texto = ev.result || texto;
      custo += ev.total_cost_usd || 0;
      turnos = ev.num_turns || turnos;
      dur = ev.duration_ms || dur;
    } else if (ev.type === "assistant") {
      for (const c of ev.message?.content || []) if (c.type === "text" && c.text) solto.push(c.text);
    }
  }
  return { texto: texto || solto.join("\n"), custo, turnos, dur };
}

/** Tira cor ANSI e controle — o log tem escape que suja a TUI. */
const limpo = (s) =>
  String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/[^\x20-\x7eÀ-ÿ]/g, " ").trim();

/** O argumento que identifica a chamada — é o que diz "rodando npm test", não só "Bash". */
const alvoDaFerramenta = (input = {}) =>
  limpo(input.command || input.file_path || input.pattern || input.path || input.description || "").slice(0, 72);

/**
 * O CAMINHO do agente para a tela: qual ferramenta ele chamou e em quê.
 * Mostrar o JSON cru encheria o painel de `{"type":"assistant",...}` — ilegível.
 */
export function lerAtividade(logfile, n = 12) {
  const out = [];
  for (const ev of eventos(logfile)) {
    if (typeof ev === "string") { out.push(limpo(ev)); continue; }
    if (ev.type !== "assistant") continue;
    for (const c of ev.message?.content || []) {
      if (c.type === "tool_use") out.push(`▸ ${c.name}: ${alvoDaFerramenta(c.input)}`);
      else if (c.type === "text" && c.text?.trim()) out.push(limpo(c.text));
    }
  }
  return out.filter(Boolean).slice(-n);
}
