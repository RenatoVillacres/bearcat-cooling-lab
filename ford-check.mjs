import { calculateRun } from './engine.mjs';

// Published steady operating points, not measured time-series logs.
export const FORD_POINTS = Object.freeze([
  Object.freeze({ rpm: 1500, pw: 7.9, publishedFlowGps: 0.8325, publishedFuelKw: 36.630, exactFuelKw: 36.630 }),
  Object.freeze({ rpm: 2500, pw: 6.7, publishedFlowGps: 1.163, publishedFuelKw: 51.172, exactFuelKw: 51.150 })
]);

export function runFordChecks() {
  const config = {
    flow: 180, flowUnit: 'cc/min', density: 0.750, densityUnit: 'g/cc',
    injectors: 4, pulses: 1, deadtime: 0.5, deadtimeMode: 'fixed',
    pwIncludesDelay: true, cap: 0.95, lhv: 44, fraction: 0, sf: 1,
    pressureMode: 'fixed', reference: 1, fixedDelta: 1,
    filter: 'all', start: null, end: null, gap: 0.05, secondBank: null
  };
  // Equal pressure values provide a unity multiplier. They are not Ford pressure data.
  return FORD_POINTS.map(point => {
    const rows = Array.from({ length: 1501 }, (_, i) => ({ t: i * 0.02, rpm: point.rpm, pw: point.pw }));
    const windows = [10, 15].map(window => {
      const result = calculateRun(rows, { ...config, window });
      return { seconds: window, wholeFuelKw: result.full.fuelKw,
        peakFuelKw: result.peak.fuelKw, minimumFuelKw: result.minimum.fuelKw,
        flowGps: result.full.flowGps, massG: result.full.massG,
        cappedRows: result.counts.cappedRows };
    });
    const fuelKw = windows[0].wholeFuelKw;
    const matches = windows.every(w => [w.wholeFuelKw, w.peakFuelKw, w.minimumFuelKw]
      .every(value => Math.abs(value - point.exactFuelKw) < 1e-9) && w.cappedRows === 0);
    const sourceRoundingMatches = Math.abs(point.publishedFlowGps * config.lhv - point.publishedFuelKw) < 1e-9;
    return { ...point, windows, fuelKw, flowGps: windows[0].flowGps,
      differenceKw: fuelKw - point.publishedFuelKw,
      differencePercent: 100 * (fuelKw - point.publishedFuelKw) / point.publishedFuelKw,
      passed: matches && sourceRoundingMatches };
  });
}

if (typeof document !== 'undefined') {
  const button = document.getElementById('runFordCheck');
  button?.addEventListener('click', () => {
    const status = document.getElementById('fordCheckStatus');
    button.disabled = true;
    status.textContent = 'Running the published operating points…';
    setTimeout(() => {
      try {
        const results = runFordChecks();
        results.forEach((result, i) => {
          document.getElementById(`fordResult${i + 1}`).textContent = `${result.fuelKw.toFixed(3)} kW`;
          document.getElementById(`fordDifference${i + 1}`).textContent = Math.abs(result.differenceKw) < 1e-9
            ? 'Exact match' : `${result.differenceKw.toFixed(3)} kW (${result.differencePercent.toFixed(3)}%)`;
        });
        const passed = results.filter(r => r.passed).length;
        status.textContent = `${passed}/2 calculation checks passed · 10 s, 15 s and whole-series averages checked.`;
        status.className = passed === 2 ? 'benchmark-status pass' : 'benchmark-status fail';
      } catch (error) {
        status.textContent = `Check could not finish: ${error.message}`;
        status.className = 'benchmark-status fail';
      } finally { button.disabled = false; }
    }, 0);
  });
}
