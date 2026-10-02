/**
 * Zstandard frame primitives for reading dsh session logs.
 *
 * The JSONL session artifact is a *concatenated-frame* container: every
 * appended batch is its own independent Zstandard frame. `zstdDecompressSync`
 * decodes exactly one frame and silently ignores the bytes after it, so a
 * naive call returns only the session header and no events at all. This module
 * walks the frame boundaries itself (RFC 8878 §3) and decodes each frame
 * separately.
 *
 * @module dsh-usage-dashboard/zstd
 */

import { zstdDecompressSync } from 'node:zlib';

/** Zstandard frame magic number (`0xFD2FB528`, little-endian on disk). */
const ZSTD_MAGIC = 0xfd2fb528;

/** Block_Type values from RFC 8878 §3.1.1.2. */
const BLOCK_TYPE_RAW = 0;
const BLOCK_TYPE_RLE = 1;
const BLOCK_TYPE_COMPRESSED = 2;

/**
 * Whether this runtime can decode Zstandard session frames.
 * @returns {boolean} true when `node:zlib` exposes the synchronous decoder.
 */
export function zstdAvailable() {
  return typeof zstdDecompressSync === 'function';
}

/**
 * Locate every complete Zstandard frame in `buffer` without decompressing any
 * block. A trailing partial frame (a writer mid-append) is reported separately
 * instead of failing the whole scan.
 *
 * @param {Buffer} buffer - the bytes currently present in the session artifact.
 * @returns {{ frames: Array<{ start: number, end: number }>, damagedAt: number | null }}
 *   complete frame ranges plus the byte offset where the container stops being
 *   readable, when it does.
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  let damagedAt = null;

  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      damagedAt = offset;
      break;
    }

    let cursor = offset + 4;
    try {
      if (cursor >= buffer.length) throw new RangeError('truncated frame header');
      const descriptor = buffer[cursor++];
      const contentSizeFlag = (descriptor >> 6) & 0x3;
      const singleSegment = (descriptor >> 5) & 0x1;
      const hasChecksum = (descriptor >> 2) & 0x1;
      const dictionaryIdFlag = descriptor & 0x3;

      if (!singleSegment) cursor += 1; // Window_Descriptor
      cursor += dictionaryIdFlag === 0 ? 0 : dictionaryIdFlag === 1 ? 1 : dictionaryIdFlag === 2 ? 2 : 4;
      cursor += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
      if (cursor > buffer.length) throw new RangeError('truncated frame header');

      let last = false;
      while (!last) {
        if (cursor + 3 > buffer.length) throw new RangeError('truncated block header');
        // The 3-byte block header must be assembled byte by byte: reading four
        // bytes and masking shifts the whole header by one byte, which walks
        // past the frame end and collapses the container into a single frame.
        const header = buffer[cursor] | (buffer[cursor + 1] << 8) | (buffer[cursor + 2] << 16);
        last = (header & 0x1) === 1;
        const blockType = (header >> 1) & 0x3;
        const blockSize = header >>> 3;
        cursor += 3;
        if (blockType === BLOCK_TYPE_RLE) cursor += 1;
        else if (blockType === BLOCK_TYPE_RAW || blockType === BLOCK_TYPE_COMPRESSED) cursor += blockSize;
        else throw new RangeError('reserved block type');
        if (cursor > buffer.length) throw new RangeError('truncated block body');
      }

      if (hasChecksum) {
        cursor += 4;
        if (cursor > buffer.length) throw new RangeError('truncated frame checksum');
      }
    } catch {
      damagedAt = offset;
      break;
    }

    frames.push({ start: offset, end: cursor });
    offset = cursor;
  }

  if (offset < buffer.length && damagedAt === null) damagedAt = offset;
  return { frames, damagedAt };
}

/**
 * Read every JSON line from a session artifact: a `.jsonl.zstd` concatenated
 * container, or a plain `.jsonl` file.
 *
 * A frame that fails to decode is skipped rather than aborting the read, so one
 * damaged batch never costs the whole session's history.
 *
 * @param {Buffer} buffer - the complete artifact bytes.
 * @param {boolean} compressed - whether the artifact is a Zstandard container.
 * @returns {{ lines: string[], badFrames: number, damagedAt: number | null, unavailable: boolean }}
 *   the JSONL lines, the count of frames that failed to decode, the byte offset
 *   of structural damage, and whether Zstandard is unavailable in this runtime.
 */
export function readJsonlLines(buffer, compressed) {
  if (!compressed) {
    return { lines: buffer.toString('utf8').split('\n').filter((line) => line.trim() !== ''), badFrames: 0, damagedAt: null, unavailable: false };
  }
  if (!zstdAvailable()) return { lines: [], badFrames: 0, damagedAt: null, unavailable: true };

  const { frames, damagedAt } = scanZstdFrames(buffer);
  const lines = [];
  let badFrames = 0;
  for (const frame of frames) {
    let text;
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
    } catch {
      badFrames += 1;
      continue;
    }
    for (const line of text.split('\n')) if (line.trim() !== '') lines.push(line);
  }
  return { lines, badFrames, damagedAt, unavailable: false };
}
