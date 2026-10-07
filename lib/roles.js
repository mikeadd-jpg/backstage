// Roles and what each one can reach. The single source for both the server checks
// (lib/access.js) and the navigation, so a screen can never be shown to someone the
// server would refuse, or hidden from someone it would allow. Pure, no imports: the
// browser bundles this file too.
//
// An "area" is one screen plus the API routes behind it. Granting a role means listing
// its areas here; nothing else changes.

export const AREAS = {
  inbox:     'Inbox',
  risk:      'At risk',
  approvals: 'Approvals',
  products:  'Products',
  mockups:   'Mockups',
  profit:    'Profit',
  attribution: 'Attribution',
  settings:  'Settings',
  users:     'Users',
  // Approving a Claude (MCP) connection. That connection reads every inquiry and order
  // with no per-person identity, so it is held to the people who manage access.
  connect:   'Connect Claude',
};

export const ROLES = {
  owner: {
    label: 'Owner',
    description: 'Everything, including profit and attribution. Only an owner can make or change owners.',
    areas: ['inbox', 'risk', 'approvals', 'products', 'mockups', 'profit', 'attribution', 'settings', 'users', 'connect'],
  },
  admin: {
    label: 'Admin',
    description: 'Runs the tool: every screen except profit, plus settings and who can sign in.',
    areas: ['inbox', 'risk', 'approvals', 'products', 'mockups', 'settings', 'users', 'connect'],
  },
  support: {
    label: 'Support',
    description: 'Customer service: the inbox, at-risk orders and print approvals.',
    areas: ['inbox', 'risk', 'approvals'],
  },
  creative: {
    label: 'Creative',
    description: 'Builds products and lifestyle mockups. No customer data.',
    areas: ['products', 'mockups'],
  },
  // What every non-admin had before roles existed. Kept so nobody lost access the day
  // roles shipped; move people off it onto Support or Creative.
  member: {
    label: 'Member (legacy)',
    description: 'The old default: everything except profit and user management.',
    areas: ['inbox', 'risk', 'approvals', 'products', 'mockups', 'settings'],
  },
};

export const ROLE_ORDER = ['owner', 'admin', 'support', 'creative', 'member'];
export const DEFAULT_ROLE = 'support';

export function isRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

export function areasFor(role) {
  return isRole(role) ? ROLES[role].areas.slice() : [];
}

export function can(role, area) {
  return isRole(role) && ROLES[role].areas.includes(area);
}

/**
 * Whether `actorRole` may give `targetEmail` the role `newRole`, or remove them, given
 * their current role. Returns an error message, or null when allowed.
 *   - Managing users needs the users area at all.
 *   - Owner is only granted, changed or removed by an owner: profit sits behind it, and
 *     an admin who could mint owners could read profit by promoting themselves.
 *   - Nobody changes their own role, which blocks self-promotion and accidental lockout.
 */
export function roleChangeError({ actorEmail, actorRole, targetEmail, currentRole, newRole }) {
  if (!can(actorRole, 'users')) return 'Only an admin or owner can manage users.';
  if (newRole !== undefined && !isRole(newRole)) return 'Unknown role.';
  if (actorEmail && targetEmail && actorEmail === targetEmail) return "You can't change your own access.";
  const touchesOwner = newRole === 'owner' || currentRole === 'owner';
  if (touchesOwner && actorRole !== 'owner') return 'Only an owner can make or change an owner.';
  return null;
}
