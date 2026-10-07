// Reading the level a /effort run set.

// What /effort accepts ("Valid options are: low, medium, high, xhigh, max, auto").
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const

/**
 * The level a finished /effort set: what its output reports ("Set effort level to high ..."),
 * else the level its args named (the output may not reach hooks); undefined for an unknown level or none.
 */
export function effortFromCommand(args: string, output: string | undefined): string | undefined {
  const reported = /^Set effort level to (\w+)/.exec(output ?? '')?.[1]
  if (reported) return reported
  const asked = args.trim().split(/\s+/)[0] ?? ''
  return (EFFORTS as readonly string[]).includes(asked) ? asked : undefined
}

/**
 * The effort a finished /model left the session on: `null` when it set a model with no effort
 * ("Set model to `Haiku 4.5` ..."), the level it names ("... with `medium` effort"), and
 * undefined when it changed nothing ("Kept model as ...", "Cancelled") or the output is unknown.
 */
export function effortFromModelCommand(output: string | undefined): string | null | undefined {
  if (!output || !/^Set model to /.test(output)) return undefined
  return /with `(\w+)` effort/.exec(output)?.[1] ?? null
}
