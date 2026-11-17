/** Minimal ustar writer for archive fixtures (a provider's folder download). */
export function tarEntry(path: string, data: string | Uint8Array = "", type = "0"): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const header = new Uint8Array(512);
  const put = (text: string, at: number) => header.set(new TextEncoder().encode(text), at);
  put(path.slice(0, 100), 0);
  put("0000644\0", 100);
  put(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  const body = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  body.set(bytes);
  const out = new Uint8Array(512 + body.length);
  out.set(header);
  out.set(body, 512);
  return out;
}

export function tarArchive(...entries: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat([...entries, new Uint8Array(1024)]));
}
