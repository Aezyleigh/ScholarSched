(()=>{'use strict';
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const fire=(el,t)=>el.dispatchEvent(new Event(t,{bubbles:true}));
const selD=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
Object.defineProperty(HTMLSelectElement.prototype,'value',{configurable:true,get(){return selD.get.call(this)},set(v){
 if(this.id==='f-day'&&v&&![...this.options].some(o=>o.value===v))this.add(new Option(v.split('|').join(' / '),v));
 selD.set.call(this,v);this._sync&&this._sync()}});
const inD=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){return inD.get.call(this)},set(v){inD.set.call(this,v);this._sync&&this._sync()}});

/* 1. searchable dropdowns */
function combo(sel){
 if(sel._combo||sel.hasAttribute('data-no-combo'))return;sel._combo=1;
 const lab=sel.closest('label'),wrap=document.createElement('div'),inp=document.createElement('input'),list=document.createElement('ul');
 wrap.className='combo';inp.className='combo-input';inp.type='text';inp.autocomplete='off';
 inp.setAttribute('role','combobox');inp.setAttribute('aria-autocomplete','list');inp.setAttribute('aria-expanded','false');
 list.className='combo-list';list.setAttribute('role','listbox');list.hidden=true;list.id=(sel.id||'cb'+Math.random().toString(36).slice(2))+'-list';inp.setAttribute('aria-controls',list.id);
 const nm=lab?[...lab.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim():'';if(nm)inp.setAttribute('aria-label',nm);
 sel.before(wrap);wrap.append(inp,list,sel);sel.classList.add('sr-only');sel.tabIndex=-1;sel.setAttribute('aria-hidden','true');
 let act=-1;
 const sync=()=>{inp.value=sel.selectedOptions[0]?sel.selectedOptions[0].text.trim():'';inp.disabled=sel.disabled;inp.placeholder='Type to search…'};
 const items=()=>$$('li[data-i]',list);
 const mark=i=>{const l=items();l.forEach(x=>x.classList.remove('active'));act=Math.max(0,Math.min(i,l.length-1));const c=l[act];if(c){c.classList.add('active');inp.setAttribute('aria-activedescendant',c.id);c.scrollIntoView({block:'nearest'})}};
 const render=q=>{q=(q||'').toLowerCase();list.innerHTML='';
  [...sel.options].filter(o=>!o.hidden&&o.text.toLowerCase().includes(q)).forEach(o=>{const li=document.createElement('li');li.setAttribute('role','option');li.textContent=o.text||'(none)';li.dataset.i=o.index;li.id=list.id+'-'+o.index;if(o.disabled)li.setAttribute('aria-disabled','true');if(o.selected)li.setAttribute('aria-selected','true');list.append(li)});
  if(!list.children.length)list.innerHTML='<li class="combo-empty">No matches</li>';
  const s=$('[aria-selected=true]',list);act=-1;if(q)mark(0);else if(s)mark(items().indexOf(s))};
 const open=()=>{if(sel.disabled)return;render('');list.hidden=false;inp.setAttribute('aria-expanded','true');inp.select()};
 const close=()=>{list.hidden=true;inp.setAttribute('aria-expanded','false');sync()};
 const pick=li=>{if(!li||li.dataset.i==null||li.getAttribute('aria-disabled'))return;sel.selectedIndex=+li.dataset.i;sync();fire(sel,'input');fire(sel,'change');close()};
 inp.addEventListener('focus',open);inp.addEventListener('click',()=>list.hidden&&open());
 inp.addEventListener('input',()=>{list.hidden&&(list.hidden=false,inp.setAttribute('aria-expanded','true'));render(inp.value)});
 inp.addEventListener('blur',close);
 list.addEventListener('mousedown',e=>{e.preventDefault();pick(e.target.closest('li'))});
 inp.addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();list.hidden&&open();mark(act+(e.key==='ArrowDown'?1:-1))}
  else if(e.key==='Enter'){if(!list.hidden){e.preventDefault();pick(items()[act])}}
  else if(e.key==='Escape'){close()}});
 new MutationObserver(()=>{sync();list.hidden||render(inp.value)}).observe(sel,{childList:true,subtree:true,attributes:true});
 sel._sync=sync;sync()}
const initCombos=()=>$$('select').forEach(combo);

/* 2. sub-tabs */
function subtabs(){$$('[data-subtabs]').forEach(nav=>{
 const bs=$$('button',nav),show=b=>{bs.forEach(x=>{const on=x===b;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;const p=$('#'+x.dataset.sub);p&&(p.hidden=!on)})};
 nav.addEventListener('click',e=>{const b=e.target.closest('button');b&&show(b)});
 nav.addEventListener('keydown',e=>{const i=bs.indexOf(document.activeElement),d={ArrowRight:1,ArrowLeft:-1}[e.key];if(i<0||!d)return;const n=bs[(i+d+bs.length)%bs.length];n.focus();show(n)});
 show(bs[0])})}

