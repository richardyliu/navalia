/**
 * Small RFC 4180 CSV reader (S1-R3-07; no dependency). Handles quoted fields with embedded
 * delimiters / newlines / doubled quotes, CRLF, a UTF-8 BOM, and `,` `;` or tab delimiters
 * (detected from the header line). Pure.
 */

export const MAX_CSV_ROWS = 100_000

export interface CsvTable {
  header: string[]
  rows: string[][]
  delimiter: string
  truncated: boolean
}

export function detectDelimiter(firstLine: string): string {
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}

export function parseCsv(text: string, maxRows = MAX_CSV_ROWS): CsvTable {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = detectDelimiter(firstLine)
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let truncated = false
  const endRecord = (): boolean => {
    record.push(field)
    field = ''
    if (!(record.length === 1 && record[0] === '')) records.push(record)
    record = []
    if (records.length > maxRows) {
      truncated = true
      return false
    }
    return true
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') inQuotes = true
    else if (c === delimiter) {
      record.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      if (!endRecord()) break
    } else field += c
  }
  if (!truncated && (field !== '' || record.length)) endRecord()
  const header = (records.shift() ?? []).map((h) => h.trim())
  return { header, rows: truncated ? records.slice(0, maxRows) : records, delimiter, truncated }
}
