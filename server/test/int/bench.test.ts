/** Benchmark REST API (API_SPEC §3, TESTING §5 "bench upload without X-Bench-Token → 401"). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BENCH_MAX_RESULTS } from '@zkduel/shared/constants';
import { startTestServer, type TestServer } from '../support/testServer';

const TOKEN = 'bench-test-token';
let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer({ BENCH_TOKEN: TOKEN });
});
afterAll(async () => srv.stop());

const row = (sampleNo: number, proveMs: number, windowTicks = 60) => ({
  scheme: 'groth16',
  windowTicks,
  constraints: 32748,
  sampleNo,
  witnessMs: 50,
  proveMs,
  verifyMs: 9,
  proofBytes: 805,
  valid: true,
  peakMemMb: 400 + sampleNo,
});
const body = (results: unknown[]) => ({
  environment: 'node',
  deviceLabel: 'test laptop',
  cpuThreads: 12,
  inputLog: 'bench-seed42-2640t.jsonl',
  inputLogSha256: 'a'.repeat(64),
  seed: 42,
  results,
});
const post = (b: unknown, headers: Record<string, string> = { 'x-bench-token': TOKEN }) =>
  fetch(`${srv.baseUrl}/api/bench/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(b),
  });

describe('benchmark API', () => {
  it('upload without or with a wrong X-Bench-Token → 401; invalid body → 400', async () => {
    expect((await post(body([row(1, 1000)]), {})).status).toBe(401);
    expect((await post(body([row(1, 1000)]), { 'x-bench-token': 'nope' })).status).toBe(401);
    expect((await post(body([]))).status).toBe(400);
    expect((await post(body([{ ...row(1, 1000), windowTicks: 61 }]))).status).toBe(400);
    const tooMany = Array.from({ length: BENCH_MAX_RESULTS + 1 }, (_, i) => row(i + 1, 1));
    expect((await post(body(tooMany))).status).toBe(400);
  });

  it('upload → listed run, per-variant aggregates (p5/p50/p95, r_max) and a raw CSV', async () => {
    const results = [
      ...Array.from({ length: 20 }, (_, i) => row(i + 1, 1000 + i * 10)),
      ...Array.from({ length: 20 }, (_, i) => row(i + 1, 1500, 120)),
    ];
    const r = await post(body(results));
    expect(r.status).toBe(201);
    const { runId } = (await r.json()) as { runId: string };

    const list = (await (await fetch(`${srv.baseUrl}/api/bench/runs`)).json()) as {
      runs: { id: string; samples: number; environment: string }[];
    };
    expect(list.runs.find((x) => x.id === runId)).toMatchObject({
      samples: 40,
      environment: 'node',
    });

    const agg = (await (await fetch(`${srv.baseUrl}/api/bench/runs/${runId}`)).json()) as {
      run: { inputLogSha256: string };
      variants: {
        windowTicks: number;
        n: number;
        valid: number;
        proveMs: { mean: number; p5: number; p50: number; p95: number };
        playMs: number;
        rMax: number;
        peakMemMb: number;
      }[];
    };
    expect(agg.run.inputLogSha256).toBe('a'.repeat(64));
    const v60 = agg.variants.find((v) => v.windowTicks === 60);
    expect(v60).toMatchObject({ n: 20, valid: 20, playMs: 1000, peakMemMb: 420 });
    expect(v60?.proveMs.p5).toBe(1000);
    expect(v60?.proveMs.p50).toBe(1090);
    expect(v60?.proveMs.p95).toBe(1180);
    expect(v60?.proveMs.mean).toBeCloseTo(1095);
    expect(v60?.rMax).toBeCloseTo(1000 / 1095);
    expect(agg.variants.find((v) => v.windowTicks === 120)?.rMax).toBeCloseTo(2000 / 1500);

    const csv = await fetch(`${srv.baseUrl}/api/bench/runs/${runId}/csv`);
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    const lines = (await csv.text()).trim().split('\r\n');
    expect(lines).toHaveLength(41);
    expect(lines[0]).toBe(
      'run_id,environment,device_label,scheme,window_ticks,constraints,sample_no,witness_ms,prove_ms,verify_ms,proof_bytes,valid,peak_mem_mb',
    );
    expect(lines[1]).toBe(`${runId},node,test laptop,groth16,60,32748,1,50,1000,9,805,1,401`);

    expect((await fetch(`${srv.baseUrl}/api/bench/runs/nope`)).status).toBe(404);
  });
});
