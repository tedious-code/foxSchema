import chalk from 'chalk';
import { AuthModule } from '@foxschema/server';
import { getStore } from '@foxschema/server';
import { requireReady } from '../runtime/bootstrap';
import { friendlyError } from '../format/friendlyError';
import { DEFAULT_UI_PORT } from '../runtime/paths';

/**
 * `foxschema reset-password [email]` — a one-time reset code for an account,
 * printed here.
 *
 * For an owner locked out of an install with no email set up. Whoever can
 * run this already holds the metadata database and the keychain key, so it
 * gives them nothing new; it only saves them editing the database by hand.
 * Without an email it resets the install owner, the account the CLI acts as.
 */
export async function runResetPassword(email?: string): Promise<void> {
  try {
    requireReady();
    const auth = new AuthModule();
    const target = (email ?? '').trim().toLowerCase() || (await auth.ownerAccount()).email;
    const store = await getStore();
    const row = await store.get<{ id: string }>('SELECT id FROM users WHERE email = ?', [target]);
    if (!row) {
      console.error(chalk.red(`No account for ${target}.`));
      process.exitCode = 1;
      return;
    }
    const issued = await auth.issueCode(row.id, 'reset');
    const link = `http://127.0.0.1:${process.env.FOXSCHEMA_PORT || DEFAULT_UI_PORT}/#reset=${issued.code}`;
    console.log(`Reset code for ${chalk.bold(issued.email)}: ${chalk.bold.cyan(issued.code)}`);
    console.log(`Valid until ${new Date(issued.expiresAt).toLocaleTimeString()}, once.`);
    console.log(`Open ${link} — or choose "Forgot password?" → "I have a code" on the sign-in page.`);
  } catch (err) {
    console.error(chalk.red(friendlyError(err)));
    process.exitCode = 1;
  }
}
