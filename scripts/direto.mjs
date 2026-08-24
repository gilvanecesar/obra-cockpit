#!/usr/bin/env node
/**
 * DIRETO — o "eu" registra aqui o trabalho que faz na MÃO (não via crew), pra também
 * aparecer no cockpit como card "Boss (direto)". Fala com o cockpit local (localhost:4477).
 *
 *   direto começar "<título>" [projeto]     → cria o card; imprime o ID (guarde-o)
 *   direto atividade <id> "<o que faço agora>"
 *   direto terminar <id> ["<resultado curto>"]
 *
 * Sem cockpit no ar, os comandos apenas avisam e saem 0 (nunca travam o trabalho).
 */
const BASE = process.env.COCKPIT_URL || "http://127.0.0.1:4477";
const [, , cmd, ...a] = process.argv;

async function post(body) {
  try {
    const r = await fetch(BASE + "/direto", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return await r.json();
  } catch { console.error("(cockpit off — card não registrado)"); process.exit(0); }
}

if (cmd === "começar" || cmd === "comecar") {
  const [titulo, projeto] = a;
  if (!titulo) { console.error('uso: direto começar "<título>" [projeto]'); process.exit(1); }
  const d = await post({ titulo, projeto: projeto || null });
  console.log(d.id || "(sem id)");
} else if (cmd === "atividade") {
  const [id, texto] = a;
  if (!id || !texto) { console.error('uso: direto atividade <id> "<texto>"'); process.exit(1); }
  await post({ id, atividade: texto }); console.log("ok");
} else if (cmd === "terminar") {
  const [id, resultado] = a;
  if (!id) { console.error('uso: direto terminar <id> ["<resultado>"]'); process.exit(1); }
  await post({ id, status: "terminou", resultado: resultado || "feito" }); console.log("ok");
} else {
  console.log("DIRETO — registra trabalho direto do Boss no cockpit\n" +
    '  começar "<título>" [projeto]   cria o card (imprime o id)\n' +
    '  atividade <id> "<texto>"       atualiza o que está fazendo\n' +
    '  terminar <id> ["<resultado>"]  fecha o card');
}