/* 3. organized exports: read the table being shown, so CSV/PDF/print are clean and tabular */
const clean=t=>t.replace(/\s+/g,' ').trim();
function parse(tb){
 const ths=$$('thead th',tb),keep=ths.map(h=>!h.classList.contains('admin-only')&&!$('input',h)&&clean(h.textContent)&&!/^actions?$/i.test(clean(h.textContent)));
 let head=[],ti=-1;ths.forEach((h,i)=>{if(!keep[i])return;const t=clean(h.textContent);if(/^time$/i.test(t)){ti=head.length;head.push('Start time','End time')}else head.push(t)});
 const rows=$$('tbody tr',tb).filter(r=>!r.hidden&&r.style.display!=='none'&&r.cells.length>1).map(r=>{const o=[];[...r.cells].forEach((c,i)=>{if(!keep[i])return;const t=clean(c.textContent);if(i===ths.findIndex((h,j)=>keep[j]&&/^time$/i.test(clean(h.textContent)))){const p=t.split(/\s*[–—-]\s*/);o.push(p[0]||'',p.slice(1).join(' - '))}else o.push(t)});return o});
 const cap=tb.closest('div,section')?.querySelector('h3,h4,caption');
 return{caption:cap?clean(cap.textContent):'',head,rows}}
const txt=s=>{const e=$(s);return e&&e.selectedOptions?.[0]?clean(e.selectedOptions[0].text):''};
function data(sc){
 let tbs,title,sub=[],period;
 if(sc==='s'){tbs=$$('#student-table-view table');title='Class schedule';sub=[txt('#s-program'),txt('#s-year'),$('#s-search')?.value];period=$('#student-period')}
 else if(sc==='staff'){tbs=$$('#staff-table-view table');title='Class schedules';sub=[$('#search-input')?.value?`Search: ${$('#search-input').value}`:''];period=$('#period-label')}
 else{tbs=$$('#report-output table');title=txt('#r-type')||'Report';sub=['#r-program','#r-year','#r-teacher','#r-room'].filter(s=>!$(s)?.closest('label')?.hidden).map(txt);period=$('#period-label')}
 const blocks=tbs.map(parse).filter(b=>b.rows.length);if(!blocks.length)return null;
 return{title,sub:sub.filter(Boolean).join(' · '),period:period?clean(period.textContent):'',blocks,date:new Date().toLocaleString('en-PH',{dateStyle:'medium',timeStyle:'short'})}}
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const save=(blob,n)=>{const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=n;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)};
const fname=(d,x)=>`scholarsched-${slug(d.title)}-${new Date().toISOString().slice(0,10)}.${x}`;
function csv(d){const q=c=>`"${String(c).replace(/"/g,'""')}"`;
 save(new Blob(['\uFEFF'+d.blocks.map(b=>[...(d.blocks.length>1&&b.caption?[[b.caption]]:[]),b.head,...b.rows].map(r=>r.map(q).join(',')).join('\r\n')).join('\r\n\r\n')],{type:'text/csv;charset=utf-8'}),fname(d,'csv'))}
function pdf(d){
 const doc=new window.jspdf.jsPDF({orientation:'landscape',unit:'pt',format:'a4'}),W=doc.internal.pageSize.getWidth(),H=doc.internal.pageSize.getHeight(),M=36,pr=getComputedStyle(document.documentElement).getPropertyValue('--green-900').trim();
 const col=/^#[0-9a-f]{6}$/i.test(pr)?[1,3,5].map(i=>parseInt(pr.substr(i,2),16)):[7,61,39];let y=M;
 doc.setFont('helvetica','bold').setFontSize(15);doc.text('Unida Christian Colleges · ScholarSched',M,y);y+=18;
 doc.setFontSize(12);doc.text(d.title,M,y);y+=14;doc.setFont('helvetica','normal').setFontSize(9);
 doc.text([d.period,d.sub,'Generated '+d.date].filter(Boolean).join('   |   '),M,y);y+=16;
 d.blocks.forEach(b=>{
  const wt=b.head.map((h,i)=>Math.max(6,Math.min(28,Math.max(h.length,...b.rows.map(r=>(r[i]||'').length))))),T=wt.reduce((a,c)=>a+c,0),ws=wt.map(x=>x/T*(W-2*M));
  const row=(cells,hd)=>{doc.setFontSize(9);const ls=cells.map((c,i)=>doc.splitTextToSize(c||'',ws[i]-8)),h=Math.max(...ls.map(l=>l.length))*11+8;
   if(y+h>H-M){doc.addPage();y=M;if(!hd)row(b.head,true)}
   let x=M;cells.forEach((c,i)=>{if(hd){doc.setFillColor(...col);doc.rect(x,y,ws[i],h,'F');doc.setTextColor(255)}else{doc.setTextColor(0)}doc.setDrawColor(200);doc.rect(x,y,ws[i],h);doc.setFont('helvetica',hd?'bold':'normal');doc.text(ls[i],x+4,y+12);x+=ws[i]});y+=h};
  if(b.caption&&d.blocks.length>1){doc.setFont('helvetica','bold').setTextColor(0);doc.text(b.caption,M,y+8);y+=16}
  row(b.head,true);b.rows.forEach((r,k)=>{row(r,false)});y+=14});
 const n=doc.getNumberOfPages();for(let i=1;i<=n;i++){doc.setPage(i);doc.setFontSize(8).setTextColor(120);doc.text(`Page ${i} of ${n}`,W-M,H-16,{align:'right'})}
 doc.save(fname(d,'pdf'))}
