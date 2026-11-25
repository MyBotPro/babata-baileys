import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(process.argv[2] || 'dist');
const upstream = '@whiskeysockets/baileys@7.0.0-rc14';
const version = '7.0.0-rc14-babata.1';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd,args,cwd) => execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','inherit'],maxBuffer:16*1024*1024});
const tmp = await mkdtemp(join(tmpdir(),'babata-build-'));
try {
  // Optional local official tarball for offline builds; never use Rifza's package.
  const source = process.argv[3] ? resolve(process.argv[3]) : join(tmp,JSON.parse(run(npm,['pack',upstream,'--ignore-scripts','--json','--pack-destination',tmp],tmp))[0].filename);
  run('tar',['-xzf',source,'-C',tmp],tmp);
  const pkg = join(tmp,'package');
  const manifest = JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));
  if (!['baileys','@whiskeysockets/baileys'].includes(manifest.name) || manifest.version !== '7.0.0-rc14') throw Error('Unexpected upstream package/version');
  for (const f of ['lib/index.js','lib/Utils/messages.js','WAProto/index.js']) await access(join(pkg,f));
  await cp(join(here,'vc'),join(pkg,'lib/babata-vc'),{recursive:true});
  const entry = join(pkg,'lib/index.js');
  await writeFile(entry,(await readFile(entry,'utf8'))+"\n// Babata experimental video call extension\nexport { vcFor, VCController, phone as vcPhone, prepareMedia as prepareVCMedia } from './babata-vc/index.mjs';\n");
  manifest.name='babata-baileys'; manifest.version=version;
  manifest.description='Babata distribution of WhiskeySockets Baileys with experimental VC';
  manifest.optionalDependencies={...manifest.optionalDependencies,nexcaller:'0.5.0'};
  // Keep the bot's legacy Jimp separate from upstream's newer optional Jimp.
  if (manifest.peerDependencies?.jimp) { manifest.optionalDependencies.jimp=manifest.peerDependencies.jimp; delete manifest.peerDependencies.jimp; if(manifest.peerDependenciesMeta) delete manifest.peerDependenciesMeta.jimp; }
  // The npm distribution already contains compiled JavaScript, not TypeScript sources.
  for (const key of ['prepare','prepack','postpack','prepublish','prepublishOnly']) if(manifest.scripts) delete manifest.scripts[key];
  delete manifest.devDependencies; delete manifest.packageManager; delete manifest.resolutions;
  await writeFile(join(pkg,'package.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(join(pkg,'BABATA.md'),'Babata custom distribution. Original upstream license and credits retained. VC is experimental, not verified against WhatsApp.\n');
  if(Array.isArray(manifest.files)) {manifest.files.push('BABATA.md'); await writeFile(join(pkg,'package.json'),JSON.stringify(manifest,null,2)+'\n');}
  await mkdir(out,{recursive:true});
  const result=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',out],pkg))[0];
  console.log('Built:',join(out,result.filename));
} finally {await rm(tmp,{recursive:true,force:true});}
