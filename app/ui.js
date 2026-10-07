// Display constants shared by the Inbox, At risk and Approvals screens. Brand keys match
// lib/brands.js; adding a brand means a line here and colour vars in globals.css (see
// "Adding a brand" in CLAUDE.md).

export const BRANDS = {
  elderemo:  { name: 'Elder Emo', short: 'EE', color: 'var(--violet)', bg: 'var(--violet-bg)' },
  poppunks:  { name: 'PopPunks',  short: 'PP', color: 'var(--pink)',   bg: 'var(--pink-bg)' },
  wallspoke: { name: 'Wallspoke', short: 'WS', color: 'var(--blue)',   bg: 'var(--blue-bg)' },
  unknown:   { name: 'Unknown',   short: '?',  color: 'var(--muted)',  bg: 'var(--surface-2)' },
};
export const RAIL_BRANDS = ['elderemo', 'poppunks', 'wallspoke'];

export const STATUS = {
  shipped:    { cls: 's-shipped',    dot: 'var(--green)', label: 'Shipped' },
  production: { cls: 's-production', dot: 'var(--amber)', label: 'In production' },
  action:     { cls: 's-action',     dot: 'var(--red)',   label: 'Needs action' },
};

export const FULFILLER = { you: 'Fulfilled by You', printify: 'Printify', gelato: 'Gelato', printful: 'Printful' };

/** The most urgent line-item status on an order. */
export function worst(items = []) {
  if (items.some((i) => i.status === 'action')) return 'action';
  if (items.some((i) => i.status === 'production')) return 'production';
  return 'shipped';
}

/** Case-insensitive "does any of these fields contain the query". */
export function matches(query, ...fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => String(f == null ? '' : f).toLowerCase().includes(q));
}
