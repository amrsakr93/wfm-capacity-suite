import type { IncomingMessage, ServerResponse } from 'node:http';

export type OtpChannel = 'outlook' | 'teams' | 'both';
export type AuthMode = 'power_automate' | 'demo' | 'unconfigured';

export interface AuthEnv {
  AUTH_MODE?: string;
  PA_SEND_OTP_URL?: string;
  PA_VERIFY_OTP_URL?: string;
  PA_SHARED_SECRET?: string;
  SESSION_SECRET?: string;
  NODE_ENV?: string;
}

export interface SessionPayload {
  email: string;
  mode: 'power_automate' | 'demo';
  iat: number;
  exp: number;
}

export interface ApiResponsePayload {
  status: number;
  body: Record<string, unknown>;
  cookies?: string[];
}

const SESSION_COOKIE_NAME = 'wfm_session';
const SESSION_TTL_SEC = 12 * 60 * 60; // 12 hours
const DEMO_OTP_TTL_SEC = 10 * 60; // 10 minutes
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Ephemeral fallback secret ONLY used when running explicit local/preview demo without SESSION_SECRET
let cachedDemoSecret: string | null = null;

export function resolveAuthMode(env: AuthEnv): AuthMode {
  const hasPaUrls = Boolean(env.PA_SEND_OTP_URL?.trim() && env.PA_VERIFY_OTP_URL?.trim());
  if (hasPaUrls && env.AUTH_MODE !== 'demo') {
    return 'power_automate';
  }
  if (env.AUTH_MODE === 'demo') {
    return 'demo';
  }
  return 'unconfigured';
}

function getSigningSecret(env: AuthEnv, mode: AuthMode): string {
  const explicit = env.SESSION_SECRET?.trim();
  if (explicit && explicit.length >= 16) return explicit;
  if (mode === 'power_automate') {
    throw new Error('SESSION_SECRET (>=16 chars) is required in power_automate mode.');
  }
  if (!cachedDemoSecret) {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    cachedDemoSecret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return cachedDemoSecret;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function signPayload<T extends object>(payload: T, secret: string): Promise<string> {
  const data = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return `${data}.${toBase64Url(new Uint8Array(sigBuf))}`;
}

export async function verifySignedPayload<T extends { exp: number }>(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<T | null> {
  if (!token || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const key = await importHmacKey(secret);
    const expectedBuf = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(data));
    const expectedBytes = new Uint8Array(expectedBuf);
    const actualBytes = fromBase64Url(sig);
    if (!timingSafeEqualBytes(actualBytes, expectedBytes)) {
      return null;
    }
    const parsed = JSON.parse(decoder.decode(fromBase64Url(data))) as T;
    if (typeof parsed.exp !== 'number' || parsed.exp < nowSec) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function buildCookieString(value: string, maxAgeSec: number, isHttps: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) parts.push('Secure');
  return parts.join('; ');
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed) || trimmed.length > 200) return null;
  return trimmed;
}

function normalizeChannel(raw: unknown): OtpChannel {
  if (raw === 'outlook' || raw === 'teams' || raw === 'both') return raw;
  return 'both';
}

function randomSixDigitCode(): string {
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

export async function handleRequestOtp(
  body: Record<string, unknown>,
  env: AuthEnv,
  fetchFn: typeof fetch = fetch
): Promise<ApiResponsePayload> {
  const mode = resolveAuthMode(env);
  if (mode === 'unconfigured') {
    return {
      status: 503,
      body: {
        error: 'AUTH_NOT_CONFIGURED',
        message:
          'Power Automate webhooks (PA_SEND_OTP_URL / PA_VERIFY_OTP_URL) are not configured and AUTH_MODE is not set to demo.',
      },
    };
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return {
      status: 400,
      body: { error: 'INVALID_EMAIL', message: 'Please enter a valid corporate email address.' },
    };
  }
  const channel = normalizeChannel(body.channel);

  if (mode === 'demo') {
    const secret = getSigningSecret(env, mode);
    const code = randomSixDigitCode();
    const now = Math.floor(Date.now() / 1000);
    const codeHash = await sha256Hex(`${email}:${code}`);
    const challengeToken = await signPayload(
      {
        email,
        codeHash,
        channel,
        exp: now + DEMO_OTP_TTL_SEC,
      },
      secret
    );
    return {
      status: 200,
      body: {
        sent: true,
        mode: 'demo',
        email,
        channel,
        expiresInSec: DEMO_OTP_TTL_SEC,
        challengeToken,
        demoCodePreview: code,
      },
    };
  }

  const sendUrl = env.PA_SEND_OTP_URL!.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.PA_SHARED_SECRET?.trim()) {
    headers['x-wfm-secret'] = env.PA_SHARED_SECRET.trim();
  }

  try {
    const paRes = await fetchFn(sendUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        email,
        channel,
        requestedAt: new Date().toISOString(),
        appName: 'WFM & Capacity Suite',
      }),
    });

    const text = await paRes.text();
    let parsed: Record<string, unknown> = {};
    try {
      if (text) parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw: text };
    }

    if (!paRes.ok || parsed.sent === false || parsed.authorized === false) {
      return {
        status: paRes.status >= 400 && paRes.status < 500 ? paRes.status : 403,
        body: {
          error: 'OTP_DELIVERY_REJECTED',
          message:
            (typeof parsed.message === 'string' && parsed.message) ||
            'Email not authorized or Power Automate rejected OTP request.',
        },
      };
    }

    return {
      status: 200,
      body: {
        sent: true,
        mode: 'power_automate',
        email,
        channel,
        expiresInSec: DEMO_OTP_TTL_SEC,
      },
    };
  } catch (err) {
    return {
      status: 502,
      body: {
        error: 'PA_UNREACHABLE',
        message: `Unable to reach Power Automate SendOTP endpoint: ${err instanceof Error ? err.message : 'Network error'}`,
      },
    };
  }
}

