import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { phone, VCController, prepareMedia } from '../vc/index.mjs';
test('phone validation',()=>{assert.equal(phone('628123456789@s.whatsapp.net'),'628123456789');assert.equal(phone('628123456789@lid'),null);assert.equal(phone('123@g.us'),null)});
test('real FFmpeg video and audio encoding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vc-test-'));try{
 const p=join(dir,'sample.mp4');execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x240:rate=30','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',p]);
 const media=await prepareMedia(await readFile(p));assert.equal(media.units.length,30);assert.equal(media.duration,1);assert.ok(media.samples.some(x=>Math.abs(x)>0.01));assert.equal(media.samples.length%960,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('no real call without media; fail closed for callers',async()=>{const c=new VCController({});await assert.rejects(c.dial('628123456789'),/setvc/);assert.equal(c.allowedIncoming('628123456789',true),false);await c.close();});
test('mock engine lifecycle and sends exactly one access unit',async()=>{
 let ready,ended,frames=0; const call={onReady:f=>ready=f,onEnd:f=>ended=f,onStateChange:()=>{},play:()=>{},sendVideo:async()=>{frames++},end:async()=>ended('local')};
 class Client {onIncomingCall(){} connect(){} async call(){return call;}}
 const s=Object.fromEntries(['ev','user','ws','sendNode','query','getUSyncDevices','assertSessions','createParticipantNodes','authState','signalRepository'].map(k=>[k,{}]));
 const c=new VCController(s,{load:async()=>({Client,WithBaileys:x=>x,SourceFunc:x=>x}),loadBaileys:async()=>({})});
 c.media={units:[Buffer.from([0,0,1,9])],samples:new Float32Array(960),duration:1/30};await c.dial('628123456789');ready();await new Promise(r=>setTimeout(r,100));assert.equal(frames,1);assert.equal(c.status().phase,'stopped');
});
