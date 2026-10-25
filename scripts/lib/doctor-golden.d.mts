// Type declarations for the doctor golden harness, so test/doctor-golden.test.ts
// can import the .mjs module with full typing (the repo's sibling-declaration
// pattern; see scripts/lib/pack-boundaries.d.mts). Hand-maintained like the
// module itself.

export declare const root: string;
export declare const setupCli: string;
export declare const goldenFixturesDir: string;
export declare const fakeHcloud: string;

export declare function doctorGoldenEnv(home: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
export declare function installGoldenEnv(home: string): NodeJS.ProcessEnv;
export declare function runGoldenDoctor(home: string, extra?: Record<string, string>): string;
export declare function runGoldenInstall(home: string): void;
export declare function stageHermesOfficeaceMarkers(home: string): { OFFICE_CLAW_CONFIG_ROOT: string };
export declare function normalizeGoldenOutput(text: string): string;

export declare const goldenNames: {
  empty: string;
  opencodeInstall: string;
  hermesOfficeace: string;
};

export declare function captureEmptyHome(home: string): string;
export declare function captureOpencodeInstall(home: string): string;
export declare function captureHermesOfficeace(home: string): string;