function print(d){
 const e=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 const t=d.blocks.map(b=>`${b.caption&&d.blocks.length>1?`<h3>${e(b.caption)}</h3>`:''}<table><thead><tr>${b.head.map(h=>`<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(r=>`<tr>${r.map(c=>`<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
 const f=document.createElement('iframe');f.style.cssText='position:fixed;width:0;height:0;border:0';document.body.append(f);
 f.contentDocument.write(`<!DOCTYPE html><title>${e(d.title)}</title><style>@page{size:A4 landscape;margin:12mm}body{font:11px Arial,sans-serif;color:#000}h1{font-size:16px;margin:0}h2{font-size:13px;margin:2px 0}p{margin:2px 0 10px;color:#444}table{width:100%;border-collapse:collapse;margin-bottom:14px}th,td{border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top}th{background:#e6e9ee;-webkit-print-color-adjust:exact;print-color-adjust:exact}thead{display:table-header-group}tr{break-inside:avoid}tr:nth-child(even) td{background:#f6f7f9;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style><h1>Unida Christian Colleges · ScholarSched</h1><h2>${e(d.title)}</h2><p>${e([d.period,d.sub,'Generated '+d.date].filter(Boolean).join(' | '))}</p>${t}`);
 f.contentDocument.close();f.contentWindow.focus();setTimeout(()=>{f.contentWindow.print();setTimeout(()=>f.remove(),2000)},200)}
const M={'s-export-csv':['s','csv'],'s-export-pdf':['s','pdf'],'s-print':['s','print'],'staff-export-csv':['staff','csv'],'staff-export-pdf':['staff','pdf'],'staff-print':['staff','print'],'r-export-csv':['r','csv'],'r-export-pdf':['r','pdf'],'r-print':['r','print']};
const F={csv,pdf,print};
document.addEventListener('click',e=>{
 const b=e.target.closest('button'),m=b&&M[b.id];if(!m)return;
 b.closest('details')?.removeAttribute('open');
 if(m[1]==='pdf'&&!window.jspdf)return;
 const d=data(m[0]);
 if(!d){if(b.id==='s-print'||b.id==='staff-print'){const a=$(m[0]==='s'?'#student-export-alert':'#staff-export-alert');a.textContent='Nothing to print yet.';a.hidden=false}return}
 e.stopImmediatePropagation();e.preventDefault();F[m[1]](d)},true);
document.addEventListener('click',e=>{$$('details.export-menu[open]').forEach(d=>d.contains(e.target)||d.removeAttribute('open'))});

/* 4. toasts: a visual echo of the inline alerts, so results show wherever the user is.
   The inline alerts keep role="alert", so this layer stays visual-only to avoid double announcements. */
const toastRegion=document.createElement('div');
toastRegion.className='toast-region';toastRegion.setAttribute('aria-hidden','true');
document.body.append(toastRegion);
window.toast=(message,type='ok')=>{
 const text=String(message??'').replace(/\s+/g,' ').trim();if(!text)return;
 const el=document.createElement('div');el.className='toast '+(type||'ok');el.textContent=text;
 toastRegion.append(el);
 setTimeout(()=>{el.classList.add('hide');setTimeout(()=>el.remove(),250)},4200)};

initCombos();subtabs();
new MutationObserver(initCombos).observe(document.body,{childList:true,subtree:true});
document.addEventListener('reset',e=>setTimeout(()=>$$('select',e.target).forEach(s=>s._sync&&s._sync())),true);
})();
