export function formatTableRows(headers: readonly string[], rows: readonly (readonly string[])[]) {
  const widths = headers.map((header, index) =>
    rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), header.length),
  );
  const render = (cells: readonly string[]) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd();
  return { header: render(headers), rows: rows.map(render) };
}

export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]) {
  const { header, rows: formatted } = formatTableRows(headers, rows);
  return `${[header, ...formatted].join("\n")}\n`;
}
