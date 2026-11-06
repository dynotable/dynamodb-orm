// Writes the benchmark charts in docs/assets from the numbers in docs/benchmarks.md.
// Run `node docs/assets/make-charts.mjs` after a new benchmark run, with the new medians below.
import {writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const LIB = 'dynotable-orm';
const SDK = 'hand-written AWS SDK';

// Median calls per second. `order`: the median ops/s of `pnpm bench --gate --json`. `small`: 1e6 over the
// median µs of `pnpm bench:competitors`, one run for all five libraries.
const figures = {
  order: {
    title: 'Calls per second on a 60-attribute schema — higher is better',
    notes: [
      'CPU only: a stub client, no network. Median of 20 rounds. dynamoose 4.2.0.',
      'Each panel has its own scale.'
    ],
    panels: [
      ['create', {[LIB]: 23304, [SDK]: 20075, dynamoose: 256}],
      ['get', {[LIB]: 107452, [SDK]: 84281, dynamoose: 281}],
      ['update', {[LIB]: 69360, [SDK]: 66819, dynamoose: 78.8}],
      ['query of 100 items', {[LIB]: 1068, [SDK]: 836, dynamoose: 3.76}]
    ]
  },
  small: {
    title: 'Calls per second on a 5-attribute schema — higher is better',
    notes: [
      'CPU only: a stub client, no network. One run of 10 rounds. dynamoose 4.2.0,',
      'ElectroDB 3.9.3, dynamodb-toolbox 2.11.1. Each panel has its own scale.'
    ],
    panels: [
      [
        'create',
        {
          [LIB]: 1e6 / 1.6,
          [SDK]: 1e6 / 1.39,
          dynamoose: 1e6 / 191,
          ElectroDB: 1e6 / 34.4,
          'dynamodb-toolbox': 1e6 / 11.5
        }
      ],
      [
        'get',
        {
          [LIB]: 1e6 / 0.671,
          [SDK]: 1e6 / 0.935,
          dynamoose: 1e6 / 254,
          ElectroDB: 1e6 / 21.6,
          'dynamodb-toolbox': 1e6 / 9.08
        }
      ],
      [
        'update',
        {
          [LIB]: 1e6 / 1.49,
          [SDK]: 1e6 / 0.972,
          dynamoose: 1e6 / 238,
          ElectroDB: 1e6 / 34.7,
          'dynamodb-toolbox': 1e6 / 15.1
        }
      ],
      [
        'query of 100 items',
        {
          [LIB]: 1e6 / 28.3,
          [SDK]: 1e6 / 26.5,
          dynamoose: 1e6 / 6290,
          ElectroDB: 1e6 / 173,
          'dynamodb-toolbox': 1e6 / 460
        }
      ]
    ]
  }
};

const themes = {
  light: {lib: '#2a78d6', other: '#8c959f', text: '#1f2328', muted: '#59636e', axis: '#d1d9e0'},
  dark: {lib: '#3987e5', other: '#6e7681', text: '#e6edf3', muted: '#9198a1', axis: '#3d444d'}
};

const W = 800;
const LABEL_W = 170;
const PLOT_R = W - 110;
const BAR_H = 20;
const ROW = 28;
const FONT = `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif"`;

/** Three significant figures, with thousands separators: 24,200/s. */
const perSecond = (v) => `${Number(v.toPrecision(3)).toLocaleString('en-US')}/s`;

// A horizontal bar anchored at x0 with only its far end rounded (up to 4px).
function bar(x0, x1, y, h, fill) {
  const r = Math.min(4, (x1 - x0) / 2);
  return `<path d="M${x0} ${y}H${x1 - r}Q${x1} ${y} ${x1} ${y + r}V${y + h - r}Q${x1} ${y + h} ${x1 - r} ${y + h}H${x0}Z" fill="${fill}"/>`;
}

function chart({title, notes, panels}, c) {
  let b = `<text x="0" y="22" font-size="17" font-weight="600" fill="${c.text}">${title}</text>\n`;
  notes.forEach((line, i) => {
    b += `<text x="0" y="${46 + i * 18}" font-size="13" fill="${c.muted}">${line}</text>\n`;
  });
  let y = 46 + notes.length * 18 + 16;
  for (const [operation, values] of panels) {
    const entries = Object.entries(values);
    const max = Math.max(...entries.map(([, v]) => v));
    const x = (v) => LABEL_W + Math.max(2, ((PLOT_R - LABEL_W) * v) / max);
    b += `<text x="0" y="${y + 14}" font-size="14" font-weight="600" fill="${c.text}">${operation}</text>\n`;
    y += 24;
    const top = y;
    for (const [name, v] of entries) {
      const lib = name === LIB;
      b += `<text x="${LABEL_W - 10}" y="${y + 15}" font-size="13"${lib ? ' font-weight="600"' : ''} fill="${c.text}" text-anchor="end">${name}</text>
${bar(LABEL_W, x(v), y, BAR_H, lib ? c.lib : c.other)}
<text x="${x(v) + 8}" y="${y + 15}" font-size="13"${lib ? ' font-weight="600"' : ''} fill="${c.text}">${perSecond(v)}</text>\n`;
      y += ROW;
    }
    b += `<line x1="${LABEL_W}" y1="${top - 4}" x2="${LABEL_W}" y2="${y - ROW + BAR_H + 4}" stroke="${c.axis}" stroke-width="1"/>\n`;
    y += 14;
  }
  const height = y;
  const desc = panels
    .map(
      ([op, v]) =>
        `${op}: ${Object.entries(v)
          .map(([n, x]) => `${n} ${perSecond(x)}`)
          .join(', ')}`
    )
    .join('. ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="t d" ${FONT}>
<title id="t">${title}</title>
<desc id="d">${desc}.</desc>
${b}</svg>
`;
}

for (const [mode, c] of Object.entries(themes)) {
  writeFileSync(join(here, `benchmark-order-${mode}.svg`), chart(figures.order, c));
  writeFileSync(join(here, `benchmark-small-${mode}.svg`), chart(figures.small, c));
}
