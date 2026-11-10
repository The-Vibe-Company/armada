/** Remove the authorization before executing guest code: an error/exit/daemon launch
 * cannot skip cleanup. Root SSH registration may target /root even when HOME is
 * /home/user. The exact line alone is removed, preserving metadata/unrelated keys. */
export const cleanupGuestKey = String.raw`set +x
set -e
for armada_key_home in "$HOME" $(if [ "$(id -u)" = 0 ] && [ "$HOME" != /root ]; then printf /root; fi); do
  [ ! -L "$armada_key_home/.ssh" ] || exit 96
  [ -d "$armada_key_home/.ssh" ] || continue
  [ ! -L "$armada_key_home/.ssh/authorized_keys.armada.lock" ] || exit 96
  ARMADA_KEY_HOME="$armada_key_home" flock -x "$armada_key_home/.ssh/authorized_keys.armada.lock" node <<'ARMADA_PRIVATE_KEY_CLEANUP'
const fs=require('node:fs'),path=require('node:path');
try {
 const p=path.join(process.env.ARMADA_KEY_HOME,'.ssh','authorized_keys'),key=process.env.ARMADA_SSH_PUBLIC_KEY;
 if(!key||key.includes('\n'))process.exit(96);
 let stat;try{stat=fs.lstatSync(p);}catch(e){if(e.code==='ENOENT')process.exit(0);throw e;}
 if(!stat.isFile()||stat.isSymbolicLink())process.exit(96);
 const text=fs.readFileSync(p,'utf8'),lines=text.split('\n');
 if(!lines.includes(key))process.exit(0);
 const tmp=p+'.armada-'+process.pid;
 try {
  const fd=fs.openSync(tmp,'wx',stat.mode&0o777);
  try {if(process.getuid()===0)fs.fchownSync(fd,stat.uid,stat.gid);fs.writeFileSync(fd,lines.filter(line=>line!==key).join('\n'));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,p);
 }finally{fs.rmSync(tmp,{force:true});}
}catch{process.exit(96);}
ARMADA_PRIVATE_KEY_CLEANUP
done
unset ARMADA_SSH_PUBLIC_KEY
`;
