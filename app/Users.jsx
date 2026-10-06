'use client';
// Who can sign in, and with which role. Opened from the account menu by admins and owners.
// The server enforces every rule shown here (app/api/users, lib/roles.js); the UI only
// avoids offering choices that would be refused: only owners see "Owner", and nobody can
// edit their own row or the permanent ADMIN_EMAIL owner.
import { useEffect, useState } from 'react';
import { ROLES, ROLE_ORDER, DEFAULT_ROLE } from '../lib/roles';

function ago(iso) {
  if (!iso) return 'Never signed in';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d === 0 ? 'Active today' : d === 1 ? 'Active yesterday' : 'Active ' + d + ' days ago';
}

export default function Users() {
  const [data, setData] = useState(null);   // { users, me, myRole }
  const [msg, setMsg] = useState({ text: '', bad: false });
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ email: '', role: DEFAULT_ROLE });
  const [query, setQuery] = useState('');

  function load() {
    return fetch('/api/users').then((r) => r.json()).then((d) => {
      if (d.error) throw new Error(d.error);
      setData(d);
    }).catch((e) => setMsg({ text: String(e.message || e), bad: true }));
  }
  useEffect(() => { load(); }, []);

  const roleChoices = data ? ROLE_ORDER.filter((r) => r !== 'owner' || data.myRole === 'owner') : [];

  async function save(email, role, label) {
    setBusy(email); setMsg({ text: '', bad: false });
    const d = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    }).then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    setBusy('');
    if (d.error) return setMsg({ text: d.error, bad: true });
    setMsg({ text: label, bad: false });
    load();
    return true;
  }
  async function add() {
    if (!draft.email.includes('@')) return setMsg({ text: 'Enter a Google email address.', bad: true });
    if (await save(draft.email.trim(), draft.role, draft.email.trim() + ' can now sign in as ' + ROLES[draft.role].label + '.')) {
      setDraft({ email: '', role: DEFAULT_ROLE });
    }
  }
  async function remove(u) {
    if (!window.confirm('Remove ' + u.email + "? They'll be signed out within a minute.")) return;
    setBusy(u.email);
    const d = await fetch('/api/users?email=' + encodeURIComponent(u.email), { method: 'DELETE' })
      .then((r) => r.json()).catch(() => ({ error: 'Request failed' }));
    setBusy('');
    if (d.error) return setMsg({ text: d.error, bad: true });
    setMsg({ text: u.email + ' removed.', bad: false });
    load();
  }

  const editable = (u) => data && u.email !== data.me && !u.bootstrap && (u.role !== 'owner' || data.myRole === 'owner');
  const shown = data ? data.users.filter((u) => !query || (u.email + ' ' + (u.name || '')).toLowerCase().includes(query.toLowerCase())) : [];
  const counts = {};
  if (data) for (const u of data.users) counts[u.role] = (counts[u.role] || 0) + 1;

  return (
    <div className="pane pane-wide">
      <div className="pane-head">Users</div>
      <p className="pane-sub">Anyone listed can sign in with that Google account. Their role decides which screens they see; changes apply within a minute.</p>

      <div className="users-layout">
        <div>
          <div className="card users-add">
            <div className="card-label">Add someone</div>
            <div className="users-add-row">
              <input className="input" type="email" placeholder="person@company.com" value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
              <select className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
                {roleChoices.map((r) => <option key={r} value={r}>{ROLES[r].label}</option>)}
              </select>
              <button className="btn btn-primary" onClick={add} disabled={busy === draft.email}>Add</button>
            </div>
          </div>

          {msg.text && <div className={msg.bad ? 'approve-error' : 'approve-done'}>{msg.text}</div>}

          <div className="users-list-head">
            <span>{data ? data.users.length + ' people' : 'Loading…'}</span>
            {data && data.users.length > 8 && (
              <input className="input users-search" placeholder="Find by name or email" value={query}
                onChange={(e) => setQuery(e.target.value)} />
            )}
          </div>
          <div className="users-list">
            {shown.map((u) => (
              <div className="users-row" key={u.email}>
                <div className="users-who">
                  <span className="users-avatar" aria-hidden="true">{(u.name || u.email)[0].toUpperCase()}</span>
                  <div className="users-id">
                    <div className="users-name">{u.name || u.email}{u.email === data.me && <span className="users-you">you</span>}</div>
                    <div className="users-sub">{u.name ? u.email + ' · ' : ''}{ago(u.last_seen)}</div>
                  </div>
                </div>
                {editable(u) ? (
                  <div className="users-actions">
                    <select className="input users-role" value={u.role} disabled={busy === u.email}
                      aria-label={'Role for ' + u.email}
                      onChange={(e) => save(u.email, e.target.value, u.email + ' is now ' + ROLES[e.target.value].label + '.')}>
                      {/* Keep a legacy or unknown role visible rather than silently rewriting it. */}
                      {!roleChoices.includes(u.role) && <option value={u.role}>{(ROLES[u.role] || { label: u.role }).label}</option>}
                      {roleChoices.map((r) => <option key={r} value={r}>{ROLES[r].label}</option>)}
                    </select>
                    <button className="btn btn-ghost users-remove" onClick={() => remove(u)} disabled={busy === u.email}>Remove</button>
                  </div>
                ) : (
                  <span className="users-fixed">
                    {(ROLES[u.role] || { label: u.role }).label}
                    {u.bootstrap ? ' · permanent' : ''}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <aside className="card users-roles">
          <div className="card-label">Roles</div>
          {ROLE_ORDER.map((r) => (
            <div key={r} className="users-role-def">
              <div className="users-role-name">{ROLES[r].label}<span>{counts[r] || 0}</span></div>
              <div className="users-role-desc">{ROLES[r].description}</div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
