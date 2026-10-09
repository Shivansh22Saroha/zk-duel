declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export interface R1csInfo {
    nConstraints: number;
    nPubInputs: number;
    nPrvInputs: number;
    nOutputs: number;
    nVars: number;
    nLabels: number;
  }
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    prove(
      zkey: string | Uint8Array,
      witness: string | Uint8Array,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const wtns: {
    calculate(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      out: string | { type: 'mem'; data?: Uint8Array },
    ): Promise<void>;
  };
  export const r1cs: {
    info(file: string, logger?: unknown): Promise<R1csInfo>;
  };
  export const zKey: {
    newZKey(r1cs: string, ptau: string, zkey: string, logger?: unknown): Promise<unknown>;
    contribute(
      oldZkey: string,
      newZkey: string,
      name: string,
      entropy: string,
      logger?: unknown,
    ): Promise<unknown>;
    exportVerificationKey(zkey: string): Promise<unknown>;
    verifyFromR1cs(r1cs: string, ptau: string, zkey: string, logger?: unknown): Promise<boolean>;
  };
}
