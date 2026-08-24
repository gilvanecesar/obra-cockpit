#!/usr/bin/env node
/**
 * AGENDA — tarefas do Claude agendadas no saturno (via cron). O "eu" usa isto pra agendar
 * tarefas diárias: "roda X todo dia às 8h" → `agenda add <nome> "0 8 * * *" "<prompt>" [projeto]`.
 * Cada tarefa roda `claude -p "<prompt>"` na pasta do projeto (tem memória + portfólio), e a
 * saída vai pro log em ~/.obra-agenda/<nome>.log. Gerencia SÓ as próprias linhas do crontab
 * (marcadas com "# OBRA-AGENDA:<nome>") — não toca no resto.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const SELF = fileURLToPath(import.meta.url);
const RAIZ = resolve(dirname(SELF), "..");
const DB = resolve(RAIZ, ".herdr-obra-agenda.json");
const HOME = process.env.HOME || "/home/saturno";
const LOGDIR = resolve(HOME, ".obra-agenda");
const PROJ_BASE = resolve(HOME, "Documents/DEV");
const CLAUDE = "/usr/bin/claude";
const NODE = process.execPath;
const TAG = "OBRA-AGENDA";

const ler = () => { try { return JSON.parse(readFileSync(DB, "utf8")); } catch { return []; } };
const salvar = (a) => writeFileSync(DB, JSON.stringify(a, null, 2));
const agora = () => new Date().toISOString();

function crontabAtual() { try { return execSync("crontab -l 2>/dev/null").toString(); } catch { return ""; } }
function regenCrontab() {
  const base = crontabAtual().split("\n").filter((l) => !l.includes("# " + TAG + ":")).join("\n").replace(/\n+$/, "");
  const linhas = ler().filter((t) => t.ativo !== false).map((t) =>
    `${t.cron} ${NODE} ${SELF} run ${t.nome} >> ${LOGDIR}/${t.nome}.log 2>&1 # ${TAG}:${t.nome}`);
  const txt = [base, ...linhas].filter(Boolean).join("\n") + "\n";
  const p = spawnSync("crontab", ["-"], { input: txt });
  if (p.status !== 0) throw new Error("crontab -: " + (p.stderr || ""));
}

if (!existsSync(LOGDIR)) mkdirSync(LOGDIR, { recursive: true });
const [, , cmd, ...args] = process.argv;

if (cmd === "add") {
  const [nome, cron, prompt, projeto] = args;
  if (!nome || !cron || !prompt) { console.error('uso: agenda add <nome> "<cron>" "<prompt>" [projeto]'); process.exit(1); }
  const proj = projeto || "querofretes-ofc";
  if (!existsSync(resolve(PROJ_BASE, proj))) { console.error("projeto não existe: " + proj); process.exit(1); }
  const lista = ler().filter((t) => t.nome !== nome);
  lista.push({ nome, cron, prompt, projeto: proj, criado: agora(), ativo: true, lastRun: null, lastOk: null });
  salvar(lista); regenCrontab();
  console.log(`✓ agendado "${nome}" · ${cron} · ${proj}\n  ${prompt}`);
}
else if (cmd === "list") {
  const lista = ler();
  if (!lista.length) console.log("(nenhuma tarefa agendada)");
  else for (const t of lista) console.log(
    `${t.ativo === false ? "[off] " : ""}${t.nome}  ·  ${t.cron}  →  ${t.projeto}  |  último: ${t.lastRun || "nunca"}${t.lastOk === false ? " (falhou)" : ""}\n    ${String(t.prompt).slice(0, 90)}`);
}
else if (cmd === "rm") {
  const [nome] = args;
  salvar(ler().filter((t) => t.nome !== nome)); regenCrontab();
  console.log("✓ removido: " + nome);
}
else if (cmd === "run") {
  const [nome] = args;
  const t = ler().find((x) => x.nome === nome);
  if (!t) { console.error("não encontrada: " + nome); process.exit(1); }
  console.log(`\n===== ${nome} @ ${agora()} =====`);
  const p = spawnSync(CLAUDE, ["-p", t.prompt], { cwd: resolve(PROJ_BASE, t.projeto), encoding: "utf8", timeout: 20 * 60 * 1000, env: process.env });
  console.log((p.stdout || "") + (p.stderr || ""));
  const l = ler(); const tt = l.find((x) => x.nome === nome);
  if (tt) { tt.lastRun = agora(); tt.lastOk = p.status === 0; salvar(l); }
}
else {
  console.log("AGENDA — tarefas do Claude no saturno (cron)\n" +
    '  add <nome> "<cron>" "<prompt>" [projeto]   agenda (cron ex.: "0 8 * * *" = todo dia 8h)\n' +
    "  list                                        lista as tarefas\n" +
    "  rm <nome>                                   remove\n" +
    "  run <nome>                                  roda agora (teste)");
}
