import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Root test config. Everything here runs offline: tests exercise pure functions or the real
 * QuickJS runtime with hand-built fakes, and never open a socket to Postgres, Redis, an RPC
 * node, or Anthropic. Workspace packages are aliased to their sources so tests see the code in
 * the tree rather than a possibly stale `dist/`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@pyre/shared": fileURLToPath(new URL("packages/shared/src/index.ts", import.meta.url)),
      "@pyre/chain": fileURLToPath(new URL("packages/chain/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    watch: false,
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // `apps/api/src/env.ts` validates the whole environment at import time; these are syntactically
    // valid but unroutable/fake values. No test performs I/O with them.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://pyre:pyre@127.0.0.1:1/pyre_test?schema=public",
      REDIS_URL: "redis://127.0.0.1:1",
      WEB_ORIGIN: "https://pyre.test",
      API_ORIGIN: "https://api.pyre.test",
      APP_DOMAIN: "apps.pyre.test",
      INTERNAL_SECRET: "test-internal-secret",
      SESSION_SECRET: "test-session-secret",
      GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
      RPC_URL: "https://rpc.pyre.test",
      CHAIN_ID: "4663",
      PLATFORM_MASTER_SEED_HEX: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
      // Valid EIP-55 checksums of otherwise meaningless addresses; nothing is ever fetched from them.
      PYRE_TOKEN: "0x1111111111111111111111111111111111111111",
      USDG_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      PONS_FACTORY: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
      PONS_LAUNCH_AND_BUY: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
      PONS_FEE_ESCROW: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
      PONS_MEME_HOOK: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
      UNIV4_POOL_MANAGER: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      UNIV4_UNIVERSAL_ROUTER: "0x8876789976dEcBfCbBbe364623C63652db8C0904",
      UNIV4_QUOTER: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94",
      UNIV4_STATE_VIEW: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
      BLOCKSCOUT_URL: "https://explorer.pyre.test",
      GECKOTERMINAL_URL: "https://gecko.pyre.test/api/v2",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GITHUB_WEBHOOK_SECRET: "test-github-secret",
      // Runner-only requirements (apps/runner/src/env.ts).
      E2B_API_KEY: "e2b-test",
      GITHUB_TOKEN: "ghp-test",
      GITHUB_OWNER: "pyre-test",
    },
  },
});
