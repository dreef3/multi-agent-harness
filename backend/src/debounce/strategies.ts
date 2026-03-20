export type DebounceStrategy = "timer";

export interface DebounceConfig {
  strategy: DebounceStrategy;
  delayMs: number; // default 600000 (10 minutes)
}

export const defaultDebounceConfig: DebounceConfig = {
  strategy: "timer",
  delayMs: 10 * 60 * 1000, // 10 minutes
};
