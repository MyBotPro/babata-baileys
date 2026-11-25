import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { FPS, AUDIO_SAMPLES, prepareMedia } from './media.mjs';
export { prepareMedia };

export function phone(value) {
  const raw = String(value ?? '').trim();
  const match = /^(?:\+)?([1-9]\d{7,14})(?::\d+)?(?:@s\.whatsapp\.net)?$/.exec(raw);
  return match ? match[1] : null;
}
const controllers = new WeakMap();
export function vcFor(socket, options = {}) {
  if (!controllers.has(socket)) controllers.set(socket,new VCController(socket,options));
  return controllers.get(socket);
}

export class VCController {
  constructor(socket, { load = () => import('nexcaller'), loadBaileys = () => import('../index.js') } = {}) {
    this.socket = socket; this.load = load; this.loadBaileys = loadBaileys;
    this.phase = 'idle'; this.loop = false; this.auto = null; this.media = null; this.closed = false;
  }
  async init() {
    if (this.closed) throw new Error('Socket sudah ditutup');
    if (this.client) return;
    if (this.initPending) return this.initPending;
    this.initPending = (async () => {
      const missing = ['ev','user','ws','sendNode','query','getUSyncDevices','assertSessions','createParticipantNodes','authState','signalRepository'].filter(k=>!this.socket[k]);
      if (missing.length) throw new Error('Socket Baileys belum kompatibel: '+missing.join(', '));
      const [lib, baileys] = await Promise.all([this.load(),this.loadBaileys()]);
      if (typeof lib.Client !== 'function' || typeof lib.WithBaileys !== 'function' || typeof lib.SourceFunc !== 'function') throw new Error('API engine VC tidak kompatibel');
      if (this.closed) throw new Error('Socket ditutup');
      const client = new lib.Client(this.socket,lib.WithBaileys(baileys));
      client.onIncomingCall(call => { void this.incoming(call).catch(e=>this.fail(e)); });
      await client.connect();
      this.lib = lib; this.client = client;
    })();
    try { await this.initPending; } finally { this.initPending = null; }
  }
  fail(error) { this.lastError = String(error?.message || error).slice(0,250); this.phase = 'error'; console.warn('[VC]',this.lastError); }
  async setMedia(buffer) {
    if (this.call || this.starting || this.encoding) throw new Error('VC sedang aktif atau video sedang diproses');
    this.encoding = true;
    try { this.media = await prepareMedia(buffer); return this.media.duration; }
    finally { this.encoding = false; }
  }
  allowedIncoming(from, video = false) { return Boolean(!this.closed && this.client && this.auto && video && !this.socket.vcAutoBlocked?.() && phone(from) === this.auto && this.media && !this.call && !this.starting && !this.encoding); }
  async setAuto(number) {
    if (number === null) { this.auto = null; return; }
    if (!phone(number)) throw new Error('Nomor tidak valid');
    if (!this.media) throw new Error('Atur video dengan .setvc terlebih dahulu');
    await this.init(); this.auto = phone(number);
  }
  async dial(number) {
    if (!phone(number)) throw new Error('Gunakan nomor internasional, misalnya 628xxx');
    if (!this.media) throw new Error('Atur video dengan .setvc terlebih dahulu');
    if (this.call || this.starting || this.encoding) throw new Error('VC lain sedang berjalan');
    this.starting = true;
    try {
      await this.init(); this.phase='requesting';
      const call = await this.client.call({}, '+'+phone(number), {video:true});
      if (this.closed) { await this.endCall(call); throw new Error('Socket terputus'); }
      this.bind(call);
    } catch(e) { this.fail(e); throw e; }
    finally { this.starting = false; }
  }
  async incoming(call) {
    if (!this.allowedIncoming(call.peer(),call.isVideo())) return;
    this.bind(call);
    try { await call.answer({video:true}); }
    catch(e) { await this.stop().catch(()=>{}); throw e; }
  }
  bind(call) {
    this.call=call; this.phase='signaling'; this.lastError=null;
    const abort = new AbortController(); this.abort=abort;
    call.onStateChange?.(phase => { if(this.call===call && this.phase!=='streaming') this.phase=String(phase); });
    call.onEnd(reason => { if(this.call===call) { abort.abort(); clearTimeout(this.watchdog); this.call=null; this.phase='ended'; this.lastEnd=String(reason??''); } });
    this.watchdog=setTimeout(()=>{ if(this.call===call && this.phase!=='streaming') { this.fail(new Error('Media belum siap dalam 45 detik')); void this.stop().catch(e=>this.fail(e)); } },45000);
    this.watchdog.unref?.();
    let started=false;
    call.onReady(() => {
      if(started || this.call!==call) return;
      started=true; clearTimeout(this.watchdog); this.phase='streaming';
      void this.stream(call,abort.signal).catch(async e=>{ if(!abort.signal.aborted) { this.fail(e); await this.stop().catch(()=>{}); } });
    });
  }
  async stream(call,signal) {
    const media=this.media; let audioIndex=0;
    if (typeof call.sendVideo !== 'function' || typeof call.play !== 'function') throw new Error('Engine tidak memiliki API media');
    call.play(this.lib.SourceFunc(async()=>{
      if(signal.aborted) return null;
      if(audioIndex>=media.samples.length) { if(this.loop) audioIndex=0; else return null; }
      const frame=media.samples.slice(audioIndex,audioIndex+AUDIO_SAMPLES); audioIndex+=AUDIO_SAMPLES; return frame;
    }));
    const start=performance.now(); let n=0;
    do {
      for(const unit of media.units) {
        if(signal.aborted) return;
        const wait = start+n*1000/FPS-performance.now();
        if(wait>0) await delay(wait,undefined,{signal});
        await call.sendVideo(unit,{timestamp:(n*90000/FPS)>>>0});
        n++;
      }
    } while(this.loop && !signal.aborted);
    if(!signal.aborted) { await delay(1000/FPS,undefined,{signal}); await this.stop(); }
  }
  async endCall(call) {
    for(const method of ['hangup','end','terminate','close']) if(typeof call[method]==='function') { await call[method](); return; }
    throw new Error('API hangup engine belum diketahui; akhiri panggilan dari HP');
  }
  async stop() {
    this.abort?.abort(); clearTimeout(this.watchdog);
    if(this.starting && !this.call) throw new Error('Permintaan panggilan masih diproses');
    if(!this.call) return false;
    const call=this.call;
    try { await this.endCall(call); if(this.call===call) this.call=null; this.phase='stopped'; return true; }
    catch(e) { this.fail(e); throw e; }
  }
  async close() { this.closed=true; this.auto=null; this.abort?.abort(); clearTimeout(this.watchdog); if(this.call) await this.stop().catch(()=>{}); if(typeof this.client?.disconnect==='function') await this.client.disconnect(); }
  status() { return { phase:this.phase, videoSeconds:this.media?.duration??0, loop:this.loop, auto:this.auto, error:this.lastError??null, engine:!!this.client }; }
}
