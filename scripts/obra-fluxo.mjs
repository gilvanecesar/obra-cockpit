/**
 * O MAESTRO da obra — aciona os agentes na sequência, cada um no SEU painel da sala.
 *
 *   BOSS (narra) → ENGENHEIRO → QA → REVISOR → (aprova?) → PR
 *
 * Cada agente é um Claude Code headless (`claude -p`) rodando DENTRO do painel dele,
 * numa CÓPIA isolada do repo (git worktree) compartilhada pela sequência (serial, sem
 * conflito). O fim de cada um é detectado por um marcador ÚNICO via `pane wait-output`.
 * Revisor pode REPROVAR → volta pro engenheiro (máx 2 rodadas).
 *
 * ⚠️ herdr `pane run <p> bash -lc "<script>"` NÃO passa o script como 1 arg — o shell
 * do painel reparte as aspas. Por isso todo comando vai num ARQUIVO .sh e roda como
 * `bash <arquivo>` (dois tokens simples). Foi o bug da 1ª versão.
 *
 * Pré: a sala existe (`node scripts/obra-sala.mjs` grava .herdr-obra-sala.json).
 * Uso: node scripts/obra-fluxo.mjs "<tarefa>"
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, mkdtempSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir, tmpdir } from "os";
import { criarTarefa, moverTarefa } from "./obra-tarefas.mjs";
import { lerResultado } from "./obra-stream.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * REPO = onde a obra CONSTRÓI. Sem `--projeto`, é este repositório (querofretes-ofc); com
 * ele, é outro repo irmão (TMS, AGB…), para o cockpit acionar o time em qualquer projeto.
 * O motor mora aqui, mas o git/worktree/CLAUDE.md que valem são os do REPO escolhido — é o
 * CLAUDE.md de LÁ que ensina o agente a não fazer besteira naquele código.
 */
const argv = process.argv.slice(2);
const iProj = argv.indexOf("--projeto");
const REPO = iProj >= 0 && argv[iProj + 1] ? resolve(argv[iProj + 1]) : RAIZ;
if (iProj >= 0) argv.splice(iProj, 2); // tira a flag antes de ler a tarefa

// pid entra no NONCE: em paralelo, duas missões no mesmo milissegundo colidiriam no nome do
// branch/worktree e uma quebraria no `git worktree add`. O pid do processo as separa.
const NONCE = String(Date.now()).slice(-6) + "-" + process.pid;
const COMECOU = new Date().toISOString();

/**
 * Cada missão grava num arquivo PRÓPRIO em .herdr-obra-runs/ — assim o cockpit varre essa
 * pasta e VÊ TODA missão da obra, não importa por qual porta nasceu (botão do cockpit OU
 * `obra-fluxo` direto de outra sessão). Antes o padrão era um arquivo único
 * (.herdr-obra-status.json), então missão lançada por fora ficava invisível pro cockpit.
 * OBRA_STATUS ainda manda (o cockpit pode apontar para onde quiser).
 */
const RUNS = resolve(RAIZ, ".herdr-obra-runs");
try { mkdirSync(RUNS, { recursive: true }); } catch {}
const STATUS = process.env.OBRA_STATUS || join(RUNS, `run-${NONCE}.json`);

/**
 * A SALA (painéis do herdr) só existia para ENDEREÇAR pane no terminal — mas `rodarAgente`
 * roda o claude como filho e grava o status num arquivo; nunca usou o pane de verdade.
 * Por isso ela virou OPCIONAL: o cockpit dispara a missão sem herdr nenhum e é ele que
 * mostra os painéis. Sem sala, os campos `pane:` ficam vazios e ninguém sente falta.
 */
const SALA = (() => {
  try { return JSON.parse(readFileSync(resolve(RAIZ, ".herdr-obra-sala.json"), "utf8")); }
  catch { return {}; }
})();
const TIMEOUT = 25 * 60 * 1000; // 25 min por agente
const TMP = mkdtempSync(join(tmpdir(), "obra-"));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const sh = (bin, args) => execFileSync(bin, args, { encoding: "utf8", maxBuffer: 16e6 });

const tarefa = argv.join(" ").trim();
if (!tarefa) { console.error('uso: node scripts/obra-fluxo.mjs "<tarefa>" [--projeto <dir>]'); process.exit(1); }
const NOME_REPO = REPO.split("/").pop();

/**
 * RECEITA — o harness de cada papel: modelo e esforço casados com a FUNÇÃO dele.
 *
 * Antes todo agente subia no modelo padrão da sessão, então o passo mecânico (rodar
 * três comandos de git e abrir o PR) queimava o mesmo token do passo que precisa de
 * cabeça. Quem decide é quem IMPLEMENTA e quem diz NÃO; o QA varre e o PR só executa
 * comando já escrito. Trocar não exige editar o arquivo:
 *
 *   OBRA_MODELO_ENG=sonnet OBRA_EFFORT_REVISOR=max node scripts/obra-fluxo.mjs "..."
 */
