"use client";

interface SparklineProps {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
  label?: string;
}

export function Sparkline({
  data,
  color = "oklch(0.62 0.19 255)",
  width = 80,
  height = 36,
  label,
}: SparklineProps) {
  // ponytail: drop fake line on <2 points, add interactive exploration if hover tooltips requested
  const pointsData = Array.isArray(data)
    ? data.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    : [];

  if (pointsData.length < 2) {
    return null;
  }

  const min = Math.min(...pointsData);
  const max = Math.max(...pointsData);
  const range = max - min;
  const points = pointsData
    .map((v, i) => {
      const x = (i / (pointsData.length - 1)) * width;
      const y = range === 0 ? height / 2 : height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      className="metric-card-spark"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {label && <title>{label}</title>}
      <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}
