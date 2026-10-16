import type { Threshold } from '../../src/shared/types.ts';
import { number } from './api';
import { useI18n } from './i18n';
export interface ChartLine {
  label: string;
  points: { ts: number; value: number | null }[];
}
export function Chart({
  title,
  lines,
  since,
  now,
  threshold,
  unit = '%',
}: {
  title: string;
  lines: ChartLine[];
  since: number;
  now: number;
  threshold?: Threshold;
  unit?: string;
}) {
  const { t, lang } = useI18n();
  let max = Math.max(1, threshold?.crit ?? 0, threshold?.warn ?? 0);
  let hasData = false;
  for (const line of lines) {
    for (const point of line.points) {
      if (point.value !== null) {
        max = Math.max(max, point.value);
        hasData = true;
      }
    }
  }
  max *= 1.1;
  const x = (ts: number) => 52 + ((ts - since) / Math.max(1, now - since)) * 600;
  const y = (value: number) => 180 - (value / max) * 152;
  // Ranges beyond a day span several dates, so labels need the date too.
  const time = (ts: number) =>
    new Date(ts).toLocaleString(
      lang,
      now - since > 86_400_000
        ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' },
    );
  return (
    <section className="panel chart">
      <h3>{title}</h3>
      <div className="legend">
        {lines.map((line, index) => (
          <span key={line.label} className={`line-${index % 2}`}>
            {line.label}
          </span>
        ))}
        {threshold && (
          <>
            <span className="warn">
              {t('warn')}: {number(threshold.warn, unit)}
            </span>
            <span className="crit">
              {t('crit')}: {number(threshold.crit, unit)}
            </span>
          </>
        )}
      </div>
      {!hasData && <p className="muted">{t('noData')}</p>}
      <svg viewBox="0 0 680 215" role="img" aria-label={title}>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line className="gridline" x1="52" x2="652" y1={y(max * fraction)} y2={y(max * fraction)} />
            <text x="46" y={y(max * fraction) + 4} textAnchor="end">
              {number(max * fraction)}
            </text>
          </g>
        ))}
        {threshold &&
          (['warn', 'crit'] as const).map((level) => (
            <line
              key={level}
              className={`threshold ${level}`}
              x1="52"
              x2="652"
              y1={y(threshold[level])}
              y2={y(threshold[level])}
            />
          ))}
        {lines.map((line, index) => {
          let connected = false;
          const path = line.points
            .map((point) => {
              if (point.value === null) {
                connected = false;
                return '';
              }
              const command = `${connected ? 'L' : 'M'}${x(point.ts)},${y(point.value)}`;
              connected = true;
              return command;
            })
            .join(' ');
          return (
            <g key={line.label} className={`line-${index % 2}`}>
              <path className="series" d={path} />
              {line.points.map((point, pointIndex) =>
                point.value === null ? null : (
                  <circle key={pointIndex} cx={x(point.ts)} cy={y(point.value)} r="1.8">
                    <title>{`${time(point.ts)} · ${line.label}: ${number(point.value, unit)}`}</title>
                  </circle>
                ),
              )}
            </g>
          );
        })}
        <text x="52" y="205">
          {time(since)}
        </text>
        <text x="652" y="205" textAnchor="end">
          {time(now)}
        </text>
      </svg>
    </section>
  );
}
