import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AuthModule } from '../auth/auth.service';
import { newToken } from '../../platform/crypto/crypto';
import { readCookie, setSessionCookie } from '../auth/auth.routes';
import { authorizeUrl, fetchVerifiedEmail, newPkce, redirectUri } from './sso.service';
import { SignInSettings } from './sign-in-settings.service';
import { sendError } from '../../platform/http/respond';
import { setCookie, clearCookie } from '../../platform/http/reply';

const STATE_COOKIE = 'sso_state';
const STATE_PATH = '/api/auth/sso';

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** SSO (OAuth2/OIDC) routes — mounted at /api/auth/sso. */
export function createSsoRoutes(auth: AuthModule, settings = new SignInSettings()): Router {
  const router = Router();
  const secure = process.env.NODE_ENV === 'production';

  // Which providers are configured (drives which buttons the login shows).
  router.get('/providers', async (_req: AppRequest, res: FastifyReply) => {
    const providers = await settings.providers();
    res.send({ providers: providers.map((p) => ({ id: p.id, label: p.label })) });
  });

  // Begin the flow: remember state + PKCE verifier in a short-lived cookie,
  // then send the browser to the provider.
  router.get('/:provider/start', async (req: AppRequest, res: FastifyReply) => {
    const provider = await settings.provider(String(req.params.provider));
    if (!provider) {
      // Plain text here would be the one error in the API a client cannot
      // parse; the SSO flow is reached from a browser redirect, but the
      // response is still ours to keep consistent.
      sendError(res, 'not_found', 'Unknown or unconfigured SSO provider');
      return;
    }
    const state = newToken();
    const pkce = newPkce();
    setCookie(res, STATE_COOKIE, `${state}.${pkce.verifier}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 10 * 60 * 1000,
      path: STATE_PATH,
    });
    const { url } = await settings.publicUrl();
    res.redirect(authorizeUrl(provider, redirectUri(req, provider.id, url), state, pkce.challenge));
  });

  // Provider redirects back here with ?code&state.
  router.get('/:provider/callback', async (req: AppRequest, res: FastifyReply) => {
    try {
      const provider = await settings.provider(String(req.params.provider));
      if (!provider) throw new Error('Unknown SSO provider');

      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const [expected = '', verifier = ''] = (readCookie(req, STATE_COOKIE) ?? '').split('.');
      clearCookie(res, STATE_COOKIE, { path: STATE_PATH });
      if (!code || !state || !expected || !verifier || !sameText(state, expected)) {
        throw new Error('Invalid or expired SSO state. Start the sign-in again.');
      }

      const { url } = await settings.publicUrl();
      const email = await fetchVerifiedEmail(provider, code, redirectUri(req, provider.id, url), verifier);
      const { token } = await auth.loginWithEmail(email);
      setSessionCookie(res, token);
      res.redirect('/');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'SSO sign-in failed';
      res.redirect('/?sso_error=' + encodeURIComponent(message));
    }
  });

  return router;
}
