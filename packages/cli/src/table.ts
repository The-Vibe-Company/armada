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

export function stripControl(input: string) {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const code = input.codePointAt(i) ?? 0;
    if (code === 0x1b && input[i + 1] === "[") {
      i += 2;
      while (i < input.length && !/[A-Za-z]/.test(input[i] ?? "")) i++;
      continue;
    }
    if (code > 0xffff) {
      out += input.slice(i, i + 2);
      i++;
      continue;
    }
    out += code < 32 || (code >= 127 && code <= 159) ? " " : input[i];
  }
  return out;
}
