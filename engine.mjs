/** Bearcat cooling model. Units: s, ms, rpm, psi, mph; fuel mass g, power kW. */
export const DEFAULTS = Object.freeze({
  flow: 230, flowUnit: 'cc/min', density: 0.7369325445, densityUnit: 'g/cc',
  reference: 47, atm: 14.7, lhv: 43.11609756097561,
  injectors: 2, pulses: 1, deadtime: 0.8185648829978736,
  cap: 0.95, fraction: 0.30, sf: 1.2, gap: 0.05, window: 10,
  filter: 'all', speedMin: 5, rpmMin: 1000,
  fuelPressureType: 'gauge', mapType: 'absolute',
  pressureMode: 'logged', fixedDelta: 47, pwIncludesDelay: true,
  deadtimeMode: 'fixed', fixedVoltage: 14, maxPlotPoints: 1600
});
const finite = Number.isFinite;
const EPS = 1e-9;
function number(value) {
  if (typeof value === 'number') return value;
  if (value == null || String(value).trim() === '') return NaN;
  let text = String(value).trim();
  if (/^[+-]?\d+,\d+$/.test(text)) text = text.replace(',', '.');
  return Number(text);
}
function validate(input) {
  const c = { ...DEFAULTS, ...input };
  const bounds = { flow: [0, Infinity], density: [0, Infinity], reference: [0, Infinity],
    lhv: [0, Infinity], injectors: [0, 64], pulses: [0, Infinity], cap: [0, 1],
    sf: [0, Infinity], gap: [0, Infinity], window: [0, Infinity] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    c[key] = number(c[key]);
    if (!finite(c[key]) || c[key] <= min || c[key] > max) throw new Error(`${key} must be greater than ${min}${finite(max) ? ` and no more than ${max}` : ''}.`);
  }
  if (!Number.isInteger(c.injectors)) throw new Error('Injector count must be a whole number.');
  for (const key of ['atm', 'deadtime', 'fraction', 'fixedDelta', 'speedMin', 'rpmMin', 'fixedVoltage']) {
    c[key] = number(c[key]);
    if (!finite(c[key]) || c[key] < 0) throw new Error(`${key} must be a nonnegative number.`);
  }
  if (c.fraction > 1) throw new Error('Coolant fraction must be between 0 and 1 (30% = 0.30).');
  for (const [key, options] of Object.entries({ flowUnit: ['cc/min', 'g/min'], densityUnit: ['g/cc', 'kg/m3'],
    filter: ['all', 'moving'], fuelPressureType: ['gauge', 'absolute', 'differential'], mapType: ['absolute', 'gauge'],
    pressureMode: ['logged', 'fixed'], deadtimeMode: ['fixed', 'voltage'] })) {
    if (!options.includes(c[key])) throw new Error(`Unknown ${key}: ${c[key]}.`);
  }
  c.densityGcc = c.densityUnit === 'kg/m3' ? c.density / 1000 : c.density;
  c.flowGmin = c.flowUnit === 'g/min' ? c.flow : c.flow * c.densityGcc;
  if (c.start != null && c.start !== '') {
    c.start = number(c.start); if (!finite(c.start)) throw new Error('Start time must be numeric.');
  } else c.start = null;
  if (c.end != null && c.end !== '') {
    c.end = number(c.end); if (!finite(c.end)) throw new Error('End time must be numeric.');
  } else c.end = null;
  if (c.start != null && c.end != null && c.end <= c.start) throw new Error('End time must be after start time.');
  c.maxPlotPoints = Math.max(50, Math.floor(number(c.maxPlotPoints) || 1600));
  if (c.deadtimeMode === 'voltage') {
    const table = (c.deadtimeTable || []).map(p => Array.isArray(p) ? [number(p[0]), number(p[1])] : [number(p.voltage), number(p.ms)]).sort((a,b) => a[0] - b[0]);
    if (table.length < 2 || table.some((p,i) => !p.every(finite) || p[1] < 0 || (i && p[0] <= table[i-1][0]))) throw new Error('Provide at least two distinct voltages and nonnegative delays for the voltage table.');
    c.deadtimeTable = table;
  }
  if (c.secondBank?.enabled) {
    const b = { count: 1, flow: c.flow, flowUnit: c.flowUnit, deadtime: c.deadtime, pulses: c.pulses, cap: c.cap, ...c.secondBank };
    for (const k of ['count', 'flow', 'deadtime', 'pulses', 'cap']) b[k] = number(b[k]);
    if (!Number.isInteger(b.count) || b.count < 1 || b.count > 64 || !finite(b.flow) || b.flow <= 0 || !finite(b.deadtime) || b.deadtime < 0 || !finite(b.pulses) || b.pulses <= 0 || !finite(b.cap) || b.cap <= 0 || b.cap > 1) throw new Error('Check the second injector bank count, flow, delay, pulses and duty cap.');
    if (!['cc/min', 'g/min'].includes(b.flowUnit)) throw new Error('Unknown second bank flow unit.');
    b.flowGmin = b.flowUnit === 'g/min' ? b.flow : b.flow * c.densityGcc;
    c.secondBank = b;
  }
  return c;
}
function interpolateTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  if (x >= table.at(-1)[0]) return table.at(-1)[1];
  let i = 1;
  while (table[i][0] < x) i++;
  const a = table[i-1], b = table[i];
  return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
}
function stats(massG, duration, c, extra = {}) {
  if (!(duration > 0)) return null;
  const flowGps = massG / duration, fuelKw = flowGps * c.lhv;
  return { ...extra, duration, massG, flowGps, fuelKw, coolantKw: fuelKw * c.fraction, designKw: fuelKw * c.fraction * c.sf };
}
function instant(row, c, counts) {
  if (![row.t, row.rpm, row.pw].every(finite)) return null;
  let deltaPsi = c.fixedDelta;
  if (c.pressureMode === 'logged') {
    if (!finite(row.fuel)) return null;
    if (c.fuelPressureType === 'differential') deltaPsi = row.fuel;
    else {
      if (!finite(row.map)) return null;
      const fuelAbsolute = row.fuel + (c.fuelPressureType === 'gauge' ? c.atm : 0);
      const mapAbsolute = row.map + (c.mapType === 'gauge' ? c.atm : 0);
      deltaPsi = fuelAbsolute - mapAbsolute;
    }
  }
  if (c.filter === 'moving' && !finite(row.speed)) return null;
  if (c.secondBank?.enabled && !finite(row.pw2)) return null;
  if (deltaPsi <= 0) counts.nonpositivePressure++;
  const pressureRatio = Math.sqrt(Math.max(deltaPsi, 0) / c.reference);
  let deadtime = c.deadtime;
  if (c.deadtimeMode === 'voltage') {
    const voltage = finite(row.voltage) ? row.voltage : c.fixedVoltage;
    if (!finite(row.voltage)) counts.voltageFallback++;
    if (voltage < c.deadtimeTable[0][0] || voltage > c.deadtimeTable.at(-1)[0]) counts.voltageOutsideTable++;
    deadtime = interpolateTable(c.deadtimeTable, voltage);
  }
  const rpm = Math.max(row.rpm, 0);
  const eventFactor = rpm * c.pulses / 120000;
  const requestedDuty = Math.max(row.pw, 0) * eventFactor;
  const cmdDuty = Math.min(requestedDuty, c.cap);
  const effectiveDuty = Math.max(cmdDuty - (c.pwIncludesDelay ? deadtime * eventFactor : 0), 0);
  if (requestedDuty > c.cap) counts.cappedRows++;
  let flowGps = c.injectors * c.flowGmin * pressureRatio * effectiveDuty / 60;
  if (c.secondBank?.enabled) {
    const b = c.secondBank, factor = rpm * b.pulses / 120000;
    const requested = Math.max(row.pw2, 0) * factor;
    const duty = Math.max(Math.min(requested, b.cap) - (c.pwIncludesDelay ? b.deadtime * factor : 0), 0);
    if (requested > b.cap) counts.secondBankCappedRows++;
    flowGps += b.count * b.flowGmin * pressureRatio * duty / 60;
  }
  if (row.rpm < 0 || row.pw < 0 || (c.secondBank?.enabled && row.pw2 < 0)) counts.clampedRows++;
  return { t: row.t, flowGps, rpm: row.rpm, speed: row.speed, deltaPsi, deadtime, cmdDuty, effectiveDuty };
}
function interpolatePoint(a, b, t) {
  const f = (t-a.t)/(b.t-a.t), point = { ...a, t, interpolated: true };
  for (const key of ['flowGps', 'rpm', 'speed', 'deltaPsi', 'deadtime', 'cmdDuty', 'effectiveDuty']) point[key] = a[key] + (b[key]-a[key])*f;
  return point;
}
function clipPoints(points, start, end) {
  const lo = start == null ? points[0].t : Math.max(start, points[0].t);
  const hi = end == null ? points.at(-1).t : Math.min(end, points.at(-1).t);
  if (hi <= lo) return [];
  let i = 0; while (i+1 < points.length && points[i+1].t <= lo) i++;
  const out = [points[i].t === lo ? points[i] : interpolatePoint(points[i], points[i+1], lo)];
  for (let j=i+1; j<points.length && points[j].t<hi; j++) out.push(points[j]);
  let k=i; while (k+1<points.length && points[k+1].t<hi) k++;
  const right = points[k+1];
  out.push(right.t === hi ? right : interpolatePoint(points[k], right, hi));
  return out;
}
function integralAt(points, cumulative, t) {
  if (t <= points[0].t) return 0;
  if (t >= points.at(-1).t) return cumulative.at(-1);
  let lo=0, hi=points.length-1;
  while (hi-lo>1) { const mid=(lo+hi)>>1; if(points[mid].t<=t) lo=mid; else hi=mid; }
  const a=points[lo], b=points[lo+1], dx=t-a.t;
  return cumulative[lo]+a.flowGps*dx+(b.flowGps-a.flowGps)*dx*dx/(2*(b.t-a.t));
}
/** Exact continuous mean of complete rolling windows, weighted by available end-time. */
function rollingIntegral(points, window) {
  const a=points[0].t, b=points.at(-1).t;
  if (b-a <= window+EPS) return { numerator: 0, duration: 0 };
  const exposure = t => Math.max(0, Math.min(b, t+window)-Math.max(a+window, t))/window;
  let numerator=0;
  const breaks=[a+window,b-window].sort((x,y)=>x-y);
  for(let i=1;i<points.length;i++) {
    const left=points[i-1],right=points[i];
    const knots=[left.t,...breaks.filter(t=>t>left.t && t<right.t),right.t];
    const f=t=> (left.flowGps+(right.flowGps-left.flowGps)*(t-left.t)/(right.t-left.t))*exposure(t);
    for(let j=1;j<knots.length;j++) {
      const x=knots[j-1],y=knots[j];
      numerator+=(y-x)/6*(f(x)+4*f((x+y)/2)+f(y));
    }
  }
  return { numerator, duration:b-a-window };
}
function downsample(points, maximum) {
  if(points.length<=maximum) return points;
  // Preserve the extrema of each bucket. This only affects display, never integration.
  const out=[points[0]], bucket=(points.length-2)/Math.max(1,Math.floor((maximum-2)/2));
  for(let pos=1;pos<points.length-1;pos+=bucket) {
    const start=Math.floor(pos),end=Math.min(points.length-1,Math.floor(pos+bucket));
    let min=start,max=start;
    for(let i=start+1;i<end;i++) {
      const value=points[i].windowFuelKw ?? points[i].fuelKw;
      if(value<(points[min].windowFuelKw ?? points[min].fuelKw)) min=i;
      if(value>(points[max].windowFuelKw ?? points[max].fuelKw)) max=i;
    }
    for(const i of [...new Set([min,max])].sort((a,b)=>a-b)) out.push(points[i]);
  }
  out.push(points.at(-1));return out;
}
/** Integrates valid contiguous intervals. Windows end at original sample times (plus a clip endpoint). */
export function calculateRun(rows, input = {}) {
  const config=validate(input), c=config;
  const counts={ inputRows:rows.length, validRows:0, invalidRows:0, excludedRows:0, clippedRows:0,
    gapBreaks:0, timeResetBreaks:0, sourceBreaks:0, nonpositivePressure:0, cappedRows:0,
    secondBankCappedRows:0, clampedRows:0, voltageFallback:0, voltageOutsideTable:0, segments:0, windowCount:0 };
  const pieces=[];let current=[], previous=null;
  const flush=()=>{if(current.length>=2)pieces.push(current);current=[];};
  for(let i=0;i<rows.length;i++) {
    const row=rows[i], point=instant(row,c,counts);
    if(!point) {counts.invalidRows++;flush();previous=null;continue;}
    if(c.filter==='moving' && !(row.speed>c.speedMin && row.rpm>=c.rpmMin)) {counts.excludedRows++;flush();previous=null;continue;}
    counts.validRows++;
    if(previous) {
      const dt=row.t-previous.t;
      const source=row.source ?? row.sourceId, oldSource=previous.source ?? previous.sourceId;
      if(source!==oldSource) {counts.sourceBreaks++;flush();}
      else if(dt<=0) {counts.timeResetBreaks++;flush();}
      else if(dt>c.gap+EPS) {counts.gapBreaks++;flush();}
    }
    point.sourceIndex=i;point.source=row.source ?? row.sourceId;
    current.push(point);previous=row;
  }
  flush();
  let totalMass=0,totalDuration=0,peak=null,minimum=null,rollingMass=0,rollingDuration=0,blockMass=0,blockDuration=0,blockCount=0;
  const segments=[],windows=[],plotPieces=[];
  for(const piece of pieces) {
    const points=clipPoints(piece,c.start,c.end);
    counts.clippedRows+=piece.length-points.filter(p=>!p.interpolated).length;
    if(points.length<2)continue;
    const id=segments.length, cumulative=[0];
    for(let i=1;i<points.length;i++) cumulative.push(cumulative[i-1]+(points[i-1].flowGps+points[i].flowGps)/2*(points[i].t-points[i-1].t));
    const duration=points.at(-1).t-points[0].t,mass=cumulative.at(-1);
    const summary=stats(mass,duration,c,{start:points[0].t,end:points.at(-1).t,segment:id});
    segments.push({...summary,id,count:points.length,points,cumulative});
    totalMass+=mass;totalDuration+=duration;
    const rolling=rollingIntegral(points,c.window);rollingMass+=rolling.numerator;rollingDuration+=rolling.duration;
    const n=Math.floor((duration+EPS)/c.window);
    if(n>0){blockMass+=integralAt(points,cumulative,points[0].t+n*c.window);blockDuration+=n*c.window;blockCount+=n;}
    const plot=[];
    for(let i=0;i<points.length;i++) {
      const p=points[i],fuelKw=p.flowGps*c.lhv;
      const display={t:p.t,flowGps:p.flowGps,fuelKw,coolantKw:fuelKw*c.fraction,designKw:fuelKw*c.fraction*c.sf,segment:id,sourceIndex:p.sourceIndex};
      if(p.t-points[0].t>=c.window-EPS) {
        const start=Math.max(points[0].t,p.t-c.window);
        const w=stats(Math.max(0,cumulative[i]-integralAt(points,cumulative,start)),c.window,c,{start,end:p.t,segment:id});
        windows.push(w);
        if(!peak || w.fuelKw>peak.fuelKw)peak=w;
        if(!minimum || w.fuelKw<minimum.fuelKw)minimum=w;
        display.windowFuelKw=w.fuelKw;display.windowCoolantKw=w.coolantKw;display.windowDesignKw=w.designKw;
      } else {display.windowFuelKw=null;display.windowCoolantKw=null;display.windowDesignKw=null;}
      plot.push(display);
    }
    plotPieces.push(plot);
  }
  counts.segments=segments.length;counts.windowCount=windows.length;
  const full=stats(totalMass,totalDuration,c,{start:segments[0]?.start ?? null,end:segments.at(-1)?.end ?? null});
  const rollingMean=stats(rollingMass,rollingDuration,c,{window:c.window});
  const blockMean=stats(blockMass,blockDuration,c,{window:c.window,blockCount});
  counts.integratedRows=plotPieces.reduce((total,p)=>total+p.length,0);
  const series=plotPieces.flatMap(p=>downsample(p,Math.max(10,Math.floor(c.maxPlotPoints*p.length/Math.max(1,counts.integratedRows)))));
  const warnings=[];
  if(!full)warnings.push('No valid time intervals. Check channel mapping, time units, filters and maximum gap.');
  else if(!peak)warnings.push(`No complete ${c.window} s window exists within a continuous valid segment.`);
  if(counts.invalidRows)warnings.push(`${counts.invalidRows.toLocaleString()} rows are missing a required numeric channel. Those rows break the integration.`);
  if(counts.gapBreaks)warnings.push(`${counts.gapBreaks.toLocaleString()} gaps exceed ${c.gap} s. Fuel is not integrated across them.`);
  if(counts.timeResetBreaks)warnings.push(`${counts.timeResetBreaks.toLocaleString()} duplicate or decreasing timestamps split the run.`);
  if(counts.nonpositivePressure)warnings.push(`${counts.nonpositivePressure.toLocaleString()} rows have zero or negative injector pressure difference and therefore zero modeled flow.`);
  if(counts.cappedRows)warnings.push(`${counts.cappedRows.toLocaleString()} rows reach the commanded duty cap.`);
  if(counts.voltageFallback)warnings.push(`${counts.voltageFallback.toLocaleString()} rows use the fixed voltage because logged voltage is unavailable.`);
  if(counts.voltageOutsideTable)warnings.push(`${counts.voltageOutsideTable.toLocaleString()} rows use the nearest endpoint of the deadtime table.`);
  return {config,full,summary:full,peak,minimum,rollingMean,blockMean,windows,series,segments,counts,warnings,
    method:{ integration:'Trapezoidal fuel mass within each valid contiguous segment',
      windowEvaluation:'Complete windows ending at logged sample times, plus an interpolated clip endpoint when selected',
      boundaryInterpolation:'Exact integral of piecewise-linear fuel flow',
      peakMeaning:'Highest evaluated window in these logs; not an absolute engine limit' } };
}
/** Continuous static-flow reference at fixedDelta; it does not apply the pulse duty cap or opening delay. */
export function fullyOpen(input={}) {
  const c=validate(input),ratio=Math.sqrt(Math.max(c.fixedDelta,0)/c.reference);
  let flowGps=c.injectors*c.flowGmin*ratio/60;
  if(c.secondBank?.enabled)flowGps+=c.secondBank.count*c.secondBank.flowGmin*ratio/60;
  const fuelKw=flowGps*c.lhv;
  return {flowGps,fuelKw,coolantKw:fuelKw*c.fraction,designKw:fuelKw*c.fraction*c.sf,deltaPsi:c.fixedDelta};
}
function parseGrid(text,delimiter) {
  const result=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(char==='"') {
      if(quoted && text[i+1]==='"'){cell+='"';i++;}
      else if(quoted || cell.trim()==='')quoted=!quoted;
      else cell+=char;
    } else if(!quoted && char===delimiter) {row.push(cell.trim());cell='';}
    else if(!quoted && (char==='\n' || char==='\r')) {
      if(char==='\r' && text[i+1]==='\n')i++;
      row.push(cell.trim());if(row.some(v=>v!==''))result.push(row);row=[];cell='';
    } else cell+=char;
  }
  if(quoted)throw new Error('The file contains an unclosed quoted field. Export the log as CSV or TSV again.');
  row.push(cell.trim());if(row.some(v=>v!==''))result.push(row);
  return result;
}
export function parseDelimited(text) {
  if(typeof text!=='string' || !text.trim())throw new Error('The log file is empty.');
  text=text.replace(/^\uFEFF/,'');
  // Examine enough complete lines to tolerate a short PE3 metadata preamble.
  const sample=text.split(/\r?\n/).slice(0,50).join('\n');
  let delimiter=',',best=-Infinity;
  for(const candidate of [',','\t',';']) {
    let rows;try{rows=parseGrid(sample,candidate);}catch{continue;}
    const lengths=rows.map(r=>r.length),max=Math.max(...lengths);
    const score=max>1?max+lengths.filter(n=>n===max).length:-1;
    if(score>best){best=score;delimiter=candidate;}
  }
  const grid=parseGrid(text,delimiter);
  let headerIndex=0,headerScore=-1;
  for(let i=0;i<Math.min(30,grid.length);i++) {
    const m=suggestMapping(grid[i]);
    const score=(m.t!=null?5:0)+(m.rpm!=null?5:0)+(m.pw!=null?3:0)+(m.fuel!=null?1:0)+(m.map!=null?1:0);
    if(score>headerScore){headerScore=score;headerIndex=i;}
  }
  const used=new Map();
  const headers=grid[headerIndex].map((h,i)=>{
    const base=h.trim() || `Column ${i+1}`,n=(used.get(base)||0)+1;used.set(base,n);return n===1?base:`${base} [${n}]`;
  });
  const records=grid.slice(headerIndex+1).map((row,index)=>{
    const record={};headers.forEach((h,i)=>record[h]=row[i]??'');
    Object.defineProperty(record,'_line',{value:headerIndex+index+2,enumerable:false});return record;
  });
  return {headers,records,delimiter,headerLine:headerIndex+1};
}
export function suggestMapping(headers) {
  const normalized=headers.map(h=>String(h).toLowerCase().replace(/[^a-z0-9]/g,''));
  const patterns={
    t:[/^time(?:s|sec|seconds|ms)?$/, /^elapsedtime/,/^timestamp/,/^logtime/],
    rpm:[/^enginespeed/,/^enginerpm/,/^rpm/],
    pw:[/^injector1pulsewidth/,/^injector1pw/,/^fuel1pulsewidth/,/^fuel1pw/,/^injectorpulsewidth/,/^fuelpulsewidth/,/^pulsewidth/,/^inj1pw/,/^injpw/,/^pw1/,/^pw$/],
    pw2:[/^injector2pulsewidth/,/^injector2pw/,/^fuel2pulsewidth/,/^fuel2pw/,/^inj2pw/,/^pw2/],
    fuel:[/^fuelpressure/,/^fuelrailpressure/,/^railpressure/,/^fuelpress/,/^fp(?:psi)?$/],
    map:[/^map(?:psi|kpa|bar|absolute|gauge)?$/, /^manifoldabsolutepressure/,/^manifoldpressure/],
    speed:[/^nondrivenspeed/,/^nondrivenwheelspeed/,/^vehiclespeed/,/^gpsspeed/,/^speed(?:mph|kmh|ms)?$/],
    voltage:[/^batteryvoltage/,/^supplyvoltage/,/^battv/,/^voltage/]
  };
  const mapping={};
  for(const [key,expressions]of Object.entries(patterns)) {
    let index=-1;
    for(const regex of expressions){index=normalized.findIndex(h=>regex.test(h));if(index>=0)break;}
    mapping[key]=index>=0?headers[index]:null;
  }
  return mapping;
}
const unitName=u=>String(u||'').toLowerCase().replace(/[\s_³]/g,'').replace('μ','u').replace('µ','u');
function convert(value,key,unit) {
  let v=number(value);const u=unitName(unit);
  if(key==='t' && !finite(v) && typeof value==='string' && /^\d+:\d{2}(?::\d{2})?(\.\d+)?$/.test(value.trim()))v=value.trim().split(':').reduce((acc,n)=>acc*60+Number(n),0);
  if(!finite(v))return NaN;
  if(key==='t')return u==='ms'?v/1000:u==='min'?v*60:v;
  if(key==='pw'||key==='pw2')return u==='s'?v*1000:u==='us'?v/1000:v;
  if(key==='fuel'||key==='map')return u==='kpa'?v/6.894757293168:u==='bar'?v*14.50377377302:u==='pa'?v/6894.757293168:v;
  if(key==='speed')return ['km/h','kmh','kph'].includes(u)?v/1.609344:['m/s','ms'].includes(u)?v*2.2369362920544:v;
  return v;
}
/** Mapping values are exact header names, or numeric indices for array records. Missing channels stay NaN. */
export function normalizeRows(records,mapping,units={}) {
  return records.map(record=>{
    const row={};
    for(const key of ['t','rpm','pw','fuel','map','speed','voltage','pw2']) {
      const column=mapping[key];row[key]=column==null || column===''?NaN:convert(record[column],key,units[key]);
    }
    const sourceColumn=mapping.source ?? mapping.sourceId;
    if(sourceColumn!=null)row.source=record[sourceColumn];
    return row;
  });
}
