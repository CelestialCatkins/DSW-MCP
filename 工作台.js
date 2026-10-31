// ==UserScript==
// @name         DSW 单文工作台 + MCP
// @namespace    dsw-single-text
// @version      0.6.0
// @description  单篇纯文本 AI 驾驶工作台：编辑、定位、历史回溯、自动回传与 MCP
// @match        https://chat.deepseek.com/*
// @match        https://www.deepseek.com/*
// @grant        none
// ==/UserScript==

(function(){
'use strict';

const VERSION='0.6.0';
const STORE_PREFIX='dsw.single.';
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const uid=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);
const hash=s=>{
  let h=2166136261;
  for(let i=0;i<s.length;i++){
    h^=s.charCodeAt(i);
    h=Math.imul(h,16777619);
  }
  return (h>>>0).toString(36);
};

const store={
  get(key,def){
    try{
      const v=localStorage.getItem(STORE_PREFIX+key);
      return v==null?def:JSON.parse(v);
    }catch(e){
      return def;
    }
  },
  set(key,value){
    try{
      localStorage.setItem(STORE_PREFIX+key,JSON.stringify(value));
    }catch(e){}
  }
};

let cfg=store.get('config',{
  theme:'auto',
  paused:false,
  autoReturn:true,
  mergeDraft:true,
  autoBootstrap:true,
  mcpRisk:'partial'
});

let doc=store.get('document',{text:''});
if(!doc||typeof doc.text!=='string')doc={text:''};

let savePoints=store.get('history',[]);
if(!Array.isArray(savePoints))savePoints=[];

let mcpServers=store.get('mcp.servers',[]);
if(!Array.isArray(mcpServers))mcpServers=[];

let callHistory=store.get('mcp.calls',[]);
if(!Array.isArray(callHistory))callHistory=[];

let receipts=store.get('receipts',[]);
if(!Array.isArray(receipts))receipts=[];

let panel,host,root,editor,ball;
let ballPos=store.get('ball.position',null);
let currentTab='article';
let dirty=false;
let timelineDraft=null;
let scanBusy=false;
let seenBlocks=new Set();

function saveCfg(){store.set('config',cfg)}
function saveDoc(){store.set('document',doc)}
function saveHistory(){store.set('history',savePoints)}
function saveMcp(){store.set('mcp.servers',mcpServers)}
function saveCalls(){store.set('mcp.calls',callHistory)}
function saveReceipts(){store.set('receipts',receipts)}

function nowText(t){
  try{
    return new Date(t).toLocaleString('zh-CN',{
      month:'2-digit',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit'
    });
  }catch(e){
    return '';
  }
}

function esc(s){
  return String(s??'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function colors(){
  const dark=cfg.theme==='dark'||(
    cfg.theme==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches
  );
  if(dark){
    return {
      bg:'#15171b',
      sf:'#1e2127',
      fg:'#e7e9ed',
      dim:'#9399a5',
      ln:'#30343c',
      ac:'#6d8cff',
      er:'#ff6b78'
    };
  }
  return {
    bg:'#f5f6f8',
    sf:'#ffffff',
    fg:'#20242b',
    dim:'#727986',
    ln:'#e2e5ea',
    ac:'#4e6fe8',
    er:'#d84a5b'
  };
}

function toast(text){
  let el=root?.querySelector('.toast');
  if(!el){
    el=document.createElement('div');
    el.className='toast';
    root.appendChild(el);
  }
  el.textContent=text;
  el.classList.add('on');
  clearTimeout(el._timer);
  el._timer=setTimeout(()=>el.classList.remove('on'),2200);
}

function css(){
 const c=colors();
 return `:host{all:initial}
 *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
 button,input,textarea{font:inherit}
 .ball{position:fixed;z-index:2147483647;left:calc(var(--bx,100vw - 72px));top:calc(var(--by,100dvh - 92px));width:56px;height:56px;border-radius:50%;border:1px solid ${c.ln};background:${c.sf};color:${c.ac};box-shadow:0 10px 30px #0004;display:grid;place-items:center;font-weight:850;font-size:14px;cursor:grab;user-select:none;touch-action:none;transition:transform .18s,box-shadow .18s;will-change:left,top}
 .ball:active{transform:scale(.93);cursor:grabbing}.ball.drag{transition:none;transform:scale(.96)}
 .panel{position:fixed;z-index:2147483646;right:16px;bottom:84px;width:min(760px,calc(100vw - 24px));height:min(84vh,820px);background:${c.bg};color:${c.fg};border:1px solid ${c.ln};border-radius:22px;box-shadow:0 24px 80px #0006;overflow:hidden;display:none;flex-direction:column}
 .panel.on{display:flex}
 .head{padding:15px 18px 12px;border-bottom:1px solid ${c.ln};background:linear-gradient(180deg,${c.sf},${c.bg});display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
 .title{font-weight:800;font-size:17px;letter-spacing:.2px}.sub{font-size:12px;color:${c.dim};margin-top:4px}
 .tabs{display:flex;gap:7px;padding:9px 12px;border-bottom:1px solid ${c.ln};align-items:center;background:${c.sf};overflow:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
 .tabs button,.btn{border:1px solid ${c.ln};background:${c.sf};color:${c.fg};border-radius:11px;padding:8px 11px;cursor:pointer;transition:background .15s,transform .15s,border-color .15s}
 .tabs button:active,.btn:active{transform:scale(.97)}.tabs button.on,.btn.pri{background:${c.ac};border-color:${c.ac};color:#fff}.btn.danger{color:${c.er}}
 .more{position:relative;margin-left:auto}.more summary{list-style:none}.more summary::-webkit-details-marker{display:none}.more[open] summary{border-color:${c.ac}}.more-menu{position:absolute;right:0;top:calc(100% + 7px);z-index:4;width:160px;padding:6px;background:${c.sf};border:1px solid ${c.ln};border-radius:13px;box-shadow:0 12px 32px #0003}.more-menu button{width:100%;text-align:left;border:0;background:transparent;color:${c.fg};padding:9px;border-radius:8px;cursor:pointer}.more-menu button:hover{background:${c.bg}}
 .body{flex:1;min-height:0;overflow:auto;padding:14px;overscroll-behavior:contain}.article{height:100%;display:flex;flex-direction:column;gap:10px}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{font-size:12px;color:${c.dim};margin-left:auto}
 .editor{flex:1;width:100%;resize:none;border:1px solid ${c.ln};border-radius:15px;background:${c.sf};color:${c.fg};padding:15px;font:14px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;box-shadow:inset 0 1px 0 #00000008}.editor:focus{border-color:${c.ac};box-shadow:0 0 0 3px ${c.ac}22}
 .quick{display:flex;gap:6px;flex-wrap:wrap}.quick .btn{padding:6px 9px;font-size:12px}
 .card{background:${c.sf};border:1px solid ${c.ln};border-radius:15px;padding:14px;margin-bottom:10px}.card h3{margin:0 0 7px;font-size:14px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .inp{width:100%;border:1px solid ${c.ln};background:${c.bg};color:${c.fg};border-radius:10px;padding:10px;outline:none}.inp:focus{border-color:${c.ac}}
 .small{font-size:12px;color:${c.dim};white-space:pre-wrap}.badge{display:inline-block;font-size:11px;border:1px solid ${c.ln};padding:3px 7px;border-radius:999px;color:${c.dim};background:${c.bg}}
 .toast{position:fixed;z-index:2147483647;left:50%;bottom:18px;max-width:calc(100vw - 28px);transform:translateX(-50%) translateY(100px);background:${c.fg};color:${c.bg};padding:10px 14px;border-radius:12px;box-shadow:0 8px 25px #0004;transition:.22s;font-size:13px;text-align:center}.toast.on{transform:translateX(-50%) translateY(0)}
 .tl{position:relative;margin:10px 0 0 12px;border-left:2px solid ${c.ln};padding-left:18px}.tl-i{position:relative;text-align:left;width:100%;background:${c.sf};border:1px solid ${c.ln};color:${c.fg};border-radius:12px;padding:11px;margin-bottom:9px;cursor:pointer}.tl-i:before{content:"";position:absolute;width:10px;height:10px;border-radius:50%;left:-24px;top:16px;background:${c.ac};border:3px solid ${c.bg}}.tl-i.on{outline:2px solid ${c.ac}}.tl-i b{display:block}
 .log{font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;max-height:200px;overflow:auto}.tool{border-top:1px solid ${c.ln};padding:10px 0}.tool:first-child{border-top:0}.split{display:grid;grid-template-columns:1fr 1fr;gap:8px}
 @media(max-width:620px){.panel{right:0;bottom:0;width:100vw;height:100dvh;max-height:none;border-radius:0;border:0}.ball{width:52px;height:52px;border-radius:17px}.head{padding:12px 14px 10px}.sub{display:none}.tabs{padding:8px 10px}.tabs button,.btn{padding:8px 10px}.body{padding:10px}.editor{padding:12px;border-radius:12px;font-size:15px}.muted{width:100%;margin-left:0}.split{grid-template-columns:1fr}.more-menu{position:fixed;right:10px;top:102px;width:180px}.card{padding:12px}}
 @media(max-width:390px){.tabs button{padding:7px 9px}.title{font-size:16px}.bar>.btn{flex:1}.quick .btn{flex:1}.editor{font-size:14px}}
 `;
}

function clampBall(x,y){
  const w=ball?.offsetWidth||56,h=ball?.offsetHeight||56;
  return {
    x:Math.max(8,Math.min(innerWidth-w-8,Number(x)||8)),
    y:Math.max(8,Math.min(innerHeight-h-8,Number(y)||8))
  };
}
function applyBallPosition(){
  if(!ball)return;
  const fallback={x:innerWidth-(ball.offsetWidth||56)-16,y:Math.max(16,innerHeight-(ball.offsetHeight||56)-96)};
  const p=clampBall(ballPos?.x??fallback.x,ballPos?.y??fallback.y);
  ball.style.setProperty('--bx',p.x+'px');
  ball.style.setProperty('--by',p.y+'px');
}
function installBallGesture(){
  let down=null,moved=false,lastTap=0,longTimer=0;
  ball.addEventListener('pointerdown',e=>{
    if(e.button!=null&&e.button!==0)return;
    const r=ball.getBoundingClientRect();
    down={id:e.pointerId,x:e.clientX,y:e.clientY,ox:r.left,oy:r.top};
    moved=false; ball.setPointerCapture?.(e.pointerId);
    longTimer=setTimeout(()=>{if(!moved){toast('正在重新识别命令');scanStableMessages(true);}},650);
  });
  ball.addEventListener('pointermove',e=>{
    if(!down||e.pointerId!==down.id)return;
    const dx=e.clientX-down.x,dy=e.clientY-down.y;
    if(Math.abs(dx)+Math.abs(dy)>7){
      moved=true;clearTimeout(longTimer);ball.classList.add('drag');
      const p=clampBall(down.ox+dx,down.oy+dy);
      ball.style.setProperty('--bx',p.x+'px');ball.style.setProperty('--by',p.y+'px');
    }
  });
  const finish=e=>{
    if(!down||e.pointerId!==down.id)return;
    clearTimeout(longTimer);
    if(moved){
      const r=ball.getBoundingClientRect();
      ballPos=clampBall(r.left,r.top);store.set('ball.position',ballPos);
      ball.classList.remove('drag');down=null;return;
    }
    down=null;
    const now=Date.now();
    if(now-lastTap<280){cfg.paused=!cfg.paused;saveCfg();toast(cfg.paused?'命令识别已暂停':'命令识别已恢复');lastTap=0;return;}
    lastTap=now;
    setTimeout(()=>{if(lastTap===now){panel.classList.toggle('on');if(panel.classList.contains('on'))render();lastTap=0;}},290);
  };
  ball.addEventListener('pointerup',finish);
  ball.addEventListener('pointercancel',finish);
  window.addEventListener('resize',applyBallPosition);
}
function mount(){
  if(host)return;
  host=document.createElement('div');host.id='dsw-single-host';document.documentElement.appendChild(host);
  root=host.attachShadow({mode:'open'});
  const style=document.createElement('style');style.textContent=css();
  ball=document.createElement('button');ball.className='ball';ball.type='button';ball.textContent='DSW';
  panel=document.createElement('div');panel.className='panel';
  panel.innerHTML=`<div class="head"><div><div class="title">DSW 单文工作台</div><div class="sub">单篇纯文本 · AI 驾驶 · 历史回溯 · MCP</div></div><button class="btn" id="close">关闭</button></div><div class="tabs"></div><div class="body"></div>`;
  root.append(style,ball,panel);applyBallPosition();installBallGesture();
  panel.querySelector('#close').onclick=()=>panel.classList.remove('on');
}
function reroot(){
  if(!host)return;
  root.querySelector('style').textContent=css();
  if(panel.classList.contains('on'))render();
}

function writeSavePoint(reason){
  const point={
    id:uid(),
    at:Date.now(),
    text:doc.text,
    reason:reason||'保存',
    hash:hash(doc.text)
  };
  savePoints.unshift(point);
  if(savePoints.length>100)savePoints.length=100;
  saveHistory();
  return point;
}

function applyText(text,reason){
  doc.text=String(text??'');
  saveDoc();
  if(editor)editor.value=doc.text;
  if(reason)writeSavePoint(reason);
}

function pushCall(item){
  callHistory.unshift(item);
  if(callHistory.length>80)callHistory.length=80;
  saveCalls();
}

function receipt(title,lines,ok=true){
  const item={
    id:uid(),
    at:Date.now(),
    title,
    lines:Array.isArray(lines)?lines:[String(lines)],
    ok
  };
  receipts.unshift(item);
  if(receipts.length>100)receipts.length=100;
  saveReceipts();
  if(cfg.autoReturn)queueAutoReturn(formatReceipt(item));
  return item;
}

function formatReceipt(item){
  const state=item.ok?'成功':'失败';
  return `【DSW 回执 · ${state}】\n${item.title}\n${item.lines.join('\n')}`;
}

function assistantText(node){
  return (node?.innerText||node?.textContent||'').trim();
}

function parseQuoted(line){
  const out=[];
  const re=/"((?:\\.|[^"\\])*)"/g;
  let m;
  while((m=re.exec(line))){
    try{
      out.push(JSON.parse('"'+m[1].replace(/"/g,'\\"')+'"'));
    }catch(e){
      out.push(m[1]);
    }
  }
  return out;
}

function extractDomains(text){
  const out=[];
  const tag=/<dsw\b[^>]*>([\s\S]*?)<\/dsw>/gi;
  let m;
  while((m=tag.exec(text)))out.push(m[1].trim());
  const fence=/```dsw\s*\n([\s\S]*?)```/gi;
  while((m=fence.exec(text)))out.push(m[1].trim());
  return out;
}

function scanLegacyDomains(){
  if(cfg.paused)return;
  const nodes=[
    ...document.querySelectorAll('[data-message-author-role="assistant"]'),
    ...document.querySelectorAll('.ds-markdown')
  ];
  for(const node of nodes){
    const text=assistantText(node);
    if(!text)continue;
    for(const raw of extractDomains(text)){
      const id='dsw:'+hash(raw);
      if(seenBlocks.has(id))continue;
      seenBlocks.add(id);
      executeDomain(raw);
    }
  }
}

let returnQueue=[];
let returning=false;

function queueAutoReturn(text){
  returnQueue.push(text);
  drainReturn();
}

async function drainReturn(){
 if(returning||!returnQueue.length)return;
 returning=true;
 try{
   while(returnQueue.length){
     const gate=await waitComposerStable(5000);
     if(!gate.ok){
       toast('输入区未稳定，回执保留等待');
       break;
     }
     const c=gate.el;
     const own=returnQueue.splice(0).join('\n\n');
     const old=getComposerText(c).trim();
     const payload=old&&cfg.mergeDraft?old+'\n\n---\n\n'+own:own;
     if(!setComposerText(c,payload)){
       returnQueue.unshift(own);
       break;
     }
     await sleep(180);
     const btn=pickSendButton();
     if(btn&&!btn.disabled){
       btn.click();
       await sleep(900);
     }else{
       toast('回执已写入输入框，等待手动发送');
       break;
     }
   }
 }finally{
   returning=false;
 }
}

function renderReceipts(body){
  let html='<div class="card"><h3>回执中心</h3><div class="small">文章命令与 MCP 调用的执行结果会集中记录在这里。</div></div>';
  if(!receipts.length){
    html+='<div class="card"><div class="small">暂无回执</div></div>';
  }else{
    html+=receipts.map(x=>`<div class="card"><div class="row"><b>${esc(x.title)}</b><span class="badge">${x.ok?'成功':'失败'}</span></div><div class="small">${nowText(x.at)}</div><div class="log">${esc(x.lines.join('\n'))}</div></div>`).join('');
  }
  body.innerHTML=html;
}

function risk(tool){
  const name=String(tool?.name||'').toLowerCase();
  const desc=String(tool?.description||'').toLowerCase();
  if(/write|delete|remove|update|create|insert|patch|execute|run|shell|command/.test(name+' '+desc))return 'write';
  return 'read';
}

function sess(server){
  server._session=server._session||{
    id:'',
    tools:[],
    toolsAt:0
  };
  return server._session;
}

function enabledServers(){
  return mcpServers.filter(s=>s&&s.enabled!==false&&s.url);
}

async function mcpRequest(server,body,signal){
  const st=sess(server);
  const headers=Object.assign(
    {
      'Content-Type':'application/json',
      'Accept':'application/json, text/event-stream'
    },
    server.headers||{}
  );
  if(st.id)headers['Mcp-Session-Id']=st.id;
  const res=await fetch(server.url.replace(/\/+$/,''),{
    method:'POST',
    headers,
    body:JSON.stringify(body),
    signal
  });
  if(!res.ok)throw Error('HTTP '+res.status+' '+res.statusText);
  const sid=res.headers.get('mcp-session-id');
  if(sid)st.id=sid;
  const raw=await res.text();
  let data=null;
  if((res.headers.get('content-type')||'').includes('text/event-stream')){
    raw.split(/\r?\n/).forEach(line=>{
      if(line.trim().startsWith('data:')){
        try{
          data=JSON.parse(line.trim().slice(5));
        }catch(e){}
      }
    });
  }else{
    data=JSON.parse(raw);
  }
  if(data?.error)throw Error(data.error.message||JSON.stringify(data.error));
  return data?.result??data??{};
}

async function initialize(server){
  const st=sess(server);
  if(st.initialized)return;
  const result=await mcpRequest(server,{
    jsonrpc:'2.0',
    id:uid(),
    method:'initialize',
    params:{
      protocolVersion:'2025-03-26',
      capabilities:{},
      clientInfo:{
        name:'DSW Single',
        version:VERSION
      }
    }
  });
  st.initialized=true;
  try{
    await mcpRequest(server,{
      jsonrpc:'2.0',
      method:'notifications/initialized',
      params:{}
    });
  }catch(e){}
  return result;
}

async function listTools(server,refresh=false){
  const st=sess(server);
  if(!refresh&&st.tools?.length&&Date.now()-st.toolsAt<5*60*1000)return st.tools;
  await initialize(server);
  const result=await mcpRequest(server,{
    jsonrpc:'2.0',
    id:uid(),
    method:'tools/list',
    params:{}
  });
  st.tools=Array.isArray(result?.tools)?result.tools:[];
  st.toolsAt=Date.now();
  return st.tools;
}

const UPGRADE_KEY='dsw.single.bootstrap';
const MCP_JOBS=new Map();
const MCP_IDEM=new Map();
const MCP_IDEM_WINDOW=90000;
const COMPOSER_STABLE_MS=550;

function isVisibleEl(el){
  if(!el||!el.isConnected)return false;
  const r=el.getBoundingClientRect();
  if(!r||r.width<8||r.height<8)return false;
  const cs=getComputedStyle(el);
  return cs.display!=='none'&&cs.visibility!=='hidden'&&Number(cs.opacity||1)!==0;
}

function resolveEditableTarget(el){
  if(!el)return null;
  if(el.matches&&el.matches('textarea,input:not([type]),input[type="text"],[contenteditable="true"],[role="textbox"]'))return el;
  try{
    return el.querySelector('textarea,[contenteditable="true"],[role="textbox"],input[type="text"]');
  }catch(e){
    return null;
  }
}

function composerScore(el){
  if(!isVisibleEl(el))return -1;
  const r=el.getBoundingClientRect();
  const vh=innerHeight||800;
  let score=0;
  if(r.bottom>vh*.48)score+=30;
  if(r.width>120)score+=15;
  if(el.id==='chat-input')score+=100;
  const ph=(el.getAttribute('placeholder')||'').toLowerCase();
  if(/message|消息|输入|问|chat/.test(ph))score+=20;
  const cls=(el.className||'').toString().toLowerCase();
  if(/chat|input|composer|textarea/.test(cls))score+=20;
  return score;
}

function findComposer(){
  const selectors=[
    '#chat-input',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];
  const all=[];
  for(const sel of selectors){
    try{
      document.querySelectorAll(sel).forEach(x=>{
        const e=resolveEditableTarget(x);
        if(e&&!all.includes(e))all.push(e);
      });
    }catch(e){}
  }
  all.sort((a,b)=>composerScore(b)-composerScore(a));
  return all.length&&composerScore(all[0])>=20?all[0]:null;
}

function getComposerText(el){
  el=resolveEditableTarget(el)||el;
  return !el?'':(
    el.matches&&el.matches('textarea,input')
      ?el.value
      :(el.innerText||el.textContent||'')
  );
}

function setComposerText(el,text){
  el=resolveEditableTarget(el)||el;
  if(!el)return false;
  if(el.matches&&el.matches('textarea,input')){
    const proto=el.tagName==='TEXTAREA'
      ?HTMLTextAreaElement.prototype
      :HTMLInputElement.prototype;
    const d=Object.getOwnPropertyDescriptor(proto,'value');
    if(d&&d.set)d.set.call(el,text);
    else el.value=text;
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  }
  try{
    el.focus();
    const sel=getSelection();
    const range=document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    const before=getComposerText(el);
    let ok=false;
    try{
      ok=document.execCommand('insertText',false,text);
    }catch(e){}
    if(!ok||getComposerText(el)===before){
      el.textContent=text;
      el.dispatchEvent(new InputEvent('input',{
        bubbles:true,
        inputType:'insertText',
        data:text
      }));
    }
    return true;
  }catch(e){
    return false;
  }
}

function pickSendButton(){
  const c=findComposer();
  if(!c)return null;
  const cr=c.getBoundingClientRect();
  const candidates=new Set();
  let p=c;
  for(let i=0;i<5&&p;i++,p=p.parentElement){
    try{
      p.querySelectorAll('button,[role="button"]').forEach(x=>candidates.add(x));
    }catch(e){}
  }
  try{
    document.querySelectorAll('button,[role="button"]').forEach(x=>{
      if(isVisibleEl(x)){
        const r=x.getBoundingClientRect();
        if(r.bottom>cr.top-80&&r.top<cr.bottom+180)candidates.add(x);
      }
    });
  }catch(e){}
  let best=null;
  let bestScore=-1;
  for(const b of candidates){
    if(!isVisibleEl(b)||b.disabled)continue;
    const label=(
      (b.getAttribute('aria-label')||'')+' '+
      (b.getAttribute('title')||'')+' '+
      (b.innerText||'')+' '+
      (b.className||'')
    ).toLowerCase();
    if(/sidebar|menu|search|history|setting|新对话|new chat|停止|stop|clear|关闭/.test(label))continue;
    const r=b.getBoundingClientRect();
    let sc=0;
    if(/发送|send|submit|提交/.test(label))sc+=100;
    if(/primary|filled/.test(label))sc+=20;
    if(r.left>=cr.left-80&&r.right<=cr.right+160)sc+=20;
    if(r.top>=cr.top-100&&r.bottom<=cr.bottom+180)sc+=15;
    if(sc>bestScore){
      best=b;
      bestScore=sc;
    }
  }
  return bestScore>=30?best:null;
}

let stableProbe={el:null,text:'',at:0};

async function waitComposerStable(timeout=5000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const c=findComposer();
    if(c&&isVisibleEl(c)){
      const t=getComposerText(c);
      if(
        stableProbe.el===c&&
        stableProbe.text===t&&
        Date.now()-stableProbe.at>=COMPOSER_STABLE_MS
      )return {ok:true,el:c};
      stableProbe={el:c,text:t,at:Date.now()};
    }
    await sleep(120);
  }
  return {ok:false,reason:'DeepSeek 输入区未稳定'};
}

function currentConversationKey(){
  const p=location.pathname||'/';
  const m=p.match(/(?:chat|conversation|c)\/([^/?#]+)/i);
  return m?'ds:'+m[1]:'root:'+p;
}

function bootstrapPayload(){
  return '【DSW 单文工作台：本会话操作协议】\n'+
    '程序只维护当前工作台中的一篇纯文本文章，不存在文件、目录或路径。\n'+
    '仅执行 <dsw>...</dsw> 或 ```dsw 代码块中的命令；支持 read、find、replace、insert、delete、save。\n'+
    '文章编辑后会生成历史保存点，可双向回溯。\n'+
    'MCP 使用 ```mcp 代码块，支持 mcp tools/schema/call/wait/jobs/kill；调用前应先了解工具与参数。';
}

let bootKey='';
let bootTimer=0;

async function maybeBootstrap(force=false){
  if(cfg.autoBootstrap===false)return;
  const key=currentConversationKey();
  if(!force&&key===bootKey)return;
  const seen=store.get(UPGRADE_KEY,{});
  if(!force&&seen[key]){
    bootKey=key;
    return;
  }
  const gate=await waitComposerStable(3500);
  if(!gate.ok)return;
  if(getComposerText(gate.el).trim())return;
  if(!setComposerText(gate.el,bootstrapPayload()))return;
  const btn=pickSendButton();
  if(btn&&!btn.disabled){
    btn.click();
    seen[key]=Date.now();
    store.set(UPGRADE_KEY,seen);
    bootKey=key;
    toast('已为新对话注入 DSW 操作协议');
  }
}

function watchConversation(){
  const key=currentConversationKey();
  if(key!==bootKey){
    clearTimeout(bootTimer);
    bootTimer=setTimeout(()=>maybeBootstrap(false),800);
  }
}

function commandFingerprint(raw){
  return hash(String(raw).replace(/\s+/g,' ').trim());
}

function commandDomainSafe(raw){
  if(!raw||raw.length>120000)return {ok:false,error:'执行域为空或过长'};
  if(/<script\b|<\/script>|javascript:/i.test(raw)){
    return {ok:false,error:'执行域包含不允许的脚本内容'};
  }
  return {ok:true};
}

function jobLines(job){
  const sec=Math.max(
    0,
    Math.round(((job.endedAt||Date.now())-job.startedAt)/1000)
  );
  return [`${job.id} · ${job.tool.name} · ${job.state} · ${sec}s`];
}

function startMcpJob(server,tool,args,timeout){
  const job={
    id:'J'+uid(),
    server,
    tool,
    args,
    state:'running',
    startedAt:Date.now(),
    endedAt:0,
    result:null,
    error:'',
    reported:false,
    controller:new AbortController()
  };
  MCP_JOBS.set(job.id,job);
  const effective=timeout||120000;
  job.promise=(async()=>{
    try{
      const st=sess(server);
      const headers=Object.assign(
        {
          'Content-Type':'application/json',
          'Accept':'application/json, text/event-stream'
        },
        server.headers||{}
      );
      if(st.id)headers['Mcp-Session-Id']=st.id;
      const timer=setTimeout(()=>job.controller.abort(),effective);
      let res;
      try{
        res=await fetch(server.url.replace(/\/+$/,''),{
          method:'POST',
          headers,
          body:JSON.stringify({
            jsonrpc:'2.0',
            id:uid(),
            method:'tools/call',
            params:{
              name:tool.name,
              arguments:args||{}
            }
          }),
          signal:job.controller.signal
        });
      }finally{
        clearTimeout(timer);
      }
      if(!res.ok)throw Error('HTTP '+res.status+' '+res.statusText);
      const sid=res.headers.get('mcp-session-id');
      if(sid)st.id=sid;
      const raw=await res.text();
      let data=null;
      if((res.headers.get('content-type')||'').includes('text/event-stream')){
        raw.split(/\r?\n/).forEach(l=>{
          if(l.trim().startsWith('data:')){
            try{
              data=JSON.parse(l.trim().slice(5));
            }catch(e){}
          }
        });
      }else{
        data=JSON.parse(raw);
      }
      if(data&&data.error)throw Error(data.error.message||JSON.stringify(data.error));
      job.result=data&&data.result||data||{};
      job.state='done';
    }catch(e){
      job.state=job.state==='killed'?'killed':'fail';
      job.error=e&&e.name==='AbortError'
        ?'任务已中止'
        :(e.message||String(e));
    }
    job.endedAt=Date.now();
    const text=job.state==='done'
      ?JSON.stringify(job.result,null,2).slice(0,12000)
      :job.error;
    pushCall({
      id:job.id,
      at:job.startedAt,
      server:job.server.name||job.server.url,
      tool:job.tool.name,
      ok:job.state==='done',
      result:text
    });
    if(!job.reported){
      job.reported=true;
      receipt(
        'MCP '+(job.state==='done'?'完成':'结束')+' · '+job.tool.name,
        [job.id,'状态：'+job.state,text],
        job.state==='done'
      );
    }
    return job;
  })();
  return job;
}

function findMcpTool(ref){
  const dot=String(ref||'').indexOf('.');
  return {
    serverRef:dot>0?ref.slice(0,dot):'',
    toolName:dot>0?ref.slice(dot+1):String(ref||'')
  };
}

async function handleMcpCommand(raw){
  const text=raw.trim().replace(/^mcp\s+/i,'');
  const [head,...tail]=text.split('\n');
  const toks=head.trim().split(/\s+/);
  const sub=(toks.shift()||'status').toLowerCase();

  if(sub==='jobs'){
    const rows=[...MCP_JOBS.values()]
      .sort((a,b)=>b.startedAt-a.startedAt)
      .map(j=>jobLines(j).join(''));
    receipt('MCP 任务列表',rows.length?rows:['暂无后台任务'],true);
    return;
  }

  if(sub==='kill'){
    const ids=toks;
    const out=[];
    ids.forEach(id=>{
      const j=MCP_JOBS.get(id);
      if(!j){
        out.push(id+'：不存在');
        return;
      }
      if(j.state!=='running'){
        out.push(id+'：已是 '+j.state);
        return;
      }
      j.state='killed';
      j.controller.abort();
      out.push(id+'：已请求终止');
    });
    receipt('MCP kill',out,true);
    return;
  }

  if(sub==='wait'){
    const timeoutTok=toks.find(x=>/^timeout=/.test(x));
    const timeout=timeoutTok
      ?Math.max(1000,+timeoutTok.split('=')[1]||60000)
      :60000;
    const ids=toks.filter(x=>!/^timeout=/.test(x));
    const jobs=ids.map(id=>MCP_JOBS.get(id)).filter(Boolean);
    if(!jobs.length){
      receipt('MCP wait',['没有找到任务'],false);
      return;
    }
    const race=Promise.all(jobs.map(j=>j.promise));
    let timer;
    const timed=await Promise.race([
      race,
      new Promise(r=>timer=setTimeout(()=>r(null),timeout))
    ]);
    clearTimeout(timer);
    receipt(
      'MCP wait',
      timed
        ?timed.map(j=>jobLines(j).join(''))
        :jobs.map(j=>j.id+'：仍在运行'),
      true
    );
    return;
  }

  if(sub==='tools'||sub==='schema'){
    const name=toks.join(' ');
    const all=[];
    for(const server of enabledServers()){
      try{
        const ts=await listTools(
          server,
          sub==='tools'&&/\brefresh\b/.test(name)
        );
        ts.forEach(t=>all.push({server,t}));
      }catch(e){}
    }

    if(sub==='tools'){
      const q=name.replace(/\brefresh\b/g,'').trim().toLowerCase();
      const rows=all
        .filter(x=>
          !q||
          x.t.name.toLowerCase().includes(q)||
          String(x.t.description||'').toLowerCase().includes(q)
        )
        .slice(0,40)
        .map(x=>
          `${x.server.name||x.server.url}.${x.t.name} `+
          `[${risk(x.t)}] ${x.t.description||''}`
        );
      receipt('MCP tools',rows.length?rows:['未找到工具'],true);
      return;
    }

    const hit=
      all.find(x=>x.t.name.toLowerCase()===name.toLowerCase())||
      all.find(x=>x.t.name.toLowerCase().includes(name.toLowerCase()));

    receipt(
      'MCP schema',
      hit
        ?[
          hit.server.name||hit.server.url,
          hit.t.name,
          String(hit.t.description||''),
          JSON.stringify(hit.t.inputSchema||{},null,2)
        ]
        :['找不到工具：'+name],
      !!hit
    );
    return;
  }

  if(sub==='call'){
    let nowait=false;
    let timeout=30000;
    const rest=toks.filter(x=>{
      if(x==='nowait'){
        nowait=true;
        return false;
      }
      if(/^timeout=/.test(x)){
        timeout=+x.split('=')[1]||30000;
        return false;
      }
      return true;
    });

    const ref=rest.shift();
    let args={};
    const body=tail.join('\n').trim();

    if(body){
      try{
        args=JSON.parse(body);
      }catch(e){
        receipt('MCP 参数错误',[e.message],false);
        return;
      }
    }

    const tr=findMcpTool(ref);
    let server=tr.serverRef
      ?enabledServers().find(s=>(s.name||s.id)===tr.serverRef)
      :null;
    let tool=null;

    if(server){
      tool=(await listTools(server)).find(t=>t.name===tr.toolName);
    }else{
      for(const s of enabledServers()){
        const t=(await listTools(s)).find(x=>x.name===tr.toolName);
        if(t){
          server=s;
          tool=t;
          break;
        }
      }
    }

    if(!server||!tool){
      receipt('MCP 调用失败',['找不到工具：'+ref],false);
      return;
    }

    const idemKey=server.id+'|'+tool.name+'|'+JSON.stringify(args);

    if(
      risk(tool)==='read'&&
      MCP_IDEM.has(idemKey)&&
      Date.now()-MCP_IDEM.get(idemKey)<MCP_IDEM_WINDOW
    ){
      receipt(
        'MCP 调用跳过',
        ['90 秒内已调用相同只读工具'],
        true
      );
      return;
    }

    if(risk(tool)==='write'&&cfg.mcpRisk==='never'){
      receipt(
        'MCP 调用拒绝',
        ['风险模式禁止写入类工具'],
        false
      );
      return;
    }

    if(
      risk(tool)==='write'&&
      cfg.mcpRisk==='partial'&&
      !confirm(
        'MCP 工具可能产生写入或执行：'+tool.name+
        '\n是否允许？'
      )
    ){
      receipt('MCP 调用取消',['用户拒绝'],false);
      return;
    }

    if(risk(tool)==='read')MCP_IDEM.set(idemKey,Date.now());

    const job=startMcpJob(
      server,
      tool,
      args,
      Math.max(timeout,120000)
    );

    if(nowait){
      receipt(
        'MCP 已后台执行',
        [
          job.id,
          '使用 mcp wait '+job.id+' 获取状态；完成后会自动回传'
        ],
        true
      );
      return;
    }

    let timer;
    const done=await Promise.race([
      job.promise,
      new Promise(r=>timer=setTimeout(()=>r(null),timeout))
    ]);
    clearTimeout(timer);

    if(!done){
      receipt(
        'MCP 已转后台',
        [
          job.id,
          '超过前台等待时间；使用 mcp wait '+job.id+
          ' / mcp jobs / mcp kill '+job.id
        ],
        true
      );
    }
    return;
  }

  receipt(
    'MCP 命令错误',
    [
      '支持：mcp tools / schema <工具> / call <工具> '+
      '[nowait] [timeout=毫秒] / wait <任务号> / jobs / kill <任务号>'
    ],
    false
  );
}

function parseMcpBlock(raw){
  const text=raw.trim();
  if(/^mcp(?:\s|$)/i.test(text)){
    handleMcpCommand(text);
    return;
  }
  const lines=text.split('\n');
  const first=lines.shift().trim();
  const parts=first.split(/\s+/);
  const server=parts.length>1?parts.shift():'';
  const tool=parts.join(' ');
  handleMcpCommand(
    'mcp call '+
    (server?server+'.':'')+
    tool+
    (lines.length?'\n'+lines.join('\n'):'')
  );
}

function scanMcp(){
  document.querySelectorAll('pre code,code').forEach(code=>{
    const cls=(
      (code.className||'')+' '+
      ((code.parentElement&&code.parentElement.className)||'')
    ).toLowerCase();
    if(!/language-mcp/.test(cls))return;
    const text=code.textContent||'';
    const id='mcp:'+hash(text);
    if(seenBlocks.has(id))return;
    seenBlocks.add(id);
    parseMcpBlock(text);
  });
}
    function extractStructuredBlocks(node){
  const blocks=[],push=(type,text)=>{
    text=String(text||'').replace(/\r\n?/g,'\n').trim();
    if(text)blocks.push({type,text});
  };
  node.querySelectorAll('pre,code').forEach(el=>{
    const pre=el.tagName==='PRE'?el:el.closest('pre');
    if(!pre||pre!==el&&el.closest('pre')!==pre)return;
    const code=pre.querySelector('code')||pre;
    const text=(code.textContent||pre.textContent||'').trim();
    if(!text)return;
    let hint='';
    let p=pre;
    for(let i=0;i<5&&p;i++,p=p.parentElement){
      hint+=' '+(p.className||'')+' '+(p.getAttribute?.('data-language')||'')+' '+(p.getAttribute?.('data-lang')||'');
      const labels=p.querySelectorAll?.('[class*="language"],[class*="lang"],[data-language],[data-lang]')||[];
      labels.forEach(x=>hint+=' '+(x.textContent||''));
    }
    hint=hint.toLowerCase();
    if(/(?:^|[\s_-])dsw(?:$|[\s_-])|language-dsw|lang-dsw/.test(hint))push('dsw',text);
    else if(/(?:^|[\s_-])mcp(?:$|[\s_-])|language-mcp|lang-mcp/.test(hint))push('mcp',text);
  });
  const source=assistantText(node);
  const fence=/(`{3,}|~{3,})\s*(dsw|mcp)\b[^\n]*\n([\s\S]*?)\n?\1/gi;
  let m;while((m=fence.exec(source)))push(m[2].toLowerCase(),m[3]);
  const tag=/<(dsw|mcp)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  while((m=tag.exec(source)))push(m[1].toLowerCase(),m[2]);
  const unique=new Map();
  blocks.forEach(b=>{const key=b.type+':'+hash(b.text);if(!unique.has(key))unique.set(key,b);});
  return [...unique.values()];
}
function executeStableBlock(messageKey,block){
  const raw=block.text;
  const safe=commandDomainSafe(raw);

  if(!safe.ok){
    receipt(
      '命令已拒绝',
      [safe.error],
      false
    );
    return;
  }

  const key=messageKey+':'+block.type+':'+hash(raw);
  if(seenBlocks.has(key))return;
  seenBlocks.add(key);

  if(seenBlocks.size>1500){
    seenBlocks=new Set([...seenBlocks].slice(-800));
  }

  if(block.type==='mcp'){
    parseMcpBlock(raw);
    return;
  }

  executeDomain(raw);
}

function parseDswLines(raw){
  return String(raw||'')
    .replace(/\r\n/g,'\n')
    .replace(/\r/g,'\n')
    .split('\n')
    .map(x=>x.trim())
    .filter(Boolean);
}

function normalizeCommandName(name){
  return String(name||'').trim().toLowerCase();
}

function commandArgs(line){
  const first=line.trim().match(/^([a-zA-Z_][\w-]*)\b\s*(.*)$/);
  if(!first)return null;
  return {
    name:normalizeCommandName(first[1]),
    rest:first[2]||''
  };
}

function parseJsonOrText(text){
  const s=String(text||'').trim();
  if(!s)return null;
  try{
    return JSON.parse(s);
  }catch(e){
    return null;
  }
}

function readQuotedArgs(rest){
  const args=parseQuoted(rest);
  if(args.length)return args;

  const json=parseJsonOrText(rest);
  if(Array.isArray(json))return json;
  if(typeof json==='string')return [json];
  if(json&&typeof json==='object')return [json];

  return rest.trim()?[rest.trim()]:[];
}

function linePosition(text,pos){
  const before=text.slice(0,Math.max(0,pos));
  return before.split('\n').length;
}

function findText(query,start=0){
  if(!query)return -1;
  return doc.text.indexOf(query,start);
}

function executeRead(args){
  const mode=String(args[0]||'all').toLowerCase();

  if(mode==='all'){
    receipt(
      '文章读取',
      [
        `当前文章长度：${doc.text.length} 字`,
        doc.text||'（当前文章为空）'
      ],
      true
    );
    return;
  }

  if(mode==='range'){
    const from=Math.max(0,+args[1]||0);
    const length=Math.max(0,+args[2]||0);
    const text=doc.text.slice(from,from+length);
    receipt(
      '文章区段读取',
      [
        `位置：${from}`,
        `长度：${text.length}`,
        text||'（范围为空）'
      ],
      true
    );
    return;
  }

  if(mode==='line'){
    const line=Math.max(1,+args[1]||1);
    const count=Math.max(1,+args[2]||1);
    const rows=doc.text.split('\n');
    const text=rows.slice(line-1,line-1+count).join('\n');
    receipt(
      '文章行读取',
      [
        `第 ${line} 行起，共 ${count} 行`,
        text||'（范围为空）'
      ],
      true
    );
    return;
  }

  receipt(
    '读取参数错误',
    ['支持：read all / read range <位置> <长度> / read line <行号> <行数>'],
    false
  );
}

function executeFind(args){
  const query=String(args[0]||'');
  if(!query){
    receipt('查找失败',['缺少查找文本'],false);
    return;
  }

  const positions=[];
  let start=0;

  while(positions.length<100){
    const pos=findText(query,start);
    if(pos<0)break;
    positions.push(pos);
    start=pos+Math.max(query.length,1);
  }

  if(!positions.length){
    receipt(
      '查找结果',
      [`未找到：${query}`],
      true
    );
    return;
  }

  const lines=positions.map(pos=>
    `位置 ${pos} · 第 ${linePosition(doc.text,pos)} 行`
  );

  receipt(
    '查找结果',
    [
      `查找：${query}`,
      `找到 ${positions.length}${positions.length>=100?'（已截断）':''} 处`,
      ...lines
    ],
    true
  );
}

function executeReplace(args){
  const oldText=String(args[0]??'');
  const newText=String(args[1]??'');

  if(!oldText){
    receipt('替换失败',['旧文本不能为空'],false);
    return;
  }

  const pos=doc.text.indexOf(oldText);
  if(pos<0){
    receipt(
      '替换失败',
      ['未找到需要替换的原文'],
      false
    );
    return;
  }

  const next=
    doc.text.slice(0,pos)+
    newText+
    doc.text.slice(pos+oldText.length);

  writeSavePoint('修改前自动保存');
  doc.text=next;
  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已替换',
    [
      `位置：${pos}`,
      `第 ${linePosition(next,pos)} 行`,
      `替换长度：${oldText.length} → ${newText.length}`
    ],
    true
  );
}

function executeReplaceAll(args){
  const oldText=String(args[0]??'');
  const newText=String(args[1]??'');

  if(!oldText){
    receipt('批量替换失败',['旧文本不能为空'],false);
    return;
  }

  const count=doc.text.split(oldText).length-1;

  if(!count){
    receipt(
      '批量替换失败',
      ['未找到需要替换的文本'],
      false
    );
    return;
  }

  writeSavePoint('批量修改前自动保存');
  doc.text=doc.text.split(oldText).join(newText);
  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已批量替换',
    [
      `替换次数：${count}`,
      `文本长度：${oldText.length} → ${newText.length}`
    ],
    true
  );
}

function executeInsert(args){
  const position=Math.max(
    0,
    Math.min(
      doc.text.length,
      +args[0]||0
    )
  );

  const text=String(args[1]??'');

  if(!text){
    receipt('插入失败',['插入内容不能为空'],false);
    return;
  }

  writeSavePoint('修改前自动保存');

  doc.text=
    doc.text.slice(0,position)+
    text+
    doc.text.slice(position);

  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已插入',
    [
      `位置：${position}`,
      `插入长度：${text.length}`
    ],
    true
  );
}

function executeAppend(args){
  const text=String(args[0]??'');

  if(!text){
    receipt('追加失败',['追加内容不能为空'],false);
    return;
  }

  writeSavePoint('修改前自动保存');

  doc.text+=text;
  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已追加',
    [`追加长度：${text.length}`],
    true
  );
}

function executeDelete(args){
  const target=String(args[0]??'');

  if(!target){
    receipt('删除失败',['删除文本不能为空'],false);
    return;
  }

  const pos=doc.text.indexOf(target);

  if(pos<0){
    receipt(
      '删除失败',
      ['未找到需要删除的文本'],
      false
    );
    return;
  }

  writeSavePoint('删除前自动保存');

  doc.text=
    doc.text.slice(0,pos)+
    doc.text.slice(pos+target.length);

  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已删除',
    [
      `位置：${pos}`,
      `删除长度：${target.length}`
    ],
    true
  );
}

function executeDeleteRange(args){
  const from=Math.max(0,+args[0]||0);
  const length=Math.max(0,+args[1]||0);

  if(!length){
    receipt(
      '删除范围失败',
      ['删除长度必须大于 0'],
      false
    );
    return;
  }

  if(from>=doc.text.length){
    receipt(
      '删除范围失败',
      ['起始位置超出文章范围'],
      false
    );
    return;
  }

  writeSavePoint('删除前自动保存');

  doc.text=
    doc.text.slice(0,from)+
    doc.text.slice(from+length);

  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章区段已删除',
    [
      `位置：${from}`,
      `删除长度：${length}`
    ],
    true
  );
}

function executeSave(args){
  const reason=String(args[0]||'AI 保存');
  doc.text=editor?editor.value:doc.text;
  writeSavePoint(reason);
  saveDoc();
  dirty=false;

  receipt(
    '文章已保存',
    [
      `保存原因：${reason}`,
      `当前长度：${doc.text.length} 字`
    ],
    true
  );
}

function executeSet(args){
  const text=String(args[0]??'');

  if(
    !confirm(
      'AI 请求直接覆盖当前整篇文章。\n'+
      '执行前会自动保存历史版本，是否继续？'
    )
  ){
    receipt(
      '整篇覆盖已取消',
      ['用户拒绝覆盖当前文章'],
      false
    );
    return;
  }

  writeSavePoint('整篇覆盖前自动保存');

  doc.text=text;
  saveDoc();

  if(editor){
    editor.value=doc.text;
  }

  dirty=false;

  receipt(
    '文章已整体更新',
    [`当前长度：${doc.text.length} 字`],
    true
  );
}

function executeStatus(){
  receipt(
    'DSW 状态',
    [
      `版本：${VERSION}`,
      `文章长度：${doc.text.length} 字`,
      `历史版本：${savePoints.length}`,
      `自动回传：${cfg.autoReturn?'开启':'关闭'}`,
      `草稿协同：${cfg.mergeDraft?'开启':'关闭'}`,
      `新对话注入：${cfg.autoBootstrap?'开启':'关闭'}`,
      `MCP 服务：${enabledServers().length}/${mcpServers.length}`,
      `后台任务：${MCP_JOBS.size}`
    ],
    true
  );
}

function executeDomain(raw){
  const check=commandDomainSafe(raw);

  if(!check.ok){
    receipt(
      '命令已拒绝',
      [check.error],
      false
    );
    return;
  }

  const lines=parseDswLines(raw);

  if(!lines.length)return;

  const results=[];

  for(const line of lines){
    const cmd=commandArgs(line);

    if(!cmd){
      results.push('无法识别：'+line);
      continue;
    }

    const args=readQuotedArgs(cmd.rest);

    try{
      switch(cmd.name){
        case 'read':
          executeRead(args);
          break;

        case 'find':
          executeFind(args);
          break;

        case 'replace':
          executeReplace(args);
          break;

        case 'replaceall':
        case 'replace_all':
          executeReplaceAll(args);
          break;

        case 'insert':
          executeInsert(args);
          break;

        case 'append':
          executeAppend(args);
          break;

        case 'delete':
          executeDelete(args);
          break;

        case 'delete_range':
        case 'deleterange':
          executeDeleteRange(args);
          break;

        case 'save':
          executeSave(args);
          break;

        case 'set':
        case 'write':
          executeSet(args);
          break;

        case 'status':
          executeStatus();
          break;

        case 'help':
          receipt(
            'DSW 命令手册',
            [
              'read all',
              'read range <位置> <长度>',
              'read line <行号> <行数>',
              'find "文本"',
              'replace "旧文本" "新文本"',
              'replaceall "旧文本" "新文本"',
              'insert <位置> "文本"',
              'append "文本"',
              'delete "文本"',
              'delete_range <位置> <长度>',
              'save "原因"',
              'set "完整文章"',
              'status'
            ],
            true
          );
          break;

        default:
          results.push('未知命令：'+cmd.name);
      }
    }catch(e){
      results.push(
        `${cmd.name} 执行异常：${e.message||String(e)}`
      );
    }
  }

  if(results.length){
    receipt(
      '部分命令未执行',
      results,
      false
    );
  }
}

function renderArticle(body){
  body.innerHTML=`
    <div class="article">
      <div class="bar">
        <button class="btn pri" id="save">保存</button>
        <button class="btn" id="hist">历史</button>
        <button class="btn" id="find">查找</button>
        <span class="muted" id="stat"></span>
      </div>
      <div class="quick">
        <button class="btn" id="top">顶部</button>
        <button class="btn" id="bottom">末尾</button>
        <button class="btn" id="copy">复制全文</button>
        <button class="btn danger" id="clear">清空</button>
      </div>
      <textarea
        class="editor"
        spellcheck="false"
        placeholder="将文章粘贴到这里。这里始终只维护一篇纯文本文章。"
      ></textarea>
    </div>
  `;

  editor=body.querySelector('.editor');
  editor.value=doc.text||'';

  const stat=()=>{
    const v=editor.value;
    body.querySelector('#stat').textContent=
      `${v.length} 字 · ${v.split('\n').length} 行`+
      `${dirty?' · 草稿中':''}`;
  };

  stat();

  editor.addEventListener('input',()=>{
    dirty=true;
    doc.text=editor.value;
    scheduleDocSave();
    stat();
  });

  body.querySelector('#save').onclick=()=>{
    doc.text=editor.value;
    writeSavePoint('手动保存');
    saveDoc();
    dirty=false;
    stat();
    toast('已保存，并写入历史保存点');
  };

  body.querySelector('#hist').onclick=()=>{
    timelineDraft=editor.value;
    currentTab='history';
    render();
  };

  body.querySelector('#find').onclick=()=>{
    const q=prompt('查找文本：');

    if(q==null||q==='')return;

    const pos=editor.value.indexOf(q);

    if(pos<0){
      toast('未找到');
      return;
    }

    editor.focus();
    editor.setSelectionRange(pos,pos+q.length);

    const before=editor.value.slice(0,pos);
    const line=before.split('\n').length;
    const lineHeight=
      parseFloat(getComputedStyle(editor).lineHeight)||24;

    editor.scrollTop=Math.max(
      0,
      (line-3)*lineHeight
    );

    toast(`已定位到第 ${line} 行`);
  };

  body.querySelector('#top').onclick=()=>{
    editor.focus();
    editor.setSelectionRange(0,0);
    editor.scrollTop=0;
  };

  body.querySelector('#bottom').onclick=()=>{
    editor.focus();
    const n=editor.value.length;
    editor.setSelectionRange(n,n);
    editor.scrollTop=editor.scrollHeight;
  };

  body.querySelector('#copy').onclick=async()=>{
    try{
      await navigator.clipboard.writeText(editor.value);
      toast('全文已复制');
    }catch(e){
      editor.select();
      document.execCommand('copy');
      toast('全文已复制');
    }
  };

  body.querySelector('#clear').onclick=()=>{
    if(
      confirm(
        '清空当前文章？历史保存点不会删除。'
      )
    ){
      if(editor.value){
        writeSavePoint('清空前自动保存');
      }

      doc.text='';
      editor.value='';
      saveDoc();
      dirty=true;
      stat();
      toast('当前文章已清空');
    }
  };
}
    function renderHistory(body){
  const current=timelineDraft??doc.text;

  body.innerHTML=`
    <div class="card">
      <div class="row">
        <div>
          <h3>历史版本</h3>
          <div class="small">
            保存点独立保留。恢复旧版本不会删除之后的历史版本。
          </div>
        </div>
        <button class="btn" id="back">返回编辑</button>
      </div>
    </div>
    <div class="card">
      <div class="row">
        <button class="btn pri" id="saveCurrent">保存当前草稿</button>
        <span class="badge">${savePoints.length} 个保存点</span>
      </div>
    </div>
    <div class="tl" id="timeline"></div>
  `;

  const timeline=body.querySelector('#timeline');

  const draft={
    id:'current',
    at:Date.now(),
    text:current,
    reason:'当前草稿',
    current:true
  };

  const points=[draft,...savePoints];

  points.forEach(point=>{
    const item=document.createElement('button');
    item.className='tl-i'+(point.current?' on':'');
    item.innerHTML=`
      <b>${esc(point.reason||'保存')}</b>
      <span class="small">
        ${point.current?'当前编辑状态':nowText(point.at)}
        · ${point.text.length} 字
      </span>
    `;

    item.onclick=()=>{
      [...timeline.querySelectorAll('.tl-i')]
        .forEach(x=>x.classList.remove('on'));

      item.classList.add('on');

      showHistoryPreview(
        body,
        point,
        current
      );
    };

    timeline.appendChild(item);
  });

  showHistoryPreview(body,draft,current);

  body.querySelector('#back').onclick=()=>{
    currentTab='article';
    render();
  };

  body.querySelector('#saveCurrent').onclick=()=>{
    const text=timelineDraft??doc.text;

    if(
      savePoints[0]&&
      savePoints[0].hash===hash(text)
    ){
      savePoints[0].at=Date.now();
      savePoints[0].reason='手动保存';
    }else{
      savePoints.unshift({
        id:uid(),
        at:Date.now(),
        text,
        reason:'手动保存',
        hash:hash(text)
      });

      if(savePoints.length>100){
        savePoints.length=100;
      }
    }

    doc.text=text;
    saveHistory();
    saveDoc();
    dirty=false;
    toast('当前版本已保存');
    render();
  };
}

function showHistoryPreview(body,point,currentText){
  let preview=body.querySelector('#historyPreview');

  if(!preview){
    preview=document.createElement('div');
    preview.id='historyPreview';
    preview.className='card';
    body.appendChild(preview);
  }

  const same=point.text===currentText;

  preview.innerHTML=`
    <div class="row">
      <div>
        <h3>${esc(point.reason||'保存点')}</h3>
        <div class="small">
          ${point.current?'当前草稿':nowText(point.at)}
          · ${point.text.length} 字
        </div>
      </div>
      ${
        point.current
          ?'<span class="badge">当前</span>'
          :`<button class="btn pri" id="restorePoint">
              恢复此版本
            </button>`
      }
    </div>
    <div class="small" style="margin-top:8px">
      ${
        same
          ?'当前文章与该版本内容相同。'
          :'恢复会覆盖当前草稿，但不会删除任何其他历史版本。'
      }
    </div>
    <div class="log" style="margin-top:10px;max-height:280px">
${esc(point.text||'（空文章）')}
    </div>
  `;

  const restore=preview.querySelector('#restorePoint');

  if(restore){
    restore.onclick=()=>{
      if(
        !confirm(
          '恢复此历史版本？\n\n'+
          '当前草稿会先保留，所有其他历史版本不会删除。'
        )
      )return;

      const before=timelineDraft??doc.text;

      if(before!==point.text){
        if(
          !savePoints[0]||
          savePoints[0].hash!==hash(before)
        ){
          savePoints.unshift({
            id:uid(),
            at:Date.now(),
            text:before,
            reason:'恢复前自动保存',
            hash:hash(before)
          });

          if(savePoints.length>100){
            savePoints.length=100;
          }
        }
      }

      doc.text=point.text;
      timelineDraft=doc.text;
      saveDoc();
      saveHistory();
      dirty=false;

      toast('历史版本已恢复');
      render();
    };
  }
}

function renderMcp(body){
  body.innerHTML=`
    <div class="card">
      <div class="row">
        <div>
          <h3>MCP 服务</h3>
          <div class="small">
            Streamable HTTP / SSE · 工具缓存 · 后台任务
          </div>
        </div>
        <button class="btn pri" id="addServer">
          添加服务
        </button>
      </div>
    </div>
    <div id="serverList"></div>
    <div class="card">
      <div class="row">
        <h3>后台任务</h3>
        <button class="btn" id="refreshJobs">刷新</button>
      </div>
      <div id="jobs"></div>
    </div>
    <div class="card">
      <h3>调用记录</h3>
      <div id="callList"></div>
    </div>
  `;

  const list=body.querySelector('#serverList');

  if(!mcpServers.length){
    list.innerHTML=`
      <div class="card">
        <div class="small">
          暂未配置 MCP 服务。
        </div>
      </div>
    `;
  }else{
    mcpServers.forEach(server=>{
      const card=document.createElement('div');
      card.className='card';

      card.innerHTML=`
        <div class="row">
          <div style="flex:1;min-width:120px">
            <h3>${esc(server.name||'未命名服务')}</h3>
            <div class="small">${esc(server.url||'')}</div>
          </div>
          <span class="badge">
            ${server.enabled===false?'已停用':'已启用'}
          </span>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn tools">工具</button>
          <button class="btn toggle">
            ${server.enabled===false?'启用':'停用'}
          </button>
          <button class="btn edit">编辑</button>
          <button class="btn danger remove">删除</button>
        </div>
      `;

      card.querySelector('.tools').onclick=async()=>{
        const btn=card.querySelector('.tools');
        btn.disabled=true;
        btn.textContent='读取中…';

        try{
          const tools=await listTools(server,true);
          receipt(
            'MCP 工具列表 · '+(server.name||server.url),
            tools.length
              ?tools.map(t=>
                `${t.name} [${risk(t)}] ${t.description||''}`
              )
              :['该服务没有返回工具'],
            true
          );
          toast(`读取到 ${tools.length} 个工具`);
        }catch(e){
          receipt(
            'MCP 工具读取失败',
            [e.message||String(e)],
            false
          );
          toast('读取失败');
        }finally{
          btn.disabled=false;
          btn.textContent='工具';
        }
      };

      card.querySelector('.toggle').onclick=()=>{
        server.enabled=server.enabled===false;
        saveMcp();
        render();
      };

      card.querySelector('.edit').onclick=()=>{
        editMcpServer(server);
      };

      card.querySelector('.remove').onclick=()=>{
        if(
          confirm(
            '删除 MCP 服务“'+
            (server.name||server.url)+
            '”？'
          )
        ){
          mcpServers=mcpServers.filter(
            x=>x!==server
          );
          saveMcp();
          render();
        }
      };

      list.appendChild(card);
    });
  }

  const renderJobs=()=>{
    const box=body.querySelector('#jobs');

    const jobs=[...MCP_JOBS.values()]
      .sort((a,b)=>b.startedAt-a.startedAt);

    if(!jobs.length){
      box.innerHTML='<div class="small">暂无后台任务</div>';
      return;
    }

    box.innerHTML='';

    jobs.slice(0,30).forEach(job=>{
      const row=document.createElement('div');
      row.className='tool';

      const elapsed=Math.max(
        0,
        Math.round(
          ((job.endedAt||Date.now())-job.startedAt)/1000
        )
      );

      row.innerHTML=`
        <div class="row">
          <b>${esc(job.tool.name)}</b>
          <span class="badge">${esc(job.state)}</span>
          <span class="small">${elapsed}s</span>
          ${
            job.state==='running'
              ?'<button class="btn kill">终止</button>'
              :''
          }
        </div>
        <div class="small">
          ${esc(job.id)}
          · ${esc(job.server.name||job.server.url)}
        </div>
      `;

      const kill=row.querySelector('.kill');

      if(kill){
        kill.onclick=()=>{
          if(
            confirm(
              '终止任务 '+job.id+'？'
            )
          ){
            job.state='killed';
            job.controller.abort();
            renderJobs();
          }
        };
      }

      box.appendChild(row);
    });
  };

  renderJobs();

  body.querySelector('#refreshJobs').onclick=renderJobs;

  const calls=body.querySelector('#callList');

  if(!callHistory.length){
    calls.innerHTML='<div class="small">暂无调用记录</div>';
  }else{
    calls.innerHTML=callHistory
      .slice(0,30)
      .map(call=>`
        <div class="tool">
          <div class="row">
            <b>${esc(call.tool)}</b>
            <span class="badge">
              ${call.ok?'成功':'失败'}
            </span>
          </div>
          <div class="small">
            ${esc(call.server)}
            · ${nowText(call.at)}
          </div>
          <div class="log">${esc(
            String(call.result||'').slice(0,2000)
          )}</div>
        </div>
      `)
      .join('');
  }

  body.querySelector('#addServer').onclick=()=>{
    editMcpServer(null);
  };
}

function editMcpServer(server){
  const isNew=!server;

  const name=prompt(
    '服务名称：',
    server?.name||''
  );

  if(name===null)return;

  const url=prompt(
    'MCP 服务地址：',
    server?.url||''
  );

  if(url===null)return;

  const clean=url.trim();

  if(
    !/^https?:\/\//i.test(clean)
  ){
    toast('服务地址必须以 http:// 或 https:// 开头');
    return;
  }

  let headers={};

  const oldHeaders=
    server?.headers&&typeof server.headers==='object'
      ?JSON.stringify(server.headers)
      :'{}';

  const headerText=prompt(
    '请求头 JSON（可留空）：',
    oldHeaders
  );

  if(headerText===null)return;

  if(headerText.trim()){
    try{
      const parsed=JSON.parse(headerText);

      if(
        !parsed||
        Array.isArray(parsed)||
        typeof parsed!=='object'
      ){
        throw Error('必须是对象');
      }

      headers=parsed;
    }catch(e){
      toast('请求头 JSON 格式错误');
      return;
    }
  }

  if(isNew){
    mcpServers.push({
      id:uid(),
      name:name.trim()||'未命名服务',
      url:clean,
      headers,
      enabled:true
    });
  }else{
    server.name=name.trim()||'未命名服务';
    server.url=clean;
    server.headers=headers;
    server._session=null;
  }

  saveMcp();
  render();
  toast(isNew?'服务已添加':'服务已更新');
}

function renderSettings(body){
  body.innerHTML=`
    <div class="card">
      <h3>运行策略</h3>
      <div class="small">
        控制 AI 命令扫描、自动回传和新对话协议注入。
      </div>
      <div class="tool">
        <label class="row">
          <input type="checkbox" id="paused">
          暂停 AI 命令扫描
        </label>
      </div>
      <div class="tool">
        <label class="row">
          <input type="checkbox" id="autoReturn">
          自动回传执行结果
        </label>
      </div>
      <div class="tool">
        <label class="row">
          <input type="checkbox" id="mergeDraft">
          回传时协同保留输入框中的用户草稿
        </label>
      </div>
      <div class="tool">
        <label class="row">
          <input type="checkbox" id="autoBootstrap">
          新建对话时自动注入 DSW 操作协议
        </label>
      </div>
    </div>

    <div class="card">
      <h3>界面</h3>
      <select class="inp" id="theme">
        <option value="auto">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </div>

    <div class="card">
      <h3>MCP 风险策略</h3>
      <select class="inp" id="mcpRisk">
        <option value="partial">
          写入类工具执行前确认
        </option>
        <option value="always">
          允许直接执行
        </option>
        <option value="never">
          禁止写入类工具
        </option>
      </select>
      <div class="small" style="margin-top:8px">
        只读工具仍会经过调用去重和后台任务管理。
      </div>
    </div>

    <div class="card">
      <h3>维护</h3>
      <div class="row">
        <button class="btn" id="clearSeen">
          重置命令去重状态
        </button>
        <button class="btn" id="defaultPolicy">
          恢复默认运行策略
        </button>
      </div>
    </div>
  `;

  const paused=body.querySelector('#paused');
  const autoReturn=body.querySelector('#autoReturn');
  const mergeDraft=body.querySelector('#mergeDraft');
  const autoBootstrap=body.querySelector('#autoBootstrap');
  const theme=body.querySelector('#theme');
  const mcpRisk=body.querySelector('#mcpRisk');

  paused.checked=!!cfg.paused;
  autoReturn.checked=cfg.autoReturn!==false;
  mergeDraft.checked=cfg.mergeDraft!==false;
  autoBootstrap.checked=cfg.autoBootstrap!==false;
  theme.value=cfg.theme||'auto';
  mcpRisk.value=cfg.mcpRisk||'partial';

  paused.onchange=()=>{
    cfg.paused=paused.checked;
    saveCfg();
  };

  autoReturn.onchange=()=>{
    cfg.autoReturn=autoReturn.checked;
    saveCfg();
  };

  mergeDraft.onchange=()=>{
    cfg.mergeDraft=mergeDraft.checked;
    saveCfg();
  };

  autoBootstrap.onchange=()=>{
    cfg.autoBootstrap=autoBootstrap.checked;
    saveCfg();
  };

  theme.onchange=()=>{
    cfg.theme=theme.value;
    saveCfg();
    reroot();
  };

  mcpRisk.onchange=()=>{
    cfg.mcpRisk=mcpRisk.value;
    saveCfg();
  };

  body.querySelector('#clearSeen').onclick=()=>{
    seenBlocks.clear();
    toast('命令去重状态已重置');
  };

  body.querySelector('#defaultPolicy').onclick=()=>{
    if(
      !confirm(
        '恢复默认运行策略？\n'+
        '不会删除文章、历史版本或 MCP 服务。'
      )
    )return;

    cfg={
      ...cfg,
      paused:false,
      autoReturn:true,
      mergeDraft:true,
      autoBootstrap:true,
      mcpRisk:'partial'
    };

    saveCfg();
    reroot();
    toast('已恢复默认运行策略');
  };
}
    function render(){
  if(!panel||!panel.classList.contains('on'))return;

  const tabs=panel.querySelector('.tabs');
  const body=panel.querySelector('.body');

  tabs.innerHTML=`
    <button data-tab="article">文章</button>
    <button data-tab="history">历史</button>
    <details class="more">
      <summary class="btn">更多</summary>
      <div class="more-menu">
        <button data-tab="receipts">回执中心</button>
        <button data-tab="mcp">MCP 服务</button>
        <button data-tab="settings">设置</button>
      </div>
    </details>
  `;

  tabs.querySelectorAll('[data-tab]').forEach(button=>{
    if(button.dataset.tab===currentTab){
      button.classList.add('on');
    }

    button.onclick=()=>{
      if(
        currentTab==='article'&&
        editor
      ){
        doc.text=editor.value;
        saveDoc();
        timelineDraft=doc.text;
      }

      currentTab=button.dataset.tab;

      if(currentTab!=='history'){
        timelineDraft=null;
      }

      render();
    };
  });

  body.innerHTML='';

  switch(currentTab){
    case 'history':
      renderHistory(body);
      break;

    case 'receipts':
      renderReceipts(body);
      break;

    case 'mcp':
      renderMcp(body);
      break;

    case 'settings':
      renderSettings(body);
      break;

    default:
      renderArticle(body);
  }
}

let saveTimer=0;

function scheduleDocSave(){
  clearTimeout(saveTimer);

  saveTimer=setTimeout(()=>{
    if(editor){
      doc.text=editor.value;
    }

    saveDoc();
  },700);
}

function forceSave(){
  if(editor){
    doc.text=editor.value;
  }

  saveDoc();
}

function messageCandidates(){
  const selectors=[
    '.ds-assistant-message-main-content',
    '[data-testid*="assistant"] [class*="markdown"]',
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[class*="assistant-message"]'
  ];
  const set=new Set();
  for(const selector of selectors){
    try{document.querySelectorAll(selector).forEach(node=>{
      if(isVisibleEl(node)&&assistantText(node).length)set.add(node);
    });}catch(e){}
  }
  return [...set].filter(node=>!node.closest?.('#dsw-single-host'));
}
const messageState=new WeakMap();
const executedMessages=new WeakMap();

function getMessageIdentity(node){
  let state=messageState.get(node);

  if(!state){
    state={
      id:'msg:'+uid(),
      text:'',
      changedAt:Date.now(),
      stableHash:''
    };

    messageState.set(node,state);
  }

  return state;
}

function scanStableMessages(force=false){
  if(scanBusy||cfg.paused)return;

  scanBusy=true;

  try{
    watchConversation();

    const nodes=messageCandidates();

    for(const node of nodes){
      const text=assistantText(node);

      if(!text)continue;

      const state=getMessageIdentity(node);
      const fingerprint=hash(text);

      if(state.text!==fingerprint){
        state.text=fingerprint;
        state.changedAt=Date.now();
        continue;
      }

      if(!force&&Date.now()-state.changedAt<750)continue;

      if(state.stableHash===fingerprint){
        continue;
      }

      state.stableHash=fingerprint;

      const blocks=extractStructuredBlocks(node);

      if(!blocks.length)continue;

      let executed=executedMessages.get(node);

      if(!executed){
        executed=new Set();
        executedMessages.set(node,executed);
      }

      blocks.forEach(block=>{
        const id=
          block.type+':'+
          commandFingerprint(block.text);

        if(executed.has(id))return;

        executed.add(id);

        executeStableBlock(
          state.id,
          block
        );
      });
    }
  }catch(e){
    console.warn(
      '[DSW] scan failed',
      e
    );
  }finally{
    scanBusy=false;
  }
}

let scanTimer=0;

function scheduleScan(delay=260){
  clearTimeout(scanTimer);

  scanTimer=setTimeout(()=>{
    scanStableMessages();
  },delay);
}

function installObserver(){
  const observer=new MutationObserver(()=>{
    scheduleScan();
    watchConversation();
  });

  observer.observe(
    document.documentElement,
    {
      childList:true,
      subtree:true,
      characterData:true
    }
  );

  setInterval(
    ()=>scanStableMessages(),
    1200
  );

  setInterval(
    ()=>watchConversation(),
    1800
  );

  document.addEventListener(
    'visibilitychange',
    ()=>{
      if(!document.hidden){
        scheduleScan(600);
        watchConversation();
      }else{
        forceSave();
      }
    }
  );

  window.addEventListener(
    'pagehide',
    forceSave
  );

  window.addEventListener(
    'beforeunload',
    forceSave
  );
}

function installShortcuts(){
  document.addEventListener(
    'keydown',
    event=>{
      const active=document.activeElement;
      const typing=
        active&&(
          active.matches?.(
            'textarea,input,[contenteditable="true"]'
          )||
          active.closest?.(
            '[contenteditable="true"]'
          )
        );

      if(
        event.ctrlKey&&
        event.shiftKey&&
        event.key.toLowerCase()==='s'
      ){
        if(
          host&&
          panel?.classList.contains('on')
        ){
          event.preventDefault();

          if(editor){
            doc.text=editor.value;
          }

          writeSavePoint('快捷键保存');
          saveDoc();
          dirty=false;
          toast('已保存历史版本');
        }

        return;
      }

      if(
        event.key==='Escape'&&
        panel?.classList.contains('on')&&
        !typing
      ){
        panel.classList.remove('on');
      }
    },
    true
  );
}

function installThemeWatch(){
  const media=matchMedia(
    '(prefers-color-scheme: dark)'
  );

  const update=()=>{
    if(cfg.theme==='auto'){
      reroot();
    }
  };

  if(media.addEventListener){
    media.addEventListener('change',update);
  }else if(media.addListener){
    media.addListener(update);
  }
}

function cleanupCaches(){
  const cutoff=Date.now()-MCP_IDEM_WINDOW;

  for(const [key,time] of MCP_IDEM){
    if(time<cutoff){
      MCP_IDEM.delete(key);
    }
  }

  if(MCP_JOBS.size>100){
    const jobs=[...MCP_JOBS.values()]
      .sort((a,b)=>a.startedAt-b.startedAt);

    while(jobs.length>60){
      const job=jobs.shift();

      if(job.state!=='running'){
        MCP_JOBS.delete(job.id);
      }else{
        break;
      }
    }
  }

  if(seenBlocks.size>1200){
    seenBlocks=new Set(
      [...seenBlocks].slice(-700)
    );
  }
}

function startMaintenance(){
  setInterval(
    cleanupCaches,
    60000
  );
}

function initialize(){
  mount();
  installObserver();
  installShortcuts();
  installThemeWatch();
  startMaintenance();

  setTimeout(()=>{
    scanStableMessages();
    watchConversation();
  },1000);

  setTimeout(()=>{
    maybeBootstrap(false);
  },1800);
}

if(
  document.readyState==='loading'
){
  document.addEventListener(
    'DOMContentLoaded',
    initialize,
    {once:true}
  );
}else{
  initialize();
}

})();