export async function handleVerifyOtp(
  body: Record<string, unknown>,
  env: AuthEnv,
  isHttps: boolean,
  fetchFn: typeof fetch = fetch
): Promise<ApiResponsePayload> {
  const mode = resolveAuthMode(env);
  if (mode === 'unconfigured') {
    return {
      status: 503,
      body: { error: 'AUTH_NOT_CONFIGURED', message: 'Authentication server is not configured.' },
    };
  }

  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!email || !/^[a-zA-Z0-9]{4,12}$/.test(code)) {
    return {
      status: 400,
      body: { error: 'INVALID_INPUT', message: 'Valid email and 4-12 character verification code required.' },
    };
  }

  let secret: string;
  try {
    secret = getSigningSecret(env, mode);
  } catch (err) {
    return {
      status: 503,
      body: { error: 'MISCONFIGURED_SECRET', message: err instanceof Error ? err.message : 'Missing SESSION_SECRET' },
    };
  }

  if (mode === 'demo') {
    const token = typeof body.challengeToken === 'string' ? body.challengeToken : '';
    const challenge = await verifySignedPayload<{ email: string; codeHash: string; exp: number }>(
      token,
      secret
    );
    if (!challenge || challenge.email !== email) {
      return {
        status: 401,
        body: { error: 'EXPIRED_OR_INVALID_CHALLENGE', message: 'OTP expired or invalid. Please request a new code.' },
      };
    }
    const candidateHash = await sha256Hex(`${email}:${code}`);
    if (!timingSafeEqualBytes(encoder.encode(candidateHash), encoder.encode(challenge.codeHash))) {
      return {
        status: 401,
        body: { error: 'CODE_MISMATCH', message: 'Incorrect verification code.' },
      };
    }
  } else {
    const verifyUrl = env.PA_VERIFY_OTP_URL!.trim();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.PA_SHARED_SECRET?.trim()) {
      headers['x-wfm-secret'] = env.PA_SHARED_SECRET.trim();
    }

    try {
      const paRes = await fetchFn(verifyUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ email, code }),
      });
      const text = await paRes.text();
      let parsed: Record<string, unknown> = {};
      try {
        if (text) parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const isValid =
        paRes.ok &&
        (parsed.authenticated === true || parsed.valid === true || parsed.verified === true);
      if (!isValid) {
        return {
          status: 401,
          body: {
            error: 'CODE_MISMATCH',
            message:
              (typeof parsed.message === 'string' && parsed.message) ||
              'Code does not match SharePoint List record or has expired.',
          },
        };
      }
    } catch (err) {
      return {
        status: 502,
        body: {
          error: 'PA_UNREACHABLE',
          message: `Unable to reach Power Automate VerifyOTP endpoint: ${err instanceof Error ? err.message : 'Network error'}`,
        },
      };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const session: SessionPayload = {
    email,
    mode,
    iat: now,
    exp: now + SESSION_TTL_SEC,
  };
  const cookieToken = await signPayload(session, secret);

  return {
    status: 200,
    body: {
      authenticated: true,
      email,
      mode,
      expiresAt: new Date(session.exp * 1000).toISOString(),
    },
    cookies: [buildCookieString(cookieToken, SESSION_TTL_SEC, isHttps)],
  };
}

