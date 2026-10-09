import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalMode } from '../../protocol/agentDetails.ts';
import type { Exec } from './exec.ts';
import type { SecuritySnapshot } from './agentDetailsPorts.ts';
import { AgentDetailsError } from './agentDetailsError.ts';
import { resolveHermesPython, resolveHermesSource } from './hermesRuntime.ts';

// Isolated parser: PyYAML only, never imports a Hermes initializer or reads a profile itself. An absent
// approvals.mode is Hermes' own default, read from its pure-data defaults module; unreadable means unknown.
// Pin: Hermes ea114c3 / approval_context.py normalization, approval_floors.py exact globs, config_defaults.py.
const PARSER = String.raw`
import sys,json,yaml
from yaml.nodes import MappingNode,ScalarNode
from yaml.tokens import AnchorToken,AliasToken
try:
 if not yaml.__version__.startswith('6.'): raise ValueError()
 request=json.load(sys.stdin); text=request['text']
 if any(isinstance(t,(AnchorToken,AliasToken)) for t in yaml.scan(text)): raise ValueError()
 node=yaml.compose(text); data=yaml.safe_load(text)
 if not isinstance(node,MappingNode) or not isinstance(data,dict): raise ValueError()
 def checked(n,depth=0):
  if depth>32: raise ValueError()
  if isinstance(n,MappingNode):
   keys=[]
   for k,v in n.value:
    if not isinstance(k,ScalarNode) or k.value in keys: raise ValueError()
    keys.append(k.value); checked(v,depth+1)
  elif hasattr(n,'value') and isinstance(n.value,list):
   for v in n.value: checked(v,depth+1)
 checked(node)
 approvals=data.get('approvals',{})
 if not isinstance(approvals,dict): raise ValueError()
 def hermes_default():
  try:
   import importlib.util
   spec=importlib.util.spec_from_file_location('relay_hermes_defaults',request['defaults']); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
   return module.DEFAULT_CONFIG['approvals']['mode']
  except Exception: return None
 rawmode=approvals['mode'] if 'mode' in approvals else hermes_default()
 mode='off' if rawmode is False else 'manual' if rawmode is True else str(rawmode).strip().lower()
 refs=any(chr(36)+'{' in str(v) for v in approvals.values())
 if mode not in ['manual','smart','off']: mode=None
 deny=approvals.get('deny',[]); policy=approvals.get('smart_policy',None)
 if not isinstance(deny,list) or len(deny)>100 or not all(isinstance(v,str) and v.strip() and len(v)<=256 and not any(ord(c)<32 for c in v) for v in deny): raise ValueError()
 if policy is not None and (not isinstance(policy,str) or len(policy)>8192): raise ValueError()
 result={'mode':mode,'deny':deny,'guardianPolicy':policy,'writable':not refs and mode is not None}
 if refs: result.update(mode=None,deny=None,guardianPolicy=None)
 if 'leaf' in request:
  if not result['writable']: raise ValueError()
  leaf=request['leaf']; value=request['value']
  if leaf not in ['mode','deny']: raise ValueError()
  if leaf=='mode' and value not in ['manual','smart','off']: raise ValueError()
  if leaf=='deny' and (not isinstance(value,list) or len(value)>100 or not all(isinstance(v,str) and v.strip() and len(v)<=256 and not any(ord(c)<32 for c in v) for v in value)): raise ValueError()
  target=next((v for k,v in node.value if k.value=='approvals'),None)
  if target is not None and (not isinstance(target,MappingNode) or target.flow_style): raise ValueError()
  rendered=value if leaf=='mode' and value!='off' else json.dumps(value,ensure_ascii=False)
  existing=next((v for k,v in target.value if k.value==leaf),None) if target else None
  if existing is not None:
   start=existing.start_mark.index; end=existing.end_mark.index
   if not isinstance(existing,ScalarNode) and end>start and text[end-1]=='\n': rendered+='\n'+' '*existing.start_mark.column
   patch=text[:start]+rendered+text[end:]
  elif target is not None:
   at=target.end_mark.index
   prefix='' if at==0 or text[at-1]=='\n' else '\n'
   patch=text[:at]+prefix+'  '+leaf+': '+rendered+'\n'+text[at:]
  else:
   patch=text+('' if text.endswith('\n') else '\n')+'approvals:\n  '+leaf+': '+rendered+'\n'
  after=yaml.safe_load(patch); expected=dict(data); expected['approvals']=dict(approvals); expected['approvals'][leaf]=value
  if after!=expected: raise ValueError()
  result['patch']=patch
 print(json.dumps(result,ensure_ascii=False))
except Exception:
 sys.exit(2)
`;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
interface Options { home: string; source?: string; python?: string; exec: Exec; managedFile?: string; env?: Record<string,string|undefined> }
export class AgentConfig {
  private options: Options;
  constructor(options: Options) { this.options = options; }
  private async parent(profile: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile) || profile === '.' || profile === '..') throw new AgentDetailsError('agent_details_unavailable');
    const root=path.resolve(this.options.home), before=await fs.lstat(root);
    if(!before.isDirectory()||before.isSymbolicLink()||await fs.realpath(root)!==root)throw new AgentDetailsError('agent_details_unavailable');
    let handle=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try {
      let stat=await handle.stat();
      if(stat.dev!==before.dev||stat.ino!==before.ino)throw new AgentDetailsError('agent_details_unavailable');
      const parts=profile==='default'?[]:['profiles',profile];
      for(let index=0;index<=parts.length;index++) {
        stat=await handle.stat();
        if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o022))throw new AgentDetailsError('agent_details_unavailable');
        if(index===parts.length)break;
        const next=await fs.open(`/proc/self/fd/${handle.fd}/${parts[index]}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
        await handle.close();handle=next;
      }
      return {handle,base:`/proc/self/fd/${handle.fd}`,identity:`${stat.dev}:${stat.ino}`};
    }catch(error){await handle.close();throw error;}
  }
  private async bytes(file:string) {
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try { const stat=await handle.stat(); if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o022)||stat.size>1024*1024)throw new Error();
      const bytes=await handle.readFile(); if(bytes.length>1024*1024)throw new Error();
      return {bytes,identity:`${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`,mode:stat.mode&0o777};
    } finally {await handle.close();}
  }
  private async parse(bytes:Uint8Array,leaf?:'mode'|'deny',value?:ApprovalMode|string[]) {
    try {
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      const result=await this.options.exec(resolveHermesPython(this.options),['-I','-B','-c',PARSER],{timeoutMs:3000,input:JSON.stringify({text,defaults:path.join(resolveHermesSource(this.options),'hermes_cli','config_defaults.py'),...(leaf?{leaf,value}:{})})});
      if(result.code!==0||result.stdout.length>2*1024*1024)throw new Error();
      const row=JSON.parse(result.stdout);
      if(!row||![null,'manual','smart','off'].includes(row.mode)||typeof row.writable!=='boolean'||row.deny!==null&&!Array.isArray(row.deny)||row.guardianPolicy!==null&&typeof row.guardianPolicy!=='string')throw new Error();
      return row as {mode:ApprovalMode|null;deny:string[]|null;guardianPolicy:string|null;writable:boolean;patch?:string};
    } catch {throw new AgentDetailsError('agent_details_unavailable');}
  }
  private async managed() {
    const env=this.options.env??process.env;
    if(env.HERMES_IGNORE_USER_CONFIG==='1'||env.HERMES_MANAGED||env.HERMES_MANAGED_DIR) return true;
    const file=this.options.managedFile??'/etc/hermes/config.yaml';
    try {await fs.lstat(file); return true;} catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  async security(profile:string):Promise<SecuritySnapshot> {
    try {
      const parent=await this.parent(profile);
      try {
      const source=await this.bytes(`${parent.base}/config.yaml`), parsed=await this.parse(source.bytes);
      const managed=await this.managed();
      return {bytes:source.bytes,identity:`${parent.identity}:${source.identity}`,revision:hash(source.bytes),security:{mode:managed?null:parsed.mode,deny:managed?null:parsed.deny,guardianPolicy:managed?null:parsed.guardianPolicy,
        writable:parsed.writable&&!managed,reason:managed?'La configuración está administrada o usa una configuración externa.':parsed.writable?null:'La configuración usa valores externos o no compatibles.'}};
      } finally {await parent.handle.close();}
    } catch(error){if(error instanceof AgentDetailsError)throw error;throw new AgentDetailsError('agent_details_unavailable');}
  }
  async writeSecurity(profile:string,snapshot:SecuritySnapshot,leaf:'mode'|'deny',value:ApprovalMode|string[],guard:()=>void,retain:()=>Promise<void>):Promise<SecuritySnapshot> {
    guard(); if(!snapshot.security.writable)throw new AgentDetailsError('agent_security_read_only');
    const parent=await this.parent(profile);
    try {
    const file=`${parent.base}/config.yaml`; const current=await this.security(profile); guard();
    if(current.revision!==snapshot.revision||current.identity!==snapshot.identity)throw new AgentDetailsError('agent_security_conflict');
    if(!current.security.writable)throw new AgentDetailsError('agent_security_read_only');
    const parsed=await this.parse(current.bytes,leaf,value); guard(); if(typeof parsed.patch!=='string')throw new AgentDetailsError('agent_security_uncertain');
    const replacement=Buffer.from(parsed.patch); if(replacement.length>1024*1024)throw new AgentDetailsError('agent_security_invalid');
    await retain(); guard();
    const temporary=`${parent.base}/.relay-config-${randomUUID()}.tmp`;
    try {
      const opened=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await opened.writeFile(replacement);await opened.sync();}finally{await opened.close();}
      const latest=await this.security(profile); guard();
      if(latest.revision!==snapshot.revision||latest.identity!==snapshot.identity)throw new AgentDetailsError('agent_security_conflict');
      if(!latest.security.writable)throw new AgentDetailsError('agent_security_read_only');
      await fs.rename(temporary,file);
      await parent.handle.sync();
      const after=await this.security(profile); guard();
      if(after.revision!==hash(replacement)||JSON.stringify(leaf==='mode'?after.security.mode:after.security.deny)!==JSON.stringify(value))throw new AgentDetailsError('agent_security_uncertain');
      return after;
    } catch(error){if(error instanceof AgentDetailsError||error instanceof Error&&error.name==='AuthorizationError')throw error;throw new AgentDetailsError('agent_security_uncertain');}
    finally{await fs.unlink(temporary).catch(()=>{});}
    } finally {await parent.handle.close();}
  }
}
