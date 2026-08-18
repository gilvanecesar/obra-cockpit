#!/usr/bin/env node
/**
 * PAINEL DA OBRA — a visão de cima, no navegador.
 *
 * O herdr mostra os agentes trabalhando painel por painel, mas é só terminal. Este é o
 * quadro: o que precisa ser feito, quem está em quê, há quanto tempo, e o que já passou
 * por teste e revisão. Foi o pedido do dono ("quero ver o que está circulando").
 *
 * Duas fontes, de propósito:
 *  · AGENTE — perguntado ao herdr ao vivo (quem existe, em que estado). Estado inventado
 *    aqui divergiria do real na primeira falha, e painel que mente é pior que nenhum.
 *  · TAREFA — guardada em `.herdr-obra.json` (obra-tarefas.mjs), porque ela existe antes
 *    de alguém pegar e continua depois de terminar: não há a quem perguntar.
 *
 *   node scripts/obra-painel.mjs          → http://localhost:4477
 */
import { createServer } from "http";
import { execFileSync } from "child_process";
import {
  COLUNAS,
  LIMITE_PROJETO,
  LIMITE_TITULO,
  TRILHA,
  criarTarefa,
  lerRegistro,
  passoDaTrilha,
} from "./obra-tarefas.mjs";

const PORTA = Number(process.env.PORTA || 4477);

const MARINHO = "#071119", CIANO = "#35C1EF", VERDE = "#37CF7C", GELO = "#EAF3F8", AMBAR = "#e8b339";

function herdr(...args) {
  try {
    const j = JSON.parse(execFileSync("herdr", args, { encoding: "utf8", maxBuffer: 8e6 }));
    return j.result ?? j;
  } catch {
    return null;
  }
}

function estado() {
  const reg = lerRegistro();
  const vivos = new Map((herdr("agent", "list")?.agents || []).map((a) => [a.pane_id, a]));
  const agentes = Object.entries(reg.agentes).map(([nome, r]) => {
    const a = vivos.get(r.pane);
    return {
      nome,
      papel: r.papel,
      pane: r.pane,
      // "working" = pensando/escrevendo · "idle" = entregou e espera · sem agente = painel fechado
      status: a?.agent_status || "fechado",
      fazendo: a?.terminal_title_stripped || "",
      tarefa: r.tarefa,
      tarefaId: r.tarefaId || null,
      desde: r.aberto_em,
      caminho: r.caminho,
    };
  });
  const papelDe = new Map(agentes.map((a) => [a.nome, a.papel]));
  const tarefas = reg.tarefas.map((t) => {
    const ultima = (t.historico || [])[t.historico?.length - 1];
    return {
      ...t,
      // "há quanto tempo" é o tempo NESTA etapa, não desde que foi criada: numa tarefa
      // parada há 3 dias em revisão, é isso que precisa saltar aos olhos.
      desde: ultima?.em || t.criado_em,
      papelDoAgente: t.agente ? papelDe.get(t.agente) || null : null,
      passo: passoDaTrilha(t.estado),
    };
  });
  return { agentes, tarefas, em: new Date().toISOString() };
}

/**
 * Corpo JSON com teto: porta de escrita sem limite é como entra texto de 100 mil
 * caracteres — a lição já está no CLAUDE.md.
 *
 * Passando do teto, o resto é DESCARTADO mas a leitura continua até o fim, para dar uma
 * resposta em vez de derrubar a conexão calada (quem enviou não saberia o que houve).
 * Cortar de vez só no absurdo, que aí não é engano de digitação.
 */
function lerCorpo(req, limite = 8 * 1024, corte = 1024 * 1024) {
  return new Promise((ok, erro) => {
    let bruto = "";
    let grande = false;
    req.on("data", (p) => {
      if (bruto.length + p.length > limite) {
        grande = true;
        if (bruto.length + p.length > corte) return req.destroy();
        return;
      }
      bruto += p;
    });
    req.on("end", () => {
      if (grande) return erro(new Error(`tarefa grande demais (teto de ${limite} bytes)`));
      try {
        ok(JSON.parse(bruto || "{}"));
      } catch {
        erro(new Error("json inválido"));
      }
    });
    req.on("error", erro);
  });
}

const EMOJI = { engenheiro: "🔧", testador: "🧪", revisor: "🔍" };
const CARGO = { engenheiro: "ENGENHEIRO", testador: "QA", revisor: "REVISOR" };
const COR = { working: CIANO, idle: VERDE, blocked: AMBAR, fechado: "#54708a" };
const ROTULO = { working: "trabalhando", idle: "entregou · aguardando", blocked: "travado", fechado: "painel fechado" };

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Obra · Quero Fretes</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:${MARINHO};color:${GELO};font:14px/1.5 "SF Mono",Menlo,monospace;min-height:100vh;
 background-image:linear-gradient(rgba(53,193,239,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(53,193,239,.05) 1px,transparent 1px);
 background-size:44px 44px}
