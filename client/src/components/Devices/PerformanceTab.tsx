import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';
import { DeviceMetrics, MetricPoint, Response } from '../../typescript/interfaces';

type Range = DeviceMetrics['range'];
type Field = 'cpu' | 'memory' | 'disk';

const RANGES: { id: Range; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' }
];

const formatAt = (iso: string, range: Range) =>
  new Date(iso).toLocaleString(undefined, range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const axisLabel = (iso: string, range: Range) =>
  new Date(iso).toLocaleString(undefined, range === '24h' ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' });

const useWidth = () => {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, Math.floor(entries[0].contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
};

const lastValue = (points: MetricPoint[], field: Field) => {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index][field];
    if (value !== null) return value;
  }
  return null;
};

/**
 * One measure over time: a 2px line with a faint area, hairline gridlines at
 * 0/50/100%, and a labelled 90% reference. Hovering anywhere moves a shared
 * crosshair across all charts; the title readout shows the hovered value.
 */
const TrendChart = (props: {
  title: string;
  field: Field;
  points: MetricPoint[];
  range: Range;
  hover: number | null;
  onHover: (index: number | null) => void;
  note?: string;
}) => {
  const { ref, width } = useWidth();
  const { points, field, hover } = props;
  const height = 150;
  const pad = { top: 10, right: 12, bottom: 22, left: 38 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const values = points.map(point => point[field]);
  const max = Math.max(100, ...values.map(value => value || 0));
  const x = (index: number) => pad.left + (index / Math.max(points.length - 1, 1)) * innerW;
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;

  // Break the line where there is no data rather than drawing through gaps
  const segments: { index: number; value: number }[][] = [];
  values.forEach((value, index) => {
    if (value === null) return;
    const last = segments[segments.length - 1];
    if (last && last[last.length - 1].index === index - 1) last.push({ index, value });
    else segments.push([{ index, value }]);
  });
  const line = segments.map(segment => segment.map((p, i) => `${i ? 'L' : 'M'}${x(p.index).toFixed(1)},${y(p.value).toFixed(1)}`).join('')).join('');
  const area = segments
    .filter(segment => segment.length > 1)
    .map(
      segment =>
        `M${x(segment[0].index).toFixed(1)},${y(0)}` +
        segment.map(p => `L${x(p.index).toFixed(1)},${y(p.value).toFixed(1)}`).join('') +
        `L${x(segment[segment.length - 1].index).toFixed(1)},${y(0)}Z`
    )
    .join('');
  const singles = segments.filter(segment => segment.length === 1).map(segment => segment[0]);

  const hovered = hover !== null ? values[hover] : null;
  const current = lastValue(points, field);
  const ticks = [0, Math.round(points.length / 2), points.length - 1].filter((value, index, all) => all.indexOf(value) === index);

  const onMove = (event: React.MouseEvent<SVGRectElement>) => {
    const box = (event.target as SVGRectElement).getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    props.onHover(Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))));
  };

  return (
    <figure className='trend-chart'>
      <figcaption>
        <span className='trend-title'>{props.title}</span>
        <span className='trend-readout'>
          {hover !== null ? (
            <>
              <strong>{hovered === null ? 'no data' : `${hovered}%`}</strong> <span>{formatAt(points[hover].at, props.range)}</span>
            </>
          ) : (
            <>
              <strong>{current === null ? '—' : `${current}%`}</strong> <span>latest</span>
            </>
          )}
        </span>
      </figcaption>
      <div ref={ref} className='trend-plot'>
        <svg width={width} height={height} role='img' aria-label={`${props.title} over the last ${props.range}`}>
          {[0, 50, 100].map(value => (
            <g key={value}>
              <line className='trend-grid' x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} />
              <text className='trend-axis' x={pad.left - 6} y={y(value) + 4} textAnchor='end'>
                {value}%
              </text>
            </g>
          ))}
          <line className='trend-threshold' x1={pad.left} x2={width - pad.right} y1={y(90)} y2={y(90)} />
          <text className='trend-axis' x={width - pad.right} y={y(90) - 4} textAnchor='end'>
            90%
          </text>
          {ticks.map(index => (
            <text
              key={index}
              className='trend-axis'
              x={x(index)}
              y={height - 6}
              textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            >
              {points[index] ? axisLabel(points[index].at, props.range) : ''}
            </text>
          ))}
          <path className='trend-area' d={area} />
          <path className='trend-line' d={line} />
          {singles.map(point => (
            <circle key={point.index} className='trend-dot' cx={x(point.index)} cy={y(point.value)} r={3} />
          ))}
          {hover !== null && (
            <>
              <line className='trend-crosshair' x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} />
              {hovered !== null && <circle className='trend-marker' cx={x(hover)} cy={y(hovered)} r={4.5} />}
            </>
          )}
          <rect
            x={pad.left}
            y={0}
            width={innerW}
            height={height}
            fill='transparent'
            onMouseMove={onMove}
            onMouseLeave={() => props.onHover(null)}
          />
        </svg>
      </div>
      {props.note && <p className='form-text mb-0'>{props.note}</p>}
    </figure>
  );
};

