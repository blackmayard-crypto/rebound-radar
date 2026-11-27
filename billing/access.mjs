import { randomBytes, timingSafeEqual } from "node:crypto";

const TEST_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MEMBER = /^[a-z0-9_-]{1,40}$/;
const HASH = /^[a-f0-9]{64}$/;
const COOKIE = 'rr_sandbox_session';
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export async function hash(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function sandboxOrigin(value) {
  const url = new URL(value);
  if (url.href !== url.origin + '/' || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Configure a fixed HTTPS origin or local loopback origin');
  }
  return url.origin;
}

export function sessionToken(request) {
  const entry = request.headers.get('Cookie')?.split(/; */).find(part => part.startsWith(COOKIE + '='));
  const token = entry?.slice(COOKIE.length + 1);
  return TEST_TOKEN.test(token ?? '') ? token : null;
}

export function cookie(token, origin) {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_SECONDS : 0}${secure}`;
}

export async function signIn(db, testerHashes, token, now) {
  if (typeof token !== 'string' || !TEST_TOKEN.test(token)) return null;
  const digest = await hash(token);
  const entries = Object.entries(JSON.parse(testerHashes ?? '{}'));
  const match = entries.find(([member, expected]) => MEMBER.test(member) && HASH.test(expected) &&
    timingSafeEqual(encoder.encode(digest), encoder.encode(expected)));
  if (!match) return null;

  const [member] = match;
  const session = randomBytes(32).toString('base64url');
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO members (member_id) VALUES (?)').bind(member),
    db.prepare('DELETE FROM sessions WHERE expires <= ?').bind(now),
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(await hash(session), member, now + SESSION_SECONDS),
  ]);
  return session;
}

export async function getMember(db, testerHashes, token, now) {
  if (!token) return null;
  const member = await db.prepare(
    'SELECT members.* FROM sessions JOIN members USING (member_id) WHERE token_hash = ? AND expires > ?',
  ).bind(await hash(token), now).first();
  const testers = JSON.parse(testerHashes ?? '{}');
  return member && Object.hasOwn(testers, member.member_id) && HASH.test(testers[member.member_id]) ? member : null;
}
