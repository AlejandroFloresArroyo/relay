// Runs the browser scenario against every lab configuration and prints PASS/FAIL per check.
//   node src/matrix.ts [config…]      CHROMIUM=/path/to/chrome to pick the browser
import { runScenario, type Result } from './scenario.ts';
import { CONFIGS, startLab, type Config } from './lab.ts';

const executablePath = process.env.CHROMIUM ?? '/usr/bin/chromium';
const configs = (process.argv.length > 2 ? process.argv.slice(2) : [...CONFIGS]) as Config[];
const table = new Map<string, Record<string, string>>();

for (const config of configs) {
  let offset = 0;
  const lab = await startLab(config, { now: () => Date.now() + offset });
  let run: { browser: string; results: Result[] };
  try {
    run = await runScenario(lab, { executablePath, advanceClock: (ms) => { offset += ms; } });
  } finally {
    await lab.close();
  }
  console.log(`\n## ${config} (${executablePath}, ${run.browser})\n`);
  for (const r of run.results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(15)} ${r.label}\n      ${r.detail}`);
    const row = table.get(r.id) ?? { label: r.label };
    row[config] = r.pass ? 'PASS' : 'FAIL';
    table.set(r.id, row);
  }
}

console.log(`\n| Comprobación | ${configs.join(' | ')} |\n|---|${configs.map(() => '---').join('|')}|`);
for (const [id, row] of table) console.log(`| \`${id}\` ${row.label} | ${configs.map((c) => row[c] ?? '-').join(' | ')} |`);
