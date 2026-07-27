// Minimal ZIP reader: central-directory walk + native DecompressionStream
// ("deflate-raw") — zero dependencies, negligible CPU (decompression is
// native). Supports stored (0) and deflated (8) entries, which is all the
// House Clerk's daily 2026FD.zip uses (verified fixture).

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function findEocd(bytes: Uint8Array): number {
  // EOCD signature PK\x05\x06, scan backwards over the (≤64KB) comment.
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

function readEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error("zip: no end-of-central-directory record");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's bytes by exact name; throws when absent or unsupported. */
export async function unzipEntry(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const entry = readEntries(bytes).find((e) => e.name === name);
  if (!entry) throw new Error(`zip: entry not found: ${name}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lho = entry.localHeaderOffset;
  if (view.getUint32(lho, true) !== 0x04034b50) throw new Error("zip: bad local header");
  // Local header name/extra lengths can differ from the central directory's.
  const nameLen = view.getUint16(lho + 26, true);
  const extraLen = view.getUint16(lho + 28, true);
  const dataStart = lho + 30 + nameLen + extraLen;
  const raw = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return raw.slice();
  if (entry.method !== 8) throw new Error(`zip: unsupported compression method ${entry.method}`);
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
