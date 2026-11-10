// Self-contained Bun program, executed inside the sandbox without Python or OpenSSL.
export const RECOVERY_BUN = String.raw`if [ -x /opt/armada/runtime-bun/bun ]; then
  armada_bun=/opt/armada/runtime-bun/bun
elif command -v bun >/dev/null 2>&1; then
  armada_bun=$(command -v bun)
else
  printf '{"status":"failed","reason":"missing_bun"}\n'; exit 0
fi`;

export const RECOVERY_COLLECTOR = String.raw`
const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path'), crypto=require('node:crypto');
const LIMIT=2*1024*1024, tmp='/tmp/armada-recovery-ARMADA_TOKEN';
function fail(reason) { throw Object.assign(new Error(),{reason}); }
function git(root,...args) {
  const p=cp.spawnSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',root,...args],
    {timeout:8000,maxBuffer:LIMIT,stdio:['ignore','pipe','ignore']});
  if(p.error?.code==='ENOBUFS'||p.stdout?.length>=LIMIT) fail('size_limit');
  if(p.error?.code==='ETIMEDOUT') fail('timeout');
  if(p.status!==0) fail(p.signal?'collector_signal':'collector_exit');
  return p.stdout;
}
function head(root) {
  const p=cp.spawnSync('git',['-C',root,'rev-parse','--verify','HEAD'],{timeout:8000,maxBuffer:LIMIT,stdio:['ignore','pipe','ignore']});
  if(p.error||p.signal) fail(p.error?.code==='ETIMEDOUT'?'timeout':'collector_failed');
  return p.status===0?p.stdout.toString().trim():null;
}
const patches=[['index.patch',['diff','--no-ext-diff','--no-textconv','--cached','--binary']],['worktree.patch',['diff','--no-ext-diff','--no-textconv','--binary']]];
function untracked(root) { return git(root,'ls-files','--others','--exclude-standard','-z').toString().split('\0').filter(Boolean); }
function file(root,name) {
  if(path.isAbsolute(name)||name.split('/').includes('..')) fail('collector_failed');
  const source=path.join(root,name),stat=fs.lstatSync(source);
  if(stat.isSymbolicLink()) return {mode:stat.mode,link:fs.readlinkSync(source),data:Buffer.alloc(0)};
  if(!stat.isFile()) fail('collector_failed');
  if(stat.size>LIMIT) fail('size_limit');
  const fd=fs.openSync(source,'r');
  try {
    const b=Buffer.alloc(LIMIT+1); let n=0,count;
    while(n<b.length&&(count=fs.readSync(fd,b,n,b.length-n,null))) n+=count;
    if(n>LIMIT) fail('size_limit');
    return {mode:stat.mode,data:b.subarray(0,n)};
  } finally { fs.closeSync(fd); }
}
function fingerprint(root) {
  if(git(root,'ls-files','--unmerged','-z').length) fail('collector_failed');
  const hash=crypto.createHash('sha256').update(head(root)||'');
  for(const [,args] of patches) hash.update(git(root,...args));
  for(const name of untracked(root)) {
    const f=file(root,name); hash.update(name+'\0'+f.mode+'\0').update(f.link===undefined?f.data:f.link);
  }
  return hash.digest('hex');
}
try {
  if(cp.spawnSync('git',['--version'],{stdio:'ignore'}).error?.code==='ENOENT') fail('missing_git');
  const repos=[];
  function walk(root) {
    const entries=fs.readdirSync(root,{withFileTypes:true});
    if(entries.some(e=>e.name==='.git')) {
      const dirty=git(root,'status','--porcelain=v1','-z','--untracked-files=all'),h=head(root);
      if(dirty.length||(h&&git(root,'rev-list','--max-count=1','HEAD','--not','--remotes').length)) repos.push([root,h]);
    }
    for(const e of entries) if(e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='node_modules') walk(path.join(root,e.name));
  }
  walk(require('node:os').homedir());
  if(!repos.length) console.log(JSON.stringify({status:'clean'}));
  else {
    const parts=[]; let size=0;
    function append(data) { size+=data.length; if(size>LIMIT) fail('size_limit'); parts.push(data); }
    function header(name,data,mode=0o600,type='0',link='') {
      const h=Buffer.alloc(512);
      h.write(name,0,100); h.write((mode&0o777).toString(8).padStart(7,'0')+'\0',100,8);
      h.write('0000000\0',108,8); h.write('0000000\0',116,8);
      h.write(data.length.toString(8).padStart(11,'0')+'\0',124,12);
      h.write('00000000000\0',136,12); h.fill(32,148,156);
      h.write(type,156,1); h.write(link,157,100); h.write('ustar\0',257,6); h.write('00',263,2);
      h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148,8);
      append(h); append(data); if(data.length%512) append(Buffer.alloc(512-data.length%512));
    }
    function add(name,data,mode,link) {
      // GNU long-name records preserve long UTF-8 paths and symlink targets.
      if(Buffer.byteLength(name)>100) header('././@LongLink',Buffer.from(name+'\0'),0o600,'L');
      if(link!==undefined&&Buffer.byteLength(link)>100) header('././@LongLink',Buffer.from(link+'\0'),0o600,'K');
      header(name,data,mode,link===undefined?'0':'2',link);
    }
    const manifest=[];
    for(const [i,[root,h]] of repos.entries()) {
      const before=fingerprint(root),prefix='repo-'+i;
      if(head(root)!==h) fail('collector_failed');
      const bundle=!!(h&&git(root,'rev-list','--max-count=1','HEAD','--branches','--tags','--not','--remotes').length);
      manifest.push({path:root,directory:prefix,head:h,bundle});
      if(bundle) add(prefix+'/commits.bundle',git(root,'bundle','create','-','HEAD','--branches','--tags','--not','--remotes'));
      for(const [name,args] of patches) add(prefix+'/'+name,git(root,...args));
      for(const name of untracked(root)) { const f=file(root,name); add(prefix+'/untracked/'+name,f.data,f.mode,f.link); }
      if(fingerprint(root)!==before) fail('collector_failed');
    }
    add('manifest.json',Buffer.from(JSON.stringify({version:2,repositories:manifest}))); append(Buffer.alloc(1024));
    const password=crypto.randomBytes(32).toString('hex'),salt=crypto.randomBytes(8),derived=crypto.pbkdf2Sync(password,salt,10000,48,'sha256');
    const cipher=crypto.createCipheriv('aes-256-cbc',derived.subarray(0,32),derived.subarray(32));
    const sealed=Buffer.concat([Buffer.from('Salted__'),salt,cipher.update(Buffer.concat(parts)),cipher.final()]);
    const key=crypto.publicEncrypt({key:'ARMADA_PUBLIC_KEY',oaepHash:'sha256',padding:crypto.constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(password));
    fs.mkdirSync(tmp,{mode:0o700});
    const janitor=cp.spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').rmSync(process.argv[1],{recursive:true,force:true}),120000)",tmp],{detached:true,stdio:'ignore'});
    janitor.unref();
    fs.writeFileSync(tmp+'/recovery.tar',sealed,{mode:0o600});
    console.log(JSON.stringify({status:'preserved',bytes:sealed.length,sha256:crypto.createHash('sha256').update(sealed).digest('hex'),key:key.toString('base64')}));
  }
} catch(error) { console.log(JSON.stringify({status:'failed',reason:error.reason||'collector_failed'})); }
`;
