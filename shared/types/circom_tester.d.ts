declare module 'circom_tester' {
  export interface WasmTesterOptions {
    include?: string | string[];
    output?: string;
    recompile?: boolean;
    templateName?: string;
    templateParams?: (number | string | bigint)[];
    templatePublicSignals?: string[];
    O?: 0 | 1 | 2;
  }
  export interface WasmTester {
    symbols: Record<string, { labelIdx: number; varIdx: number; componentIdx: number }>;
    calculateWitness(input: Record<string, unknown>, sanityCheck?: boolean): Promise<bigint[]>;
    checkConstraints(witness: bigint[]): Promise<void>;
    assertOut(witness: bigint[], expected: Record<string, unknown>): Promise<void>;
    loadSymbols(): Promise<void>;
    loadConstraints(): Promise<void>;
    release(): Promise<void>;
  }
  const tester: { wasm(path: string, options?: WasmTesterOptions): Promise<WasmTester> };
  export default tester;
}
