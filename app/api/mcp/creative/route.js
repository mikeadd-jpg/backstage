// The creative MCP server: POST /api/mcp/creative (lib/mcpCreative.js).
//
// A second connection beside /api/mcp, on purpose. That one reads the inbox and orders
// with no per-person identity, so only an owner or admin may approve it. This one holds no
// customer data and acts as the person who approved it, so a Creative can connect too, and
// their role is re-read on every call: a removed or demoted person loses it at once.
//
// Two ways in, as for /api/mcp: a static MCP_CREATIVE_TOKEN for Claude Code (acting as
// ADMIN_EMAIL, the bootstrap owner), or an OAuth access token with the backstage:creative
// scope, which carries the approver's email. Unset MCP_CREATIVE_TOKEN closes that door.
// Exempt from the sign-in gate under /api/mcp in middleware.js.
import { NextResponse, after } from 'next/server';
import { listCreativeTools, callCreativeTool, CREATIVE_INSTRUCTIONS } from '../../../../lib/mcpCreative.js';
import { verifyAccessToken, baseUrl, CREATIVE_SCOPE, CREATIVE_PATH } from '../../../../lib/oauth.js';
import { findUser, bootstrapAdmin } from '../../../../lib/users.js';
import { areasFor } from '../../../../lib/roles.js';

export const dynamic = 'force-dynamic';
// A video sent to Meta is waited on for up to 90s inside create_meta_ad.
export const maxDuration = 300;

const SERVER_INFO = { name: 'backstage-creative', version: '1.0.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';

// Who is calling, with their current areas, or null.
async function caller(req) {
  const header = req.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!bearer) return null;
  let email = null;
  const staticToken = process.env.MCP_CREATIVE_TOKEN;
  if (staticToken && bearer === staticToken) email = bootstrapAdmin();
  else {
    const t = await verifyAccessToken(bearer);
    if (t && t.scope === CREATIVE_SCOPE) email = t.userEmail;
  }
  if (!email) return null;
  const user = await findUser(email);
  if (!user) return null;
  return { email: user.email, areas: areasFor(user.role), origin: new URL(req.url).origin };
}

function unauthorized(req, asJsonRpc) {
  const headers = { 'WWW-Authenticate': 'Bearer resource_metadata="' + baseUrl(req) + '/.well-known/oauth-protected-resource' + CREATIVE_PATH + '"' };
  const body = asJsonRpc ? { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } } : { error: 'unauthorized' };
  return NextResponse.json(body, { status: 401, headers });
}

const result = (id, r) => ({ jsonrpc: '2.0', id, result: r });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, who) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return result(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : DEFAULT_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: CREATIVE_INSTRUCTIONS + ' You are working as ' + who.email + '.',
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: listCreativeTools(who.areas) });
  if (method === 'tools/call') {
    const ctx = { ...who, after: (fn) => after(() => Promise.resolve().then(fn).catch((err) => console.error('[mcp creative] after', err))) };
    try {
      const data = await callCreativeTool(params && params.name, (params && params.arguments) || {}, ctx);
      return result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false });
    } catch (err) {
      // In band, so the model can read the failure and recover.
      return result(id, { content: [{ type: 'text', text: 'Error: ' + String(err.message || err) }], isError: true });
    }
  }
  return failure(id, -32601, 'Method not found: ' + method);
}

export async function POST(req) {
  const who = await caller(req);
  if (!who) return unauthorized(req, true);
  let body;
  try { body = await req.json(); } catch { return NextResponse.json(failure(null, -32700, 'Parse error'), { status: 400 }); }
  const isNotification = (m) => m && m.id === undefined;
  if (Array.isArray(body)) {
    const replies = [];
    for (const m of body) if (!isNotification(m)) replies.push(await handle(m, who));
    return replies.length ? NextResponse.json(replies) : new NextResponse(null, { status: 202 });
  }
  if (isNotification(body)) return new NextResponse(null, { status: 202 });
  return NextResponse.json(await handle(body, who));
}

export async function GET(req) {
  const who = await caller(req);
  if (!who) return unauthorized(req, false);
  return NextResponse.json({ server: SERVER_INFO, transport: 'Streamable HTTP, POST JSON-RPC to this URL', as: who.email, tools: listCreativeTools(who.areas).map((t) => t.name) });
}
