declare module 'circomlibjs' {
  interface PoseidonField {
    toObject(a: Uint8Array): bigint;
    toString(a: Uint8Array, radix?: number): string;
  }
  interface Poseidon {
    (inputs: (bigint | number | string)[]): Uint8Array;
    F: PoseidonField;
  }
  export function buildPoseidon(): Promise<Poseidon>;
}
