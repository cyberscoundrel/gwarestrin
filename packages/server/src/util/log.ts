export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = process.env.GWARESTRIN_LOG === "debug" ? "debug" : "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function log(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (extra !== undefined) sink(line, extra);
  else sink(line);
}

export function scoped(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => log("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => log("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => log("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => log("error", scope, msg, extra),
  };
}
