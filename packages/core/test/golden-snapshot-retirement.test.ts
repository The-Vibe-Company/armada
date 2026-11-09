import { SQL } from "bun";
import { sqlGoldenBackendSlots } from "../src/golden-create.ts";
import { expect, test } from "bun:test";
import { applyMigrations, openDatabase } from "../../../scripts/db/apply.ts";
import { createSqlGoldenStore, beginGoldenOperation, type Sql } from "../src/golden-store.ts";
import { captureGoldenPublication, recordGoldenPublication, enqueueGoldenRetirement, GoldenSnapshotRetirements } from "../src/golden-snapshot-retirement.ts";
import { encryptSecret } from "../src/crypto.ts";
import { type Provider, ProviderError, type SnapshotInfo } from "../src/provider.ts";
import { launchSandbox, type LaunchStores } from "../src/launch.ts";

const KEY=Buffer.alloc(32,29).toString('base64');
const absent=()=>new ProviderError({provider:'boat',code:'not_found',retryable:false,message:'absent'});
async function fixture(sql:Sql) {
  const user=crypto.randomUUID(),org=crypto.randomUUID();
  await sql.query("insert into auth.users(id) values($1)",[user]);
  await sql.query("insert into orgs(id,name) values($1,'retirement')",[org]);
  await sql.query("insert into members(org_id,user_id,role) values($1,$2,'admin')",[org,user]);
  const actor={userId:user,orgId:org,role:'admin' as const};
  const store=createSqlGoldenStore(sql);
  const golden=await store.insert({orgId:org,ownerId:user,name:'retire',visibility:'org',provider:'boat',modal:null,config:{repos:[{url:'https://github.com/acme/web.git',branch:'main',dir:'web'}],init:[]}});
  await store.setSnapshot(golden.id,'old-'+golden.id);
  const old='old-'+golden.id,next='new-'+golden.id;
  const target={orgId:org,ownerId:user,visibility:'org' as const,provider:'boat' as const,modal:null};
  const backend='account-'+org;
  const slots=sqlGoldenBackendSlots(sql);const reservation=await slots.reserve({provider:"boat",backendId:backend,capacity:1,orgId:org,ownerId:user});await slots.finalize(reservation,golden.id);
  const snapshots=new Map<string,SnapshotInfo>([old,next].map(name=>[name,{name,status:'ready',sourceSandboxId:'builder-'+name,artifactId:'disk-'+name}]));
  const deleted:string[]=[];let failure:unknown;let deleteGate:(()=>Promise<void>)|undefined;let account=backend;let authority={scope:'org' as const,ownerId:org};let sourceActive=false;
  const provider={id:'boat',harnesses:['claude','codex'],capabilities:{claude:{reasoningEffort:true},codex:{reasoningEffort:true}},backendIdentity:async()=>({id:account}),managementIdentity:async()=>authority,
    getSnapshot:async(name:string)=>{const info=snapshots.get(name);if(!info)throw absent();return info;},
    get:async(id:string)=>({id,state:sourceActive?'ready':'stopped',name:id,labels:{},providerState:'stopped'}),
    deleteSnapshot:async(name:string)=>{deleted.push(name);if(failure)throw failure;await deleteGate?.();snapshots.delete(name);},
    fork:async()=>{throw Error('A stale revision reached fork');},
  } as Provider;
  const retirement=new GoldenSnapshotRetirements({sql,encryptionKey:KEY,provider:async()=>provider});
  const publish=async()=>{
    const a=await captureGoldenPublication(provider,actor,target,golden.id,old,'builder-'+old);
    const b=await captureGoldenPublication(provider,actor,target,golden.id,next,'builder-'+next);
    await sql.transaction!(async tx=>{
      await tx.query("select id from goldens where id=$1 for update",[golden.id]);
      await storeFor(tx).setSnapshot(golden.id,next);
      await enqueueGoldenRetirement(tx,await recordGoldenPublication(tx,a),await recordGoldenPublication(tx,b));
    });
  };
  const due=async()=>{await sql.query("update golden_snapshot_retirements set next_attempt_at=now()-interval '1 second',claim_until=null where golden_id=$1",[golden.id]);};
  return {sql,actor,store,golden,target,backend,old,next,snapshots,deleted,provider,retirement,publish,due,
    fail:(e:unknown)=>{failure=e;},pause:(gate:()=>Promise<void>)=>{deleteGate=gate;},account:(id:string)=>{account=id;},authority:(ownerId:string)=>{authority={scope:'org',ownerId};},active:()=>{sourceActive=true;}};
}
const storeFor=createSqlGoldenStore;

