const LOCAL_PATH_START = "(?:file:\\/\\/\\/|[A-Za-z]:[\\\\/]|\\/|\\\\\\\\\\?\\\\[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\\\/\\s'\"\\x60<>]+\\\\[^\\\\\\/\\s'\"\\x60<>]+[\\\\/]?)";
const QUOTED_SINGLE_ABSOLUTE_PATH = new RegExp(`'(${LOCAL_PATH_START}[^']*)'`, "g");
const QUOTED_DOUBLE_ABSOLUTE_PATH = new RegExp(`"(${LOCAL_PATH_START}[^"]*)"`, "g");
const UNQUOTED_ABSOLUTE_PATH = new RegExp(`(^|[\\s([{;,=]|:\\s)(${LOCAL_PATH_START}[^\\s'"\\x60<>]*)`, "g");

export function redactLocalPathEvidence(message: string, cwd = process.cwd()): string {
  let redacted = message.replace(QUOTED_SINGLE_ABSOLUTE_PATH, "'[path]'");
  redacted = redacted.replace(QUOTED_DOUBLE_ABSOLUTE_PATH, "\"[path]\"");
  redacted = redacted.replace(UNQUOTED_ABSOLUTE_PATH, "$1[path]");
  return cwd.length > 1 ? redacted.split(cwd).join("[path]") : redacted;
}
