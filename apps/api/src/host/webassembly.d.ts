/**
 * The subset of the WebAssembly JS API `host/quickjs.ts` uses. TypeScript only ships these
 * declarations in `lib.dom.d.ts`, which this Node-only package does not load.
 */
declare namespace WebAssembly {
  class Module {
    private constructor();
  }
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
    shared?: boolean;
  }
  class Memory {
    constructor(descriptor: MemoryDescriptor);
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  function compile(bytes: BufferSource): Promise<Module>;
}
