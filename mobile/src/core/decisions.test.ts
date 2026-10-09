import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DecisionRecord } from '../../../protocol/protocol.ts';
import { parseDecisionHistory } from './decisions.ts';
import { RelayError } from './client.ts';
const record: DecisionRecord = {id:'fixture-result',agentId:'coding',agentName:'Coding',sessionId:'discord-session',runId:null,approvalId:null,toolCallId:'terminal-call',command:'echo inspected',actor:'unknown',outcome:'executed',choice:null,at:2000,timeKind:'result',origin:'other',source:'discord',originLabel:'Discord'};
test('an imported command without consent evidence remains executed and unattributed',()=>{
 const history=parseDecisionHistory({decisions:[record],capturedAt:3000});
 assert.deepEqual(history.decisions,[record]);
});
test('contradictory actor and outcome metadata is unavailable rather than inventing consent',()=>{
 for(const change of [{actor:'unknown',outcome:'approved'},{actor:'person',outcome:'executed'},{actor:'guardian',outcome:'rejected'},{actor:'expired',outcome:'approved'},{actor:'person',outcome:'expired'}]){
  assert.throws(()=>parseDecisionHistory({decisions:[{...record,...change}],capturedAt:3000}),error=>error instanceof RelayError && error.code === 'decision_history_unavailable');
 }
});


test('a large legacy history keeps only the newest hundred confirmed records and abbreviates commands, never uncertain choices',()=>{
 const command='echo '+ 'x'.repeat(8192);
 const decisions=Array.from({length:5000},(_,i)=>({...record,id:`large-${i}`,at:2000+i,command}));
 const uncertain=[{id:'intent',agentId:'coding',agentName:'Coding',command,choice:'session' as const,at:1234,origin:'relay' as const}];
 const history=parseDecisionHistory({decisions,capturedAt:9000,uncertain});
 assert.equal(history.decisions.length,100);
 assert.equal(history.decisions[0].id,'large-4999');assert.equal(history.decisions[99].id,'large-4900');
 assert.equal(history.decisions[0].command.length,512);assert.equal(history.decisions[0].commandTruncated,true);
 assert.deepEqual(history.window,{limit:100,total:5000});assert.deepEqual(history.uncertain,uncertain);
 assert.equal(decisions[4999].command,command);
 assert.deepEqual([history.decisions[0].actor,history.decisions[0].outcome,history.decisions[0].choice,history.decisions[0].at,history.decisions[0].timeKind],['unknown','executed',null,6999,'result']);
});


test('history metadata is additive and corrupt metadata or an invalid discarded tail still fails closed',()=>{
 const history=parseDecisionHistory({decisions:[{...record,command:'short preview',commandTruncated:true}],capturedAt:3000,window:{limit:100,total:9000}});
 assert.deepEqual(history.window,{limit:100,total:9000});assert.equal(history.decisions[0].commandTruncated,true);
 for(const window of [null,false,[], 'invalid',{limit:100,total:100,extra:true},{limit:0,total:100},{limit:100,total:0},{limit:100,total:1.5},{limit:100,total:'100'}]){
  assert.throws(()=>parseDecisionHistory({decisions:[record],capturedAt:3000,window}),error=>error instanceof RelayError && error.code==='decision_history_unavailable');
 }
 const records=Array.from({length:150},(_,i)=>({...record,id:`record-${i}`,at:2000+i}));
 assert.throws(()=>parseDecisionHistory({decisions:[...records,{...record,actor:'person',outcome:'executed',at:0}],capturedAt:3000}));
});

test('historical previews do not split a unicode surrogate pair or invent a truncated flag on short commands',()=>{
 const history=parseDecisionHistory({decisions:[{...record,command:'x'.repeat(510)+'😀more'}],capturedAt:3000});
 assert.equal(history.decisions[0].command,'x'.repeat(510)+'…');assert.equal(history.decisions[0].commandTruncated,true);
 assert.equal(parseDecisionHistory({decisions:[record],capturedAt:3000}).decisions[0].commandTruncated,undefined);
});