test('stale golden admission cannot fork a superseded revision',async()=>{
  const db=await openDatabase();try{await applyMigrations(db);
    const f=await fixture(db);
    // A real launch reads old, then credentials resolve while a rebuild publishes next.
    let forks=0;f.provider.fork=async()=>{forks++;throw Error('stale fork');};
    const stores={goldens:f.store,sandboxes:{} as LaunchStores['sandboxes'],credentials:{resolve:async()=>{await f.store.setSnapshot(f.golden.id,f.next);return {env:{},secrets:[],codexAuthJson:false};}}} as LaunchStores;
    await expect(launchSandbox(f.provider,stores,f.actor,{golden:'retire',harness:'claude'})).rejects.toMatchObject({code:'conflict'});
    expect(forks).toBe(0);
    const release=await beginGoldenOperation(db,f.golden.id,{snapshotId:f.next,sandboxId:null});await release();
    expect((await db.query('select id from golden_operation_fences')).rows).toEqual([]);
  }finally{await db.close();}
});

test.each(['fence','hidden-pointer','tombstone-pointer','job','artifact','source','account','authority','active-source'])(
  'retirement retains candidate with %s protection or changed provenance',async(kind)=>{
    const db=await openDatabase();try{await applyMigrations(db);const f=await fixture(db);
      let release:(()=>Promise<void>)|undefined;
      if(kind==='fence')release=await beginGoldenOperation(db,f.golden.id,{snapshotId:f.old,sandboxId:null});
      await f.publish();
      if(kind.endsWith('pointer')){
        const hiddenOwner=crypto.randomUUID();await db.query("insert into auth.users(id) values($1)",[hiddenOwner]);
        const hidden=await f.store.insert({orgId:f.actor.orgId,ownerId:hiddenOwner,name:'hidden',visibility:'private',provider:'boat',modal:null,config:{repos:[{url:'https://github.com/acme/web.git',branch:'main',dir:'web'}],init:[]}});
        await f.store.setSnapshot(hidden.id,f.old);
        if(kind==='tombstone-pointer')await db.query('update goldens set removed_at=now() where id=$1',[hidden.id]);
      }
      if(kind==='job')await db.query("insert into golden_build_jobs(id,reservation_id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,provider,golden_id,state,expected_snapshot_id) values(gen_random_uuid(),gen_random_uuid(),$1,$2,'recovery','org',$3,'hash',$4,'boat',$5,'recovery_required',$6)",[f.actor.orgId,f.actor.userId,crypto.randomUUID(),new Uint8Array([1]),f.golden.id,f.old]);
      if(kind==='artifact')f.snapshots.get(f.old)!.artifactId='different';
      if(kind==='source')f.snapshots.get(f.old)!.sourceSandboxId='different';
      if(kind==='account')f.account('different');
      if(kind==='authority')f.authority(crypto.randomUUID());
      if(kind==='active-source')f.active();
      await f.retirement.runOne();expect(f.deleted).toEqual([]);expect(f.snapshots.has(f.old)).toBe(true);
      const r=(await db.query<{state:string;reason:string}>('select state,reason from golden_snapshot_retirements')).rows[0]!;
      expect(r.state).toBe('deferred');expect(r.reason).not.toBeNull();
      if(release){await release();await f.due();await f.retirement.runOne();expect(f.deleted).toEqual([f.old]);}
    }finally{await db.close();}
  });

test.each(['success','absent','refusal','unknown'])( 'retirement %s outcome is idempotent and never deletes a raw artifact',async(mode)=>{
  const db=await openDatabase();try{await applyMigrations(db);const f=await fixture(db);await f.publish();
    if(mode==='absent')f.snapshots.delete(f.old);
    if(mode==='refusal')f.fail(new ProviderError({provider:'boat',code:'forbidden',message:'refused',retryable:false}));
    if(mode==='unknown')f.fail(Error('lost response'));
    await f.retirement.runOne();
    expect(f.snapshots.has(f.next)).toBe(true);
    if(mode==='refusal'){f.fail(undefined);await f.due();await f.retirement.runOne();expect(f.deleted).toEqual([f.old,f.old]);}
    if(mode==='unknown'){
      await f.due();await f.retirement.runOne();expect(f.deleted).toEqual([f.old]);
      f.snapshots.delete(f.old);await f.due();await f.retirement.runOne();
    }
    expect((await db.query<{state:string}>('select state from golden_snapshot_retirements')).rows[0]!.state).toBe('retired');
    expect(f.deleted.every(name=>name===f.old)).toBe(true);
    await f.due();await f.retirement.runOne();
    await expect(f.store.setSnapshot(f.golden.id,f.old)).rejects.toThrow('unavailable');
  }finally{await db.close();}
});

