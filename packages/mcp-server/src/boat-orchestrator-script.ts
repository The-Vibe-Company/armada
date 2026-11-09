/** Public code only. Bootstrap/control payload is private pinned SSH stdin; no token
 * appears in this script, argv, native configuration, daemon logs or disk files. */
const brokerCode = String.raw`
const fs=require('node:fs'),net=require('node:net'),http=require('node:http'),crypto=require('node:crypto');
let line='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>line+=c);process.stdin.on('end',()=>start(JSON.parse(line)));
function start(c){
 const secrets=new Set(); let token=null,hash=null,epoch=null,url=null,inflight=0;
 const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(boot!==c.boot)process.exit(1);
 let highest='0';try{const old=JSON.parse(fs.readFileSync(c.state,'utf8'));if(old.boot===boot)highest=old.epoch;}catch(e){if(e.code!=='ENOENT')process.exit(1);}
 if(typeof highest!=='string'||!/^[0-9]{1,19}$/.test(highest))process.exit(1);
 function redact(text){for(const value of secrets)text=text.split(value).join('[REDACTED]');return text;}
 function reply(){return {physicalGeneration:boot,acknowledged:true,port:server.address().port,epoch:highest,authorityInstalled:token!==null};}
 const server=http.createServer(async(req,res)=>{
  if(req.url!=='/mcp'||!['POST','GET','DELETE'].includes(req.method)){res.writeHead(404);res.end();return;}
  if(!token){res.writeHead(503);res.end('Orchestrator authority unavailable.');return;}
  const credential=token,target=url;inflight++;const abort=new AbortController();res.on('close',()=>abort.abort());
  try{
   const chunks=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>1048576)throw Error('bounded');chunks.push(chunk);}
   const headers={Authorization:'Bearer '+credential};
   for(const key of ['content-type','accept','mcp-protocol-version','mcp-session-id'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key];
   const upstream=await fetch(target,{method:req.method,headers,...(req.method==='POST'?{body:redact(Buffer.concat(chunks).toString('utf8'))}:{}),redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(600000)])});
   const output={};for(const key of ['content-type','mcp-session-id']){const value=upstream.headers.get(key);if(value)output[key]=value;}
   res.writeHead(upstream.status,output);
   if(upstream.body){const decoder=new TextDecoder();let pending='';const keep=Math.max(1,...[...secrets].map(v=>v.length))-1;for await(const chunk of upstream.body){pending=redact(pending+decoder.decode(chunk,{stream:true}));if(pending.length>keep){res.write(pending.slice(0,pending.length-keep));pending=pending.slice(pending.length-keep);}}res.write(redact(pending+decoder.decode()));}
   res.end();
  }catch{if(!res.headersSent)res.writeHead(502);res.end('Orchestrator upstream unavailable.');}
  finally{inflight--;}
 });
 const control=net.createServer(socket=>{
  let raw='',used=false;
  socket.setEncoding('utf8');socket.on('error',()=>{});socket.on('data',chunk=>{
   if(used)return;raw+=chunk;if(Buffer.byteLength(raw)>8192){used=true;socket.end('{"denied":true}\n');return;}
   const end=raw.indexOf('\n');if(end<0)return;used=true;
   try{
    const r=JSON.parse(raw.slice(0,end));
    if(typeof r.control!=='string'||r.control.length!==c.control.length||!crypto.timingSafeEqual(Buffer.from(r.control),Buffer.from(c.control))||r.boot!==boot)throw Error('denied');
    if(r.op==='install'){
     if(typeof r.token!=='string'||!/^armada_epoch_[a-f0-9]{64}$/.test(r.token))throw Error('denied');
     secrets.add(r.token); // Register before any diagnostic/operation; diagnostics remain constants only.
     if(typeof r.epoch!=='string'||!/^[1-9][0-9]{0,18}$/.test(r.epoch))throw Error('denied');
     const parsed=new URL(r.url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw Error('denied');
     const next=crypto.createHash('sha256').update(r.token).digest('hex');
     if(BigInt(r.epoch)<BigInt(highest))throw Error('denied');
     if(BigInt(r.epoch)===BigInt(highest)){
      if(epoch!==r.epoch||hash!==next||url!==parsed.href)throw Error('denied');
     }else{
      if(inflight)throw Error('denied');
      const tmp=c.state+'.next';fs.writeFileSync(tmp,JSON.stringify({boot,epoch:r.epoch}),{mode:0o600});fs.renameSync(tmp,c.state);
      highest=r.epoch;epoch=r.epoch;hash=next;token=r.token;url=parsed.href;
     }
    }else if(r.op==='scrub'){
     if(r.hash!==undefined&&!/^[a-f0-9]{64}$/.test(r.hash))throw Error('denied');
     if(token&&(r.hash===undefined||r.hash===hash)){
      if(inflight)throw Error('denied');token=null;hash=null;epoch=null;url=null;
     }
    }else if(r.op==='shutdown'){if(token||inflight)throw Error('denied');}
    else if(r.op!=='probe')throw Error('denied');
    socket.end(JSON.stringify(reply())+'\n',()=>{if(r.op==='shutdown'){server.close();control.close(()=>{try{fs.unlinkSync(c.socket);}catch{}process.exit(0);});}});
   }catch{socket.end('{"denied":true}\n');}
  });
 });
 server.listen(0,'127.0.0.1',()=>control.listen(c.socket,()=>{
  fs.chmodSync(c.socket,0o600);fs.writeSync(3,JSON.stringify(reply())+'\n');fs.closeSync(3);
 }));
 process.on('uncaughtException',()=>process.exit(1));process.on('unhandledRejection',()=>process.exit(1));
}
`;

