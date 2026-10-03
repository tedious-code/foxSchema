import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { AuthModule } from '../auth/auth.service';
import { newToken } from '../../platform/crypto/crypto';
import { readCookie, setSessionCookie } from '../auth/auth.routes';
import { authorizeUrl, fetchVerifiedEmail, newPkce, redirectUri } from './sso.service';
import { SignInSettings } from './sign-in-settings.service';
import { SsoBroker } from './sso-broker';
import { sendError } from '../../platform/http/respond';
import { setCookie, clearCookie } from '../../platform/http/reply';

const STATE_COOKIE = 'sso_state';
const STATE_PATH = '/api/auth/sso';

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * What the Fox sign-in service says when it sends someone back without an
 * assertion. Only these reach the sign-in page: the `error` query is in the
 * URL, so anyone can craft a link that carries their own words.
 */
const BROKER_ERRORS = new Set([
  'Too many sign-in attempts. Try again in a few minutes.',
  'That sign-in method is not available on the Fox sign-in service.',
  'That sign-in method is no longer available.',
  'Sign-in was cancelled.',
  'The provider sent no sign-in code.',
  'The provider did not accept the sign-in. Try again.',
  'Google did not return an email address.',
  'Google has not verified this email address.',
  'Your GitHub account has no verified primary email address.',
]);

export function brokerErrorMessage(error: string): string {
  return BROKER_ERRORS.has(error) ? error : 'The Fox sign-in service could not sign you in. Start the sign-in again.';
}

/** The callback path segment for sign-ins through the Fox sign-in service. */
export const BROKER_CALLBACK = 'broker';

/** SSO (OAuth2/OIDC) routes — mounted at /api/auth/sso. */
export function createSsoRoutes(
  auth: AuthModule,
  settings = new SignInSettings(),
  broker = new SsoBroker()
): Router {
  const router = Router();
  const secure = process.env.NODE_ENV === 'production';
  const stateCookie = (res: FastifyReply, value: string) =>
    setCookie(res, STATE_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: 10 * 60 * 1000,
      path: STATE_PATH,
    });

  /**
   * Providers the Fox sign-in service adds: only when an admin turned it on,
   * and only those this install has not configured itself (its own app wins).
   */
  const brokered = async () => {
    if (!(await settings.broker()).enabled) return [];
    const own = new Set((await settings.providers()).map((p) => p.id));
    return (await broker.providers()).filter((p) => !own.has(p.id));
  };

  // Which providers are configured (drives which buttons the login shows).
  router.get('/providers', async (_req: AppRequest, res: FastifyReply) => {
    const providers = await settings.providers();
    res.send({
      providers: [
        ...providers.map((p) => ({ id: p.id, label: p.label })),
        ...(await brokered()).map((p) => ({ id: p.id, label: p.label })),
      ],
    });
  });

  // Begin the flow: remember state + PKCE verifier in a short-lived cookie,
  // then send the browser to the provider.
  router.get('/:provider/start', async (req: AppRequest, res: FastifyReply) => {
    const id = String(req.params.provider);
    const provider = await settings.provider(id);
    if (!provider && (await brokered()).some((p) => p.id === id)) {
      // Through the Fox sign-in service: its assertion must come back carrying
      // this nonce, which only this browser holds.
      const nonce = newToken();
      stateCookie(res, `${nonce}.broker`);
      const { url } = await settings.publicUrl();
      res.redirect(broker.startUrl(id, redirectUri(req, BROKER_CALLBACK, url), nonce));
      return;
    }
    if (!provider) {
      // Plain text here would be the one error in the API a client cannot
      // parse; the SSO flow is reached from a browser redirect, but the
      // response is still ours to keep consistent.
      sendError(res, 'not_found', 'Unknown or unconfigured SSO provider');
      return;
    }
    const state = newToken();
    const pkce = newPkce();
    stateCookie(res, `${state}.${pkce.verifier}`);
    const { url } = await settings.publicUrl();
    res.redirect(authorizeUrl(provider, redirectUri(req, provider.id, url), state, pkce.challenge));
  });

  // The Fox sign-in service redirects back here with ?assertion&state.
  router.get(`/${BROKER_CALLBACK}/callback`, async (req: AppRequest, res: FastifyReply) => {
    try {
      if (!(await settings.broker()).enabled) throw new Error('The Fox sign-in service is turned off on this install.');
      const error = typeof req.query.error === 'string' ? req.query.error : '';
      const assertion = typeof req.query.assertion === 'string' ? req.query.assertion : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const [nonce = '', kind = ''] = (readCookie(req, STATE_COOKIE) ?? '').split('.');
      clearCookie(res, STATE_COOKIE, { path: STATE_PATH });
      if (error) throw new Error(brokerErrorMessage(error));
      if (!assertion || !state || !nonce || kind !== 'broker' || !sameText(state, nonce)) {
        throw new Error('Invalid or expired SSO state. Start the sign-in again.');
      }
      const { url } = await settings.publicUrl();
      const { email } = await broker.verify(assertion, {
        audience: redirectUri(req, BROKER_CALLBACK, url),
        nonce,
      });
      const { token } = await auth.loginWithEmail(email);
      setSessionCookie(res, token);
      res.redirect('/');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'SSO sign-in failed';
      res.redirect('/?sso_error=' + encodeURIComponent(message));
    }
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
