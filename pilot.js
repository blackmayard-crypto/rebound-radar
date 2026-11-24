// Inputs are consecutive, completed trading sessions for one security, oldest first.
// Close must use a consistent split-adjusted basis and volume the matching share basis.
function reboundScore(bars) {
  const window = bars.slice(-21);
  if (window.length !== 21 || window.some((b, i) =>
    !Number.isFinite(b.close) || b.close <= 0 || !Number.isFinite(b.volume) ||
    b.volume < 0 || (i > 0 && b.date <= window[i - 1].date))) return null;
  const last = window[20];
  const prior = window.slice(0, 20);
  const high = Math.max(...prior.map(b => b.close));
  const averageVolume = prior.reduce((sum, b) => sum + b.volume, 0) / 20;
  if (!averageVolume) return null;
  const cap = x => Math.max(0, Math.min(1, x));
  const decline = 1 - last.close / high;
  if (decline <= 0) return null;
  const recovery = last.close / prior[19].close - 1;
  const relativeVolume = last.volume / averageVolume;
  const points = [
    Math.round(40 * cap(decline / 0.20)),
    Math.round(40 * cap(recovery / 0.05)),
    Math.round(20 * cap(relativeVolume - 1))
  ];
  return {score: points.reduce((a,b) => a+b, 0), points};
}

// Use exchange-session dates, not calendar-day offsets. Missing quotes stay pending.
function forwardReturn(closesByDate, sessions, asOf, offset) {
  const start = sessions.indexOf(asOf);
  if (start < 0 || ![1, 5].includes(offset)) return null;
  const base = closesByDate[asOf], end = closesByDate[sessions[start + offset]];
  return Number.isFinite(base) && base > 0 && Number.isFinite(end) && end > 0
    ? end / base - 1 : null;
}
if (typeof module !== 'undefined') module.exports = {reboundScore, forwardReturn};
