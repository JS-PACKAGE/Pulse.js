import type { ReactNode } from 'react';
import type { Threshold } from '../../src/shared/types.ts';
import { number } from './api';

// 270° dial opening at the bottom; angles are SVG degrees (0 = 3 o'clock, clockwise).
const CENTER = 60;
const RADIUS = 50;
const START = 135;
const SWEEP = 270;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const ARC = (CIRCUMFERENCE * SWEEP) / 360;

function point(percent: number, radius: number): [number, number] {
  const angle = ((START + (SWEEP * Math.min(Math.max(percent, 0), 100)) / 100) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)];
}

/** Percentage dial coloured by the same rule as server alerts: warn from `warn`, crit from `crit`. */
export function Gauge({
  title,
  value,
  threshold,
  children,
}: {
  title: string;
  value: number | null;
  threshold: Threshold;
  children?: ReactNode;
}) {
  const level = value === null ? 'none' : value >= threshold.crit ? 'crit' : value >= threshold.warn ? 'warn' : 'ok';
  const filled = value === null ? 0 : (ARC * Math.min(Math.max(value, 0), 100)) / 100;
  return (
    <section className="panel gauge">
      <h3>{title}</h3>
      <div className={`gauge-dial ${level}`}>
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="gauge-ticks" cx={CENTER} cy={CENTER} r={58} />
          <circle
            className="gauge-track"
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeDasharray={`${ARC} ${CIRCUMFERENCE}`}
            transform={`rotate(${START} ${CENTER} ${CENTER})`}
          />
          <circle
            className="gauge-value"
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
            transform={`rotate(${START} ${CENTER} ${CENTER})`}
          />
          {(['warn', 'crit'] as const).map((mark) => {
            const [x1, y1] = point(threshold[mark], 42);
            const [x2, y2] = point(threshold[mark], 58);
            return <line key={mark} className={`gauge-mark ${mark}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </svg>
        <strong>{number(value, '%')}</strong>
      </div>
      {children}
    </section>
  );
}
