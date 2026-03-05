/**
 * Reusable SVG line chart for date-wise data. No external deps.
 * Renders a single series with optional X-axis date labels (sampled to avoid clutter).
 */
export type LineChartPoint = {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  value: number;
};

export type LineChartProps = {
  /** Data points in order (oldest first) */
  data: LineChartPoint[];
  /** Chart width (default 400) */
  width?: number;
  /** Chart height (default 200) */
  height?: number;
  /** Label for the series (e.g. "Drawer opens") */
  label?: string;
  /** Format value for tooltip/display (default Number) */
  formatValue?: (n: number) => string;
  /** Max number of X-axis labels to show (default 6) */
  maxXLabels?: number;
  /** Optional className for the wrapper */
  className?: string;
};

function sampleIndices(length: number, maxLabels: number): number[] {
  if (length <= maxLabels) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (maxLabels - 1);
  return Array.from({ length: maxLabels }, (_, i) => Math.round(i * step));
}

export function LineChart({
  data,
  width = 400,
  height = 200,
  label,
  formatValue = (n) => String(n),
  maxXLabels = 6,
  className,
}: LineChartProps) {
  if (data.length === 0) {
    return (
      <div className={className} style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--app-bg-subdued, #f6f6f7)", borderRadius: 8 }}>
        <span style={{ fontSize: 14, color: "var(--app-muted-text, #6d7175)" }}>No data</span>
      </div>
    );
  }

  const padding = { top: 16, right: 16, bottom: 32, left: 44 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const values = data.map((d) => d.value);
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 1);
  const range = maxVal - minVal || 1;

  const xScale = (i: number) => padding.left + (i / Math.max(data.length - 1, 1)) * chartWidth;
  const yScale = (v: number) => padding.top + chartHeight - ((v - minVal) / range) * chartHeight;

  const pathD = data.length === 1
    ? `M ${xScale(0)} ${yScale(data[0].value)} L ${xScale(0)} ${yScale(data[0].value)}`
    : data.map((d, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(d.value)}`).join(" ");

  const xLabelIndices = sampleIndices(data.length, maxXLabels);
  const xLabels = xLabelIndices.map((i) => ({
    i,
    date: data[i].date,
    x: xScale(i),
  }));

  return (
    <div className={className} style={{ width: "100%", maxWidth: width }}>
      {label && (
        <div style={{ marginBottom: 8, fontSize: 14, fontWeight: 500 }}>{label}</div>
      )}
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ overflow: "visible" }}>
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          d={pathD}
          style={{ color: "var(--p-color-border-info, #2c6ecb)" }}
        />
        {xLabels.map(({ i, date, x }) => (
          <g key={i}>
            <line
              x1={x}
              y1={padding.top + chartHeight}
              x2={x}
              y2={height}
              stroke="var(--app-border-subtle, #e1e3e5)"
              strokeWidth={1}
            />
            <text
              x={x}
              y={height - 8}
              textAnchor="middle"
              fontSize={10}
              fill="var(--app-muted-text, #6d7175)"
            >
              {date.slice(5)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
