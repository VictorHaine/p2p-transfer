const QUOTED_SINGLE_ABSOLUTE_PATH = /'((?:[A-Za-z]:[\\/]|\/)[^']*)'/g;
const QUOTED_DOUBLE_ABSOLUTE_PATH = /"((?:[A-Za-z]:[\\/]|\/)[^"]*)"/g;
const UNQUOTED_ABSOLUTE_PATH = /(^|[\s([{;,=]|:\s)((?:[A-Za-z]:[\\/][^\s'"`<>]+|\/[^\s'"`<>]+))/g;

export function redactLocalPathEvidence(message: string, cwd = process.cwd()): string {
  let redacted = message.replace(QUOTED_SINGLE_ABSOLUTE_PATH, "'[path]'");
  redacted = redacted.replace(QUOTED_DOUBLE_ABSOLUTE_PATH, "\"[path]\"");
  if (cwd.length > 1) redacted = redacted.split(cwd).join("[cwd]");
  return redacted.replace(UNQUOTED_ABSOLUTE_PATH, "$1[path]");
}
