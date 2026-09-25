// JIA AN 工时台 — 数据全部在 Airtable。
// 录入 → 附工卡 → 核验 → 按《总包 Claim 计算表》口径算 Claim。
(() => {
"use strict";
const C = window.JIAAN_TS_CONFIG;
const T = C.ops.timesheets, A = C.ops.adjustments;
const API = "https://api.airtable.com/v0/";
const TZ = "Asia/Singapore";
const WORKER_FORM_URL = new URL("form/", location.href).href;   // 工人用的固定网址

const SHIFTS = {
  D:{name:"日班", en:"Day", st:"08:00", et:"20:00"},
  N:{name:"夜班", en:"Night", st:"20:00", et:"08:00"},
  CL:{name:"爬升", en:"Climbing", st:"08:00", et:"17:00"},
  ER:{name:"架设", en:"Erection", st:"08:00", et:"17:00"},
  DM:{name:"拆卸", en:"Dismantling", st:"08:00", et:"17:00"},
  SB:{name:"待命", en:"Standby", st:"08:00", et:"17:00"},
};
const SHIFT_BY_EN = Object.fromEntries(Object.entries(SHIFTS).map(([k,v])=>[v.en,k]));
const STATUS = {S:"工人提交", R:"已录入", E:"有工卡", V:"已核验", X:"已退回"};
const STATUS_AT = {S:"Submitted", R:"Recorded", E:"Evidence Attached", V:"Verified", X:"Rejected"};
const STATUS_FROM_AT = Object.fromEntries(Object.entries(STATUS_AT).map(([k,v])=>[v,k]));

// ---------- state ----------
const S = {
  token:null, userName:"",
  projects:[], cranes:[], workers:[], rates:[],
  rows:{},            // recId -> row
  months:new Set(),   // months loaded (YYYY-MM)
  adj:{}, adjLoaded:"", // key -> {recId, ...}
  tab:"entry", dirty:{}, sel:new Set(), ready:false,
};
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LS = {get(k,d){try{const v=localStorage.getItem("jiaan-ts:"+k);return v==null?d:JSON.parse(v)}catch{return d}},
            set(k,v){try{localStorage.setItem("jiaan-ts:"+k,JSON.stringify(v))}catch{}},
            del(k){try{localStorage.removeItem("jiaan-ts:"+k)}catch{}}};
const SS = {get(k){try{return sessionStorage.getItem("jiaan-ts:"+k)}catch{return null}},
            set(k,v){try{sessionStorage.setItem("jiaan-ts:"+k,v)}catch{}},
            del(k){try{sessionStorage.removeItem("jiaan-ts:"+k)}catch{}}};

// ---------- dates / hours ----------
function todaySG(){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()); }
function addDays(d,n){ const t=new Date(d+"T00:00:00Z"); t.setUTCDate(t.getUTCDate()+n); return t.toISOString().slice(0,10); }
function monthOf(d){ return d.slice(0,7); }
function addMonths(m,n){ const [y,mo]=m.split("-").map(Number); const t=new Date(Date.UTC(y,mo-1+n,1)); return t.toISOString().slice(0,7); }
function daysIn(m){ const [y,mo]=m.split("-").map(Number); return new Date(Date.UTC(y,mo,0)).getUTCDate(); }
function dow(d){ return new Date(d+"T00:00:00Z").getUTCDay(); }
const WD = ["日","一","二","三","四","五","六"];
function mins(t){ if(!t) return null; const [h,m]=t.split(":").map(Number); return h*60+m; }
function normTime(v){
  const s=String(v??"").trim().replace(/[.．：]/g,":").replace(/\s/g,""); if(!s) return "";
  let m=s.match(/^(\d{1,2}):(\d{2})$/) || s.match(/^(\d{2})(\d{2})$/) || s.match(/^(\d{1,2})$/);
  if(!m) return s; const h=Number(m[1]), mi=Number(m[2]||0);
  if(h>24||mi>59) return s; return String(h%24).padStart(2,"0")+":"+String(mi).padStart(2,"0");
}
// 跨度：下班 ≤ 上班 视为跨夜；上下班同一时刻 = 连做 24 小时（2026-08-02 裁定）
function calcHours(st,et){ const a=mins(st), b=mins(et); if(a==null||b==null) return 0; let d=b-a; if(d<=0) d+=1440; return Math.round(d/60*100)/100; }
const HOL = new Map((C.holidays||[]).map(([d,n,c])=>[d,{name:n,count:c}]));
function isPH(date){ return !!HOL.get(date)?.count; }
function isSpecial(date){ return dow(date)===0 || isPH(date); }
// 与《总包 Claim 计算表》WorkName K 列 / I33 同口径（2026-09-03 D2 版）
function dayCalc(date, st, et, ltw){
  const a=mins(st), b0=mins(et); if(a==null||b0==null) return {span:0, ot:0, bill:0, lunch:0, night:false};
  const b=b0<=a?b0+1440:b0; const span=(b-a)/60;
  const lunch=(a<780 && b>720)?1:0;          // 真跨过 12:00–13:00 才扣 1h
  const night=a>=1020;                        // 上班 ≥ 17:00 = 夜班，全程计 OT
  let ot;
  if(isSpecial(date)) ot = night? span : span-lunch;
  else ot = night? span : Math.max(0,(b-1020)/60)+Math.max(0,(480-a)/60);
  ot=Math.max(0,ot)+(ltw?1:0);
  const r2=x=>Math.round(x*100)/100;
  return {span:r2(span), ot:r2(ot), bill:r2(span-lunch), lunch, night};
}
function fmtH(h){ const v=Math.round((Number(h)||0)*100)/100; return Number.isInteger(v)? String(v) : v.toFixed(2).replace(/0$/,""); }
const money=x=>(Math.round(x*100)/100).toLocaleString("en-SG",{minimumFractionDigits:2,maximumFractionDigits:2});
function safeSeg(s){ return String(s).replace(/[^A-Za-z0-9_\-.~:@+一-鿿]/g,"-"); }
function toast(msg, ms){ const t=$("toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true, ms||3600); }
let busyN=0; function busy(on){ busyN+=on?1:-1; $("busy").hidden=busyN<=0; }

// ---------- Airtable client ----------
let lastCall=0;
const chain={p:Promise.resolve()};
function throttle(){ // Airtable: 每个 base 每秒 5 次；统一排队、间隔 ≥ 220ms
  const run=chain.p.then(async()=>{ const w=lastCall+220-Date.now(); if(w>0) await new Promise(r=>setTimeout(r,w)); lastCall=Date.now(); });
  chain.p=run.catch(()=>{}); return run;
}
class AtError extends Error{ constructor(status,type,msg){ super(msg); this.status=status; this.type=type; } }
async function at(method, url, body, retried){
  await throttle(); busy(true);
  try{
    const res=await fetch(url,{method, headers:{Authorization:"Bearer "+S.token, ...(body?{"Content-Type":"application/json"}:{})}, body:body?JSON.stringify(body):undefined});
    if(res.status===429 && !retried){ toast("Airtable 请求太频繁，30 秒后自动重试…", 30000); await new Promise(r=>setTimeout(r,30500)); return at(method,url,body,true); }
    const txt=await res.text(); let js=null; try{ js=txt?JSON.parse(txt):null; }catch{}
    if(!res.ok){ const e=js?.error||{}; throw new AtError(res.status, e.type||String(res.status), e.message||txt||res.statusText); }
    return js;
  } catch(e){
    if(e instanceof AtError) throw e;
    throw new AtError(0,"NETWORK","连不上 Airtable（"+(e.message||e)+"）。检查网络后点「刷新」。");
  } finally { busy(false); }
}
function explain(e){
  if(e?.status===401) return "令牌无效或已过期。点「设置」重新贴一个。";
  if(e?.status===403) return "令牌没有这个 base 的权限。生成令牌时要把 02、03、04 三个 base 都加进 Access。";
  if(e?.status===404) return "找不到表或字段（"+(e.message||"")+"）。表可能被改名或删除了。";
  if(e?.status===422) return "Airtable 拒绝了这次写入："+(e.message||e.type);
  return e?.message||String(e);
}
async function listAll(base, table, fields, formula){
  const out=[]; let offset="";
  do{
    const q=new URLSearchParams(); q.set("pageSize","100"); q.set("returnFieldsByFieldId","true");
    (fields||[]).forEach(f=>q.append("fields[]",f)); if(formula) q.set("filterByFormula",formula); if(offset) q.set("offset",offset);
    const js=await at("GET", API+base+"/"+table+"?"+q.toString());
    out.push(...(js.records||[])); offset=js.offset||"";
  } while(offset);
  return out;
}
async function createRecs(base, table, list){ const out=[]; for(let i=0;i<list.length;i+=10){ const js=await at("POST",API+base+"/"+table,{records:list.slice(i,i+10).map(fields=>({fields})), typecast:true, returnFieldsByFieldId:true}); out.push(...js.records); } return out; }
async function updateRecs(base, table, list){ const out=[]; for(let i=0;i<list.length;i+=10){ const js=await at("PATCH",API+base+"/"+table,{records:list.slice(i,i+10), typecast:true, returnFieldsByFieldId:true}); out.push(...js.records); } return out; }
async function deleteRecs(base, table, ids){ for(let i=0;i<ids.length;i+=10){ const q=new URLSearchParams(); ids.slice(i,i+10).forEach(id=>q.append("records[]",id)); await at("DELETE",API+base+"/"+table+"?"+q.toString()); } }

// ---------- master data ----------
function shortAlias(a){
  const first=String(a||"").split("\n")[0].replace(/[（(].*$/,"").trim();
  if(!first || /[0-9⚠✅❌🔴]/.test(first) || first.length>24) return "";
  return first;
}
async function loadMaster(){
  const P=C.ops.projects, K=C.ops.cranes, W=C.hr.workers, R=C.com.rates;
  const [ps,cs,ws,rs]=await Promise.all([
    listAll(C.ops.base,P.table,[P.name,P.uid,P.org,P.status,P.cycle]),
    listAll(C.ops.base,K.table,[K.label,K.uid,K.project,K.no,K.shift,K.status]),
    listAll(C.hr.base,W.table,[W.name,W.uid,W.role,W.status,W.alias]),
    listAll(C.com.base,R.table,[R.project,R.month,R.status,R.rows,R.otSummary],"NOT({Template Rate Rows}='')"),
  ]);
  S.projects=ps.map(r=>({rec:r.id, uid:r.fields[P.uid]||"", name:r.fields[P.name]||"", org:r.fields[P.org]||"", status:r.fields[P.status]||"", cycle:r.fields[P.cycle]||""})).filter(p=>p.uid);
  S.cranes=cs.map(r=>({rec:r.id, uid:r.fields[K.uid]||"", project:r.fields[K.project]||"", no:r.fields[K.no]||"", label:r.fields[K.label]||"", shift:r.fields[K.shift]||"", status:r.fields[K.status]||""})).filter(c=>c.project&&c.no);
  S.workers=ws.map(r=>({uid:r.fields[W.uid]||"", name:r.fields[W.name]||"", role:r.fields[W.role]||"", status:r.fields[W.status]||"", alias:shortAlias(r.fields[W.alias])})).filter(w=>w.uid);
  S.rates=rs.map(r=>({project:r.fields[R.project]||"", month:r.fields[R.month]||"", status:r.fields[R.status]||"", summary:r.fields[R.otSummary]||"",
    lines:String(r.fields[R.rows]||"").split(/\n/).map(l=>l.trim()).filter(Boolean).map(l=>{ const [code,ot,lump,deduct]=l.split("|"); return {code:(code||"").trim(), ot:Number(ot)||0, lump:Number(lump)||0, deduct:(deduct||"").trim()}; })}));
}
const M = {
  proj(uid){ return S.projects.find(p=>p.uid===uid); },
  projByRec(rec){ return S.projects.find(p=>p.rec===rec); },
  projects(all){ return S.projects.filter(p=>all||/^active$/i.test(p.status)).sort((a,b)=>a.name.localeCompare(b.name)); },
  cranes(puid){ return S.cranes.filter(c=>c.project===puid && c.status!=="已撤场").sort((a,b)=>(parseInt(a.no.replace(/\D/g,""))||99)-(parseInt(b.no.replace(/\D/g,""))||99)); },
  crane(puid,no){ return S.cranes.find(c=>c.project===puid && c.no===no); },
  worker(uid){ return S.workers.find(w=>w.uid===uid); },
  wname(uid){ const w=M.worker(uid); return w? w.name : (uid||""); },
};
function workerOptions(sel){
  const g={op:[],rel:[],oth:[]};
  for(const w of S.workers){ const r=(w.role||"").toLowerCase(); (r.includes("relief")?g.rel:r.includes("operator")?g.op:g.oth).push(w); }
  const o=w=>`<option value="${esc(w.uid)}"${w.uid===sel?" selected":""}>${esc(w.name)}${w.alias&&w.alias.toUpperCase()!==w.name?" · "+esc(w.alias):""}</option>`;
  const sort=a=>a.sort((x,y)=>x.name.localeCompare(y.name));
  let h=`<option value="">— 无人 / 不开 —</option>`;
  h+=`<optgroup label="塔吊司机">${sort(g.op).map(o).join("")}</optgroup>`;
  h+=`<optgroup label="替班 Relief">${sort(g.rel).map(o).join("")}</optgroup>`;
  h+=`<optgroup label="其他人员">${sort(g.oth).map(o).join("")}</optgroup>`;
  if(sel && !M.worker(sel)) h+=`<option value="${esc(sel)}" selected>${esc(sel)}（主档中未找到）</option>`;
  return h;
}
function projOptions(sel, all, withAll){
  let h=withAll?`<option value="">全部工地</option>`:"";
  const ps=M.projects(all);
  if(sel && !ps.find(p=>p.uid===sel) && M.proj(sel)) ps.unshift(M.proj(sel));
  for(const p of ps) h+=`<option value="${esc(p.uid)}"${p.uid===sel?" selected":""}>${esc(p.name)}${/^active$/i.test(p.status)?"":" ("+esc(p.status)+")"}</option>`;
  return h;
}

// ---------- timesheet rows ----------
function slotKey(date, crane, shift, n){ return safeSeg(`${date}_${crane}_${shift}${n?"_"+n:""}`); }
// Airtable 里的稳定键带工地：日期_ProjectUID_TC_班次[_序号]
function makeUid(puid, slot){ return slot.slice(0,10)+"_"+safeSeg(puid)+slot.slice(10); }
function fromRec(rec){
  const f=rec.fields||{};
  let project=f[T.projectUid]||""; if(!project && f[T.projectLink]?.[0]) project=M.projByRec(f[T.projectLink][0])?.uid||"";
  let worker=f[T.workerUid]||""; if(!worker && f[T.worker]) worker=(String(f[T.worker]).split("｜")[1]||"").trim();
  const shift=SHIFT_BY_EN[f[T.shift]]||"D";
  const status=STATUS_FROM_AT[f[T.status]]||"S";
  const date=f[T.date]||"";
  const crane=f[T.craneNo]||"";
  const uid=f[T.uid]||"";
  return {_id:rec.id, uid, date, project, crane, craneUid:f[T.craneUid]||"", shift, worker, workerLabel:f[T.worker]||"",
    start:normTime(f[T.start]), end:normTime(f[T.end]), ltw:!!f[T.ltw], note:f[T.notes]||"", status,
    why:f[T.reject]||"", source:f[T.source]||"", vby:f[T.verifiedBy]||"",
    ev:(f[T.card]||[]).map(a=>({id:a.id, url:a.url, thumb:a.thumbnails?.small?.url||"", name:a.filename||"", pdf:/pdf/i.test(a.type||"")})),
    key: slotKey(date, crane||"—", shift)};
}
function workerLabel(uid){ const w=M.worker(uid); return w? `${w.name}｜${w.uid}` : uid; }
function toFields(r){
  const p=M.proj(r.project), c=M.crane(r.project, r.crane);
  const f={
    [T.uid]:r.uid, [T.date]:r.date, [T.projectUid]:r.project, [T.craneNo]:r.crane||null,
    [T.craneUid]:c?.uid||r.craneUid||"", [T.worker]:r.worker?workerLabel(r.worker):null, [T.workerUid]:r.worker||"",
    [T.shift]:SHIFTS[r.shift]?.en||"Day", [T.start]:r.start, [T.end]:r.end, [T.ltw]:!!r.ltw,
    [T.status]:STATUS_AT[r.status]||"Recorded", [T.notes]:r.note||"",
  };
  if(p) f[T.projectLink]=[p.rec];
  if(c) f[T.craneLink]=[c.rec];
  return f;
}
function allRows(){ return Object.values(S.rows); }
function rowsFor(puid, date){ return allRows().filter(r=>r.project===puid && r.date===date); }
function putRecs(recs){ for(const rec of recs) S.rows[rec.id]=fromRec(rec); }
async function loadMonths(months, force){
  const need=months.filter(m=>force||!S.months.has(m)); if(!need.length) return;
  const formula="OR("+need.map(m=>`DATETIME_FORMAT({Work Date},'YYYY-MM')='${m}'`).join(",")+")";
  const recs=await listAll(C.ops.base, T.table, Object.values(T).filter(v=>v.startsWith("fld")), formula);
  if(force) for(const [id,r] of Object.entries(S.rows)) if(need.includes(monthOf(r.date||"0000-00"))) delete S.rows[id];
  putRecs(recs); need.forEach(m=>S.months.add(m));
}
function neededMonths(){
  const set=new Set();
  const ed=$("e-date").value||todaySG(); set.add(monthOf(ed)); set.add(monthOf(addDays(ed,-1)));
  const cm=$("c-month").value; if(cm) set.add(cm);
  const sm=$("s-month").value; if(sm){ set.add(sm); set.add(addMonths(sm,-1)); }
  return [...set].sort();
}
async function ensureData(force){
  try{ await loadMonths(neededMonths(), force); if(S.tab==="sum") await loadAdj(force); }
  catch(e){ toast("读取工时失败："+explain(e), 8000); }
  render();
}

// ---------- ENTRY VIEW ----------
function renderEntry(){
  const body=$("e-body");
  const puid=$("e-proj").value; const date=$("e-date").value;
  if(!puid){ body.innerHTML=`<div class="note">没有可选的工地。勾选「显示非 Active 工地」看看。</div>`; return; }
  const p=M.proj(puid); const cranes=M.cranes(puid);
  const existing=rowsFor(puid,date);
  const byKey={}; for(const r of existing){ let k=r.key; if(byKey[k]) k=r.key+"_"+r._id.slice(-5); byKey[k]=r; r._slot=k; }
  const used=new Set(); const craneRows={};
  for(const c of cranes){
    const list=[]; const wantN=/night|夜/i.test(c.shift||"");
    for(const sh of ["D","N"]){
      const id=slotKey(date,c.no,sh); const ex=byKey[id];
      if(sh==="N" && !wantN && !ex && !S.dirty[id]) continue;
      list.push({id, crane:c.no, shift:sh, ex}); used.add(id);
    }
    craneRows[c.no]={c, list};
  }
  for(const [k,r] of Object.entries(byKey)){ if(used.has(k)) continue;
    const cn=r.crane||"—"; (craneRows[cn] ||= {c:{no:cn,label:r.crane?"（主档里没有这台）":"（没填塔吊号）",shift:""}, list:[]}).list.push({id:k, crane:r.crane, shift:r.shift, ex:r}); used.add(k); }
  for(const [id,d] of Object.entries(S.dirty)){ if(used.has(id)||d.project!==puid||d.date!==date) continue;
    const cn=d.crane||"—"; (craneRows[cn] ||= {c:{no:cn,label:"",shift:""}, list:[]}).list.push({id, crane:d.crane, shift:d.shift, ex:null}); }
  const nDirty=Object.values(S.dirty).filter(d=>d.project===puid&&d.date===date).length;
  const dayH=existing.reduce((a,r)=>a+calcHours(r.start,r.end),0);
  const nS=existing.filter(r=>r.status==="S").length;
  let h=`<div class="proj-head"><h2>${esc(p?.name||puid)}</h2>
    <span class="meta">${esc(p?.org||"")}${p?.cycle?" · Claim 周期 "+esc(p.cycle):""}</span>
    <span class="meta mono">${date} 周${WD[dow(date)]}${isPH(date)?" · <b style='color:var(--bad)'>公休</b>":dow(date)===0?" · <b style='color:var(--bad)'>周日</b>":""} · Airtable 里 ${existing.length} 条 · ${fmtH(dayH)} h</span></div>`;
  if(nS) h+=`<div class="note warn" style="margin-bottom:12px">有 ${nS} 条是工人用表单提交的（黄色「工人提交」）。核对后点保存，就会转成办公室记录并补齐编号。</div>`;
  if(!cranes.length) h+=`<div class="note warn" style="margin-bottom:12px">Airtable 里这个工地还没有塔吊记录（Operations → 02｜Cranes）。可以用下面「加一行」手动录。</div>`;
  h+=`<div class="cranes">`;
  for(const {c,list} of Object.values(craneRows)){
    h+=`<div class="crane"><div class="crane-h"><span class="tc">${esc(c.no)}</span><span class="lab">${esc(c.label||"")}</span><span class="req">${c.shift?"要求："+esc(c.shift):""}</span></div>`;
    for(const s of list) h+=slotHTML(s, puid, date);
    h+=`<div class="slot-add">
      <button class="btn sm" data-add="${esc(c.no)}|D">+ 日班加一人</button>
      <button class="btn sm" data-add="${esc(c.no)}|N">+ 夜班</button>
      <button class="btn sm" data-add="${esc(c.no)}|CL">+ 爬升/架设/拆卸/待命</button></div></div>`;
  }
  h+=`</div>
  <div class="slot-add" style="border:0;padding:12px 0">
    <input type="text" id="e-newtc" placeholder="其他塔吊号，如 TC8" style="max-width:180px">
    <button class="btn sm" id="e-addtc">加一行</button></div>`;
  h+=`<div class="savebar"><span>${nDirty?`<b>${nDirty}</b> 条改动未保存`:"没有未保存的改动"}</span><span class="spacer"></span>
      <button class="btn ghost" id="e-discard" style="color:var(--ground)"${nDirty?"":" disabled"}>放弃</button>
      <button class="btn primary" id="e-save"${nDirty?"":" disabled"}>保存到 Airtable</button></div>`;
  const focusId=document.activeElement?.id; const selStart=document.activeElement?.selectionStart;
  body.innerHTML=h;
  if(focusId && $(focusId)){ $(focusId).focus(); try{ if(selStart!=null) $(focusId).setSelectionRange(selStart,selStart);}catch{} }
}
function slotHTML(s, puid, date){
  const d=S.dirty[s.id]; const ex=s.ex;
  const v=d || ex || {};
  const sh=v.shift||s.shift; const def=SHIFTS[sh]||SHIFTS.D;
  const st=v.start||def.st, et=v.end||def.et, ltw=!!v.ltw;
  const dc=dayCalc(date,st,et,ltw);
  const status=ex?.status; const locked=status==="V" && !d;
  const pid=safeSeg(s.id); const dis=locked?" disabled":"";
  const attrs=`data-slot="${esc(s.id)}" data-crane="${esc(s.crane||"")}" data-shift="${esc(sh)}" data-rec="${esc(ex?._id||"")}"`;
  if(!v.worker && !ex){
    return `<div class="slot empty${d?" dirty":""}" ${attrs}>
      <div class="sh">${SHIFTS[sh]?.name||sh}<small>${SHIFTS[sh]?.en||""}</small></div>
      <div class="w"><select id="w-${pid}" data-k="worker" data-id="${esc(s.id)}" aria-label="司机">${workerOptions("")}</select></div>
      <div class="hint">选了司机再填时间，默认 ${esc(st)}–${esc(et)}</div></div>`;
  }
  const cls=["slot", d?"dirty":"", locked?"locked":""].join(" ");
  const shSel=(s.shift==="D"||s.shift==="N")&&!d?.shiftFree&&!(ex&&!["D","N"].includes(ex.shift)) ? `<div class="sh">${SHIFTS[sh]?.name||sh}<small>${SHIFTS[sh]?.en||""}</small></div>`
    : `<div class="sh"><select id="sh-${pid}" data-k="shift" data-id="${esc(s.id)}"${dis}>${Object.entries(SHIFTS).map(([k,x])=>`<option value="${k}"${k===sh?" selected":""}>${x.name}</option>`).join("")}</select></div>`;
  return `<div class="${cls}" ${attrs}>
    ${shSel}
    <div class="w"><span class="lbl-m">司机</span><select id="w-${pid}" data-k="worker" data-id="${esc(s.id)}"${dis} aria-label="司机">${workerOptions(v.worker||"")}</select></div>
    <div><span class="lbl-m">上班</span><input type="time" id="st-${pid}" data-k="start" data-id="${esc(s.id)}"${dis} value="${esc(st)}" aria-label="上班时间"></div>
    <div><span class="lbl-m">下班</span><input type="time" id="et-${pid}" data-k="end" data-id="${esc(s.id)}"${dis} value="${esc(et)}" aria-label="下班时间"></div>
    <label class="ltw"><input type="checkbox" id="lt-${pid}" data-k="ltw" data-id="${esc(s.id)}"${dis}${ltw?" checked":""}><span>午休干活<small>LTW +1h</small></span></label>
    <div class="hrs"><span class="lbl-m">工时 / OT</span>${fmtH(dc.span)}<small>OT ${fmtH(dc.ot)}</small></div>
    <div class="note-in"><input type="text" id="nt-${pid}" data-k="note" data-id="${esc(s.id)}"${dis} value="${esc(v.note||"")}" placeholder="备注：替班、提前收工…" aria-label="备注"></div>
    <div class="end">${d?`<span class="pill st-new">未保存</span>`:status?`<span class="pill st-${status}">${STATUS[status]}</span>${ex.ev.length?`<span class="src">📎${ex.ev.length}</span>`:""}`:`<span class="muted" style="font-size:12px">空</span>`}
      ${locked?`<button class="btn sm" data-unlock="${esc(s.id)}">解锁</button>`:""}</div>
  </div>`;
}
function slotBase(el){
  const slot=el.closest("[data-slot]"); const id=slot.dataset.slot;
  const puid=$("e-proj").value, date=$("e-date").value;
  const ex=slot.dataset.rec? S.rows[slot.dataset.rec] : null;
  const shift=slot.dataset.shift; const def=SHIFTS[shift]||SHIFTS.D;
  return S.dirty[id] || {project:puid, date, crane:slot.dataset.crane||"", shift, rec:ex?._id||"",
    worker:ex?.worker||"", start:ex?.start||def.st, end:ex?.end||def.et, ltw:!!ex?.ltw, note:ex?.note||"", shiftFree:!(shift==="D"||shift==="N")};
}
function onEntryInput(e){
  const el=e.target; const k=el.dataset.k; if(!k) return;
  const id=el.dataset.id; const d={...slotBase(el)};
  d[k]=el.type==="checkbox"? el.checked : el.value;
  if(k==="shift"){ const def=SHIFTS[d.shift]; if(def){ d.start=def.st; d.end=def.et; } }
  S.dirty[id]=d;
  if(e.type==="change"||k==="worker"||k==="shift"||k==="ltw") renderEntry(); else scheduleEntryRender();
}
let _er; function scheduleEntryRender(){ clearTimeout(_er); _er=setTimeout(renderEntry,600); }
async function saveEntry(){
  const puid=$("e-proj").value, date=$("e-date").value;
  const items=Object.entries(S.dirty).filter(([,d])=>d.project===puid&&d.date===date);
  if(!items.length) return;
  const creates=[], updates=[], deletes=[];
  for(const [id,d] of items){
    const ex=d.rec? S.rows[d.rec] : null;
    if(!d.worker){ if(ex) deletes.push(ex._id); continue; }
    const uid = (ex?.uid) || makeUid(puid, id.startsWith(date)? id : slotKey(date,d.crane||"—",d.shift));
    const r={uid, date, project:puid, crane:d.crane, shift:d.shift, worker:d.worker, start:normTime(d.start), end:normTime(d.end), ltw:!!d.ltw, note:(d.note||"").trim()};
    if(!ex){ r.status="R"; creates.push({...toFields(r), [T.source]:"Office Entry"}); continue; }
    const changedCore=["worker","start","end","ltw","shift","crane"].some(k=>String(ex[k]??"")!==String(r[k]??""));
    r.status = ex.status==="S" ? (ex.ev.length?"E":"R")
             : changedCore ? (ex.ev.length?"E":"R") : ex.status;
    const f=toFields(r);
    if(changedCore && ex.status!=="S"){ f[T.reject]=""; f[T.verifiedBy]=""; f[T.verifiedDate]=null; }
    updates.push({id:ex._id, fields:f});
  }
  const btn=$("e-save"); btn.disabled=true; btn.textContent="保存中…";
  try{
    if(creates.length) putRecs(await createRecs(C.ops.base,T.table,creates));
    if(updates.length) putRecs(await updateRecs(C.ops.base,T.table,updates));
    if(deletes.length){ await deleteRecs(C.ops.base,T.table,deletes); deletes.forEach(id=>delete S.rows[id]); }
    for(const [id] of items) delete S.dirty[id];
    toast(`已写入 Airtable：新增 ${creates.length}，更新 ${updates.length}，删除 ${deletes.length}`);
  }catch(e){ toast("保存失败："+explain(e)+" 改动还在，稍后再点保存。", 9000); }
  renderEntry();
}
function copyPrevDay(){
  const puid=$("e-proj").value, date=$("e-date").value, prev=addDays(date,-1);
  const src=rowsFor(puid,prev).filter(r=>r.worker);
  if(!src.length){ toast(prev+" 没有记录可以照抄"); return; }
  const have=new Set(rowsFor(puid,date).map(r=>r.key));
  let n=0;
  for(const r of src){
    const id=slotKey(date,r.crane||"—",r.shift);
    let k=id, i=1; while(have.has(k)||S.dirty[k]){ i++; k=slotKey(date,r.crane||"—",r.shift,i); }
    if(i>1 && (have.has(id)) && !src.some(x=>x!==r && x.crane===r.crane && x.shift===r.shift)) continue;
    S.dirty[k]={project:puid,date,crane:r.crane,shift:r.shift,worker:r.worker,start:r.start,end:r.end,ltw:r.ltw,note:"",rec:"",shiftFree:!(r.shift==="D"||r.shift==="N")||i>1};
    n++;
  }
  toast(n?`从 ${prev} 照抄了 ${n} 条，确认后点保存`:"这一天已经有同样的班次，没有照抄");
  renderEntry();
}
function addSlot(crane, shift){
  const puid=$("e-proj").value, date=$("e-date").value;
  const taken=new Set([...rowsFor(puid,date).map(r=>r.key), ...Object.keys(S.dirty)]);
  let id=slotKey(date,crane,shift), n=1; while(taken.has(id)){ n++; id=slotKey(date,crane,shift,n); }
  const def=SHIFTS[shift];
  S.dirty[id]={project:puid,date,crane,shift,worker:"",start:def.st,end:def.et,ltw:false,note:"",rec:"",shiftFree:!(shift==="D"||shift==="N")||n>1};
  renderEntry();
}

// ---------- CHECK VIEW ----------
function checkRows(){
  const m=$("c-month").value, p=$("c-proj").value, st=$("c-status").value, q=$("c-worker").value.trim().toLowerCase();
  return allRows().filter(r=>monthOf(r.date||"")===m && (!p||r.project===p) &&
    (st==="all" || (st==="open"? r.status!=="V" : r.status===st)) &&
    (!q || r.worker.toLowerCase().includes(q) || M.wname(r.worker).toLowerCase().includes(q) || (M.worker(r.worker)?.alias||"").toLowerCase().includes(q)))
    .sort((a,b)=>a.date.localeCompare(b.date)||a.project.localeCompare(b.project)||String(a.crane).localeCompare(String(b.crane))||a.shift.localeCompare(b.shift));
}
function evHTML(ev){
  return `<div class="ev">${(ev||[]).map(a=> a.pdf||!a.thumb
    ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}">${a.pdf?"PDF":"文件"}</a>`
    : `<a href="${esc(a.url)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${esc(a.thumb)}" alt="工卡" loading="lazy"></a>`).join("")}</div>`;
}
function renderCheck(){
  const rows=checkRows();
  for(const id of [...S.sel]) if(!rows.find(r=>r._id===id)) S.sel.delete(id);
  const nSel=S.sel.size;
  $("c-selinfo").textContent=nSel?`已选 ${nSel} 条`:"勾选记录后可批量操作";
  for(const id of ["c-verify","c-reject","c-reopen"]) $(id).disabled=!nSel;
  $("c-upl-l").style.opacity=nSel?1:.45; $("c-upl").disabled=!nSel;
  if(!rows.length){ $("c-body").innerHTML=`<div class="note">这个筛选条件下没有记录。</div>`; return; }
  const sum=rows.reduce((a,r)=>a+calcHours(r.start,r.end),0);
  let h=`<div class="tablebox"><table><thead><tr>
    <th><input type="checkbox" id="c-all" aria-label="全选"${nSel&&nSel===rows.length?" checked":""}></th>
    <th>日期</th><th>工地</th><th>塔吊</th><th>班次</th><th>司机</th><th>时间</th><th class="r">跨度 h</th><th>工卡</th><th>状态</th><th>备注</th></tr></thead><tbody>`;
  for(const r of rows){
    const sel=S.sel.has(r._id);
    const problems=[]; if(!r.project) problems.push("没有工地"); if(!r.worker) problems.push("没有司机"); if(!r.start||!r.end) problems.push("时间不全");
    h+=`<tr class="${sel?"sel":""}"><td><input type="checkbox" data-sel="${esc(r._id)}"${sel?" checked":""} aria-label="选择"></td>
      <td class="mono">${esc((r.date||"").slice(5))} <span class="muted">${r.date?WD[dow(r.date)]:""}</span></td>
      <td>${esc(M.proj(r.project)?.name||r.project||"—")}</td><td class="mono">${esc(r.crane||"—")}</td>
      <td>${esc(SHIFTS[r.shift]?.name||r.shift)}</td><td>${esc(M.wname(r.worker)||r.workerLabel||"—")}</td>
      <td class="mono">${esc(r.start)}–${esc(r.end)}${r.ltw?` <span class="muted">+LTW</span>`:""}</td>
      <td class="r mono">${fmtH(calcHours(r.start,r.end))}</td><td>${evHTML(r.ev)}</td>
      <td><span class="pill st-${r.status}">${STATUS[r.status]||r.status}</span></td>
      <td>${problems.length?`<div class="why">${problems.join("、")}</div>`:""}${r.why?`<div class="why">${esc(r.why)}</div>`:""}${r.note?`<div class="muted" style="white-space:normal;max-width:220px">${esc(r.note)}</div>`:""}</td></tr>`;
  }
  h+=`</tbody><tfoot><tr><td></td><td colspan="6">${rows.length} 条</td><td class="r mono">${fmtH(sum)}</td><td colspan="3"></td></tr></tfoot></table></div>`;
  $("c-body").innerHTML=h;
}
function selectedRows(){ return allRows().filter(r=>S.sel.has(r._id)); }
function completeFields(r){ // 工人表单提交的记录：核验时补齐编号和稳定键
  const f={};
  if(!r.uid && r.date && r.project) f[T.uid]=makeUid(r.project, slotKey(r.date,r.crane||"—",r.shift))+"_"+r._id.slice(-5);
  if(r.project){ f[T.projectUid]=r.project; const p=M.proj(r.project); if(p) f[T.projectLink]=[p.rec]; }
  if(r.worker) f[T.workerUid]=r.worker;
  const c=M.crane(r.project,r.crane); if(c){ f[T.craneUid]=c.uid; f[T.craneLink]=[c.rec]; }
  return f;
}
async function bulk(fn, okMsg){
  const rows=selectedRows(); if(!rows.length) return;
  const out=[]; let skipped=0;
  for(const r of rows){ const p=fn(r); if(p) out.push({id:r._id, fields:{...completeFields(r), ...p}}); else skipped++; }
  try{ if(out.length) putRecs(await updateRecs(C.ops.base,T.table,out)); S.sel.clear(); toast(okMsg(out.length, skipped)); }
  catch(e){ toast("操作失败："+explain(e), 8000); }
  render();
}
function verifySel(){
  bulk(r=> (r.ev.length && r.status!=="V" && r.project && r.worker && r.start && r.end) ? {[T.status]:"Verified", [T.verifiedBy]:S.userName||"Office", [T.verifiedDate]:todaySG(), [T.reject]:""} : null,
       (n,s)=> `已核验 ${n} 条`+(s?`；${s} 条没有工卡、资料不全或已核验，未改动`:""));
}
function rejectSel(why){ bulk(()=>({[T.status]:"Rejected", [T.reject]:why, [T.verifiedBy]:S.userName||"Office", [T.verifiedDate]:todaySG()}), n=>`已退回 ${n} 条`); }
function reopenSel(){ bulk(r=>({[T.status]:r.ev.length?"Evidence Attached":"Recorded", [T.reject]:"", [T.verifiedBy]:"", [T.verifiedDate]:null}), n=>`${n} 条已撤回`); }
async function toUploadable(file){
  if(file.type==="application/pdf") return {blob:file, type:"application/pdf", name:file.name};
  if(/^image\/(jpeg|png|webp)$/.test(file.type) && file.size<1.5e6) return {blob:file, type:file.type, name:file.name};
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=()=>rej(new Error("这个格式浏览器打不开，请存成 JPG 或 PDF 再传")); i.src=url; });
    const scale=Math.min(1, 2200/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas"); c.width=Math.round(img.naturalWidth*scale); c.height=Math.round(img.naturalHeight*scale);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.85));
    return {blob, type:"image/jpeg", name:(file.name||"workcard").replace(/\.\w+$/,"")+".jpg"};
  } finally { URL.revokeObjectURL(url); }
}
function b64(blob){ return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(String(fr.result).split(",")[1]); fr.onerror=()=>rej(fr.error); fr.readAsDataURL(blob); }); }
async function uploadEvidence(files){
  const rows=selectedRows(); if(!rows.length||!files.length) return;
  const lab=$("c-upl-l"); const old=lab.lastChild.textContent; lab.lastChild.textContent="上传中…";
  try{
    const first=rows[0]; let added=[];
    for(const f of files){
      const u=await toUploadable(f); if(u.blob.size>5e6) throw new Error(`${f.name} 超过 5MB，Airtable 不收。拍照时调低分辨率或压成 PDF。`);
      const js=await at("POST",`https://content.airtable.com/v0/${C.ops.base}/${first._id}/${T.card}/uploadAttachment`,{contentType:u.type, file:await b64(u.blob), filename:u.name});
      const list=js?.fields?.[T.card]||Object.values(js?.fields||{})[0]||[];
      const known=new Set([...first.ev.map(a=>a.id), ...added.map(a=>a.id)]);
      added.push(...list.filter(a=>!known.has(a.id)));
    }
    // 第一条已经带上文件；其余记录直接引用同一个附件链接，不重复上传
    const updates=rows.map((r,i)=>({id:r._id, fields:{
      ...(i===0?{}:{[T.card]:[...r.ev.map(a=>({id:a.id})), ...added.map(a=>({url:a.url, filename:a.filename}))]}),
      [T.status]: r.status==="V"?"Verified":"Evidence Attached", ...completeFields(r)}}));
    putRecs(await updateRecs(C.ops.base,T.table,updates));
    toast(`${files.length} 个文件已附到 ${rows.length} 条记录`); S.sel.clear();
  }catch(e){ toast("上传失败："+explain(e)+" 也可以直接在 Airtable 里把照片拖进 Work Card 列。", 10000); }
  lab.lastChild.textContent=old; $("c-upl").value=""; render();
}

