import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentDetails, lowersProtection } from './agentDetails.ts';
import type { AgentDetails, AgentSecurity } from '../../../protocol/agentDetails.ts';
const security:AgentSecurity={mode:'manual',pendingMode:null,deny:[],guardianPolicy:'',revision:'a'.repeat(64),writable:true,reason:null};
const amount={tokens:140,estimatedCostUsd:0.41,conversations:1};
const details:AgentDetails={agentId:'dev',name:'dev',status:'on',capturedAt:1700000000000,security,defaultModel:{model:'fixed',provider:'fixture'},recentConversations:[],usage:{capturedAt:1700000000000,timezone:'UTC',basis:'conversation_started_at',includesAuxiliary:false,today:amount,last7days:amount,daily:[{...amount,day:'2026-10-04'}]},usageError:null};
test('cached details validate every value rendered by the ficha before treating it as last known data',()=>{
 assert.equal(isAgentDetails(details,'dev'),true);
 assert.equal(isAgentDetails({...details,usage:{...details.usage,daily:[{...amount}]}},'dev'),false);
 assert.equal(isAgentDetails({...details,recentConversations:[{id:'thread',title:{bad:true}}]},'dev'),false);
 assert.equal(isAgentDetails({...details,usageError:{bad:true}},'dev'),false);
 assert.equal(isAgentDetails({...details,usage:{...details.usage,today:{...amount,conversations:-1}}},'dev'),false);
});
test('decreasing the selected pending protection needs huella, but cancelling back to the active mode is free',()=>{
 assert.equal(lowersProtection(security,'smart'),true);assert.equal(lowersProtection({...security,mode:'off'},'manual'),false);
 assert.equal(lowersProtection({...security,pendingMode:{mode:'smart',requestedAt:1700000000000}},'off'),true);
 assert.equal(lowersProtection({...security,mode:'off',pendingMode:{mode:'manual',requestedAt:1700000000000}},'off'),false);
});
