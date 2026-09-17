type Fields = Record<string, unknown>;

function log(level: 'info' | 'warn' | 'error', event: string, fields?: Fields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (event: string, fields?: Fields) => log('info', event, fields),
  warn: (event: string, fields?: Fields) => log('warn', event, fields),
  error: (event: string, fields?: Fields) => log('error', event, fields),
};
