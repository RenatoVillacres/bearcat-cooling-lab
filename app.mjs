import { DEFAULTS, calculateRun, fullyOpen, parseDelimited, suggestMapping, normalizeRows } from './engine.mjs';
const $=id=>document.getElementById(id);
const $$=s=>[...document.querySelectorAll(s)];
const fmt=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const dur=v=>Number.isFinite(v)?v.toLocaleString('en-US',{maximumFractionDigits:6}):'—';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const getJson=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const putJson=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}};
let manifest,provenance,runs=[],runCache=new Map(),currentRun,currentResult,currentConfig,mode='peak',revision=0,compareResults=[],compareConfig,compareRevision=0,importQueue=[],importState,db,worker,workId=0,requests=new Map(),timer,chartState;
const labels={competition:'Competition',endurance:'Enduro + revs','pre-enduro':'Pre-enduro',testing:'Testing',other:'Other'};
const NUMERIC=['flow','density','reference','atm','lhv','injectors','pulses','deadtime','sf','gap','window','speedMin','rpmMin','fixedDelta'];
const OPTIONS=['flowUnit','filter','fuelPressureType','mapType','pressureMode'];
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4000);}
function status(text,type=''){ $('status').textContent=text;$('status').className='status-pill '+type; }
function showError(message){$('errorBanner').textContent=message;$('errorBanner').hidden=!message;}
function configFromInputs(){
  const c={...DEFAULTS};
  NUMERIC.forEach(k=>c[k]=$(k).value===''?NaN:Number($(k).value));OPTIONS.forEach(k=>c[k]=$(k).value);
  c.fraction=Number($('fractionNumber').value)/100;c.cap=Number($('cap').value)/100;c.pwIncludesDelay=$('subtractDelay').checked;
  c.start=$('start').value===''?null:Number($('start').value);c.end=$('end').value===''?null:Number($('end').value);
  c.secondBank=$('layout').value==='banks'?{enabled:true,count:Number($('bankCount').value),flow:Number($('bankFlow').value),flowUnit:c.flowUnit,deadtime:Number($('bankDeadtime').value),pulses:c.pulses,cap:c.cap}:null;
  return c;
}
function writeConfig(c){
  c={...DEFAULTS,...c};NUMERIC.forEach(k=>$(k).value=c[k]);OPTIONS.forEach(k=>$(k).value=c[k]);
  $('fractionNumber').value=c.fraction*100;$('fraction').value=c.fraction*100;$('cap').value=c.cap*100;$('subtractDelay').checked=c.pwIncludesDelay;
  $('start').value=c.start??'';$('end').value=c.end??'';$('layout').value=c.secondBank?.enabled?'banks':'shared';
  if(c.secondBank?.enabled){$('bankCount').value=c.secondBank.count;$('bankFlow').value=c.secondBank.flow;$('bankDeadtime').value=c.secondBank.deadtime;}
  updateControls();
}
function updateControls(){
  const c=configFromInputs();
  $$('#windowButtons button').forEach(b=>b.classList.toggle('selected',mode==='run'?b.dataset.window==='run':Number(b.dataset.window)===c.window));
  $$('#fractionPresets button').forEach(b=>b.classList.toggle('selected',Number(b.dataset.fraction)===c.fraction*100));
  $('secondBankControls').hidden=$('layout').value!=='banks';$('loggedPressure').hidden=c.pressureMode==='fixed';$('fixedPressure').hidden=c.pressureMode!=='fixed';
  $('windowHint').textContent=mode==='run'?'The main result is the average over all selected valid time.':'The main result is the highest average over a complete window.';
  $('keenanPreset').classList.toggle('selected',c.flow===230&&c.flowUnit==='cc/min');$('legacyPreset').classList.toggle('selected',c.flow===328&&c.flowUnit==='g/min');
  $('windowLegend').textContent=`${dur(c.window)} s average`;
}
function isValidInputs(){
  return $$('.control-panel input[type="number"]').filter(x=>!x.closest('[hidden]')).every(x=>x.validity.valid);
}
function queueCalculate(){
  updateControls();clearTimeout(timer);revision++;currentResult=null;chartState=null;$('chartTooltip').hidden=true;disableExport(true);status('Updating','loading');document.body.classList.add('busy');
  if(compareResults.length)$('compareStatus').textContent='Settings changed. Recalculate the table to compare runs with the current assumptions.';
  timer=setTimeout(()=>recalculate(revision),220);
}
function disableExport(disabled){$('downloadCsv').disabled=disabled;$('downloadJson').disabled=disabled;}
function initWorker(){
  try{worker=new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'});worker.onmessage=({data})=>{const p=requests.get(data.id);if(!p)return;requests.delete(data.id);data.error?p.reject(new Error(data.error)):p.resolve(data.result);};worker.onerror=()=>{worker.terminate();worker=null;for(const p of requests.values())p.reject(new Error('Could not start the calculation. Change a field to try again.'));requests.clear();};}catch{worker=null;}
}
function compute(rows,config){
  if(worker)return new Promise((resolve,reject)=>{const id=++workId;requests.set(id,{resolve,reject});worker.postMessage({id,rows,config});});
  return new Promise((resolve,reject)=>setTimeout(()=>{try{const {windows,segments,...r}=calculateRun(rows,config);r.segments=segments.map(({points,cumulative,...s})=>s);resolve(r);}catch(e){reject(e);}},0));
}
async function getRows(run){
  if(runCache.has(run.id))return runCache.get(run.id);
  if(run.custom){const stored=await dbGet(run.id);if(!stored)throw new Error('This log is no longer saved in this browser. Upload it again.');runCache.set(run.id,stored.rows);return stored.rows;}
  const response=await fetch(run.file);if(!response.ok)throw new Error('Could not load the log. Check your connection and select it again.');
  const data=await response.json(),rows=data.rows.map(values=>Object.fromEntries(data.columns.map((key,i)=>[key,values[i]])));
  runCache.set(run.id,rows);return rows;
}
function fillCategories(){
  const prior=$('category').value,types=[...new Set(runs.map(r=>r.category))];
  $('category').innerHTML='<option value="all">All logs</option>'+types.map(c=>`<option value="${esc(c)}">${esc(labels[c]||c)}</option>`).join('');
  if(types.includes(prior))$('category').value=prior;
}
function fillRuns(id){
  const filtered=runs.filter(r=>$('category').value==='all'||r.category===$('category').value);
  $('run').innerHTML=filtered.map(r=>`<option value="${esc(r.id)}">${esc(r.label||r.name)}${r.custom?' · imported':''}</option>`).join('');
  if(filtered.some(r=>r.id===id))$('run').value=id;
  currentRun=runs.find(r=>r.id===$('run').value);
  $('runHint').textContent=currentRun?.name||'No logs available for this session.';$('run').title=currentRun?.name||'';
  $('userLogActions').hidden=!currentRun?.custom;
}
async function selectRun(id,keepTrim=false){
  const run=runs.find(r=>r.id===id);if(!run)return;
  if($('category').value!=='all'&&$('category').value!==run.category)$('category').value='all';fillRuns(id);
  if(!keepTrim){$('start').value='';$('end').value='';}
  queueCalculate();
}
async function recalculate(token=++revision){
  if(!currentRun)return;
  if(!isValidInputs()){if(token===revision){showError('Check the highlighted fields: enter valid values within their limits.');clearResults();status('Check values','error');document.body.classList.remove('busy');}return;}
  const run=currentRun,c=configFromInputs();
  try{
    const rows=await getRows(run);if(token!==revision)return;
    const result=await compute(rows,c);if(token!==revision)return;
    currentResult=result;currentConfig=result.config;
    showError(!result.full?'No valid intervals. Check columns, units, filters and the maximum gap.':mode==='peak'&&!result.peak?`No complete ${c.window} s window. Use a shorter window or the whole-run average.`:'');
    renderResults();renderReferences();disableExport(!result.full);status(result.full?'Calculation updated':'No valid time',result.full?'':'error');
    putJson('bcml-settings-v1',{config:c,mode,runId:run.id});
  }catch(e){if(token!==revision)return;showError(e.message);clearResults();status('Check data','error');}
  finally{if(token===revision)document.body.classList.remove('busy');}
}
function clearResults(){
  currentResult=null;disableExport(true);['mainResult','fuelPower','coolantPower','marginPower','meanPower','minPower','totalFuel'].forEach(id=>$(id).textContent='—');
  $('peakTime').textContent='Result unavailable';$('fuelFlow').textContent='— g/s';$('durationValid').textContent='— seconds integrated';$('sensitivityBody').innerHTML='';$('chart').innerHTML='';chartState=null;
}
function primary(){return mode==='run'?currentResult?.full:currentResult?.peak;}
function metric(id,value,unit='kW',digits=2){$(id).innerHTML=`${fmt(value,digits)} <small>${esc(unit)}</small>`;}
function renderResults(){
  const r=currentResult,c=r.config,p=primary(),full=r.full;
  $('primaryLabel').textContent=mode==='run'?'AVERAGE · VALID RUN TIME':`PEAK · ${dur(c.window)}-SECOND AVERAGE`;
  $('mainResult').textContent=fmt(p?.designKw);$('peakTime').textContent=p?(mode==='run'?`${fmt(p.duration,2)} valid seconds${c.filter==='moving'?' · moving only':''}`:`${fmt(p.start,3)} – ${fmt(p.end,3)} s${c.filter==='moving'?' · moving only':''}`):'No complete window';
  $('assumptionSummary').textContent=`${fmt(c.fraction*100,0)}% to coolant · SF ${fmt(c.sf)}`;
  metric('fuelPower',p?.fuelKw);metric('coolantPower',p?.coolantKw);metric('marginPower',p?p.designKw-p.coolantKw:NaN);
  $('fuelFlow').textContent=`${fmt(p?.flowGps,3)} g/s · all injectors combined`;$('marginPercent').textContent=`+${fmt((c.sf-1)*100,0)}% added to coolant heat`;
  metric('meanPower',full?.designKw);metric('minPower',r.minimum?.designKw);metric('totalFuel',full?.massG,'g',1);
  $('durationValid').textContent=`${fmt(full?.duration,2)} seconds integrated`;
  $('sensitivityContext').textContent=p?`${fmt(p.fuelKw)} kW of fuel power · ${mode==='run'?'whole-run average':`${c.window} s peak`}`:'No data for this interval.';
  $('sensitivityBody').innerHTML=[.25,.30,.35,.40].map(f=>`<tr class="${Math.abs(f-c.fraction)<1e-8?'active-row':''}"><td>${fmt(f*100,0)}%</td>${[1,1.2,1.3].map(sf=>`<td class="${Math.abs(f-c.fraction)<1e-8&&Math.abs(sf-c.sf)<1e-8?'active-cell':''}">${fmt(p?p.fuelKw*f*sf:NaN)}</td>`).join('')}</tr>`).join('');
  renderQuality();renderChart();renderConfigSummary();
}
function renderQuality(){
  const r=currentResult,c=r.counts,conf=r.config;
  $('qualityBadge').textContent=`${fmt(c.segments,0)} segments · ${fmt(c.windowCount,0)} windows`;
  const facts=[['Original samples',fmt(c.inputRows,0)],['Invalid rows',fmt(c.invalidRows,0)],['Excluded by moving filter',fmt(c.excludedRows,0)],['Gap breaks',fmt(c.gapBreaks,0)],['Time resets / duplicate times',fmt(c.timeResetBreaks,0)],['Rows with capped duty',fmt(c.cappedRows,0)]];
  const notes=[];
  if(c.gapBreaks)notes.push(`Integration was split at ${c.gapBreaks} gaps longer than ${conf.gap} s.`);
  if(c.invalidRows)notes.push(`${c.invalidRows} rows are missing required channels. They are excluded, and integration does not bridge them.`);
  if(c.nonpositivePressure)notes.push(`${c.nonpositivePressure} samples have Δp ≤ 0; the model assigns them zero flow.`);
  if(c.timeResetBreaks)notes.push('Duplicate or decreasing timestamps split segments; the chart keeps each segment’s original timestamps.');
  if(!r.peak)notes.push(`No continuous segment contains a complete ${conf.window} s window.`);
  if(conf.filter==='moving')notes.push(`Filter: speed > ${conf.speedMin} mph and RPM ≥ ${conf.rpmMin}. This does not identify laps.`);
  notes.push('Ambient temperature is not an input to this fuel-based calculation. It is needed to assess actual radiator capacity.');
  const src=currentRun.source||{};
  $('qualityDetails').innerHTML=`<div class="quality-grid">${facts.map(([k,v])=>`<div>${esc(k)}<strong>${esc(v)}</strong></div>`).join('')}</div><ul class="quality-notes">${notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul><p class="hint"><b>File:</b> ${esc(currentRun.name)}<br><b>Source:</b> ${esc(src.workbook||'File imported in this browser')} ${esc(src.registerRange||'')}<br><b>Channels:</b> time, RPM, PW, fuel pressure, MAP${conf.filter==='moving'?', speed':''}.${currentRun.custom?' The selected units and column mapping are included in the export.':''}</p>`;
}
function renderChart(){
  const r=currentResult;if(!r?.series?.length){$('chart').innerHTML='<text x="450" y="140" fill="#a4acb7" font-size="13" text-anchor="middle">No valid data to plot</text>';chartState=null;return;}
  const kind=$('chartMetric').value,key=kind==='fuel'?'fuelKw':kind==='flow'?'flowGps':'coolantKw',windowKey=kind==='fuel'?'windowFuelKw':'windowCoolantKw';
  const pointValue=p=>kind==='flow'?(p.windowFuelKw==null?null:p.windowFuelKw/r.config.lhv):p[windowKey];
  $('chartSubtitle').textContent=kind==='coolant'?'Heat to coolant, before the safety factor.':kind==='fuel'?'Chemical power of the fuel, before energy is split between outputs.':'Estimated total fuel mass flow from all injectors.';
  const series=r.series,minX=series.reduce((v,p)=>Math.min(v,p.t),Infinity),maxX=series.reduce((v,p)=>Math.max(v,p.t),-Infinity);
  const maximum=series.reduce((v,p)=>Math.max(v,p[key]||0,pointValue(p)||0),0),top=Math.max(1,Math.ceil(maximum/5)*5),W=900,H=280,L=58,R=24,T=25,B=38;
  const x=t=>L+(t-minX)/Math.max(.001,maxX-minX)*(W-L-R),y=v=>T+(1-v/top)*(H-T-B);
  let out=`<title>${esc($('chartSubtitle').textContent)}</title><desc>${esc(currentRun.name)}. Peak and average values appear in the result cards. Gray shows instantaneous values; red shows the window average.</desc>`;
  for(let i=0;i<=4;i++){const v=top*i/4,yy=y(v);out+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="#eff1f5"/><text x="${L-12}" y="${yy+4}" text-anchor="end" fill="#a6aebb" font-size="10">${fmt(v,kind==='flow'?1:0)}</text>`;}
  for(let i=0;i<=5;i++){const t=minX+(maxX-minX)*i/5;out+=`<text x="${x(t)}" y="${H-12}" text-anchor="middle" fill="#a6aebb" font-size="10">${fmt(t,0)} s</text>`;}
  const peak=r.peak;if(peak){const left=x(peak.start),width=Math.max(2,x(peak.end)-left);out+=`<rect x="${left}" y="${T}" width="${width}" height="${H-T-B}" fill="#c9273609"/><line x1="${x(peak.end)}" x2="${x(peak.end)}" y1="${T}" y2="${H-B}" stroke="#e5afb6" stroke-dasharray="3 4"/>`;}
  const buildPath=(get)=>{let d='',lastSegment=null,active=false;for(const p of series){const v=get(p);if(!Number.isFinite(v)){active=false;continue;}const move=!active||p.segment!==lastSegment;d+=`${move?'M':'L'}${x(p.t).toFixed(2)},${y(v).toFixed(2)} `;lastSegment=p.segment;active=true;}return d;};
  out+=`<path d="${buildPath(p=>p[key])}" fill="none" stroke="#d8dde5" stroke-width="1.2" vector-effect="non-scaling-stroke"/><path d="${buildPath(pointValue)}" fill="none" stroke="#c92736" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  if(peak){const value=kind==='flow'?peak.flowGps:kind==='fuel'?peak.fuelKw:peak.coolantKw;out+=`<circle cx="${x(peak.end)}" cy="${y(value)}" r="4" fill="#c92736" stroke="white" stroke-width="2"/>`;}
  $('chart').innerHTML=out;$('chartRange').textContent=`${fmt(minX,1)} – ${fmt(maxX,1)} s · ${fmt(r.counts.inputRows,0)} samples`;
  chartState={series,x,y,minX,maxX,key,pointValue,W,H,L,R,T,B,kind};
}
$('chart').addEventListener('pointermove',e=>{
  if(!chartState||!currentResult)return;const s=chartState,rect=$('chart').getBoundingClientRect(),svgX=(e.clientX-rect.left)/rect.width*s.W,t=s.minX+(svgX-s.L)/(s.W-s.L-s.R)*(s.maxX-s.minX);let nearest=s.series[0];for(const p of s.series)if(Math.abs(p.t-t)<Math.abs(nearest.t-t))nearest=p;
  const win=s.pointValue(nearest),unit=s.kind==='flow'?'g/s':'kW';$('chartTooltip').innerHTML=`<small>${fmt(nearest.t,2)} s · segment ${nearest.segment+1}</small>${fmt(nearest[s.key])} ${unit} instantaneous<br>${fmt(win)} ${unit} · ${dur(currentResult.config.window)} s average`;
  const wrap=$('chartWrap').getBoundingClientRect();$('chartTooltip').hidden=false;$('chartTooltip').style.left=Math.max(6,Math.min(e.clientX-wrap.left+10,wrap.width-195))+'px';$('chartTooltip').style.top=Math.max(0,e.clientY-wrap.top-70)+'px';
});
$('chart').addEventListener('pointerleave',()=>$('chartTooltip').hidden=true);
function renderConfigSummary(){const c=(compareResults.length&&compareConfig)?compareConfig:configFromInputs();$('compareConfig').innerHTML=`<span>Injectors <b>${esc(c.injectors)}${c.secondBank?.enabled?' + '+esc(c.secondBank.count):''}</b></span><span>Flow <b>${fmt(c.flow,1)} ${esc(c.flowUnit)}</b></span><span>Coolant <b>${fmt(c.fraction*100,0)}%</b></span><span>SF <b>${fmt(c.sf)}</b></span><span>Window <b>${dur(c.window)} s</b></span><span>Filter <b>${c.filter==='moving'?'Moving only':'Whole run'}</b></span>`;}
function renderReferences(){
  const c=configFromInputs();
  try{
    const pressure=Number($('openPressure').value),o=fullyOpen({...c,fixedDelta:pressure});$('openKw').textContent=fmt(o.designKw);
    const massRate=c.flowUnit==='g/min'?c.flow:c.flow*c.density;
    $('openEquation').textContent=c.secondBank?.enabled?`Σ(N × flow per injector in each bank × √(Δp/Δp_ref)) / 60 = ${fmt(o.flowGps,3)} g/s`:`${c.injectors} × ${fmt(massRate,3)} g/min × √(${fmt(pressure,1)}/${fmt(c.reference,1)}) / 60 = ${fmt(o.flowGps,3)} g/s`;
    $('openStats').innerHTML=kv([['Total fuel flow',fmt(o.flowGps,3)+' g/s'],['Fuel power',fmt(o.fuelKw)+' kW'],['Coolant before SF',fmt(o.coolantKw)+' kW'],['Coolant fraction / SF',fmt(c.fraction*100,0)+'% / '+fmt(c.sf)],['Pressure difference',fmt(pressure,1)+' psi']]);
    const d=Number($('chokeDiameter').value)/1000,Cd=Number($('chokeCd').value),P=Number($('chokeP').value),T=Number($('chokeT').value)+273.15,afr=Number($('chokeAfr').value),gamma=Number($('chokeGamma').value),R=Number($('chokeR').value);
    if(![d,Cd,P,T,afr,gamma,R].every(Number.isFinite)||d<=0||Cd<=0||Cd>1||P<=0||T<=0||afr<=0||gamma<=1||R<=0)throw new Error('Check the choked-flow inputs.');
    const area=Math.PI*d*d/4,air=Cd*area*P*Math.sqrt(gamma/(R*T))*(2/(gamma+1))**((gamma+1)/(2*(gamma-1))),fuel=air/afr*1000,power=fuel*c.lhv,heat=power*c.fraction*c.sf;
    $('chokeKw').textContent=fmt(heat);$('chokeStats').innerHTML=kv([['Choked air flow',fmt(air*1000,3)+' g/s'],['Required fuel flow',fmt(fuel,3)+' g/s'],['Fuel power',fmt(power)+' kW'],['Coolant before SF',fmt(power*c.fraction)+' kW']]);
    const ratio=o.flowGps>0?fuel/o.flowGps:Infinity;$('capacityNotice').className='inline-notice'+(ratio<=1?' ok':'');
    $('capacityNotice').textContent=ratio>1?`The selected AFR requires ${fmt(fuel,2)} g/s, above the static flow of ${fmt(o.flowGps,2)} g/s at ${fmt(pressure,1)} psi. This air-flow and AFR case exceeds that fuel-supply reference.`:`Required fuel flow is ${fmt(ratio*100,1)}% of the static flow shown. Usable duty and opening delay reduce delivery during pulsed operation.`;
  }catch(e){$('openKw').textContent='—';$('chokeKw').textContent='—';$('capacityNotice').textContent=e.message;}
}
function kv(items){return items.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');}
function showPage(page){
  if(!['calculator','compare','references','method'].includes(page))page='calculator';
  $$('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+page));$$('.nav').forEach(el=>{el.classList.toggle('active',el.dataset.page===page);el.setAttribute('aria-current',el.dataset.page===page?'page':'false');});
  history.replaceState(null,'','#'+page);if(page==='references')renderReferences();if(page==='compare')renderConfigSummary();window.scrollTo({top:0,behavior:'instant'});
}
async function compareAll(){
  if(!isValidInputs()){toast('Check the calculator fields first.');return;}
  const c=configFromInputs();if(c.start!=null||c.end!=null){toast('The comparison applies the same time trim to every file.');}
  const token=++compareRevision;compareConfig=c;compareResults=[];$('compareButton').disabled=true;$('compareExport').disabled=true;$('compareBody').innerHTML='';renderConfigSummary();
  const toCompare=[...runs];
  for(let i=0;i<toCompare.length;i++){
    if(token!==compareRevision)break;const run=toCompare[i];$('compareStatus').textContent=`Calculating ${i+1} of ${toCompare.length}: ${run.label||run.name}`;
    try{const result=await compute(await getRows(run),c);compareResults.push({run,result});}catch(e){compareResults.push({run,error:e.message});}
    renderComparison();
  }
  if(token===compareRevision){$('compareStatus').textContent=`${compareResults.length} runs calculated · ${c.window} s · ${fmt(c.fraction*100,0)}% coolant · SF ${fmt(c.sf)}. The table keeps these assumptions until you recalculate.`;$('compareButton').disabled=false;$('compareExport').disabled=!compareResults.length;}
}
function renderComparison(){
  const sorted=[...compareResults].sort((a,b)=>(b.result?.peak?.designKw??-1)-(a.result?.peak?.designKw??-1)),max=Math.max(1,...sorted.map(x=>x.result?.peak?.designKw||0));
  $('compareBody').innerHTML=sorted.map(({run,result:r,error})=>`<tr><td title="${esc(run.name)}">${esc(run.label||run.name)}<p class="hint">${esc(run.name)}</p></td><td>${esc(labels[run.category]||run.category)}</td>${error?`<td colspan="4">${esc(error)}</td>`:`<td>${fmt(r.full?.duration,1)} s</td><td>${fmt(r.full?.massG,1)} g</td><td>${fmt(r.full?.designKw)} kW</td><td class="bar-cell"><span class="bar" style="width:${(r.peak?.designKw||0)/max*85}%"></span><strong>${fmt(r.peak?.designKw)} kW</strong></td>`}<td><button class="text-button" data-open-run="${esc(run.id)}">View ↗</button></td></tr>`).join('');
  renderAggregate();renderConfigSummary();$$('[data-open-run]').forEach(b=>b.addEventListener('click',()=>{showPage('calculator');selectRun(b.dataset.openRun);}));
}
function renderAggregate(){
  const successful=compareResults.filter(x=>x.result?.full),mass=successful.reduce((sum,x)=>sum+x.result.full.massG,0),duration=successful.reduce((sum,x)=>sum+x.result.full.duration,0),c=compareConfig;
  $('aggregateStats').hidden=!duration;if(!duration)return;
  const fuel=mass/duration*c.lhv,heat=fuel*c.fraction*c.sf;
  $('aggregateStats').innerHTML=`<div class="stat-card"><span>Combined average + SF</span><strong>${fmt(heat)} <small>kW</small></strong><p>Time-weighted average · ${successful.length} runs</p></div><div class="stat-card"><span>Total valid time</span><strong>${fmt(duration/60,1)} <small>min</small></strong><p>${fmt(duration,3)} seconds integrated</p></div><div class="stat-card"><span>Total fuel</span><strong>${fmt(mass/1000,2)} <small>kg</small></strong><p>Selected valid intervals only</p></div>`;
}
function download(name,data,type='application/json'){const blob=new Blob([data],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
const csvCell=x=>'"'+String(x??'').replace(/^[=+@\-]/,"'$&").replaceAll('"','""')+'"';
function csvText(rows){return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');}
function snapshot(){
  if(!currentResult)throw new Error('Wait for the calculation to finish.');
  const {series,...result}=currentResult;
  if(result.rollingMean)result.rollingMean={...result.rollingMean,massMeaning:'Weighted rolling-window numerator, not actual consumed fuel',durationMeaning:'Span of valid rolling-window end times'};
  return {calculator:'Bearcat Cooling Lab',modelVersion:'1.0.0',createdAt:new Date().toISOString(),run:currentRun,mainResultMode:mode,results:result,scope:'Estimated coolant heat from fuel, not measured radiator capacity',assumptions:[`Selected flow: ${currentResult.config.flow} ${currentResult.config.flowUnit} per injector at ${currentResult.config.reference} psi differential.`, 'The original 230 cc/min preset assumes a 47 psi static-flow test; those test conditions still need confirmation.','Coolant share, constant opening delay, gasoline properties and safety factor are assumptions.','Windows end at recorded sample times; integration uses all valid samples.'],provenance};
}
function configCsvRows(c){return [[''],['ASSUMPTIONS'],...Object.entries(c).filter(([key])=>!['maxPlotPoints','flowGmin','densityGcc'].includes(key)).map(([key,value])=>[key,typeof value==='object'?JSON.stringify(value):value])];}
function exportCsv(){
  if(!currentResult)return;const r=currentResult,c=r.config,rows=[['Bearcat Cooling Lab','Estimated coolant heat'],['Run',currentRun.name],['Source',JSON.stringify(currentRun.source||{})],['Main view',mode],['Case','Start s','End s','Valid duration s','Fuel g','Fuel g/s','Fuel kW','Coolant kW before SF','Coolant kW with SF']];
  for(const [name,s] of [['Peak window',r.peak],['Selected valid time (filters and trim apply)',r.full],['Minimum window',r.minimum],['Rolling mean (end-time weighted; duration is rolling end-time span)',r.rollingMean],['Complete nonoverlapping blocks',r.blockMean]])rows.push([name,s?.start,s?.end,s?.duration,s===r.rollingMean?'':s?.massG,s?.flowGps,s?.fuelKw,s?.coolantKw,s?.designKw]);
  rows.push([''],['SENSITIVITY','Fraction','SF','Coolant kW with SF']);const p=primary();for(const f of [.25,.3,.35,.4])for(const sf of [1,1.2,1.3])rows.push(['Selected main interval',f,sf,p?p.fuelKw*f*sf:'']);
  rows.push(...configCsvRows(c),[''],['QUALITY COUNTS'],...Object.entries(r.counts),[''],['Note','Flow at the new test pressure, delay and coolant fraction still need validation.']);
  download('Cooling_'+currentRun.id+'.csv',csvText(rows),'text/csv;charset=utf-8');toast('Table exported with its assumptions.');
}
function exportComparison(){
  const rows=[['Bearcat Cooling Lab','Comparison'],['Run','Category','Valid seconds','Fuel g','Mean fuel kW','Mean coolant with SF kW','Peak window coolant with SF kW','Peak start s','Peak end s','Error']];
  compareResults.forEach(({run,result:r,error})=>rows.push([run.name,run.category,r?.full?.duration,r?.full?.massG,r?.full?.fuelKw,r?.full?.designKw,r?.peak?.designKw,r?.peak?.start,r?.peak?.end,error]));rows.push(...configCsvRows(compareConfig));download('Cooling_run_comparison.csv',csvText(rows),'text/csv;charset=utf-8');
}
async function openDb(){
  if(!window.indexedDB)return null;
  return new Promise(resolve=>{const request=indexedDB.open('bearcat-cooling-lab',1);request.onupgradeneeded=()=>request.result.createObjectStore('logs',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);});
}
function dbAction(method,value){return new Promise((resolve,reject)=>{if(!db){reject(new Error('Local storage is unavailable.'));return;}const tx=db.transaction('logs',method==='get'||method==='getAll'?'readonly':'readwrite'),store=tx.objectStore('logs'),req=value===undefined?store[method]():store[method](value);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
const dbGet=id=>dbAction('get',id);
const mappingSpec={t:{label:'Time *',units:['s','ms','min']},rpm:{label:'RPM *',units:['rpm']},pw:{label:'Bank 1 pulse width *',units:['ms','us','s']},fuel:{label:'Fuel pressure',units:['psi','kPa','bar','Pa']},map:{label:'MAP',units:['psi','kPa','bar','Pa']},speed:{label:'Speed (for filter)',units:['mph','km/h','m/s']},voltage:{label:'Voltage (stored; delay is fixed)',units:['V']},pw2:{label:'Bank 2 pulse width (optional)',units:['ms','us','s']}};
async function nextImport(){
  if(!importQueue.length){$('fileInput').value='';return;}
  const file=importQueue.shift();
  try{
    if(file.size>80*1024*1024)throw new Error('The file exceeds 80 MB. Export the run as a separate file.');
    const text=await file.text();let parsed;
    if(/\.json$/i.test(file.name)){
      const data=JSON.parse(text);if(Array.isArray(data.columns)&&Array.isArray(data.rows)){parsed={headers:data.columns,records:data.rows.map(row=>Object.fromEntries(data.columns.map((k,i)=>[k,row[i]]))),delimiter:'JSON'};}
      else if(Array.isArray(data)&&data.length&&typeof data[0]==='object'){parsed={headers:Object.keys(data[0]),records:data,delimiter:'JSON'};}else throw new Error('Expected JSON: an array of rows or {columns, rows}.');
    }else parsed=parseDelimited(text);
    if(!parsed.records.length)throw new Error('No data rows found.');
    const suggested=suggestMapping(parsed.headers);
    for(const k of Object.keys(mappingSpec))if(parsed.headers.includes(k))suggested[k]=k;
    importState={file,parsed};$('importName').textContent=file.name;$('importRows').textContent=fmt(parsed.records.length,0)+' rows';$('importError').hidden=true;
    $('mappingFields').innerHTML=Object.entries(mappingSpec).map(([key,spec])=>{const found=suggested[key],heading=String(found||'').toLowerCase();let unit=spec.units[0];if(['fuel','map'].includes(key)){if(heading.includes('kpa'))unit='kPa';else if(heading.includes('bar'))unit='bar';}if(key==='speed'&&/km|kph/.test(heading))unit='km/h';if(key==='t'&&/\bms\b/.test(heading))unit='ms';return `<div class="mapping-field"><label for="map-${key}">${esc(spec.label)}</label><select id="map-${key}" aria-label="Column ${esc(spec.label)}"><option value="">Unavailable</option>${parsed.headers.map(h=>`<option value="${esc(h)}" ${h===found?'selected':''}>${esc(h)}</option>`).join('')}</select><select id="unit-${key}" aria-label="Unit ${esc(spec.label)}">${spec.units.map(u=>`<option ${u===unit?'selected':''}>${u}</option>`).join('')}</select></div>`;}).join('');
    $('importPreview').innerHTML=`<table><thead><tr>${parsed.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${parsed.records.slice(0,3).map(row=>`<tr>${parsed.headers.map(h=>`<td>${esc(row[h])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $('importGap').value=$('gap').value;$('importCategory').value=/enduro|endurance/i.test(file.name)?'endurance':/comp|race/i.test(file.name)?'competition':'testing';
    ['map-t','unit-t'].forEach(id=>$(id).addEventListener('change',importCadence));importCadence();$('importDialog').showModal();
  }catch(e){toast(file.name+': '+e.message);await nextImport();}
}
function importCadence(){
  if(!importState)return;const key=$('map-t').value,unit=$('unit-t').value;if(!key){$('importCadence').textContent='Select the time column.';return;}
  const rows=normalizeRows(importState.parsed.records.slice(0,4000),{t:key},{t:unit}),deltas=[];for(let i=1;i<rows.length;i++){const dt=rows[i].t-rows[i-1].t;if(dt>0&&Number.isFinite(dt))deltas.push(dt);}deltas.sort((a,b)=>a-b);const mid=deltas[Math.floor(deltas.length/2)];
  $('importCadence').textContent=mid?`Typical sample spacing: ${fmt(mid,4)} s. The current gap limit is ${$('importGap').value} s; increase it if it would exclude normal samples.`:'Could not determine sample spacing. Check the column and its units.';
}
$('importForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!importState)return;$('importError').hidden=true;
  try{
    const mapping={},units={};for(const k of Object.keys(mappingSpec)){mapping[k]=$('map-'+k).value||null;units[k]=$('unit-'+k).value;}
    const c=configFromInputs();for(const k of ['t','rpm','pw'])if(!mapping[k])throw new Error('Select the column for '+mappingSpec[k].label.replace(' *','')+'.');
    if(c.pressureMode==='logged'&&(!mapping.fuel||(c.fuelPressureType!=='differential'&&!mapping.map)))throw new Error('Select fuel pressure and MAP, or return to the calculator and choose a fixed pressure difference.');
    if(c.secondBank?.enabled&&!mapping.pw2)throw new Error('Select the second bank’s pulse width.');
    const gap=Number($('importGap').value);if(!(gap>0))throw new Error('Enter a positive maximum gap.');
    const rows=normalizeRows(importState.parsed.records,mapping,units);if(!rows.some(r=>Number.isFinite(r.t)&&Number.isFinite(r.rpm)&&Number.isFinite(r.pw)))throw new Error('No valid numeric rows. Check the column mapping.');
    const id='upload-'+(crypto.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2)),run={id,name:importState.file.name,label:importState.file.name,category:$('importCategory').value,custom:true,sampleCount:rows.length,source:{workbook:'User-uploaded file',importedAt:new Date().toISOString(),mapping,units,fileSize:importState.file.size}};
    runs.push(run);runCache.set(id,rows);let stored=false;try{await dbAction('put',{id,run,rows});stored=true;}catch{}
    $('importDialog').close();$('gap').value=gap;fillCategories();$('category').value='all';await selectRun(id);toast(stored?'Log imported and saved in this browser.':'Log imported for this session. The browser did not allow it to be saved.');importState=null;await nextImport();
  }catch(error){$('importError').textContent=error.message;$('importError').hidden=false;}
});
function renderSaved(){const saves=getJson('bcml-scenarios-v1',[]);$('savedScenarios').innerHTML=saves.length?'<p class="hint">Saved scenarios</p>'+saves.map((s,i)=>`<button data-scenario="${i}">${esc(s.name)}</button>`).join(''):'';$$('[data-scenario]').forEach(b=>b.addEventListener('click',()=>{const s=saves[Number(b.dataset.scenario)];if(!runs.some(r=>r.id===s.runId)){toast('This scenario’s log is no longer available. Import it again and apply its assumptions.');return;}writeConfig(s.config);mode=s.mode;selectRun(s.runId,true);$('exportDialog').close();toast('Scenario restored.');}));}
// Controls
$$('.nav').forEach(b=>{b.title=b.textContent.trim();b.addEventListener('click',()=>showPage(b.dataset.page));});$$('[data-go]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.go)));document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();showPage('calculator');});
$('category').addEventListener('change',()=>{fillRuns(currentRun?.id);$('start').value='';$('end').value='';queueCalculate();});$('run').addEventListener('change',()=>selectRun($('run').value));
$$('.control-panel input,.control-panel select').filter(el=>!['category','run','fileInput','fraction','fractionNumber'].includes(el.id)).forEach(el=>el.addEventListener(el.type==='number'?'input':'change',()=>{if(el.id==='window')mode='peak';queueCalculate();}));
$('fraction').addEventListener('input',()=>{$('fractionNumber').value=$('fraction').value;queueCalculate();});$('fractionNumber').addEventListener('input',()=>{$('fraction').value=$('fractionNumber').value;queueCalculate();});
$$('[data-fraction]').forEach(b=>b.addEventListener('click',()=>{$('fraction').value=b.dataset.fraction;$('fractionNumber').value=b.dataset.fraction;queueCalculate();}));
$$('[data-window]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.window==='run'?'run':'peak';if(mode==='peak')$('window').value=b.dataset.window;queueCalculate();}));
$('reset').addEventListener('click',()=>{mode='peak';writeConfig(DEFAULTS);queueCalculate();toast('Default 230 cc/min assumptions restored.');});
$('keenanPreset').addEventListener('click',()=>{$('flow').value=230;$('flowUnit').value='cc/min';queueCalculate();});$('legacyPreset').addEventListener('click',()=>{$('flow').value=328;$('flowUnit').value='g/min';queueCalculate();toast('Only the flow changed to 328 g/min. All other assumptions are unchanged.');});
$('chartMetric').addEventListener('change',renderChart);$('compareButton').addEventListener('click',compareAll);$('compareExport').addEventListener('click',exportComparison);
$$('.ref-fields input,#openPressure').forEach(el=>el.addEventListener('input',renderReferences));
$('uploadButton').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',()=>{importQueue=[...$('fileInput').files];nextImport();});
$('closeImport').addEventListener('click',()=>{$('importDialog').close();importState=null;nextImport();});$('importDialog').addEventListener('cancel',()=>{importState=null;importQueue=[];$('fileInput').value='';});$('importGap').addEventListener('input',importCadence);
$('deleteLog').addEventListener('click',async()=>{if(!currentRun?.custom)return;const id=currentRun.id;try{await dbAction('delete',id);}catch{}runs=runs.filter(r=>r.id!==id);runCache.delete(id);fillCategories();$('category').value='all';selectRun(manifest.defaultRunId);toast('Imported log deleted from this browser.');});
$('exportButton').addEventListener('click',()=>{renderSaved();$('exportDialog').showModal();});$('closeExport').addEventListener('click',()=>$('exportDialog').close());$('downloadCsv').addEventListener('click',exportCsv);
$('downloadJson').addEventListener('click',()=>{try{download('Cooling_'+currentRun.id+'.json',JSON.stringify(snapshot(),null,2));}catch(e){toast(e.message);}});
$('saveScenario').addEventListener('click',()=>{const c=configFromInputs();if(!isValidInputs()){toast('Check the fields before saving.');return;}const saves=getJson('bcml-scenarios-v1',[]),name=`${fmt(c.flow,0)} ${c.flowUnit} · ${fmt(c.fraction*100,0)}% · SF ${fmt(c.sf)} · ${mode==='run'?'run':c.window+' s'}`;saves.unshift({name,config:c,mode,runId:currentRun?.id});if(putJson('bcml-scenarios-v1',saves.slice(0,12))){renderSaved();toast('Scenario saved.');}else toast('The browser does not allow settings to be saved.');});
$('templateDownload').addEventListener('click',()=>{const rows=[['Time (s)','RPM','Pulse Width (ms)','Fuel Pressure (psi)','MAP (psi)','Speed (mph)','Battery Voltage (V)']];for(let i=0;i<=20;i++)rows.push([i,3000,6,47,14.7,20,14]);download('Example_only_not_vehicle_data.csv',csvText(rows),'text/csv;charset=utf-8');toast('Synthetic example. Use a gap limit ≥ 1 s to calculate it. This is not vehicle data.');});
$('provenanceDownload').addEventListener('click',()=>{if(provenance)download('Cooling_data_sources.json',JSON.stringify(provenance,null,2));});
window.addEventListener('hashchange',()=>showPage(location.hash.slice(1)));
async function init(){
  initWorker();disableExport(true);
  try{
    const [manifestResponse,provenanceResponse]=await Promise.all([fetch('data/manifest.json'),fetch('data/provenance.json')]);if(!manifestResponse.ok)throw new Error('Could not load the log catalog. Reload the page.');
    manifest=await manifestResponse.json();provenance=provenanceResponse.ok?await provenanceResponse.json():{};runs=[...manifest.runs];db=await openDb();if(db){try{const imported=await dbAction('getAll');for(const item of imported)runs.push(item.run);}catch{}}
    $('datasetCount').textContent=manifest.runCount;$('sampleTotal').textContent=fmt(manifest.totalSamples,0);
    const saved=getJson('bcml-settings-v1',null);mode=saved?.mode==='run'?'run':'peak';writeConfig(saved?.config||DEFAULTS);fillCategories();fillRuns(saved?.runId||manifest.defaultRunId);showPage(location.hash.slice(1));queueCalculate();
  }catch(e){showError(e.message);status('Could not load the data','error');}
}
init();
