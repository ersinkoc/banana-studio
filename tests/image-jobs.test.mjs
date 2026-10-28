import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { LocalWorkspace } from '../desktop/server/store.mjs';

// Packages stay external as absolute URLs so the bundle can load from memory.
const compiled = await build({entryPoints:['api/_lib/imageJobRunner.ts'],absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),bundle:true,write:false,format:'esm',platform:'node',
  plugins:[{name:'packages',setup(b){b.onResolve({filter:/^[^./]/},args=>args.path.startsWith('node:')?undefined:{path:import.meta.resolve(args.path),external:true});}}]});
const {runImageJob} = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('a queued image whose reference was removed fails once without dispatch; temporary storage errors stay retryable',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'banana-jobs-')),store=new LocalWorkspace(directory),oldUrl=process.env.SUPABASE_URL,oldEnv=process.env.VERCEL_ENV;
  try{
    store.origin='http://127.0.0.1:12345';process.env.SUPABASE_URL=store.origin;delete process.env.VERCEL_ENV;
    const db=store.client(true),ledger=()=>store.db.prepare('SELECT payload FROM ledger').all().map(r=>JSON.parse(r.payload));
    const enqueue=async(id,key)=>{await store.upload(key,Buffer.from('synthetic'));store.workerRpc('enqueue_image_job',{p_id:id,p_metadata:{},p_payload:{id,model:'gpt-image-2.5-sunburst',provider:'openai',prompt:'p',displayPrompt:'p',aspectRatio:'1:1',resolution:'1K',options:{},referenceImages:[{id:'r1',data:store.mediaUrl(key),mimeType:'image/png'}],privateReferencePaths:[key],folderId:null}});};
    await enqueue('gone','refs/gone.png');fs.rmSync(store.mediaPath('refs/gone.png'));
    let closingCalls=0;
    const ordered={...db,rpc:async(name,args)=>{
      if(name==='finish_image_job'){
        closingCalls++;
        assert.deepEqual(ledger().filter(r=>r.generationId==='gone').map(r=>r.state),['rejected'],'audit must be finalized before the job can become terminal');
      }
      return db.rpc(name,args);
    }};
    await runImageJob(ordered,{id:'gone',userId:store.user.id});await runImageJob(ordered,{id:'gone',userId:store.user.id});
    assert.equal(closingCalls,1);
    assert.equal(store.job('gone').state,'failed');assert.equal(store.job('gone').dispatchedAt,undefined);
    assert.equal(store.get('generations','gone').status,'failed');assert.match(store.get('generations','gone').metadata.error,/reference is unavailable or was removed/);
    assert.deepEqual(ledger().filter(r=>r.generationId==='gone').map(r=>r.state),['rejected']);
    await enqueue('busy','refs/busy.png');
    const flaky={...db,storage:{from:()=>({createSignedUrl:async()=>({data:null,error:{statusCode:503,message:'unavailable'}})})}};
    await assert.rejects(runImageJob(flaky,{id:'busy',userId:store.user.id}),error=>error.name==='MediaAccessError'&&error.temporary===true);
    assert.equal(store.job('busy').state,'preparing');assert.equal(store.get('generations','busy').status,'pending');
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldEnv!==undefined)process.env.VERCEL_ENV=oldEnv;}
});

test('a queued image rejected before dispatch finalizes its audit before the job closes',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'banana-jobs-')),store=new LocalWorkspace(directory),oldUrl=process.env.SUPABASE_URL,oldEnv=process.env.VERCEL_ENV,oldKey=process.env.OPENAI_API_KEY;
  const warn=console.warn;console.warn=()=>{};
  try{
    store.origin='http://127.0.0.1:12345';process.env.SUPABASE_URL=store.origin;delete process.env.VERCEL_ENV;process.env.OPENAI_API_KEY='synthetic';
    const db=store.client(true),ledger=id=>store.db.prepare('SELECT payload FROM ledger').all().map(r=>JSON.parse(r.payload)).filter(r=>r.generationId===id).map(r=>r.state);
    const enqueue=id=>store.workerRpc('enqueue_image_job',{p_id:id,p_metadata:{},p_payload:{id,model:'gpt-image-2.5-sunburst',provider:'openai',prompt:'p',displayPrompt:'p',aspectRatio:'2:1',resolution:'1K',options:{},referenceImages:[],privateReferencePaths:[],folderId:null}});
    enqueue('invalid');
    const ordered={...db,rpc:async(name,args)=>{
      if(name==='finish_image_job')assert.deepEqual(ledger('invalid'),['rejected'],'audit must be finalized before the job can become terminal');
      return db.rpc(name,args);
    }};
    await runImageJob(ordered,{id:'invalid',userId:store.user.id});
    assert.equal(store.job('invalid').state,'failed');
    // While the audit cannot be finalized, the worker reports it and the job stays redeliverable.
    enqueue('interrupted');
    const auditDown={...db,rpc:async(name,args)=>name==='finish_openai_request'?{data:null,error:{message:'connection reset'}}:db.rpc(name,args)};
    await assert.rejects(runImageJob(auditDown,{id:'interrupted',userId:store.user.id}),/finish_openai_request could not be confirmed/);
    assert.equal(store.job('interrupted').state,'preparing');
    assert.deepEqual(ledger('interrupted'),['accepted']);
    // Once audits can be written again, redelivery after the lease ends the job and rejects its new audit.
    const job=store.job('interrupted');job.claimedAt=0;store.job('interrupted',job);
    await runImageJob(db,{id:'interrupted',userId:store.user.id});
    assert.equal(store.job('interrupted').state,'failed');
    assert.equal(ledger('interrupted').at(-1),'rejected');
  }finally{console.warn=warn;store.close();fs.rmSync(directory,{recursive:true,force:true});if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldEnv!==undefined)process.env.VERCEL_ENV=oldEnv;if(oldKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldKey;}
});
