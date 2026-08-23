/**
 * REGISTRO DE PROJETOS — a fonte única de "quais repositórios a obra alcança".
 *
 * Existe para o cockpit e o obra.mjs não divergirem: o MAPA vivia copiado no obra.mjs, e
 * lista duplicada é lista que envelhece torto. Aqui ficam o caminho no disco (para o motor
 * rodar lá) e as PALAVRAS de cada projeto — o vocabulário que a trava usa para dizer "isto
 * não é deste projeto" antes de disparar o time no repositório errado (o estrago que o dono
 * já viu: robô de LinkedIn dentro do marketplace de frete).
 *
 * O caminho é resolvido a partir da pasta-mãe dos repositórios (irmãos de querofretes-ofc).
 */
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// ⚠️ Depois que o cockpit virou repo PRÓPRIO, a raiz (RAIZ) é o obra-cockpit — NÃO um projeto.
// Os projetos são os repos IRMÃOS em ~/Documents/DEV; por isso o QueroFretes agora tem `dir`
// explícito, igual TMS/AGB, e não mais `dir: RAIZ`.
const DEV = dirname(RAIZ); // ~/Documents/DEV — onde os repositórios são irmãos
// Projetos que o dono adiciona pelo cockpit ficam aqui (o built-in é só a semente).
const ARQUIVO = resolve(RAIZ, ".herdr-obra-projetos.json");

// Os 3 de sempre — a semente. Os outros o dono adiciona pelo "+ Novo projeto".
const BUILTIN = [
  {
    slug: "querofretes-ofc",
    nome: "QueroFretes",
    dir: resolve(DEV, "querofretes-ofc"),
    url: "https://querofretes.com.br", // "ver sistema" abre isto no navegador
    palavras: ["frete", "motorista", "embarcador", "agregamento", "rota cheia", "proposta",
      "assinatura", "abacatepay", "sos estrada", "fornecedor", "documento do motorista",
      "cotacao", "cotação", "veiculo", "veículo", "crm", "campanha", "nota fiscal", "nfse"],
  },
  {
    slug: "TMS",
    nome: "TMS",
    dir: resolve(DEV, "TMS"),
    palavras: ["ct-e", "cte", "mdf-e", "mdfe", "manifesto", "sefaz", "tms", "romaneio",
      "emissao fiscal", "emissão fiscal", "dacte"],
  },
  {
    slug: "agb-projetos",
    nome: "AGB",
    dir: resolve(DEV, "agb-projetos"),
    palavras: ["agb", "solar", "energia", "fotovoltaic", "painel solar", "usina"],
  },
];

const lerAdicionados = () => { try { return JSON.parse(readFileSync(ARQUIVO, "utf8")); } catch { return []; } };

/** A lista COMPLETA: os built-in + os adicionados pelo dono. Adicionado ganha do built-in por slug. */
function todosProjetos() {
  const mapa = new Map(BUILTIN.map((p) => [p.slug, p]));
  for (const p of lerAdicionados()) if (p && p.slug && p.dir) mapa.set(p.slug, p);
  return [...mapa.values()];
}

// mantido por compatibilidade (o cockpit e a trava usam as funções abaixo)
export const PROJETOS = todosProjetos();

/** Só os projetos cujo diretório existe de fato no disco (o cockpit não oferece o que sumiu). */
export const projetosDisponiveis = () => todosProjetos().filter((p) => existsSync(p.dir));

export const acharProjeto = (slug) => todosProjetos().find((p) => p.slug === slug) || null;

const semAcento = (s) =>
  String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** slug de pasta: minúsculo, sem acento, só letra/número/hífen. */
