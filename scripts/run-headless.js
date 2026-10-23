#!/usr/bin/env node
// Headless runner: simulate a scenario without the 3D view and print KPIs.
//   node scripts/run-headless.js --scenario highway --minutes 10 --ttt 160 --hys 1
import { Simulation, SCENARIO_IDS } from '../src/sim/index.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : (all[i + 1] ?? true)]);
    return acc;
  }, []),
);

if (args.help) {
  console.log(`Usage: node scripts/run-headless.js [options]
  --scenario <${SCENARIO_IDS.join('|')}>   (default urban)
  --minutes <n>     simulated minutes (default 5)
  --ues <n>         number of UEs
  --seed <n>        random seed
  --ttt <ms>        time-to-trigger
  --hys <dB>        hysteresis
  --offset <dB>     A3 offset
  --mlb             enable mobility load balancing
  --json            print the final KPIs as JSON`);
  process.exit(0);
}

const params = {};
if (args.ttt !== undefined) params.tttMs = Number(args.ttt);
if (args.hys !== undefined) params.hysteresisDb = Number(args.hys);
if (args.offset !== undefined) params.a3OffsetDb = Number(args.offset);
if (args.mlb) params.mlbEnabled = true;

const sim = new Simulation({
  scenario: args.scenario ?? 'urban',
  seed: args.seed !== undefined ? Number(args.seed) : undefined,
  ueCount: args.ues !== undefined ? Number(args.ues) : undefined,
  params,
});

const minutes = Number(args.minutes ?? 5);
const started = performance.now();
for (let m = 1; m <= minutes; m++) {
  sim.run(60_000);
  if (!args.json) {
    const k = sim.kpis();
    console.log(
      `t=${String(m).padStart(3)} min  HO ${String(k.success).padStart(5)}  ` +
        `succ ${(k.successRate * 100).toFixed(1).padStart(5)}%  ping-pong ${(k.pingPongRate * 100).toFixed(1).padStart(4)}%  ` +
        `RLF ${String(k.rlf).padStart(4)}  avg DL ${k.avgThroughput.toFixed(0).padStart(5)} Mbps  SINR ${k.avgSinr.toFixed(1)} dB`,
    );
  }
}
const k = sim.kpis();
if (args.json) {
  console.log(JSON.stringify(k, null, 2));
} else {
  console.log(`\n${sim.scenario.name} · ${k.ues} UEs · ${k.towers} cells · ${((performance.now() - started) / 1000).toFixed(1)} s wall time`);
  console.log('Handovers by type:', k.byType);
  console.log('RLF causes:       ', k.causes);
  console.log('Users per layer:  ', k.share);
}
