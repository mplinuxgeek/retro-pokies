// Single source of truth for RTP bands and the run labels: used by js/scan-worker.js, debug.html and games.html.
// The labels say what a run saw, not why: a few hundred spins are noisy and a low figure can be bad luck as well as a fault.
// Target RTP is about 0.87-0.92 (default set 3 = 0.9226); 500-spin runs are noisy, so "working" starts at 0.8.
(function (root) {
  // RTP 0.8 to 1.3 pays normally; 0.5 to 0.8 a little low; 0.25 to 0.5 low; under 0.25 very little; over 1.3 too much
  const B = { working: 0.8, possible: 0.5, low: 0.25, suspect: 1.3 };
  // returns 'working' | 'possible' | 'low' | 'broken' | 'suspect'
  B.L = {
    normal: 'Pays normally', abitlow: 'Pays a little low', low: 'Pays low', verylow: 'Pays very little', high: 'Pays too much',
    always: 'Wins nearly every spin', never: 'Never pays', rarely: 'Almost never pays', error: 'Stalls or errors', timeout: 'Hangs (timed out)',
  };
  // a run's label: hangs and errors first, then no or almost no wins, then the hit rate and RTP band
  B.label = r => r.timeout ? B.L.timeout : (r.error || r.stuck || r.refused) ? B.L.error : r.wins === 0 ? B.L.never
    : r.hit < 0.01 && r.spins >= 500 ? B.L.rarely : r.rtp > B.suspect ? B.L.high : r.hit > 0.9 && r.spins >= 100 ? B.L.always
    : r.rtp >= B.working ? B.L.normal : r.rtp >= B.possible ? B.L.abitlow : r.rtp >= B.low ? B.L.low : B.L.verylow;
  // labels written by older runs, still found in rom-status.json, mapped to today's
  B.OLD = { 'logic working': B.L.normal, working: B.L.normal, 'possibly working': B.L.abitlow, 'low RTP (check)': B.L.low, 'Unlucky?': B.L.low,
    'probably broken': B.L.verylow, 'Low RTP?': B.L.verylow, 'suspect (RTP>1.3)': B.L.high, 'stuck? (hit>90%)': B.L.always,
    "I'm going to a real club": B.L.never, 'no wins (engine?)': B.L.never, error: B.L.error, 'timed out': B.L.timeout };
  B.current = status => B.OLD[status] || status;
  B.band = v => v > B.suspect ? 'suspect' : v >= B.working ? 'working' : v >= B.possible ? 'possible' : v >= B.low ? 'low' : 'broken';
  if (typeof module !== 'undefined' && module.exports) module.exports = B; else root.RTP_BANDS = B;
})(typeof self !== 'undefined' ? self : this);