export const slugificar = (s) =>
  semAcento(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "projeto";

/**
 * Registra um projeto (repo existente OU recém-criado). O `dir` já tem que existir no disco —
 * quem CRIA a pasta é o cockpit (git init + scaffold); aqui só entra no registro.
 * Palavras vazias viram o próprio slug, para a trava ter ao menos o nome do projeto.
 */
export function adicionarProjeto({ nome, dir, palavras }) {
  if (!dir || !existsSync(dir)) throw new Error("a pasta do projeto não existe");
  const slug = slugificar(nome || basename(dir));
  const lista = lerAdicionados().filter((p) => p.slug !== slug);
  const chaves = (Array.isArray(palavras) ? palavras : String(palavras || "").split(","))
    .map((w) => semAcento(w).trim()).filter(Boolean);
  const proj = { slug, nome: (nome || basename(dir)).trim().slice(0, 40) || slug, dir,
    palavras: chaves.length ? chaves : [slug] };
  lista.push(proj);
  writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
  return proj;
}

/**
 * Pastas de ~/Documents/DEV que SÃO repositório git e ainda NÃO estão no registro — é o que
 * o cockpit oferece quando você escolhe "apontar para um repo existente".
 */
export function reposCandidatos() {
  const registrados = new Set(todosProjetos().map((p) => p.dir));
  let nomes = [];
  try { nomes = readdirSync(DEV, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  return nomes
    .map((n) => resolve(DEV, n))
    .filter((dir) => !registrados.has(dir) && existsSync(resolve(dir, ".git")))
    .map((dir) => ({ dir, nome: basename(dir) }));
}

/**
 * Grava a URL do "ver sistema" de um projeto (o site/dev server que o botão abre no navegador).
 * Persiste como override no `.herdr-obra-projetos.json` — vale tanto para built-in (QueroFretes)
 * quanto para projeto adicionado pelo dono. URL vazia LIMPA a que existia.
 */
export function definirUrlProjeto(slug, url) {
  const proj = acharProjeto(slug);
  if (!proj) throw new Error("projeto não encontrado");
  const limpa = String(url || "").trim();
  if (limpa && !/^https?:\/\//i.test(limpa)) throw new Error("a URL tem que começar com http:// ou https://");
  const lista = lerAdicionados().filter((p) => p.slug !== slug);
  lista.push({ slug: proj.slug, nome: proj.nome, dir: proj.dir, palavras: proj.palavras, url: limpa || undefined });
  writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
  return { slug: proj.slug, nome: proj.nome, url: limpa || null };
}

export const RAIZ_DEV = DEV;

/**
 * A TRAVA: dado um objetivo e o projeto ESCOLHIDO, o texto parece pertencer a OUTRO projeto?
 *
 * Regra deliberadamente conservadora — bloquear demais irrita, e o objetivo às vezes é
 * genérico ("adiciona um teste") e não casa com projeto nenhum: nesse caso passa. Só
 * levanta a mão quando o texto casa FORTE com outro projeto e NÃO casa com o escolhido —
 * o cenário do estrago (pedir CT-e dentro do QueroFretes). Devolve `null` quando está tudo
 * bem, ou `{ sugerido, motivo }` quando o texto aponta para outro lugar.
 */
export function conflitoDeProjeto(objetivo, slugEscolhido) {
  const txt = semAcento(objetivo);
  const conta = (p) => p.palavras.reduce((n, w) => n + (txt.includes(semAcento(w)) ? 1 : 0), 0);
  const escolhido = acharProjeto(slugEscolhido);
  if (!escolhido) return null;
  const noEscolhido = conta(escolhido);
  let melhor = null;
  for (const p of projetosDisponiveis()) {
    if (p.slug === slugEscolhido) continue;
    const n = conta(p);
    if (n > 0 && (!melhor || n > melhor.n)) melhor = { p, n };
  }
  // Aponta para outro só se o outro casa e o escolhido não casa em nada.
  if (melhor && noEscolhido === 0) {
    return {
      sugerido: melhor.p.slug,
      sugeridoNome: melhor.p.nome,
      motivo: `o texto fala de "${melhor.p.palavras.find((w) => txt.includes(semAcento(w)))}", que é de ${melhor.p.nome}, não de ${escolhido.nome}`,
    };
  }
  return null;
}