// ---------- CLAIM VIEW（对照《总包 Claim 计算表》V2 = CLAIM）----------
function periodFor(puid, endMonth){
  const p=M.proj(puid); const cyc=(p?.cycle||"").toLowerCase();
  const m=cyc.match(/(\d{1,2})(?:st|nd|rd|th)?\s*to\s*(\d{1,2})/);
  if(m && Number(m[1])>1){ const sd=Number(m[1]), ed=Number(m[2]); const pm=addMonths(endMonth,-1);
    return {from:`${pm}-${String(sd).padStart(2,"0")}`, to:`${endMonth}-${String(Math.min(ed,daysIn(endMonth))).padStart(2,"0")}`, label:p.cycle, cross:true}; }
  return {from:`${endMonth}-01`, to:`${endMonth}-${String(daysIn(endMonth)).padStart(2,"0")}`, label:p?.cycle||"自然月", cross:false};
}
function datesBetween(a,b){ const out=[]; for(let d=a; d<=b; d=addDays(d,1)) out.push(d); return out; }
// Template Rate Rows：每个代码取「生效月 ≤ 业务月」的最新一行（与 rate_drift.py 同规则）
function ratesFor(puid, endMonth){
  const cut=endMonth+"-01"; const best={};
  for(const r of S.rates.filter(r=>r.project===puid && r.month && r.month<=cut).sort((a,b)=>a.month.localeCompare(b.month)))
    for(const l of r.lines) best[l.code]={...l, month:r.month, status:r.status, summary:r.summary};
  return Object.values(best);
}
function autoCode(rs, crane, sc){
  if(!rs.length) return ""; if(rs.length===1) return rs[0].code;
  const tc=rs.filter(r=>new RegExp("-"+crane+"$","i").test(r.code)); if(tc.length===1) return tc[0].code;
  const sh=rs.filter(r=>r.code.endsWith(sc==="N"?"夜班":"日班")); if(sh.length===1) return sh[0].code;
  return "";
}
function adjKey(puid, em, gk){ return `${puid}__${em}__${gk}`; }
async function loadAdj(force){
  const puid=$("s-proj").value, em=$("s-month").value; if(!puid||!em) return;
  const k=puid+"|"+em; if(!force && S.adjLoaded===k) return;
  const recs=await listAll(C.ops.base, A.table, Object.values(A).filter(v=>v.startsWith("fld")), `AND({Project UID}='${puid.replace(/'/g,"\\'")}',{Period End Month}='${em}')`);
  S.adj={}; for(const r of recs){ const f=r.fields; S.adj[f[A.key]]={rec:r.id, code:f[A.code]||"", from:f[A.from]||"", to:f[A.to]||"", manualAbsent:f[A.manualAbsent]||0, otAdj:f[A.otAdj]||0, other:f[A.other]||0}; }
  S.adjLoaded=k;
}
function claimGroups(){
  const puid=$("s-proj").value, em=$("s-month").value; if(!puid||!em) return null;
  const per=periodFor(puid,em); const onlyV=$("s-onlyv").checked; const rs=ratesFor(puid,em);
  const split=rs.some(r=>/日班|夜班/.test(r.code));
  const inPer=allRows().filter(r=>r.project===puid && r.date>=per.from && r.date<=per.to && r.status!=="X" && r.worker && r.start && r.end);
  const use=inPer.filter(r=>!onlyV||r.status==="V");
  const groups={};
  for(const r of use){
    const sc=(mins(r.start)??0)>=1020?"N":"D";
    const gk=[r.worker, r.crane||"—", split?sc:""].filter(Boolean).join("__");
    (groups[gk] ||= {gk, worker:r.worker, crane:r.crane||"—", sc: split?sc:"", rows:[]}).rows.push(r);
  }
  const dates=datesBetween(per.from, per.to); const specialN=dates.filter(isSpecial).length;
  const out=[];
  for(const g of Object.values(groups)){
    const cfg=S.adj[adjKey(puid,em,g.gk)]||{};
    const code=cfg.code || autoCode(rs, g.crane, g.sc||(g.rows.some(r=>mins(r.start)>=1020)?"N":"D"));
    const rate=rs.find(r=>r.code===code);
    const from=cfg.from||per.from, to=cfg.to||per.to;
    const byDate={}; for(const r of g.rows) (byDate[r.date] ||= []).push(r);
    const days=[]; let E=0,I=0,J=0,absent=0,worked=0;
    for(const d of dates){
      const list=byDate[d]||[]; const sp=isSpecial(d);
      let span=0,ot=0,bill=0,ltw=0,night=false,longOk=true;
      for(const r of list){ const c=dayCalc(d,r.start,r.end,r.ltw); span+=c.span; ot+=c.ot; bill+=c.bill; if(r.ltw) ltw++; if(mins(r.end)<mins(r.start)){ night=true; longOk=false; } }
      const inRange=d>=from && d<=to; const isAbs=!sp && !list.length && inRange;
      if(isAbs) absent++; if(!sp && list.length) worked++;
      E+=ot; I+=bill; J+=ltw;
      const tags=[];
      if(list.length){ if(isPH(d)) tags.push("公休OT"); else if(dow(d)===0) tags.push("Sunday OT");
        if(night) tags.push("Night Shift"); if(!sp && longOk && ot>10) tags.push("Long OT"); if(ltw) tags.push("+LTW"); }
      else if(isAbs) tags.push("Absent"); else if(isPH(d)) tags.push("PH");
      days.push({d, sp, rows:list, span, ot, bill, ltw, tags, inRange});
    }
    const r2=x=>Math.round(x*100)/100;
    const workable=dates.length-specialN; const lump=rate?.lump||0; const otRate=rate?.ot||0;
    const baseHours=lump? r2(E) : r2(I+J);
    const manualAbs=Number(cfg.manualAbsent)||0, otAdj=Number(cfg.otAdj)||0, other=Number(cfg.other)||0;
    const hours=r2(baseHours+otAdj); const otAmt=otRate? r2(hours*otRate) : 0;
    const noDeduct=(rate?.deduct||"")==="整月不折算";
    const deduction=(lump && workable && !noDeduct)? r2(lump/workable*(absent+manualAbs)) : 0;
    const total=r2(lump+otAmt+other-deduction);
    const warn=[];
    if(!code) warn.push("没有自动匹配到费率代码，请手选（CHEC-PRIMA 按 TC、CREC/TWRP/15EG 按日夜班）");
    else if(!rate) warn.push(`费率代码 ${code} 在 Project Rates 里 ${em} 前没有生效行`);
    else if(!otRate) warn.push(`Project Rates 里 ${code} 没有 OT 单价，加班费会是 0（易错点 #2/#3）`);
    if(rate && /待确认/.test(rate.status)) warn.push(`Project Rates 状态是「${rate.status}」，出单前先确认费率`);
    if(rate?.summary && /\+\s*\d|另加|每日/.test(rate.summary)) warn.push("费率摘要里有特殊规则：「"+rate.summary.split("\n")[0]+"」— 每日格里填不了，需要时在「OT 调整」手工补（易错点 #7）");
    out.push({...g, cfg, code, rate, from, to, days, E:r2(E), I:r2(I), J, absent, worked, workable, lump, otRate, baseHours, manualAbs, otAdj, other, hours, otAmt, deduction, noDeduct, total, warn});
  }
  const seen={};
  for(const g of out) if(g.lump){ const k=g.crane+"|"+g.code; (seen[k] ||= []).push(g); }
  for(const list of Object.values(seen)) if(list.length>1) for(const g of list)
    g.warn.push(`${g.crane} 用 ${g.code} 的有 ${list.length} 张表（${list.map(x=>M.wname(x.worker)).join("、")}），包干会算 ${list.length} 次。一个 TC 只收一份包干，其余把代码换掉或在「其他调整」里扣回（易错点 #6）`);
  out.sort((a,b)=>String(a.crane).localeCompare(String(b.crane))||a.sc.localeCompare(b.sc)||M.wname(a.worker).localeCompare(M.wname(b.worker)));
  return {per, groups:out, inPer, unv:inPer.filter(r=>r.status!=="V"), specialN, dates, rs};
}
function renderSum(){
  const R=claimGroups(); if(!R){ $("s-body").innerHTML=""; return; }
  const {per,groups,inPer,unv,rs}=R; const onlyV=$("s-onlyv").checked;
  $("s-period").textContent=`${per.from} → ${per.to}`;
  const grand=groups.reduce((a,g)=>a+g.total,0);
  let h=`<div class="stats">
    <div class="stat"><b>${money(grand)}</b><span>SGD Claim 合计（${onlyV?"只算已核验":"含未核验 · 预估"}）</span></div>
    <div class="stat"><b>${groups.length}</b><span>张计算表（司机 × TC）</span></div>
    <div class="stat"><b style="color:${unv.length?"var(--jib-ink)":"inherit"}">${unv.length}</b><span>条未核验${onlyV?"（未计入）":""}</span></div>
    <div class="stat"><b>${R.dates.length-R.specialN}</b><span>应工作天数（${R.dates.length} 天 − ${R.specialN} 周日/公休）</span></div></div>`;
  if(per.cross) h+=`<div class="note warn" style="margin-bottom:12px">这个工地的 Claim 周期是 ${esc(per.label)}，这里直接按 ${per.from} → ${per.to} 算，不用拆表。应工作天数也按这段日期算；Excel 模板是整月做分母（易错点 #10），两边会差一点。</div>`;
  if(!rs.length) h+=`<div class="note err" style="margin-bottom:12px">Commercial → Project Rates 里这个工地没有 Template Rate Rows，算不出金额。先在 Airtable 补费率行。</div>`;
  if(!inPer.length){ $("s-body").innerHTML=h+`<div class="note">这个周期还没有工时记录。</div>`; return; }
  if(!groups.length){ $("s-body").innerHTML=h+`<div class="note">有 ${inPer.length} 条记录，但都还没核验。取消勾选「只算已核验」可以先看预估。</div>`; return; }
  for(const g of groups){
    const gid=safeSeg(g.gk);
    const inp=(k,v,step,w)=>`<input type="number" step="${step}" data-cfg="${esc(g.gk)}" data-k="${k}" id="cf-${gid}-${k}" value="${esc(v)}" style="width:${w||90}px">`;
    h+=`<article class="claim">
      <header class="claim-h"><span class="tc">${esc(g.crane)}</span>
        <div><b>${esc(M.wname(g.worker))}</b>${g.sc?` <span class="pill ${g.sc==="N"?"st-E":"st-R"}">${g.sc==="N"?"夜班":"日班"}</span>`:""}
        <div class="muted" style="font-size:12px">${g.lump?"包干制 · 请款小时 = OT 合计":"纯计时 · 请款小时 = 总工时 + LTW"}</div></div>
        <span class="spacer"></span>
        <label class="field"><span>费率代码</span><select data-cfg="${esc(g.gk)}" data-k="code" id="cf-${gid}-code">
          <option value="">— 请选择 —</option>${rs.map(r=>`<option value="${esc(r.code)}"${r.code===g.code?" selected":""}>${esc(r.code)} · $${r.ot||"?"}/h${r.lump?" · 包干 $"+r.lump:""}</option>`).join("")}</select></label>
        <div class="claim-total"><span>最终 Claim</span><b>${money(g.total)}</b></div>
      </header>
      ${g.warn.map(w=>`<div class="note warn" style="margin:10px 14px 0">${esc(w)}</div>`).join("")}
      <div class="claim-grid">
        <dl>
          <dt>应工作天数</dt><dd class="num">${g.workable}</dd>
          <dt>出勤天数（平日）</dt><dd class="num">${g.worked}</dd>
          <dt>自动缺勤</dt><dd class="num">${g.absent}</dd>
          <dt>手动缺勤</dt><dd>${inp("manualAbsent",g.manualAbs,"0.5",80)}</dd>
          <dt>考勤起止</dt><dd><input type="date" data-cfg="${esc(g.gk)}" data-k="from" id="cf-${gid}-from" value="${esc(g.from)}"> → <input type="date" data-cfg="${esc(g.gk)}" data-k="to" id="cf-${gid}-to" value="${esc(g.to)}"></dd>
        </dl>
        <dl>
          <dt>OT 合计 (E33)</dt><dd class="num">${fmtH(g.E)}</dd>
          <dt>总计费工时 (I33)</dt><dd class="num">${fmtH(g.I)}</dd>
          <dt>LTW 小时</dt><dd class="num">${g.J}</dd>
          <dt>Claim 计费小时</dt><dd class="num">${fmtH(g.baseHours)}</dd>
          <dt>OT 调整 (h)</dt><dd>${inp("otAdj",g.otAdj,"0.5",80)}</dd>
        </dl>
        <dl class="money">
          <dt>基础包干</dt><dd class="num">${g.lump?money(g.lump):"—"}</dd>
          <dt>加班费 ${fmtH(g.hours)} h × $${g.otRate||"?"}</dt><dd class="num">${money(g.otAmt)}</dd>
          <dt>缺勤折算${g.noDeduct?"（整月不折算）":""}</dt><dd class="num">${g.deduction?"−"+money(g.deduction):"0.00"}</dd>
          <dt>其他调整 (SGD)</dt><dd>${inp("other",g.other,"0.01",100)}</dd>
          <dt class="tot">最终 Claim</dt><dd class="num tot">${money(g.total)}</dd>
        </dl>
      </div>
      <details><summary>逐日明细（对照 Excel 左侧 A–L 列）</summary><div class="tablebox" style="margin:0 14px 14px">
        <table><thead><tr><th>日期</th><th>星期</th><th>日型</th><th>上班</th><th>下班</th><th>LTW</th><th class="r">跨度 h</th><th class="r">OT h</th><th>Remarks</th><th>状态</th></tr></thead><tbody>
        ${g.days.filter(d=>d.inRange||d.rows.length).map(d=>`<tr class="${d.sp?"d-we":""}"><td class="mono">${d.d.slice(5)}</td><td>${WD[dow(d.d)]}</td><td>${d.sp?"-":d.rows.length?"1":"0"}</td>
          <td class="mono">${d.rows.map(r=>esc(r.start)).join("<br>")}</td><td class="mono">${d.rows.map(r=>esc(r.end)).join("<br>")}</td>
          <td>${d.ltw?"Y":""}</td><td class="r mono">${d.span?fmtH(d.span):""}</td><td class="r mono">${d.rows.length?fmtH(d.ot):""}</td>
          <td>${d.tags.map(t=>`<span class="tag${t==="Absent"?" bad":""}">${t}</span>`).join(" ")}</td>
          <td>${d.rows.map(r=>`<span class="pill st-${r.status}">${STATUS[r.status]}</span>`).join(" ")}</td></tr>`).join("")}
        </tbody></table></div></details>
    </article>`;
  }
  $("s-body").innerHTML=h;
}
const _cfgT={}, _cfgQ={};
function onCfgInput(e){
  const el=e.target; const gk=el.dataset.cfg; if(!gk) return;
  const k=el.dataset.k; let v=el.value;
  if(["manualAbsent","otAdj","other"].includes(k)) v=Number(v)||0;
  const puid=$("s-proj").value, em=$("s-month").value; const key=adjKey(puid,em,gk);
  const per=periodFor(puid,em);
  if((k==="from"&&v===per.from)||(k==="to"&&v===per.to)) v="";
  S.adj[key]={...(S.adj[key]||{}), [k]:v};
  clearTimeout(_cfgT[key]);
  const save=()=>{ // 同一张表的保存排队执行，避免连续输入时在 Airtable 建出重复记录
    _cfgQ[key]=(_cfgQ[key]||Promise.resolve()).then(saveNow);
  };
  const saveNow=async()=>{
    const a=S.adj[key]; const [w,cr,sc]=gk.split("__");
    const f={[A.key]:key, [A.project]:puid, [A.month]:em, [A.worker]:w, [A.crane]:cr, [A.shiftClass]:sc||"", [A.code]:a.code||"",
      [A.from]:a.from||null, [A.to]:a.to||null, [A.manualAbsent]:Number(a.manualAbsent)||0, [A.otAdj]:Number(a.otAdj)||0, [A.other]:Number(a.other)||0};
    try{
      if(a.rec) await updateRecs(C.ops.base,A.table,[{id:a.rec, fields:f}]);
      else { const [rec]=await createRecs(C.ops.base,A.table,[f]); S.adj[key].rec=rec.id; }
    }catch(err){ toast("调整项保存失败："+explain(err), 8000); }
  };
  if(e.type==="change"){ renderSum(); save(); } else _cfgT[key]=setTimeout(save,800);
}
function saveFile(name, text){
  const blob=new Blob(["﻿"+text],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); },1000);
}
function exportCSV(kind){
  const R=claimGroups(); if(!R||!R.groups.length){ toast("这个周期没有可导出的数据"); return; }
  const p=M.proj($("s-proj").value); const q=v=>{ const s=String(v??""); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  let head, lines=[];
  if(kind==="claim"){
    head=["Project","Crane","Shift","Worker UID","Worker","Rate Code","Type","Workable Days","Worked Days","Auto Absent","Manual Absent","OT Total (E33)","Billable Span (I33)","LTW Hours","Claim Hours","OT Adj","OT Rate","OT Amount","Base (Lump Sum)","Deduction","Other Adj","Total Claim","Warnings"];
    lines=R.groups.map(g=>[p?.name,g.crane,g.sc==="N"?"Night":g.sc==="D"?"Day":"",g.worker,M.wname(g.worker),g.code,g.lump?"Lump sum":"Hourly",g.workable,g.worked,g.absent,g.manualAbs,g.E,g.I,g.J,g.baseHours,g.otAdj,g.otRate,g.otAmt,g.lump,g.deduction,g.other,g.total,g.warn.join(" / ")].map(q).join(","));
  } else {
    head=["Date","Weekday","Day Type","Project","Crane","Worker UID","Worker","Start","End","LTW","Span (h)","OT (h)","Remarks","Status","Evidence Files","Airtable Record","Note"];
    for(const g of R.groups) for(const d of g.days) for(const r of d.rows){ const c=dayCalc(d.d,r.start,r.end,r.ltw);
      lines.push([d.d,WD[dow(d.d)],d.sp?"-":"1",p?.name,g.crane,g.worker,M.wname(g.worker),r.start,r.end,r.ltw?"Y":"N",c.span,c.ot,d.tags.join(" "),STATUS[r.status],r.ev.length,r._id,r.note||""].map(q).join(",")); }
  }
  saveFile(`JIAAN-${kind==="claim"?"Claim":"Timesheet"}_${safeSeg(p?.uid||"project")}_${R.per.from}_${R.per.to}${$("s-onlyv").checked?"":"_PREVIEW"}.csv`, [head.map(q).join(",")].concat(lines).join("\r\n"));
}

// ---------- shell ----------
function render(){
  if(!S.ready) return;
  $("cnt-check").textContent=allRows().filter(r=>r.status!=="V" && monthOf(r.date||"")===$("c-month").value).length;
  if(S.tab==="entry") renderEntry();
  if(S.tab==="check") renderCheck();
  if(S.tab==="sum") renderSum();
}
function setTab(t){
  S.tab=t; LS.set("tab",t);
  for(const b of document.querySelectorAll(".tab")) b.setAttribute("aria-selected", String(b.dataset.tab===t));
  $("v-entry").hidden=t!=="entry"; $("v-check").hidden=t!=="check"; $("v-sum").hidden=t!=="sum";
  render(); ensureData();
}
function fillSelectors(){
  const ep=$("e-proj").value||LS.get("proj","");
  $("e-proj").innerHTML=projOptions(ep, $("e-all").checked, false);
  if(!$("e-proj").value && $("e-proj").options.length) $("e-proj").selectedIndex=0;
  $("c-proj").innerHTML=projOptions($("c-proj").value, true, true);
  $("s-proj").innerHTML=projOptions($("s-proj").value||ep, true, false);
}
function showConnect(msg, isErr){
  for(const id of ["v-entry","v-check","v-sum","boot"]) $(id).hidden=true;
  $("v-connect").hidden=false;
  $("set-name").value=S.userName;
  $("set-cancel").hidden=!S.ready; $("set-clear").hidden=!S.token;
  $("set-msg").innerHTML=msg?`<div class="note ${isErr?"err":""}">${esc(msg)}</div>`:"";
}
function hideConnect(){ $("v-connect").hidden=true; setTab(S.tab); }
async function connect(){
  $("boot").hidden=false; $("boot").className="note"; $("boot").textContent="正在从 Airtable 读取工地、塔吊、司机和费率…";
  try{ await loadMaster(); }
  catch(e){ S.ready=false; showConnect(explain(e), true); return false; }
  $("boot").hidden=true; S.ready=true;
  $("who").innerHTML=S.userName?`<span>${esc(S.userName)}</span>`:"";
  $("btn-form").hidden=!C.workerForm;
  fillSelectors(); hideConnect();
  return true;
}
function wire(){
  document.querySelector(".tabs").addEventListener("click",e=>{ const b=e.target.closest(".tab"); if(b) setTab(b.dataset.tab); });
  const eb=$("e-body");
  eb.addEventListener("input",onEntryInput); eb.addEventListener("change",onEntryInput);
  eb.addEventListener("click",e=>{
    const a=e.target.closest("[data-add]"); if(a){ const [c,s]=a.dataset.add.split("|"); addSlot(c,s); return; }
    const u=e.target.closest("[data-unlock]"); if(u){ const id=u.dataset.unlock; const el=eb.querySelector(`[data-slot="${CSS.escape(id)}"] select`); S.dirty[id]={...slotBase(el)}; renderEntry(); toast("已解锁。改了人或时间再保存，这条要重新核验。"); return; }
    if(e.target.id==="e-save") saveEntry();
    if(e.target.id==="e-discard"){ const puid=$("e-proj").value,date=$("e-date").value; for(const [id,d] of Object.entries(S.dirty)) if(d.project===puid&&d.date===date) delete S.dirty[id]; renderEntry(); }
    if(e.target.id==="e-addtc"){ const v=$("e-newtc").value.trim().toUpperCase(); if(!v){ toast("先填塔吊号"); return; } addSlot(v,"D"); }
  });
  $("e-proj").addEventListener("change",()=>{ LS.set("proj",$("e-proj").value); renderEntry(); });
  $("e-all").addEventListener("change",()=>{ fillSelectors(); renderEntry(); });
  const moveDay=n=>{ $("e-date").value=addDays($("e-date").value,n); renderEntry(); ensureData(); };
  $("e-date").addEventListener("change",()=>{ renderEntry(); ensureData(); });
  $("e-prev").addEventListener("click",()=>moveDay(-1)); $("e-next").addEventListener("click",()=>moveDay(1));
  $("e-copy").addEventListener("click",copyPrevDay);
  for(const id of ["c-month","c-proj","c-status"]) $(id).addEventListener("change",()=>{ S.sel.clear(); renderCheck(); ensureData(); });
  $("c-worker").addEventListener("input",renderCheck);
  $("c-body").addEventListener("change",e=>{
    if(e.target.id==="c-all"){ const rows=checkRows(); if(e.target.checked) rows.forEach(r=>S.sel.add(r._id)); else S.sel.clear(); renderCheck(); return; }
    const k=e.target.dataset.sel; if(k){ e.target.checked?S.sel.add(k):S.sel.delete(k); renderCheck(); }
  });
  $("c-verify").addEventListener("click",verifySel);
  $("c-reopen").addEventListener("click",reopenSel);
  $("c-reject").addEventListener("click",()=>{ $("c-rejbox").hidden=false; $("c-rejwhy").focus(); });
  $("c-rejcancel").addEventListener("click",()=>{ $("c-rejbox").hidden=true; });
  $("c-rejgo").addEventListener("click",()=>{ const w=$("c-rejwhy").value.trim(); if(!w){ toast("写一句退回原因，录入的人才知道改什么"); return; } $("c-rejbox").hidden=true; $("c-rejwhy").value=""; rejectSel(w); });
  $("c-upl").addEventListener("change",e=>uploadEvidence([...e.target.files]));
  for(const id of ["s-proj","s-month"]) $(id).addEventListener("change",()=>{ S.adjLoaded=""; renderSum(); ensureData(); });
  $("s-onlyv").addEventListener("change",renderSum);
  $("s-csv").addEventListener("click",()=>exportCSV("claim"));
  $("s-csv2").addEventListener("click",()=>exportCSV("detail"));
  $("s-body").addEventListener("input",onCfgInput); $("s-body").addEventListener("change",onCfgInput);
  $("btn-refresh").addEventListener("click",async()=>{ if(Object.keys(S.dirty).length){ toast("还有未保存的改动，先保存或放弃再刷新"); return; } S.months.clear(); S.rows={}; S.adjLoaded=""; if(await connect()) ensureData(true); });
  $("btn-settings").addEventListener("click",()=>showConnect(""));
  $("btn-form").addEventListener("click",async()=>{ try{ await navigator.clipboard.writeText(WORKER_FORM_URL); toast("已复制："+WORKER_FORM_URL+"  发到 WhatsApp 群就行", 6000); }catch{ toast(WORKER_FORM_URL, 12000); } });
  $("set-cancel").addEventListener("click",hideConnect);
  $("set-clear").addEventListener("click",()=>{ LS.del("token"); SS.del("token"); S.token=null; S.ready=false; showConnect("已清除这台设备上的令牌。"); });
  $("set-save").addEventListener("click",async()=>{
    const tok=$("set-token").value.trim() || S.token;
    if(!tok || !/^pat\w+\.\w+$/.test(tok)){ showConnect("令牌格式不对：应该是 pat 开头、中间有一个点的一长串。", true); return; }
    S.token=tok; S.userName=$("set-name").value.trim();
    LS.set("name",S.userName);
    if($("set-remember").checked){ LS.set("token",tok); SS.del("token"); } else { SS.set("token",tok); LS.del("token"); }
    $("set-token").value="";
    if(await connect()) ensureData(true);
  });
  window.addEventListener("beforeunload",e=>{ if(Object.keys(S.dirty).length){ e.preventDefault(); e.returnValue=""; } });
}
async function start(){
  const today=todaySG();
  $("e-date").value=today; $("c-month").value=monthOf(today); $("s-month").value=monthOf(today);
  S.tab=LS.get("tab","entry"); if(!["entry","check","sum"].includes(S.tab)) S.tab="entry";
  S.userName=LS.get("name","");
  S.token=LS.get("token",null)||SS.get("token");
  wire();
  if(!S.token){ showConnect(""); return; }
  if(await connect()) ensureData();
}
start();
})();