test('historical dry-run follows proven succeeded chains, mutates nothing, and never enqueues the current handle',async()=>{
  const db=await openDatabase();try{await applyMigrations(db);const f=await fixture(db);
    const current={...f.golden,providerSnapshotId:f.next};
    const insert=async(snapshot:string,existingGolden:unknown)=>db.query(`insert into golden_build_jobs(id,reservation_id,org_id,owner_id,name,visibility,idempotency_key,request_hash,payload_enc,provider,golden_id,state,builder_id,snapshot,phase)
      values(gen_random_uuid(),gen_random_uuid(),$1,$2,'retire','org',$3,'hash',$4,'boat',$5,'succeeded',$6,$7,'complete')`,[f.actor.orgId,f.actor.userId,crypto.randomUUID(),await encryptSecret(JSON.stringify({provider:'boat',visibility:'org',modal:null,existingGolden}),KEY),f.golden.id,'builder-'+snapshot,snapshot]);
    await insert(f.old,null);await insert(f.next,{...f.golden,providerSnapshotId:f.old});await f.store.setSnapshot(f.golden.id,f.next);
    const before=await db.query('select * from golden_snapshot_retirements');
    const dry=await f.retirement.forCaller(f.actor.userId,[f.actor.orgId],f.golden.id,10,false);
    expect(dry.results).toEqual([{oldSnapshot:f.old,newSnapshot:f.next,outcome:'eligible',reason:'proven_chain'}]);
    expect((await db.query('select * from golden_snapshot_retirements')).rows).toEqual(before.rows);
    expect((await db.query('select * from golden_snapshot_publications')).rows).toEqual([]);expect(f.deleted).toEqual([]);
    await f.retirement.reconcile(f.actor,current,10,true);expect((await db.query('select old_snapshot from golden_snapshot_retirements')).rows).toEqual([{old_snapshot:f.old}]);
    await f.retirement.runOne();expect(f.deleted).toEqual([f.old]);expect(f.snapshots.has(f.next)).toBe(true);
    await expect(f.retirement.forCaller(crypto.randomUUID(),[f.actor.orgId],f.golden.id,10)).rejects.toMatchObject({code:'not_found'});
    await expect(f.retirement.forCaller(f.actor.userId,[crypto.randomUUID()],f.golden.id,10)).rejects.toMatchObject({code:'not_found'});
  }finally{await db.close();}
});


const postgres=process.env.ARMADA_TEST_POSTGRES_URL;
test.skipIf(!postgres)('PostgreSQL serializes retirement replicas, stale admission and pointer resurrection while deletion is in flight',async()=>{
  const a=new SQL(postgres!,{max:1}),b=new SQL(postgres!,{max:1});
  const adapt=(client:Pick<SQL,'unsafe'>):Sql=>({query:async<T>(text:string,params:unknown[]=[])=>({rows:Array.from(await client.unsafe(text,params as never[])) as T[]})});
  const sqlA:Sql={...adapt(a),transaction:work=>a.begin(tx=>work(adapt(tx)))};
  const sqlB:Sql={...adapt(b),transaction:work=>b.begin(tx=>work(adapt(tx)))};
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let reached!:()=>void;const entered=new Promise<void>(r=>{reached=r;});
  let running:Promise<boolean>|undefined;
  try {
    const f=await fixture(sqlA);await f.publish();
    f.pause(async()=>{reached();await gate;});
    const other=new GoldenSnapshotRetirements({sql:sqlB,encryptionKey:KEY,provider:async()=>f.provider});
    running=f.retirement.runOne();await entered;
    await expect(beginGoldenOperation(sqlB,f.golden.id,{snapshotId:f.old,sandboxId:null})).rejects.toMatchObject({code:'conflict'});
    await expect(createSqlGoldenStore(sqlB).setSnapshot(f.golden.id,f.old)).rejects.toThrow('unavailable');
    expect(await other.runOne()).toBe(false);
    // Expired ownership permits readback only, not a second destructive provider request.
    await sqlB.query("update golden_snapshot_retirements set claim_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where golden_id=$1",[f.golden.id]);
    expect(await other.runOne()).toBe(true);expect(f.deleted).toEqual([f.old]);
    release();await running;
    await f.due();await other.runOne();
    expect((await sqlB.query<{state:string}>('select state from golden_snapshot_retirements where golden_id=$1',[f.golden.id])).rows[0]!.state).toBe('retired');
    expect((await createSqlGoldenStore(sqlB).findByName(f.actor.orgId,'retire'))[0]?.providerSnapshotId).toBe(f.next);
  }finally{release();await running;await Promise.all([a.close(),b.close()]);}
});