export async function handleGetSession(
  cookieHeader: string | undefined | null,
  env: AuthEnv
): Promise<ApiResponsePayload> {
  const mode = resolveAuthMode(env);
  if (mode === 'unconfigured') {
    return {
      status: 200,
      body: { authenticated: false, mode: 'unconfigured' },
    };
  }
  let secret: string;
  try {
    secret = getSigningSecret(env, mode);
  } catch {
    return { status: 200, body: { authenticated: false, mode } };
  }

  const cookies = parseCookies(cookieHeader);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  const session = rawToken ? await verifySignedPayload<SessionPayload>(rawToken, secret) : null;

  if (!session) {
    return { status: 200, body: { authenticated: false, mode } };
  }
  return {
    status: 200,
    body: {
      authenticated: true,
      email: session.email,
      mode: session.mode,
      expiresAt: new Date(session.exp * 1000).toISOString(),
    },
  };
}

export function handleLogout(isHttps: boolean): ApiResponsePayload {
  return {
    status: 200,
    body: { authenticated: false },
    cookies: [buildCookieString('', 0, isHttps)],
  };
}

/**
 * Web-Standard Fetch Request/Response Dispatcher (Cloudflare Pages Functions / Workers)
 */
export async function dispatchWebAuthRoute(
  route: 'request-otp' | 'verify-otp' | 'session' | 'logout',
  request: Request,
  env: AuthEnv
): Promise<Response> {
  const url = new URL(request.url);
  const isHttps = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

  let result: ApiResponsePayload;
  try {
    if (route === 'session') {
      result = await handleGetSession(request.headers.get('cookie'), env);
    } else if (route === 'logout') {
      result = handleLogout(isHttps);
    } else if (request.method !== 'POST') {
      result = { status: 405, body: { error: 'METHOD_NOT_ALLOWED', message: 'Use POST' } };
    } else {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      result =
        route === 'request-otp'
          ? await handleRequestOtp(body, env)
          : await handleVerifyOtp(body, env, isHttps);
    }
  } catch (err) {
    result = {
      status: 400,
      body: { error: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Invalid request' },
    };
  }

  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (result.cookies) {
    for (const c of result.cookies) {
      headers.append('Set-Cookie', c);
    }
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers,
  });
}

async function readNodeJsonBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') {
    return req.body as Record<string, unknown>;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body) as Record<string, unknown>;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Node HTTP Dispatcher (Vercel Serverless Functions & Vite Dev Server middleware)
 */
export async function dispatchNodeAuthRoute(
  route: 'request-otp' | 'verify-otp' | 'session' | 'logout',
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  env: AuthEnv = process.env
): Promise<void> {
  const protoHeader = req.headers['x-forwarded-proto'];
  const isHttps = protoHeader === 'https' || env.NODE_ENV === 'production';

  let result: ApiResponsePayload;
  try {
    if (route === 'session') {
      result = await handleGetSession(req.headers.cookie, env);
    } else if (route === 'logout') {
      result = handleLogout(isHttps);
    } else if (req.method !== 'POST') {
      result = { status: 405, body: { error: 'METHOD_NOT_ALLOWED', message: 'Use POST' } };
    } else {
      const body = await readNodeJsonBody(req);
      result =
        route === 'request-otp'
          ? await handleRequestOtp(body, env)
          : await handleVerifyOtp(body, env, isHttps);
    }
  } catch (err) {
    result = {
      status: 400,
      body: { error: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Invalid JSON body' },
    };
  }

  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (result.cookies && result.cookies.length > 0) {
    res.setHeader('Set-Cookie', result.cookies);
  }
  res.end(JSON.stringify(result.body));
}