/** Availability per time bucket: downtime stands out, uptime stays neutral */
const UptimeStrip = (props: { points: MetricPoint[]; range: Range; hover: number | null; onHover: (index: number | null) => void }) => (
  <div className='uptime-strip-wrap'>
    <div className='uptime-strip' onMouseLeave={() => props.onHover(null)}>
      {props.points.map((point, index) => (
        <span
          key={point.at}
          className={`uptime-cell ${point.online === null ? 'is-none' : point.online < 100 ? 'is-down' : 'is-up'} ${props.hover === index ? 'is-hover' : ''}`}
          title={`${formatAt(point.at, props.range)}: ${point.online === null ? 'no data' : point.online < 100 ? `offline (up ${point.online}% of checks)` : 'online'}`}
          onMouseEnter={() => props.onHover(index)}
        />
      ))}
    </div>
    <div className='uptime-legend'>
      <span>
        <i className='uptime-cell is-up' /> Online
      </span>
      <span>
        <i className='uptime-cell is-down' /> Offline for some or all of the period
      </span>
      <span>
        <i className='uptime-cell is-none' /> No data
      </span>
    </div>
  </div>
);

export const PerformanceTab = (props: { deviceId: number; windows: boolean }) => {
  const [range, setRange] = useState<Range>('24h');
  const [metrics, setMetrics] = useState<DeviceMetrics | null>(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      axios
        .get<Response<DeviceMetrics>>(`/api/devices/${props.deviceId}/metrics`, { params: { range } })
        .then(res => !cancelled && setMetrics(res.data.data))
        .catch(() => !cancelled && setError('Could not load trends.'));
    load();
    const timer = window.setInterval(load, 120_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [props.deviceId, range]);

  const points = metrics?.points || [];
  const hasData = points.some(point => point.online !== null);

  return (
    <div className='performance-tab'>
      <div className='device-toolbar'>
        <div className='segmented' role='group' aria-label='Time range'>
          {RANGES.map(item => (
            <button key={item.id} type='button' className={range === item.id ? 'is-active' : ''} onClick={() => setRange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <button type='button' className='btn btn-sm btn-link' onClick={() => setTable(!table)} disabled={!hasData}>
          {table ? 'Show charts' : 'Show as table'}
        </button>
      </div>

      {error && <div className='alert alert-danger'>{error}</div>}

      {!metrics ? (
        <p className='text-muted'>Loading…</p>
      ) : !hasData ? (
        <p className='text-muted mb-0'>
          No history yet. The agent sends a reading every two minutes (agent 1.3.0 and newer); trends appear after the first few check-ins.
        </p>
      ) : table ? (
        <div className='values-table-wrap'>
          <table className='values-table tool-table'>
            <thead>
              <tr>
                <th>Period starting</th>
                <th className='text-end'>Online</th>
                <th className='text-end'>CPU</th>
                <th className='text-end'>Memory</th>
                <th className='text-end'>Disk</th>
              </tr>
            </thead>
            <tbody>
              {points
                .filter(point => point.online !== null)
                .reverse()
                .map(point => (
                  <tr key={point.at}>
                    <td>{formatAt(point.at, range)}</td>
                    <td className='text-end'>{point.online}%</td>
                    <td className='text-end'>{point.cpu ?? '—'}{point.cpu !== null && '%'}</td>
                    <td className='text-end'>{point.memory ?? '—'}{point.memory !== null && '%'}</td>
                    <td className='text-end'>{point.disk ?? '—'}{point.disk !== null && '%'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className='trend-availability'>
            <div className='trend-hero'>
              <strong>{metrics.availability === null ? '—' : `${metrics.availability}%`}</strong>
              <span>availability, last {RANGES.find(item => item.id === range)?.label}</span>
            </div>
            <UptimeStrip points={points} range={range} hover={hover} onHover={setHover} />
          </div>
          <div className='trend-grid-wrap'>
            <TrendChart
              title={props.windows ? 'CPU' : 'CPU load'}
              field='cpu'
              points={points}
              range={range}
              hover={hover}
              onHover={setHover}
              note={props.windows ? undefined : '1-minute load average as a share of CPUs; above 100% means work is queuing.'}
            />
            <TrendChart title='Memory used' field='memory' points={points} range={range} hover={hover} onHover={setHover} />
            <TrendChart title='Disk used (system drive)' field='disk' points={points} range={range} hover={hover} onHover={setHover} />
          </div>
        </>
      )}
    </div>
  );
};
