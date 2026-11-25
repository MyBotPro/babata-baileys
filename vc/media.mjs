import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FPS = 30;
export const MAX_SECONDS = 60;
export const MAX_BYTES = 32 * 1024 * 1024;
export const AUDIO_SAMPLES = 960;

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore','pipe','pipe'] });
    let err = '', out = '', timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill('SIGKILL'); }, 120000);
    child.stderr.on('data', x => { err = (err + x).slice(-2000); });
    child.stdout.on('data', x => { out = (out + x).slice(-65536); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => {
      clearTimeout(timer);
      code === 0 && !timeout ? resolve(out) : reject(new Error(timeout ? 'FFmpeg timeout' : `${program}: ${err || code}`));
    });
  });
}

// FFmpeg emits one AUD NAL at the beginning of each access unit.
export function splitAccessUnits(data) {
  const offsets = [];
  for (let i = 0; i + 3 < data.length;) {
    const four = data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1;
    const three = data[i] === 0 && data[i+1] === 0 && data[i+2] === 1;
    if (!four && !three) { i++; continue; }
    const len = four ? 4 : 3;
    if ((data[i+len] & 31) === 9) offsets.push(i);
    i += len + 1;
  }
  if (!offsets.length) throw new Error('H.264 tidak memiliki access unit delimiter');
  offsets[0] = 0;
  return offsets.map((start,i) => data.subarray(start, offsets[i+1] ?? data.length));
}

export async function prepareMedia(input) {
  if (!Buffer.isBuffer(input) || !input.length || input.length > MAX_BYTES) throw new Error('Video harus 1 byte–32 MiB');
  const dir = await mkdtemp(join(tmpdir(), 'baileys-vc-'));
  const src = join(dir,'input'), video = join(dir,'video.h264'), audio = join(dir,'audio.pcm');
  try {
    await writeFile(src,input);
    const info = JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',src]));
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_SECONDS + 0.05) throw new Error('Durasi video harus 1–60 detik');
    if (!info.streams?.some(x=>x.codec_type==='video')) throw new Error('File bukan video');
    await run('ffmpeg',['-nostdin','-v','error','-y','-i',src,'-t',String(MAX_SECONDS),'-map','0:v:0','-an','-vf',`fps=${FPS},scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=480:480:(ow-iw)/2:(oh-ih)/2,setsar=1`,'-c:v','libx264','-profile:v','baseline','-pix_fmt','yuv420p','-preset','veryfast','-tune','zerolatency','-threads','2','-b:v','650k','-maxrate','850k','-bufsize','850k','-g','30','-keyint_min','30','-sc_threshold','0','-x264-params','aud=1:repeat-headers=1:bframes=0','-f','h264',video]);
    let pcm = Buffer.alloc(0);
    if (info.streams.some(x=>x.codec_type==='audio')) {
      await run('ffmpeg',['-nostdin','-v','error','-y','-i',src,'-t',String(MAX_SECONDS),'-map','0:a:0','-vn','-ar','16000','-ac','1','-f','f32le',audio]);
      pcm = await readFile(audio);
    }
    const units = splitAccessUnits(await readFile(video));
    if (!units.length) throw new Error('Video kosong');
    const samples = new Float32Array(Math.ceil(units.length / FPS * 16000 / AUDIO_SAMPLES) * AUDIO_SAMPLES);
    for(let i=0;i<Math.min(samples.length,Math.floor(pcm.length/4));i++) samples[i] = pcm.readFloatLE(i*4);
    return { units, samples, duration: units.length / FPS };
  } finally { await rm(dir,{recursive:true,force:true}); }
}
