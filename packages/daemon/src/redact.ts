const patterns: [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@'"]+@/gi, '$1[redacted]@'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{3,}/gi, '$1 [redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bted-pair:[A-Za-z0-9_-]+/g, 'ted-pair:[redacted]'],
  [
    /(?<![A-Za-z0-9_-])(?=[A-Za-z_-]*[0-9])(?=[0-9_-]*[A-Za-z])(?:[A-Za-z0-9_-]{86}|[A-Za-z0-9_-]{43})(?![A-Za-z0-9_=-])/g,
    '[redacted]',
  ],
]

export function redactSecrets(text: string): string {
  return patterns.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  )
}
