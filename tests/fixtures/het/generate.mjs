// Synthetic fixture generator for HET adapter/segmenter tests. No real transcript content.
// Usage: node tests/fixtures/het/generate.mjs tests/fixtures/het
import fs from 'node:fs'
const out = process.argv[2]
const S1='11111111-1111-4111-8111-111111111111', S2='22222222-2222-4222-8222-222222222222', S3='33333333-3333-4333-8333-333333333333'
const T=(m)=>new Date(Date.UTC(2025,8,1,10,0,0)+m*60000).toISOString()
const base=(sid,cwd,m,extra={})=>({parentUuid:null,isSidechain:false,userType:'external',cwd,sessionId:sid,version:'2.0.0',gitBranch:'main',entrypoint:'cli',uuid:'u-'+sid.slice(0,4)+'-'+m,timestamp:T(m),...extra})
const user=(sid,cwd,m,content,extra)=>({...base(sid,cwd,m,extra),type:'user',message:{role:'user',content}})
const asst=(sid,cwd,m,content,extra)=>({...base(sid,cwd,m,extra),type:'assistant',requestId:'req',message:{id:'msg',type:'message',role:'assistant',model:'synthetic',content,stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}})
const tu=(name,input)=>({type:'tool_use',id:'tu_'+name,name,input,caller:{type:'direct'}})
const tr=(err=false)=>({type:'tool_result',tool_use_id:'tu',content:'synthetic output',...(err?{is_error:true}:{})})
const W='/work/demo-app'
const s1=[
 {type:'mode',mode:'normal',sessionId:S1},
 user(S1,W,0,'Add a --dry-run flag to the export command'),
 {type:'attachment',...base(S1,W,0),attachment:{type:'synthetic'}},
 asst(S1,W,1,[{type:'thinking',thinking:'SECRET-THOUGHT-should-never-appear',signature:'x'},{type:'text',text:'I will read the export module first.'},tu('Read',{file_path:'/work/demo-app/src/export.ts'})]),
 user(S1,W,1,[tr()]),
 asst(S1,W,3,[tu('Edit',{file_path:'/work/demo-app/src/export.ts',old_string:'a',new_string:'b'}),tu('Write',{file_path:'/work/demo-app/tests/export.test.ts',content:'x'})]),
 user(S1,W,3,[tr()]),
 asst(S1,W,5,[tu('Bash',{command:'npm test',description:'run tests'})]),
 user(S1,W,6,[tr(true)]),
 asst(S1,W,8,[tu('Bash',{command:'git add -A && git commit -m "feat: dry run"',description:'commit'})]),
 user(S1,W,8,[tr()]),
 asst(S1,W,9,[{type:'text',text:'Done. My key is sk-ABCDEFGHIJKLMNOPQRSTUV and that should be redacted.'}]),
 {type:'pr-link',sessionId:S1,prNumber:42,prRepository:'example/demo-app',prUrl:'https://example.invalid/pr/42',timestamp:T(10)},
 {type:'ai-title',sessionId:S1,aiTitle:'Add dry-run flag to export'},
 // after a 60 min idle gap → second segment of the same session
 user(S1,W,70,'<command-name>/clear</command-name>'),
 user(S1,W,71,'Now update the README for the flag'),
 asst(S1,W,72,[tu('Edit',{file_path:'/work/demo-app/README.md',old_string:'a',new_string:'b'})]),
 // drift
 {type:'brand-new-type',sessionId:S1,timestamp:T(72)},
 asst(S1,W,73,[{type:'mystery_block',x:1},{type:'text',text:'README updated.'}]),
 {type:'user',sessionId:S1,cwd:W,message:{role:'user',content:'no timestamp'}},
 '{not json',
]
const sub=[
 user(S1,W,4,'Review the export change for bugs',{isSidechain:true,agentId:'a1'}),
 asst(S1,W,4,[tu('Read',{file_path:'/work/demo-app/src/export.ts'})],{isSidechain:true,agentId:'a1'}),
 {type:'started',agentId:'a1',key:'k'},
]
// S2: parallel session in same project, starts 2 min after S1 ends first segment (merge gap 10 min)
const s2=[
 {type:'custom-title',sessionId:S2,customTitle:'Changelog'},
 {type:'ai-title',sessionId:S2,aiTitle:'should lose to custom title'},
 user(S2,W+'/.claude/worktrees/feature-x',12,'Write a changelog entry'),
 asst(S2,W+'/.claude/worktrees/feature-x',13,[tu('Edit',{file_path:'/work/demo-app/CHANGELOG.md',old_string:'a',new_string:'b'})]),
 user(S2,W+'/.claude/worktrees/feature-x',13,[tr()]),
]
// S3: different project, overlapping in time with S1
const s3=[
 user(S3,'/work/other',2,'What does this regex do?'),
 asst(S3,'/work/other',2,[{type:'text',text:'It matches ISO dates.'}]),
]
const w=(p,rows)=>fs.writeFileSync(p,rows.map(r=>typeof r==='string'?r:JSON.stringify(r)).join('\n')+'\n')
w(`${out}/claude/-work-demo-app/${S1}.jsonl`,s1)
w(`${out}/claude/-work-demo-app/${S1}/subagents/agent-a1.jsonl`,sub)
w(`${out}/claude/-work-demo-app/${S2}.jsonl`,s2)
w(`${out}/claude/-work-other/${S3}.jsonl`,s3)

