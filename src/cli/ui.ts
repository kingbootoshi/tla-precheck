const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const CYAN = "\u001b[36m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const RED = "\u001b[31m";

const supportsColor = (): boolean => process.stdout.isTTY;

const style = (text: string, code: string): string =>
  supportsColor() ? `${code}${text}${RESET}` : text;

export const heading = (text: string): string => style(text, `${BOLD}${CYAN}`);

export const commandText = (text: string): string => style(text, `${BOLD}${CYAN}`);

export const statusLabel = (kind: "ok" | "warn" | "fail" | "step"): string => {
  const label =
    kind === "ok"
      ? "OK"
      : kind === "warn"
        ? "WARN"
        : kind === "fail"
          ? "FAIL"
          : "NEXT";
  const color =
    kind === "ok" ? GREEN : kind === "warn" ? YELLOW : kind === "fail" ? RED : CYAN;
  return style(`[${label}]`, `${BOLD}${color}`);
};