const controlCode = String.raw`
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),cp=require('node:child_process');
const input=JSON.parse(process.env.ARMADA_GIT_TOKEN||'null');delete process.env.ARMADA_GIT_TOKEN;
const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
if(!/^[a-f0-9-]{36}$/i.test(boot))throw Error('private_transport_denied');
function emit(value){console.log('ARMADA_ORCHESTRATOR_RECEIPT '+Buffer.from(JSON.stringify(value)).toString('base64url'));}
if(input.op==='generation'){emit({physicalGeneration:boot,acknowledged:true});process.exit(0);}
if(input.boot!==boot)throw Error('private_transport_denied');
const root='/dev/shm/armada-orchestrator-'+process.getuid();
if(fs.statfsSync('/dev/shm').type!==0x01021994)throw Error('private_transport_denied');
try{const s=fs.lstatSync(root);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid())throw Error('private_transport_denied');}catch(e){if(e.code!=='ENOENT')throw e;fs.mkdirSync(root,{mode:0o700});}
fs.chmodSync(root,0o700);
const name=crypto.createHash('sha256').update(input.sandboxId).digest('hex').slice(0,24),socket=path.join(root,name+'.sock'),state=path.join(root,name+'.json');
function request(){return new Promise((resolve,reject)=>{
 const s=net.connect(socket);let text='';const timer=setTimeout(()=>{s.destroy();reject(Error('private_transport_denied'));},10000);
 s.on('error',()=>{clearTimeout(timer);reject(Error('private_transport_denied'));});
 s.on('connect',()=>s.write(JSON.stringify({...input,control:input.control})+'\n'));
 s.on('data',c=>{text+=c;if(text.length>8192)s.destroy();});s.on('end',()=>{
  clearTimeout(timer);try{const value=JSON.parse(text);if(value.denied||value.physicalGeneration!==boot||value.acknowledged!==true)throw Error();resolve(value);}catch{reject(Error('private_transport_denied'));}
 });
});}
async function launch(){
 // A failed authenticated request to an existing broker is NEVER a reason to replace it.
 let live=false;try{await new Promise((resolve,reject)=>{const s=net.connect(socket);s.once('connect',()=>{live=true;s.destroy();resolve();});s.once('error',reject);});}catch{}
 if(live)return;
 try{const s=fs.lstatSync(socket);if(!s.isSocket()||s.uid!==process.getuid())throw Error('private_transport_denied');fs.unlinkSync(socket);}catch(e){if(e.code!=='ENOENT')throw e;}
 const child=cp.spawn(process.execPath,['-e',BROKER_CODE],{detached:true,stdio:['pipe','ignore','ignore','pipe'],env:{...process.env}});
 const ready=new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('private_transport_denied')),10000);child.once('error',()=>{clearTimeout(timer);reject(Error('private_transport_denied'));});child.stdio[3].on('data',c=>{text+=c;if(text.includes('\n')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('private_transport_denied'));});});
 child.stdin.end(JSON.stringify({control:input.control,boot,socket,state}));await ready;child.unref();
}
(async()=>{if(input.op==='install')await launch();emit(await request());})().catch(()=>{console.error('orchestrator_private_transport_denied');process.exitCode=1;});
`;

export const boatOrchestratorControlScript = `set +x\nnode <<'ARMADA_ORCHESTRATOR_PRIVATE'\nprocess.on('uncaughtException',()=>{console.error('orchestrator_private_transport_denied');process.exit(1);});\nprocess.on('unhandledRejection',()=>{console.error('orchestrator_private_transport_denied');process.exit(1);});\nconst BROKER_CODE=${JSON.stringify(brokerCode)};\ntry {\n${controlCode}\n} catch {console.error('orchestrator_private_transport_denied');process.exitCode=1;}\nARMADA_ORCHESTRATOR_PRIVATE\n`;
