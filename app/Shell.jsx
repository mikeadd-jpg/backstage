'use client';
// The app frame: a grouped sidebar on desktop (an icon rail on tablets), a slim title bar
// and bottom tabs on phones, a Create chooser, and an account menu that holds Settings,
// Users and Sign out. Everything shown is filtered by the person's role (lib/roles.js);
// the server enforces the same rules route by route, so this filtering is about
// clutter, not security.

import { useEffect, useRef, useState } from 'react';
import { ROLES } from '../lib/roles';

// Line icons, 24px grid, drawn with currentColor so they follow the text colour.
const PATHS = {
  home: ['M3 11 12 4l9 7', 'M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9'],
  work: ['M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3'],
  inbox: ['M4 13h4l1.5 3h5L16 13h4', 'M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'],
  risk: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  approvals: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'm8.5 12.5 2.5 2.5 5-5'],
  products: ['M15 4l6 2v5h-3v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-8H3V6l6-2a3 3 0 0 0 6 0'],
  mockups: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'm4 16 4-4a2 2 0 0 1 3 0l5 5', 'm14 14 1-1a2 2 0 0 1 3 0l2 2', 'M15 8h.01'],
  profit: ['M4 20h16', 'M7 16v-4', 'M12 16V8', 'M17 16v-6'],
  attribution: ['M10 3.2A9 9 0 1 0 20.8 14H10z', 'M14 3.3A9 9 0 0 1 20.7 10H14z'],
  email: ['M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'm3.5 7 8.5 6 8.5-6'],
  traffic: ['M3 12h4l3-8 4 16 3-8h4'],
  insights: ['M4 20h16', 'M7 16v-4', 'M12 16V8', 'M17 16v-6'],
  create: ['M12 5v14', 'M5 12h14'],
  settings: ['M4 6h8', 'M16 6h4', 'M14 4v4', 'M4 12h4', 'M12 12h8', 'M10 10v4', 'M4 18h11', 'M19 18h1', 'M17 16v4'],
  users: ['M5 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0', 'M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M16 3.1a4 4 0 0 1 0 7.8', 'M21 21v-2a4 4 0 0 0-3-3.9'],
  logout: ['M14 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2', 'M9 12h12l-3-3', 'm18 15 3-3'],
  chevron: ['m9 6 6 6-6 6'],
};
export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ico">
      {(PATHS[name] || []).map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// Every destination, grouped the way the work divides. `area` must match lib/roles.js.
export const DESTINATIONS = {
  // First, so it is where people land; anyone without it starts on their first screen.
  home:      { area: 'home',      label: 'Home',      icon: 'home',      group: 'Start' },
  inbox:     { area: 'inbox',     label: 'Inbox',     icon: 'inbox',     group: 'Work', blurb: 'Customer emails and drafted replies' },
  risk:      { area: 'risk',      label: 'At risk',   icon: 'risk',      group: 'Work', blurb: 'Orders that may not arrive' },
  approvals: { area: 'approvals', label: 'Approvals', icon: 'approvals', group: 'Work', blurb: 'Print files waiting for a yes' },
  products:  { area: 'products',  label: 'Products',  icon: 'products',  group: 'Create', blurb: 'Printify drafts from a design' },
  mockups:   { area: 'mockups',   label: 'Mockups',   icon: 'mockups',   group: 'Create', blurb: 'Lifestyle shots for a live product' },
  profit:    { area: 'profit',    label: 'Profit',    icon: 'profit',    group: 'Insights', blurb: 'Revenue, costs and margin' },
  attribution: { area: 'attribution', label: 'Attribution', icon: 'attribution', group: 'Insights', blurb: 'Where revenue comes from' },
  email:     { area: 'email',     label: 'Email',     icon: 'email',     group: 'Insights', blurb: 'List growth, flows and campaigns' },
  traffic:   { area: 'traffic',   label: 'Traffic',   icon: 'traffic',   group: 'Insights', blurb: 'Sessions and how well they convert' },
  // Account-menu destinations: reachable, but not worth a permanent slot.
  settings:  { area: 'settings',  label: 'Settings',  icon: 'settings',  group: 'Account' },
  users:     { area: 'users',     label: 'Users',     icon: 'users',     group: 'Account' },
};
const GROUPS = ['Start', 'Work', 'Create', 'Insights'];
const UNLABELLED = ['Start'];

/** Destinations this person may open, in menu order. */
export function allowedDestinations(me) {
  if (!me) return [];
  return Object.keys(DESTINATIONS).filter((k) => me.areas.includes(DESTINATIONS[k].area));
}

function signOut() {
  fetch('/api/auth/logout', { method: 'POST' }).finally(() => { window.location.href = '/login'; });
}

function initial(me) {
  return ((me && (me.name || me.email)) || '?')[0].toUpperCase();
}

/** Account menu: who you are, then Settings / Users / Sign out. */
function AccountMenu({ me, allowed, go, onClose, placement }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [onClose]);
  return (
    <div className={'acct-menu ' + placement} ref={ref} role="menu">
      <div className="acct-who">
        <div className="acct-name">{me.name || me.email}</div>
        <div className="acct-sub">{me.name ? me.email + ' · ' : ''}{(ROLES[me.role] || { label: me.role }).label}</div>
      </div>
      {['settings', 'users'].filter((k) => allowed.includes(k)).map((k) => (
        <button key={k} role="menuitem" className="acct-item" onClick={() => { go(k); onClose(); }}>
          <Icon name={DESTINATIONS[k].icon} />{DESTINATIONS[k].label}
        </button>
      ))}
      <button role="menuitem" className="acct-item" onClick={signOut}><Icon name="logout" />Sign out</button>
    </div>
  );
}

