/** Encode cells as one line of CSV (RFC 4180), ended by a line break. */
export function csvLine(cells: (string | undefined)[], delimiter = ','): string {
  const quote = (cell: string) =>
    cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r') ? `"${cell.replace(/"/g, '""')}"` : cell;
  return cells.map((cell) => (cell === undefined ? '' : quote(cell))).join(delimiter) + '\n';
}