const RECEITA = {
  eng:     { modelo: "opus",   effort: "high",   tools: "Read,Write,Edit,Bash,Grep,Glob" },
  qa:      { modelo: "sonnet", effort: "medium", tools: "Read,Bash,Grep,Glob" },
  revisor: { modelo: "opus",   effort: "high",   tools: "Read,Bash,Grep,Glob" },
  pr:      { modelo: "haiku",  effort: "low",    tools: "Bash,Read" },
};
const receita = (papel) => {
  const r = RECEITA[papel] || RECEITA.eng;
  const env = (k, v) => process.env[`OBRA_${k}_${papel.toUpperCase()}`] || v;
  return { ...r, modelo: env("MODELO", r.modelo), effort: env("EFFORT", r.effort) };
};

/** O que cada papel gastou — vira o total no fim da obra. */
const gasto = [];

const tituloCurto = tarefa.split(/\.\s/)[0].slice(0, 90);
let seq = 0;

function narra(txt) {
  // Painéis rodam TUIs (BOSS = quadro, agentes = status) — a narração vai pro log.
  console.log(txt);
}

// Estado por AGENTE que cada painel lê pra mostrar o status ao vivo (o que faz, se passou).
// Grava também a META da missão (objetivo, projeto, quando começou) para o cockpit montar
// o card mesmo quando a missão nasceu por fora — sem depender do que ele guarda em memória.
function escreverStatus(papel, patch) {
  let s; try { s = JSON.parse(readFileSync(STATUS, "utf8")); } catch { s = {}; }
  s.task = tituloCurto; s.runId = NONCE; s.objetivo = tarefa; s.projeto = NOME_REPO;
  s.comecou = s.comecou || COMECOU; s.pid = process.pid; s.agents = s.agents || {};
  if (papel) s.agents[papel] = { ...(s.agents[papel] || {}), ...patch };
  writeFileSync(STATUS, JSON.stringify(s, null, 2));
}

// O resultado do agente, lido do log do claude — a linha-chave de cada papel.
function resumirResultado(papel, saida) {
  const linhas = saida.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const achar = (re) => { for (let i = linhas.length - 1; i >= 0; i--) if (re.test(linhas[i])) return linhas[i]; return null; };
  if (papel === "revisor") {
    if (/REPROVADO/i.test(saida)) return (achar(/REPROVADO/i) || "REPROVADO").slice(0, 160);
    if (/\bAPROVADO\b/i.test(saida)) return "APROVADO";
    return "sem veredito";
  }
  if (papel === "qa") return (achar(/^QA:/i) || "terminou").slice(0, 160);
  if (papel === "eng") return (achar(/^ENTREGA:/i) || "entregou").slice(0, 160);
  if (papel === "pr") return (achar(/^PR:/i) || achar(/https?:\/\/\S+/) || "PR criado").slice(0, 160);
  return "terminou";
}

/**
 * Aciona um agente: roda o claude headless como PROCESSO FILHO do maestro, gravando a
 * saída num LOG. O painel do agente NÃO roda o claude — ele roda a TUI de status o tempo
 * todo (obra-agente.mjs), lendo `.herdr-obra-status.json` e fazendo tail deste log: mostra
 * o que o agente está fazendo (check/test) e, no fim, se passou. Serial, sem conflito.
 *
 * O modelo e o esforço vêm da RECEITA do papel, não de um padrão único (ver acima).
 */
function rodarAgente({ papel, prompt, role }, W) {
  const rc = receita(papel);
  const logfile = join(TMP, `log-${papel}-${++seq}.txt`);
  // Os arquivos de trabalho ficam no TMP, FORA da cópia — se ficassem em W, o `git add -A`
  // do passo PR os engoliria e o PR sairia sujo (foi o que aconteceu no PR #1 do TMS).
  const fp = join(TMP, `prompt-${papel}-${seq}.txt`);
  const fr = join(TMP, `role-${papel}-${seq}.txt`);
  writeFileSync(fp, prompt);
  writeFileSync(fr, role);
  escreverStatus(papel, {
    step: "trabalhando", startedAt: new Date().toISOString(), finishedAt: null,
    log: logfile, result: null, modelo: rc.modelo, effort: rc.effort, custo: null, turnos: null,
  });
  const f = join(TMP, `run-${papel}-${seq}.sh`);
  writeFileSync(f,
    `#!/usr/bin/env bash\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"\n` +
    `cd ${q(W)} || exit 1\n` +
    `claude -p "$(cat ${q(fp)})" ` +
    `--append-system-prompt "$(cat ${q(fr)})" ` +
    `--model ${q(rc.modelo)} --effort ${q(rc.effort)} ` +
    `--allowedTools ${q(rc.tools)} --permission-mode acceptEdits ` +
    // ⚠️ `< /dev/null`: sem isso o claude fica 3s esperando stdin e ainda grava um aviso
    // no log, que apareceria como "atividade" do agente no painel.
    `--output-format stream-json --verbose < /dev/null > ${q(logfile)} 2>&1\n`);
  try { execFileSync("bash", [f], { encoding: "utf8", maxBuffer: 64e6, timeout: TIMEOUT }); }
  catch { /* claude pode sair !=0; o log tem o conteúdo mesmo assim */ }
  const r = lerResultado(logfile);
  gasto.push({ papel, modelo: rc.modelo, custo: r.custo, turnos: r.turnos });
  escreverStatus(papel, {
    step: "terminou", finishedAt: new Date().toISOString(),
    result: resumirResultado(papel, r.texto), custo: r.custo, turnos: r.turnos,
  });
  narra(`   ${papel}: ${rc.modelo}/${rc.effort} · ${r.turnos} turno(s) · US$ ${r.custo.toFixed(2)}`);
  return r.texto;
}

