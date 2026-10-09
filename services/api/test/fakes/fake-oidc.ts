// Local fake OpenID Connect provider for tests (stands in for Entra ID / AD FS): discovery, JWKS, an /authorize
// endpoint that "signs in" the configured next user and redirects back with a code, and a /token endpoint that
// checks client id/secret, redirect_uri and the PKCE verifier and returns an RS256 ID token. Knobs let a test break
// the token (wrong nonce, wrong audience, expired, other issuer) to prove TenderFlow refuses it.
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';

export interface FakeUser { sub: string; username: string; name?: string; groups?: string[]; extraClaims?: Record<string, unknown> }
export interface FakeOidcKnobs { nonce?: string; audience?: string; expired?: boolean; issuer?: string; signWithOtherKey?: boolean; tokenError?: string; omitIdToken?: boolean }

export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  nextUser: FakeUser;
  knobs: FakeOidcKnobs;
  lastAuthorize: URLSearchParams | null;
  lastToken: URLSearchParams | null;
  stop(): Promise<void>;
}

export async function startFakeOidc(opts: { clientId?: string; clientSecret?: string } = {}): Promise<FakeOidc> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; user: FakeUser; clientId: string }>();
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tenant-x/v2.0`;
  const state: FakeOidc = {
    issuer, clientId: opts.clientId ?? 'tenderflow-client', clientSecret: opts.clientSecret ?? 'fake-secret-123',
    nextUser: { sub: 'sub-1', username: 'ahmed@moi.example', name: 'Ahmed (directory)', groups: [] },
    knobs: {}, lastAuthorize: null, lastToken: null,
    async stop() { await new Promise<void>((r) => server.close(() => r())); },
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const p = url.pathname.replace('/tenant-x/v2.0', '');
    if (req.method === 'GET' && p === '/.well-known/openid-configuration') {
      return json(res, 200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`,
        response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
    }
    if (req.method === 'GET' && p === '/keys') return json(res, 200, { keys: [jwk] });
    if (req.method === 'GET' && p === '/authorize') {
      const q = url.searchParams;
      state.lastAuthorize = q;
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: q.get('nonce') ?? '', challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', user: state.nextUser, clientId: q.get('client_id') ?? '' });
      const back = new URL(q.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && p === '/token') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const f = new URLSearchParams(raw);
        state.lastToken = f;
        if (state.knobs.tokenError) return json(res, 400, { error: state.knobs.tokenError, error_description: 'fake provider refused' });
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        if (!c) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown or used code' });
        if (f.get('client_id') !== state.clientId || f.get('client_secret') !== state.clientSecret) return json(res, 401, { error: 'invalid_client' });
        if (f.get('redirect_uri') !== c.redirectUri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        const verifier = f.get('code_verifier') ?? '';
        if (crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        if (state.knobs.omitIdToken) return json(res, 200, { access_token: 'x', token_type: 'Bearer' });
        const nowS = Math.floor(Date.now() / 1000);
        const iat = state.knobs.expired ? nowS - 7200 : nowS;
        const key: KeyLike = state.knobs.signWithOtherKey ? other.privateKey : privateKey;
        const idToken = await new SignJWT({ nonce: state.knobs.nonce ?? c.nonce, preferred_username: c.user.username, name: c.user.name, groups: c.user.groups, ...(c.user.extraClaims ?? {}) })
          .setProtectedHeader({ alg: 'RS256', kid: 'fake-1' })
          .setIssuer(state.knobs.issuer ?? issuer).setSubject(c.user.sub).setAudience(state.knobs.audience ?? state.clientId)
          .setIssuedAt(iat).setExpirationTime(iat + 3600)
          .sign(key);
        return json(res, 200, { access_token: 'x', token_type: 'Bearer', id_token: idToken });
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });
  return state;
}