header{display:flex;align-items:baseline;gap:14px;padding:18px 26px;border-bottom:1px solid #16283c;flex-wrap:wrap}
h1{font-size:16px;letter-spacing:.26em;color:${CIANO};font-weight:700}
h1 b{color:${VERDE}}
.sub{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6d8299}
#atualizado{margin-left:auto;font-size:11px;color:#6d8299}
h2.secao{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6d8299;padding:22px 26px 10px}

/* nova tarefa */
form#nova{display:flex;gap:8px;padding:14px 26px;border-bottom:1px solid #16283c;flex-wrap:wrap}
form#nova input{flex:1 1 240px;min-width:0;background:#0b1420;border:1px solid #16283c;color:${GELO};
 padding:9px 11px;font:13px/1.4 "SF Mono",Menlo,monospace}
form#nova input#projeto{flex:0 1 190px}
form#nova input:focus{outline:none;border-color:${CIANO}}
form#nova button{background:transparent;border:1px solid ${VERDE};color:${VERDE};padding:9px 16px;cursor:pointer;
 font:11px/1.4 "SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}
form#nova button:hover{background:${VERDE};color:${MARINHO}}
#aviso{width:100%;font-size:11px;color:${AMBAR};min-height:0}

/* quadro */
/* colunas de mesma altura: o quadro se lê de relance, e altura irregular vira degrau */
.quadro{display:flex;gap:12px;padding:0 26px 8px;overflow-x:auto;align-items:stretch}
.col{flex:1 1 0;min-width:238px;border:1px solid #16283c;background:#0b1420;padding:12px}
.col>h3{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#6d8299;display:flex;gap:8px;
 padding-bottom:9px;margin-bottom:10px;border-bottom:1px solid #12202f}
.col>h3 i{font-style:normal;color:#54708a;margin-left:auto}
.col.pronto>h3{color:${VERDE}}
.t{border:1px solid #16283c;background:#0e1a28;padding:10px 11px;margin-bottom:9px}
.t.on{border-color:${CIANO}}
.tid{font-size:10px;letter-spacing:.14em;color:${CIANO}}
.tt{font-size:13px;margin:4px 0 8px;color:${GELO}}
.tpe{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#54708a}
.tpe .quem{color:${GELO}}
.trilha{display:flex;gap:4px;margin-bottom:9px}
.et{flex:1;text-align:center;font-size:8px;letter-spacing:.08em;text-transform:uppercase;color:#54708a;
 padding-bottom:4px;border-bottom:2px solid #16283c}
.et.feita{color:${VERDE};border-color:${VERDE}}
.et.aqui{color:${CIANO};border-color:${CIANO}}
.colvazia{font-size:11px;color:#3d566e;padding:6px 0}

/* agentes */
main{padding:0 26px 26px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}
.card{border:1px solid #16283c;background:#0b1420;padding:16px 18px}
.card.on{border-color:${CIANO}}
.topo{display:flex;align-items:center;gap:9px;margin-bottom:10px}
.nome{font-weight:700;font-size:15px}
.cargo{font-size:10px;letter-spacing:.16em;color:#6d8299}
.pill{margin-left:auto;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:3px 9px;border:1px solid}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:6px}
@keyframes pisca{50%{opacity:.25}}
.pisca{animation:pisca 1.1s infinite}
.fazendo{color:${GELO};margin:10px 0 6px;font-size:13px}
.tarefa{color:#8ba4bb;font-size:12px;max-height:76px;overflow:hidden}
.pe{display:flex;gap:14px;margin-top:12px;font-size:11px;color:#54708a;border-top:1px solid #12202f;padding-top:9px}
.vazio{grid-column:1/-1;text-align:center;color:#6d8299;padding:40px 0}
.vazio b{display:block;color:${GELO};font-size:15px;margin-bottom:6px}
@media(max-width:640px){header,form#nova,h2.secao,main{padding-left:14px;padding-right:14px}.quadro{padding-left:14px;padding-right:14px}}
</style></head><body>
<header>
  <h1>OBRA<b>·</b>QF</h1>
  <span class="sub">boss · engenheiros · qa · revisor</span>
  <span id="atualizado"></span>
</header>
<form id="nova" autocomplete="off">
  <input id="titulo" maxlength="${LIMITE_TITULO}" placeholder="Nova tarefa: o que precisa ser feito?">
  <input id="projeto" maxlength="${LIMITE_PROJETO}" placeholder="projeto (opcional)">
  <button type="submit">Pôr na fila</button>
  <div id="aviso"></div>
</form>
<div class="quadro" id="quadro"></div>
<h2 class="secao">Agentes na obra</h2>
<main id="obra"></main>
<script>
const COR=${JSON.stringify(COR)}, ROTULO=${JSON.stringify(ROTULO)}, EMOJI=${JSON.stringify(EMOJI)}, CARGO=${JSON.stringify(CARGO)};
const COLUNAS=${JSON.stringify(COLUNAS)}, TRILHA=${JSON.stringify(TRILHA.map(e=>e.chave))};
const esc=s=>String(s||"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
const desde=iso=>{const m=Math.floor((Date.now()-new Date(iso))/60000);
  return m<1?"agora":m<60?"há "+m+" min":m<1440?"há "+Math.floor(m/60)+"h"+String(m%60).padStart(2,"0"):"há "+Math.floor(m/1440)+"d"};

function trilha(passo){
  return '<div class="trilha">'+TRILHA.map(function(e,i){
    var c=i<passo?" feita":(i===passo?" aqui":"");
    return '<span class="et'+c+'">'+e+'</span>';
  }).join("")+'</div>';
}
function cartao(t){
  var emAndamento=t.estado!=="fila";
  return '<div class="t'+(t.agente?" on":"")+'">'+
    (emAndamento?trilha(t.passo):"")+
    '<div class="tid">'+esc(t.id)+'</div>'+
    '<div class="tt">'+esc(t.titulo)+'</div>'+
    '<div class="tpe"><span>'+esc(t.projeto)+'</span>'+
      (t.agente?'<span class="quem">'+(EMOJI[t.papelDoAgente]||"•")+" "+esc(t.agente)+'</span>':'<span>sem ninguém</span>')+
      '<span>'+desde(t.desde)+'</span></div></div>';
}
function quadro(tarefas){
  document.getElementById("quadro").innerHTML=COLUNAS.map(function(c){
    var lista=tarefas.filter(function(t){return t.estado===c.estado});
    return '<div class="col'+(c.estado==="pronto"?" pronto":"")+'"><h3>'+esc(c.titulo)+'<i>'+lista.length+'</i></h3>'+
      (lista.length?lista.map(cartao).join(""):'<div class="colvazia">—</div>')+'</div>';
  }).join("");
}
async function tick(){
  const d=await (await fetch("/estado")).json();
  document.getElementById("atualizado").textContent="atualizado "+new Date(d.em).toLocaleTimeString("pt-BR");
  quadro(d.tarefas);
  const el=document.getElementById("obra");
  if(!d.agentes.length){el.innerHTML='<div class="vazio"><b>Nenhum agente na obra</b>ponha alguém numa tarefa: node scripts/obra.mjs abrir eng-1 T-1</div>';return}
  el.innerHTML=d.agentes.map(a=>{
    const cor=COR[a.status]||COR.fechado, ativo=a.status==="working";
    return '<div class="card'+(ativo?" on":"")+'">'+
      '<div class="topo"><span>'+(EMOJI[a.papel]||"•")+'</span>'+
        '<div><div class="nome">'+esc(a.nome)+'</div><div class="cargo">'+(CARGO[a.papel]||a.papel)+'</div></div>'+
        '<span class="pill" style="color:'+cor+';border-color:'+cor+'">'+
          '<span class="dot'+(ativo?" pisca":"")+'" style="background:'+cor+'"></span>'+ROTULO[a.status]+'</span></div>'+
      '<div class="fazendo">'+esc(a.fazendo||"—")+'</div>'+
      '<div class="tarefa">'+(a.tarefaId?'<b>'+esc(a.tarefaId)+'</b> · ':'')+esc(a.tarefa)+'</div>'+
      '<div class="pe"><span>'+esc(a.pane)+'</span><span>'+desde(a.desde)+'</span></div></div>';
  }).join("");
}
document.getElementById("nova").addEventListener("submit",async function(ev){
  ev.preventDefault();
  const titulo=document.getElementById("titulo"), projeto=document.getElementById("projeto"), aviso=document.getElementById("aviso");
  aviso.textContent="";
  const r=await fetch("/tarefa",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({titulo:titulo.value,projeto:projeto.value})});
  const j=await r.json().catch(function(){return{}});
  if(!r.ok){aviso.textContent=j.erro||"não deu para criar";return}
  titulo.value="";
  tick();
});
tick(); setInterval(tick,3000);
</script></body></html>`;

createServer(async (req, res) => {
  const responder = (codigo, corpo) => {
    res.writeHead(codigo, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(corpo));
  };

  if (req.method === "POST" && req.url === "/tarefa") {
    try {
      const corpo = await lerCorpo(req);
      return responder(201, criarTarefa({ titulo: corpo.titulo, projeto: corpo.projeto }));
    } catch (e) {
      return responder(/grande demais/.test(e.message) ? 413 : 400, { erro: e.message });
    }
  }
  if (req.url === "/estado") return responder(200, estado());
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGINA);
  // Só no loopback: o painel agora ACEITA escrita, e não tem login nenhum — não pode
  // ficar ouvindo a rede do café por causa de um quadro de tarefas.
}).listen(PORTA, "127.0.0.1", () => console.log(`painel da obra: http://localhost:${PORTA}`));
