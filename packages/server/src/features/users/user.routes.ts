import type { FastifyReply } from 'fastify';
import type { AppRequest } from '../../platform/http/types';
import { Router } from '../../platform/http/router';
import { UserModule, UserPreferences } from './user.service';
import type { AuthedRequest } from '../../platform/http/types';

/** The signed-in user's preferences / onboarding state. */
export function createUserRoutes(user: UserModule): Router {
  const router = Router();

  router.get('/preferences', async (req: AuthedRequest, res: FastifyReply) => {
    res.send({ preferences: await user.getPreferences(req.userId!) });
  });

  router.put('/preferences', async (req: AuthedRequest, res: FastifyReply) => {
    const { role, primaryDatabase, primaryGoal, theme, onboardingCompleted } = req.body as Partial<UserPreferences>;
    res.send({
      preferences: await user.updatePreferences(req.userId!, {
        role,
        primaryDatabase,
        primaryGoal,
        theme,
        onboardingCompleted,
      }),
    });
  });

  return router;
}