// Codex current format
const C='44444444-4444-4444-8444-444444444444'
const ct=(m,type,payload)=>({timestamp:new Date(Date.UTC(2025,8,1,14,0,0)+m*60000).toISOString(),type,payload})
const ri=(m,p)=>ct(m,'response_item',p)
const codex=[
 ct(0,'session_meta',{id:C,timestamp:T(240),cwd:'/work/codex-proj',originator:'codex_cli_rs',cli_version:'0.30.0',instructions:null,git:{branch:'main'}}),
 ri(0,{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>\n  <cwd>/work/codex-proj</cwd>\n</environment_context>'}]}),
 ct(0,'turn_context',{cwd:'/work/codex-proj',approval_policy:'on-request',sandbox_policy:{mode:'workspace-write'},model:'synthetic',effort:'medium',summary:'auto'}),
 ri(1,{type:'message',role:'user',content:[{type:'input_text',text:'Fix the failing parser test'}]}),
 ct(1,'event_msg',{type:'user_message',message:'Fix the failing parser test',images:[]}),
 ri(2,{type:'reasoning',summary:[{type:'summary_text',text:'SECRET-REASONING'}],content:null,encrypted_content:'x'}),
 ri(2,{type:'function_call',name:'shell',arguments:JSON.stringify({command:['bash','-lc','npm test'],workdir:'/work/codex-proj'}),call_id:'c1'}),
 ri(3,{type:'function_call_output',call_id:'c1',output:JSON.stringify({output:'fail',metadata:{exit_code:1,duration_seconds:1}})}),
 ri(4,{type:'custom_tool_call',status:'completed',call_id:'c2',name:'apply_patch',input:'*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-a\n+b\n*** Add File: tests/parser.extra.test.ts\n+x\n*** End Patch'}),
 ri(4,{type:'custom_tool_call_output',call_id:'c2',output:'Success'}),
 ri(5,{type:'function_call',name:'shell',arguments:JSON.stringify({command:['apply_patch','*** Begin Patch\n*** Update File: src/util.ts\n@@\n-a\n+b\n*** End Patch']}),call_id:'c3'}),
 ri(6,{type:'function_call',name:'shell',arguments:JSON.stringify({command:['bash','-lc','git commit -am fix && git push']}),call_id:'c4'}),
 ct(6,'event_msg',{type:'token_count',info:null}),
 ri(7,{type:'message',role:'assistant',content:[{type:'output_text',text:'Fixed the parser test.'}]}),
 ct(7,'brand_new_top',{}),
 ri(7,{type:'mystery_item'}),
]
w(`${out}/codex/2025/09/01/rollout-2025-09-01T14-00-00-${C}.jsonl`,codex)
// Codex legacy format
const L='55555555-5555-4555-8555-555555555555'
const legacy=[
 {id:L,timestamp:'2025-05-01T09:00:00.000Z',instructions:null},
 {record_type:'state'},
 {type:'message',role:'user',content:[{type:'input_text',text:'legacy prompt'}]},
 {type:'message',role:'assistant',content:[{type:'output_text',text:'legacy answer'}]},
]
w(`${out}/codex/2025/09/01/rollout-2025-05-01T09-00-00-${L}.jsonl`,legacy)
