/**
 * Lightweight SVG sparkline. No external libraries.
 * width 120, height 40, smooth polyline, minimal styling.
 */
export function generateSparkline(data: number[]): string {
  const width = 120;
  const height = 40;
  if (data.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"></svg>`;
  }
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 2;
  const chartW = width - pad * 2;
  const chartH = height - pad * 2;
  const points = data.map((v, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = pad + chartH - ((v - min) / range) * chartH;
    return `${x},${y}`;
  });
  const pathD = points.length === 1
    ? `M ${points[0]} L ${points[0]}`
    : `M ${points.join(" L ")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="${pathD}"/></svg>`;
}