// ---------- cópia isolada (git worktree) ----------
const slug = tarefa.toLowerCase().normalize("NFD").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) || "tarefa";

/**
 * A missão sai SEMPRE da branch de integração do repo (a default: main/master), NUNCA da
 * branch em que você está sentado.
 *
 * ⚠️ Foi o bug do PR #14: eu estava na branch `obra/cockpit` (trabalho ainda não mesclado),
 * a cópia herdou meus commits e o PR veio com 5 arquivos a mais além da entrega. Cada missão
 * é um PR independente contra a main — então a base é a main, e assim o PR sai limpo não
 * importa em que branch local você esteja.
 */
const ramoBase = (() => {
  try { return sh("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "origin/HEAD"]).trim().replace(/^origin\//, ""); }
  catch {}
  for (const c of ["main", "master"]) {
    try { sh("git", ["-C", REPO, "rev-parse", "--verify", `origin/${c}`]); return c; } catch {}
  }
  return sh("git", ["-C", REPO, "rev-parse", "--abbrev-ref", "HEAD"]).trim(); // repo local sem remoto
})();
// A verdade é o remoto: busca antes, pra não sair de um main velho e chegar em conflito.
try { sh("git", ["-C", REPO, "fetch", "origin", ramoBase, "--quiet"]); } catch { /* repo local sem remoto */ }
const baseDaCopia = (() => {
  try { sh("git", ["-C", REPO, "rev-parse", "--verify", `origin/${ramoBase}`]); return `origin/${ramoBase}`; }
  catch { return ramoBase; }
})();
const ramo = `obra/${slug}-${NONCE}`;
const W = join(homedir(), ".qf-obra", `${slug}-${NONCE}`);

// Registra a tarefa no QUADRO (o painel BOSS lê daqui) e move ela pela trilha conforme
// os agentes trabalham — senão a obra roda nos painéis mas o quadro fica vazio.
let tRef = null;
try { tRef = criarTarefa({ titulo: tarefa.split(/\.\s/)[0].slice(0, 120), projeto: NOME_REPO }); } catch {}
const mover = (estado) => { if (tRef) { try { moverTarefa(tRef.id, estado); } catch {} } };

// Zera o status dos agentes: este run começa do "aguardando" em todos os painéis.
writeFileSync(STATUS, JSON.stringify({ task: tituloCurto, runId: NONCE, agents: {} }, null, 2));

narra(`▶ Tarefa: ${tarefa}`, "36");
narra(`   cópia: ${ramo} (base ${ramoBase})`, "36");
sh("git", ["-C", REPO, "worktree", "add", W, "-b", ramo, baseDaCopia]);
// node_modules só para os agentes conseguirem buildar/testar; é REMOVIDO antes do passo PR
// (senão o symlink entra no `git add -A` e suja a entrega — visto no PR #1 do TMS).
const nmLink = join(W, "node_modules");
const criouNm = !existsSync(nmLink);
if (criouNm) { try { symlinkSync(join(REPO, "node_modules"), nmLink); } catch {} }

const CTX =
  `Você está numa CÓPIA ISOLADA do repositório ${NOME_REPO} (git worktree em ${W}).\n` +
  `LEIA o CLAUDE.md na raiz antes de agir — são as regras da casa (obrigatórias).\n` +
  `NÃO faça commit nem push (quem fecha é o passo PR). Trabalhe só nesta cópia.`;

let rodada = 0, aprovado = false, motivo = "";
while (rodada < 2 && !aprovado) {
  rodada++;
  narra(`\n═══ RODADA ${rodada} ═══`, "36");

  narra("→ Engenheiro: implementando...", "33");
  mover("implementando");
  rodarAgente({
    pane: SALA.eng, papel: "eng",
    role: `Você é um ENGENHEIRO de software sênior. ${CTX}`,
    prompt:
      `TAREFA: ${tarefa}\n\n` +
      (rodada > 1 ? `⚠️ O REVISOR reprovou antes por: ${motivo}\nCorrija exatamente isso.\n\n` : "") +
      `Implemente com qualidade seguindo o CLAUDE.md. Se mexer em TypeScript, rode "npm run check". ` +
      `No FIM escreva um resumo começando com "ENTREGA:".`,
  }, W);
  narra("✓ Engenheiro entregou.", "32");

  narra("→ QA: tentando quebrar...", "33");
  mover("teste");
  rodarAgente({
    pane: SALA.qa, papel: "qa",
    role: `Você é um QA rigoroso. NÃO edite código. ${CTX}`,
    prompt:
      `O engenheiro implementou: ${tarefa}\n` +
      `Veja o git diff, tente QUEBRAR (rode "npm run check"/"npm test" se fizer sentido), procure erro/borda/regressão. ` +
      `Relate começando com "QA:". Se sólido, "QA: sem problemas".`,
  }, W);
  narra("✓ QA terminou.", "32");

  narra("→ Revisor: procurando defeito...", "33");
  mover("revisao");
  const rev = rodarAgente({
    pane: SALA.revisor, papel: "revisor",
    role: `Você é um REVISOR de código sênior e cético. NÃO edite código. ${CTX}`,
    prompt:
      `Revise a implementação de: ${tarefa}\n` +
      `Confira o git diff contra o CLAUDE.md e a qualidade. Na ÚLTIMA linha escreva EXATAMENTE ` +
      `"APROVADO" se está pronto, ou "REPROVADO: <motivo curto>".`,
  }, W);
  const m = rev.match(/REPROVADO:?\s*(.+)/i);
  aprovado = /\bAPROVADO\b/i.test(rev) && !m;
  motivo = m ? m[1].trim().slice(0, 300) : "";
  narra(aprovado ? "✓ Revisor APROVOU." : `✗ Revisor REPROVOU: ${motivo}`, aprovado ? "32" : "31");
}

if (aprovado) {
  // Tira o symlink node_modules ANTES do PR: o build/teste já rodou, e sem ele o `git add -A`
  // não tem como commitar o symlink. (Os arquivos de trabalho já vivem no TMP, fora da cópia.)
  if (criouNm) { try { unlinkSync(nmLink); } catch {} }
  narra("→ PR: montando o Pull Request...", "33");
  rodarAgente({
    pane: SALA.pr, papel: "pr",
    role: `Você fecha a entrega em um Pull Request. Está na cópia isolada ${W}. AGORA sim pode comitar e dar push.`,
    prompt:
      `A entrega "${tarefa}" foi aprovada. Rode nesta cópia:\n` +
      `1) git add -A\n2) git commit -m "feat: ${tarefa.slice(0, 60)}"\n3) git push -u origin ${ramo}\n` +
      `4) gh pr create --base ${ramoBase} --head ${ramo} --title "${tarefa.slice(0, 70)}" --body "Entrega da obra (eng→QA→revisor aprovou)."\n` +
      `Mostre a URL do PR e termine com "PR: <url>".`,
  }, W);
  mover("pronto");
  narra("\n🚀 PRONTO — PR criado. Veja o painel PR e mescle quando quiser.", "32");
} else {
  narra("\n⛔ 2 rodadas sem aprovação. Parei sem PR — veja os painéis.", "31");
}
/**
 * O que a obra custou — o número que faltava para decidir QUANDO vale acionar o time.
 * Enquanto o preço não aparecia, "chamar a obra" parecia de graça; é assim que uma
 * madrugada de agente vira surpresa na fatura.
 */
const total = gasto.reduce((a, g) => a + g.custo, 0);
try {
  const s = JSON.parse(readFileSync(STATUS, "utf8"));
  s.custoTotal = total;
  s.gasto = gasto;
  // marca de encerramento: é como o cockpit sabe que a missão acabou (ele não recebe o
  // "exit" de uma missão lançada por fora — lê isto do arquivo).
  s.encerrada = true;
  s.fim = new Date().toISOString();
  s.veredito = aprovado ? "aprovado" : "reprovado";
  writeFileSync(STATUS, JSON.stringify(s, null, 2));
} catch { /* status é conveniência; o total já foi para o log */ }
narra(
  `\n💸 custo da obra: US$ ${total.toFixed(2)}  ·  ` +
    gasto.map((g) => `${g.papel} ${g.modelo} $${g.custo.toFixed(2)}`).join("  ·  "),
);
console.log("OBRA_FLUXO_FIM aprovado=" + aprovado + " ramo=" + ramo + " worktree=" + W + " custo=" + total.toFixed(4));
