import chalk from 'chalk';
import { getContext } from '../runtime/store';

const statusColor = (s: string) =>
  s === 'SUCCESS'
    ? chalk.green(s)
    : s === 'PARTIAL_SUCCESS' || s === 'ROLLED_BACK'
      ? chalk.yellow(s)
      : s === 'FAILED'
        ? chalk.red(s)
        : chalk.dim(s);

/** `history list` — recent migration runs. */
export async function listHistory(): Promise<void> {
  const ctx = await getContext();
  const runs = await ctx.history.list(ctx.scope);
  if (runs.length === 0) {
    console.log(chalk.dim('No migration runs recorded.'));
    return;
  }
  for (const r of runs) {
    const where = `${r.database ?? ''}/${r.schema ?? ''}`;
    console.log(
      `${chalk.dim(r.startedAt)}  ${statusColor(r.status.padEnd(11))} ${r.dialect} ${where}  ${chalk.dim(`${r.objectCount} obj · id ${r.id}`)}`
    );
  }
}

/** `history show <id>` — full record (results + script). */
export async function showHistory(id: string): Promise<void> {
  const ctx = await getContext();
  const run = await ctx.history.get(ctx.scope, id);
  if (!run) {
    console.error(chalk.red(`No migration run "${id}".`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.bold(`Run ${run.id}`));
  console.log(`  status    ${statusColor(run.status)}`);
  console.log(`  target    ${run.dialect}  ${run.host ?? ''}  ${run.database ?? ''} / ${run.schema ?? ''}`);
  console.log(`  started   ${run.startedAt}${run.finishedAt ? `   finished ${run.finishedAt}` : ''}`);
  if (run.error) console.log(`  ${chalk.red('error')}     ${run.error}`);
  if (run.results.length) {
    console.log('  results:');
    for (const o of run.results) console.log(`    ${statusColor(o.status)} ${o.action} ${o.type} ${o.name}`);
  }
  if (run.script) {
    console.log(chalk.dim('\n  --- script ---'));
    console.log(run.script);
  }
}