/** Bottom sheet on phones: choose between the screens a folded tab stands for. */
function ChooserSheet({ title, keys, go, onClose, badges = {} }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{title}</div>
        {keys.map((k) => (
          <button key={k} className="sheet-option" onClick={() => { go(k); onClose(); }}>
            <span className="sheet-icon"><Icon name={DESTINATIONS[k].icon} size={20} /></span>
            <span><b>{DESTINATIONS[k].label}</b><small>{DESTINATIONS[k].blurb}</small></span>
            {badges[k] > 0 && <span className="bn-badge sheet-badge">{badges[k]}</span>}
            <Icon name="chevron" size={16} />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Shell({ me, current, go, badges = {}, children }) {
  const [menu, setMenu] = useState(null);       // null | 'side' | 'top'
  const [chooser, setChooser] = useState(null);  // null | 'work' | 'create' | 'insights'
  const allowed = allowedDestinations(me);
  const createKeys = ['products', 'mockups'].filter((k) => allowed.includes(k));

  // Bottom tabs on phones, five at most: Work screens, then Create and Insights. A group
  // with several screens folds into one tab that opens a chooser, but only when there are
  // other tabs beside it: a Creative's only tab would otherwise be Create, and a lone tab
  // hides the bar, leaving no way between Products and Mockups.
  const insightKeys = ['profit', 'attribution', 'email', 'traffic'].filter((k) => allowed.includes(k));
  const homeTab = allowed.includes('home') ? [{ key: 'home', ...DESTINATIONS.home }] : [];
  const workKeys = ['inbox', 'risk', 'approvals'].filter((k) => allowed.includes(k));
  const groupTabs = (keys, fold) => (keys.length > 1 && fold ? [fold] : keys.map((k) => ({ key: k, ...DESTINATIONS[k] })));
  const others = (n) => homeTab.length + workKeys.length + n > 0;
  const tail = [
    ...groupTabs(createKeys, others(insightKeys.length) ? { key: 'create', label: 'Create', icon: 'create' } : null),
    ...groupTabs(insightKeys, others(createKeys.length) ? { key: 'insights', label: 'Insights', icon: 'insights' } : null),
  ];
  // Home plus three Work screens plus Create and Insights is six; past five, Work folds
  // too. Home already lists whatever in Work needs attention, and the fold keeps a badge.
  const workFolds = homeTab.length + workKeys.length + tail.length > 5 && workKeys.length > 1;
  const workTabs = workFolds ? [{ key: 'work', label: 'Work', icon: 'work' }] : workKeys.map((k) => ({ key: k, ...DESTINATIONS[k] }));
  const tabs = [...homeTab, ...workTabs, ...tail];
  const FOLDS = { work: { title: 'Work', keys: workKeys }, create: { title: 'Create', keys: createKeys }, insights: { title: 'Insights', keys: insightKeys } };
  const title = (DESTINATIONS[current] || {}).label || 'Backstage';

  return (
    <div className="frame">
      <aside className="side" aria-label="Main">
        <div className="side-brand">
          <span className="wordmark">Backstage</span>
          <span className="wordmark-mini" aria-hidden="true">B</span>
        </div>
        <nav className="side-nav">
          {GROUPS.map((g) => {
            const items = allowed.filter((k) => DESTINATIONS[k].group === g);
            if (!items.length) return null;
            return (
              <div className="side-group" key={g}>
                {!UNLABELLED.includes(g) && <div className="side-label">{g}</div>}
                {items.map((k) => (
                  <button key={k} className={'side-item' + (current === k ? ' on' : '')}
                    aria-current={current === k ? 'page' : undefined} title={DESTINATIONS[k].label}
                    onClick={() => go(k)}>
                    <Icon name={DESTINATIONS[k].icon} />
                    <span className="side-text">{DESTINATIONS[k].label}</span>
                    {badges[k] > 0 && <span className="side-badge">{badges[k]}</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        {me && (
          <div className="side-foot">
            <button className={'side-acct' + (['settings', 'users'].includes(current) ? ' on' : '')}
              aria-haspopup="menu" aria-expanded={menu === 'side'} title={me.email}
              onClick={() => setMenu((m) => (m === 'side' ? null : 'side'))}>
              <span className="avatar">{initial(me)}</span>
              <span className="side-text side-acct-text">
                <b>{me.name || me.email}</b>
                <small>{(ROLES[me.role] || { label: me.role }).label}</small>
              </span>
            </button>
            {menu === 'side' && <AccountMenu me={me} allowed={allowed} go={go} onClose={() => setMenu(null)} placement="up" />}
          </div>
        )}
      </aside>

      <div className="main">
        <header className="mtop">
          <span className="mtop-title">{title}</span>
          {me && (
            <div className="mtop-acct">
              <button className="avatar avatar-btn" aria-label="Account" aria-haspopup="menu" aria-expanded={menu === 'top'}
                onClick={() => setMenu((m) => (m === 'top' ? null : 'top'))}>{initial(me)}</button>
              {menu === 'top' && <AccountMenu me={me} allowed={allowed} go={go} onClose={() => setMenu(null)} placement="down" />}
            </div>
          )}
        </header>
        <div className="view">{children}</div>
        {tabs.length > 1 && (
          <nav className="bottom-nav" aria-label="Main">
            {tabs.map((t) => {
              const on = FOLDS[t.key] ? FOLDS[t.key].keys.includes(current) : current === t.key;
              const n = FOLDS[t.key] ? FOLDS[t.key].keys.reduce((sum, k) => sum + (badges[k] || 0), 0) : badges[t.key] || 0;
              return (
                <button key={t.key} className={'bn-item' + (on ? ' active' : '')} aria-current={on ? 'page' : undefined}
                  onClick={() => (FOLDS[t.key] ? setChooser(t.key) : go(t.key))}>
                  <Icon name={t.icon} size={21} />
                  <span className="bn-label">{t.label}</span>
                  {n > 0 && <span className="bn-badge">{n}</span>}
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {chooser && <ChooserSheet title={FOLDS[chooser].title} keys={FOLDS[chooser].keys} go={go} badges={badges} onClose={() => setChooser(null)} />}
    </div>
  );
}
