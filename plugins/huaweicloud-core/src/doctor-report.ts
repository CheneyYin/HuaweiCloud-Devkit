// The doctor reporter contract: the interface every extracted doctor section
// emits through. The cmdDoctor shell owns the counters and the exact line
// formats (single source for the [PASS]/[FAIL]/[WARN]/[INFO]/[SKIP] escape
// shapes); the sections in src/doctor-payload.ts, src/doctor-native.ts, and
// the per-agent modules call these methods so a moved section prints exactly
// what it printed inline. A leaf module by design: no imports, so every
// section module can depend on it without cycles.

export interface DoctorReporter {
  /** The check() helper: [PASS]/[FAIL] with the pass/fail counters. */
  check(label: string, ok: boolean, msg: string): void;
  /** A raw [PASS] line (counted) — the dependency-availability shape. */
  pass(line: string): void;
  /** A [WARN] line (counted). */
  warn(line: string): void;
  /** An [INFO] line (uncounted). */
  info(line: string): void;
  /** A [SKIP] line (uncounted). */
  skip(line: string): void;
}
