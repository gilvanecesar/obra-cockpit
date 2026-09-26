import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=mkdtempSync(join(tmpdir(),'cockpit-functional-'));
const repo=join(root,'cockpit');mkdirSync(join(repo,'scripts'),{recursive:true});
for(const p of ['TMS','querofretes-ofc','agb-projetos'])mkdirSync(join(root,p));
for(const name of ['obra-projetos','obra-tarefas'])copyFileSync(new URL(`../scripts/${name}.mjs`,import.meta.url),join(repo,'scripts',`${name}.mjs`));
const projects=await import(pathToFileURL(join(repo,'scripts/obra-projetos.mjs')));
const tasks=await import(pathToFileURL(join(repo,'scripts/obra-tarefas.mjs')));
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
test('project guard: fiscal request selects TMS',()=>assert.equal(projects.conflitoDeProjeto('Corrigir emissão de CT-e','querofretes-ofc')?.sugerido,'TMS'));
test('project guard: generic character validation must not block chosen project',()=>assert.equal(projects.conflitoDeProjeto('Validar caracteres do campo nome','querofretes-ofc'),null));
test('project guard: solar terminology remains recognized',()=>assert.equal(projects.conflitoDeProjeto('Dimensionar sistema fotovoltaico','querofretes-ofc')?.sugerido,'agb-projetos'));
test('project URL: set, read, reject unsafe scheme and clear',()=>{
 projects.definirUrlProjeto('TMS','https://example.com/tms');assert.equal(projects.acharProjeto('TMS').url,'https://example.com/tms');
 assert.throws(()=>projects.definirUrlProjeto('TMS','javascript:alert(1)'));
 assert.equal(projects.acharProjeto('TMS').url,'https://example.com/tms');
 projects.definirUrlProjeto('TMS','');assert.equal(projects.acharProjeto('TMS').url,undefined);
});
test('task lifecycle: persist, deduplicate history, reject invalid state and release owner',()=>{
 const t=tasks.criarTarefa({titulo:'Validar cadastro',projeto:'TMS'});assert.equal(t.estado,'fila');
 tasks.moverTarefa(t.id,'teste','qa');tasks.moverTarefa(t.id,'teste','qa');
 assert.equal(tasks.buscarTarefa(t.id).historico.length,2);
 assert.throws(()=>tasks.moverTarefa(t.id,'invalid','qa'));
 tasks.soltarAgente('qa');const result=tasks.buscarTarefa(t.id);assert.equal(result.estado,'teste');assert.equal(result.agente,null);
});
