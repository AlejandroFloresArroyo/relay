import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftStore, shareText, validateSharedPayload } from './sharedDrafts.ts';
const target = { serverId: 'A', agentId: 'dev', client: {} };
test('an external share produces a private scoped draft, never overwrites without matching confirmation', () => {
  const store = new DraftStore();
  const first = store.put(target, { text: 'https://example.invalid', image: null }, () => true);
  assert.ok(first);
  assert.equal(store.put(target, { text: 'other', image: null }, () => true), null);
  assert.equal(store.read({ ...target, client: {} }), null);
  assert.equal(store.put(target, { text: 'other', image: null }, () => false, first!.id), null);
  const next = store.put(target, { text: 'other', image: null }, () => true, first!.id);
  assert.equal(next?.text, 'other'); assert.equal(store.byId(target, first!.id), null);
  store.retain(() => false); assert.equal(store.read(target), null);
});
test('text remains literal, bounded UTF8 and unknown native payloads fail closed', () => {
  assert.equal(shareText('https://example.invalid?a=1', 'Resume'), 'Resume\n\nhttps://example.invalid?a=1');
  assert.throws(() => shareText('é'.repeat(32001), ''));
  assert.deepEqual(validateSharedPayload({ kind: 'text', text: 'URL literal' }), { kind: 'text', text: 'URL literal' });
  for (const payload of [{ kind: 'audio', uri: 'content://bad' }, { kind: 'text', text: 8 }, { kind: 'image', uri: 'file:///sdcard/secret', width: -1, height: 2 }]) assert.equal(validateSharedPayload(payload), null);
});
test('bounded drafts dispose private copies on invalidation and preserve accepted receipts', () => {
  const discarded: string[] = []; const store = new DraftStore(image => discarded.push(image.uri));
  const image = { uri: 'private-copy', image: { attachmentId: 'image-id', mimeType: 'image/jpeg' as const, dataBase64: '/9j/', width: 1, height: 1 } };
  const row=store.put(target,{text:'draft',image},()=>true)!; store.remove(row.id,false); assert.deepEqual(discarded,[]);
  for(let index=0;index<8;index++) assert.ok(store.put({...target,agentId:`agent${index}`},{text:'bounded',image:index===0?image:null},()=>true));
  assert.equal(store.put({...target,agentId:'overflow'},{text:'overflow',image:null},()=>true),null);
  store.retain(()=>false); assert.deepEqual(discarded,['private-copy']); assert.equal(store.read({...target,agentId:'agent0'}),null);
});

test('terminal retirement is permanent for the exact client and purges its copies without retiring its replacement', () => {
 const discarded: string[]=[];const store=new DraftStore(image=>discarded.push(image.uri));
 const image={uri:'private-copy',image:{attachmentId:'image-id',mimeType:'image/jpeg' as const,dataBase64:'/9j/',width:1,height:1}};
 const old=store.put(target,{text:'old',image},()=>true)!;const replacement={...target,client:{}};store.put(replacement,{text:'new',image:null},()=>true);
 store.retire(target.client);assert.equal(store.byId(target,old.id),null);assert.deepEqual(discarded,['private-copy']);
 assert.equal(store.put(target,{text:'retired',image:null},()=>true),null);assert.equal(store.read(replacement)?.text,'new');assert.equal(store.isRetired(replacement.client),false);
});
