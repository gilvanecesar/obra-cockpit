/**
 * ARMAZÉM DE TAREFAS DA OBRA — o que o herdr não sabe.
 *
 * O painel pergunta ao herdr quem são os agentes e em que estado estão, e é assim que
 * tem que continuar: estado de agente inventado aqui divergiria do real na primeira
 * falha. TAREFA é outra coisa — ela existe ANTES de alguém pegar e continua depois de
 * terminar, então não há a quem perguntar: tem que ser guardada.
 *
 * Mora no mesmo `.herdr-obra.json` (fora do git) que já guarda os agentes, porque são a
 * mesma obra: a tarefa aponta para quem está nela, o agente aponta para a tarefa.
 *
 * Módulo separado de propósito: `obra.mjs` executa o dispatcher da linha de comando ao
 * ser importado, então o painel não pode importar dele — as regras da tarefa ficam aqui,
 * em um lugar só, e os dois leem daqui.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";

export const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// OBRA_REGISTRO existe para o teste escrever num arquivo descartável: sem isso, rodar a
// bateria mexeria no quadro de verdade — apagar a obra do dono para provar um `if` não.
export const REGISTRO = process.env.OBRA_REGISTRO || resolve(RAIZ, ".herdr-obra.json");

/** As colunas do quadro. A ordem aqui É a ordem na tela. */
export const COLUNAS = [
  { estado: "fila", titulo: "Fila" },
  { estado: "implementando", titulo: "Implementando" },
  { estado: "teste", titulo: "Em teste" },
  { estado: "revisao", titulo: "Em revisão" },
  { estado: "pronto", titulo: "Pronto pra entrar" },
];
export const ESTADOS = COLUNAS.map((c) => c.estado);

/**
 * A trilha que toda tarefa percorre. Não é sprint nem prioridade — é o caminho que já
 * existe na obra (engenheiro → QA → revisor → entra na main), escrito para ficar visível
 * onde a tarefa parou.
 */
export const TRILHA = [
  { chave: "implementar", estado: "implementando" },
  { chave: "testar", estado: "teste" },
  { chave: "revisar", estado: "revisao" },
  { chave: "mesclar", estado: "pronto" },
];

/** Abrir um agente numa tarefa move a tarefa sozinho — o papel diz para qual coluna. */
export const ESTADO_POR_PAPEL = { engenheiro: "implementando", testador: "teste", revisor: "revisao" };

// Limites de entrada: o painel virou porta de escrita (POST), e porta de escrita sem
// limite é como texto de 100.000 caracteres entra no banco — a lição já está no CLAUDE.md.
export const LIMITE_TITULO = 140;
export const LIMITE_PROJETO = 60;

const cortar = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * O projeto de uma tarefa criada sem dizer qual.
 *
 * ⚠️ Não é o nome da pasta: a obra também roda de dentro de uma CÓPIA de trabalho, e aí
 * a pasta se chama "worktree-quiet-forest-a55d" — a tarefa nasceria com um projeto que
 * não existe e ninguém reconheceria no quadro. `--git-common-dir` aponta para o `.git`
 * do repositório de origem, que é o mesmo para todas as cópias.
 */
let padraoEmCache;
export function projetoPadrao() {
  if (padraoEmCache) return padraoEmCache;
  try {
    const comum = execFileSync("git", ["-C", RAIZ, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    padraoEmCache = basename(dirname(comum));
  } catch {
    padraoEmCache = basename(RAIZ);
  }
  return padraoEmCache;
}

export const lerRegistro = () => {
  const r = existsSync(REGISTRO) ? JSON.parse(readFileSync(REGISTRO, "utf8")) : {};
  return { agentes: r.agentes || {}, tarefas: Array.isArray(r.tarefas) ? r.tarefas : [] };
};
export const salvarRegistro = (r) => writeFileSync(REGISTRO, JSON.stringify(r, null, 2));

export const listarTarefas = () => lerRegistro().tarefas;
export const buscarTarefa = (id) => listarTarefas().find((t) => t.id === String(id || "").toUpperCase());

/** T-1, T-2… — id curto porque ele é dito em voz alta ("o T-3 está travado"). */
function proximoId(tarefas) {
  const n = tarefas.reduce((max, t) => Math.max(max, Number(String(t.id).replace(/\D/g, "")) || 0), 0);
  return `T-${n + 1}`;
}

export function criarTarefa({ titulo, projeto } = {}) {
  const t = cortar(titulo, LIMITE_TITULO);
  if (!t) throw new Error("a tarefa precisa de um título");
  const reg = lerRegistro();
  const agora = new Date().toISOString();
  const tarefa = {
    id: proximoId(reg.tarefas),
    titulo: t,
    projeto: cortar(projeto, LIMITE_PROJETO) || projetoPadrao(),
    estado: "fila",
    agente: null,
    historico: [{ etapa: "fila", agente: null, em: agora }],
    criado_em: agora,
  };
  reg.tarefas.push(tarefa);
  salvarRegistro(reg);
  return tarefa;
}

/**
 * Move a tarefa de coluna. `agente` é quem está nela agora (null = ninguém).
 *
 * O histórico só ganha linha quando algo MUDA de verdade — repetir o mesmo estado com o
 * mesmo agente a cada passada encheria a trilha de ruído e esconderia o que aconteceu.
 */
export function moverTarefa(id, estado, agente = null) {
  if (!ESTADOS.includes(estado)) throw new Error(`estado inválido: ${estado} (use ${ESTADOS.join(", ")})`);
  const reg = lerRegistro();
  const tarefa = reg.tarefas.find((t) => t.id === String(id || "").toUpperCase());
  if (!tarefa) throw new Error(`não existe a tarefa ${id}`);
  const mudou = tarefa.estado !== estado || (tarefa.agente || null) !== (agente || null);
  tarefa.estado = estado;
  tarefa.agente = agente || null;
  if (mudou) {
    tarefa.historico = tarefa.historico || [];
    tarefa.historico.push({ etapa: estado, agente: agente || null, em: new Date().toISOString() });
  }
  salvarRegistro(reg);
  return tarefa;
}

/**
 * O agente saiu da obra (painel fechado). A tarefa NÃO volta para a fila: ela continua
 * na etapa onde parou — só fica sem ninguém. Voltar sozinho apagaria trabalho feito.
 */
export function soltarAgente(nome) {
  const reg = lerRegistro();
  let mexeu = false;
  for (const t of reg.tarefas) {
    if (t.agente === nome) {
      t.agente = null;
      mexeu = true;
    }
  }
  if (mexeu) salvarRegistro(reg);
}

/** Onde a tarefa está na trilha: -1 = ainda na fila. */
export const passoDaTrilha = (estado) => TRILHA.findIndex((e) => e.estado === estado);
