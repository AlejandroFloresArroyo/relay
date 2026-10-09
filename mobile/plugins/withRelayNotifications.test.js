const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configureNotifications } = require('./withRelayNotifications');
test('CNG declares notification permission and distributor visibility without exporting decision actions',()=>{
 const input={manifest:{$:{},application:[{$:{}}]}};
 const result=configureNotifications(structuredClone(input));
 assert.ok(result.manifest['uses-permission'].some(item=>item.$['android:name']==='android.permission.POST_NOTIFICATIONS'));
 assert.ok(result.manifest.queries[0].intent.some(item=>item.action[0].$['android:name']==='org.unifiedpush.android.distributor.REGISTER'));
 assert.deepEqual(configureNotifications(structuredClone(result)),result);
 assert.equal(result.manifest.application[0].receiver,undefined);
});


test('CNG composes with an empty queries array and preserves unrelated declarations',()=>{
 const input={manifest:{$:{},application:[{$:{}}],queries:[],'uses-permission':[{$:{'android:name':'android.permission.CAMERA'}}]}};
 const result=configureNotifications(input);
 assert.equal(result.manifest['uses-permission'][0].$['android:name'],'android.permission.CAMERA');
 assert.equal(result.manifest.queries[0].intent[0].action[0].$['android:name'],'org.unifiedpush.android.distributor.REGISTER');
 assert.deepEqual(configureNotifications(structuredClone(result)),result);
});

test('the encrypted Avisos snapshot is excluded from every backup path while SecureStore stays excluded',async t=>{
 const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
 const withRelayNotifications=require('./withRelayNotifications');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'relay-notifications-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const config=withRelayNotifications({name:'Relay',slug:'relay'});
 await config.mods.android.dangerous({...config,modRequest:{platformProjectRoot:root}});
 const exclude=name=>new RegExp(`<exclude domain="sharedpref" path="${name.replace(/\./g,'\\.')}"/>`,'g');
 const full=await fs.readFile(path.join(root,'app/src/main/res/xml/secure_store_backup_rules.xml'),'utf8');
 assert.match(full,/<full-backup-content>/);assert.equal(full.match(exclude('relay.notifications.private.v1.xml')).length,1);assert.equal(full.match(exclude('SecureStore')).length,1);
 const rules=await fs.readFile(path.join(root,'app/src/main/res/xml/secure_store_data_extraction_rules.xml'),'utf8');
 for(const section of ['cloud-backup','device-transfer']){
  const body=rules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))[1];
  assert.equal(body.match(exclude('relay.notifications.private.v1.xml')).length,1,section);assert.equal(body.match(exclude('SecureStore')).length,1,section);
 }
});
