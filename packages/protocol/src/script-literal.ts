export function scriptLiteral(value: string | number | boolean): string {
  return JSON.stringify(value).replace(
    /[<>/\b\f\n\r\t\0\u2028\u2029]/g,
    (found) => `\\u${found.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
}
