/**
 * Streaming FLAC -> fragmented MP4 remux (packet copy, no re-encode).
 *
 * Pure byte handling with no DOM or network access, so it can be unit
 * tested in isolation. The gapless engine feeds it byte ranges of a FLAC
 * file as they arrive and appends the resulting fMP4 fragments to a
 * SourceBuffer, so a track never has to be held in memory in full.
 *
 * References: RFC 9639 (FLAC), "Encapsulation of FLAC in ISO Base Media
 * File Format" (xiph), ISO/IEC 14496-12.
 */

/** Size of a FLAC STREAMINFO block body. */
const STREAMINFO_SIZE = 34;

/** CRC-8, polynomial x^8 + x^2 + x + 1, as used by FLAC frame headers. */
const CRC8_TABLE = (() => {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let bit = 0; bit < 8; bit++) {
            c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
        }
        table[i] = c;
    }
    return table;
})();

function crc8(bytes, start, end) {
    let c = 0;
    for (let i = start; i < end; i++) {
        c = CRC8_TABLE[c ^ bytes[i]];
    }
    return c;
}

/**
 * Parse the FLAC metadata header (optional ID3v2 tags, 'fLaC', metadata
 * blocks) from the start of a file.
 *
 * @param {Uint8Array} bytes - Bytes from file offset 0. May be a prefix.
 * @returns {{ done: true, info: Object } | { done: false, needOffset: number }}
 *     When the metadata ends beyond the supplied bytes, `needOffset` is the
 *     file offset of the next block header that must be fetched; pass the
 *     bytes from there to {@link continueFlacHeader}.
 */
export function parseFlacHeader(bytes) {
    let pos = 0;
    // Skip any ID3v2 tags (some taggers put them in front of 'fLaC').
    while (bytes.length >= pos + 10 && bytes[pos] === 0x49 && bytes[pos + 1] === 0x44 && bytes[pos + 2] === 0x33) {
        const size = ((bytes[pos + 6] & 0x7f) << 21) | ((bytes[pos + 7] & 0x7f) << 14) | ((bytes[pos + 8] & 0x7f) << 7) | (bytes[pos + 9] & 0x7f);
        const footer = (bytes[pos + 5] & 0x10) ? 10 : 0;
        pos += 10 + size + footer;
    }
    if (bytes.length < pos + 4) {
        if (pos > 0) {
            return { done: false, needOffset: pos, state: { stage: 'magic' } };
        }
        throw new Error('file too short for a FLAC header');
    }
    if (bytes[pos] !== 0x66 || bytes[pos + 1] !== 0x4c || bytes[pos + 2] !== 0x61 || bytes[pos + 3] !== 0x43) {
        throw new Error('not a FLAC file (missing fLaC marker)');
    }
    return walkMetadata(bytes, 0, pos + 4, null);
}

/**
 * Resume metadata parsing at `offset`, using bytes fetched from there.
 *
 * @param {Uint8Array} bytes - Bytes starting at file offset `offset`.
 * @param {number} offset
 * @param {Object} state - The `state` returned with the previous result.
 */
export function continueFlacHeader(bytes, offset, state) {
    if (state.stage === 'magic') {
        if (bytes.length < 4 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
            throw new Error('not a FLAC file (missing fLaC marker)');
        }
        return walkMetadata(bytes, offset, offset + 4, null);
    }
    return walkMetadata(bytes, offset, offset, state.streamInfo);
}

function walkMetadata(bytes, base, filePos, streamInfo) {
    let pos = filePos;
    for (;;) {
        const rel = pos - base;
        if (rel + 4 > bytes.length) {
            return { done: false, needOffset: pos, state: { stage: 'blocks', streamInfo } };
        }
        const last = (bytes[rel] & 0x80) !== 0;
        const type = bytes[rel] & 0x7f;
        const size = (bytes[rel + 1] << 16) | (bytes[rel + 2] << 8) | bytes[rel + 3];
        if (type === 0) {
            if (rel + 4 + STREAMINFO_SIZE > bytes.length) {
                return { done: false, needOffset: pos, state: { stage: 'blocks', streamInfo } };
            }
            streamInfo = bytes.slice(rel + 4, rel + 4 + STREAMINFO_SIZE);
        } else if (type === 127) {
            throw new Error('invalid FLAC metadata block');
        }
        pos += 4 + size;
        if (last) {
            if (!streamInfo) {
                throw new Error('FLAC file has no STREAMINFO block');
            }
            return { done: true, info: decodeStreamInfo(streamInfo, pos) };
        }
    }
}

function decodeStreamInfo(si, audioStart) {
    const minBlockSize = (si[0] << 8) | si[1];
    const maxBlockSize = (si[2] << 8) | si[3];
    const minFrameSize = (si[4] << 16) | (si[5] << 8) | si[6];
    const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    const channels = ((si[12] >> 1) & 0x07) + 1;
    const bitsPerSample = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
    const totalSamples = ((si[13] & 0x0f) * 4294967296) + (((si[14] << 24) | (si[15] << 16) | (si[16] << 8) | si[17]) >>> 0);
    if (!sampleRate) {
        throw new Error('FLAC STREAMINFO has no sample rate');
    }
    return {
        streamInfo: si,
        audioStart,
        minBlockSize,
        maxBlockSize,
        minFrameSize,
        sampleRate,
        channels,
        bitsPerSample,
        totalSamples,
        duration: totalSamples ? totalSamples / sampleRate : 0
    };
}

const SAMPLE_RATE_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const SAMPLE_SIZE_CODES = [0, 8, 12, 0, 16, 20, 24, 32];

/**
 * Parse and validate a FLAC frame header at `pos`.
 *
 * @returns {?{num: number, variable: boolean, blockSize: number, length: number}}
 *     null when the bytes there are not a valid header (or are truncated).
 */
function readFrameHeader(bytes, pos, info) {
    const end = bytes.length;
    if (pos + 6 > end || bytes[pos] !== 0xff || (bytes[pos + 1] & 0xfe) !== 0xf8) {
        return null;
    }
    const variable = (bytes[pos + 1] & 0x01) === 1;
    const blockCode = bytes[pos + 2] >> 4;
    const rateCode = bytes[pos + 2] & 0x0f;
    const channelCode = bytes[pos + 3] >> 4;
    const sizeCode = (bytes[pos + 3] >> 1) & 0x07;
    if (blockCode === 0 || rateCode === 15 || channelCode > 10 || sizeCode === 3 || (bytes[pos + 3] & 0x01)) {
        return null;
    }
    const channels = channelCode < 8 ? channelCode + 1 : 2;
    if (channels !== info.channels) {
        return null;
    }
    if (sizeCode !== 0 && SAMPLE_SIZE_CODES[sizeCode] !== info.bitsPerSample) {
        return null;
    }
    if (rateCode >= 1 && rateCode <= 11 && SAMPLE_RATE_CODES[rateCode] !== info.sampleRate) {
        return null;
    }

    // Coded number: UTF-8-like, up to 7 bytes.
    let p = pos + 4;
    const first = bytes[p++];
    let num;
    let extra;
    if (first < 0x80) {
        num = first;
        extra = 0;
    } else if ((first & 0xe0) === 0xc0) {
        num = first & 0x1f;
        extra = 1;
    } else if ((first & 0xf0) === 0xe0) {
        num = first & 0x0f;
        extra = 2;
    } else if ((first & 0xf8) === 0xf0) {
        num = first & 0x07;
        extra = 3;
    } else if ((first & 0xfc) === 0xf8) {
        num = first & 0x03;
        extra = 4;
    } else if ((first & 0xfe) === 0xfc) {
        num = first & 0x01;
        extra = 5;
    } else if (first === 0xfe && variable) {
        num = 0;
        extra = 6;
    } else {
        return null;
    }
    if (p + extra > end) {
        return null;
    }
    for (let i = 0; i < extra; i++) {
        const b = bytes[p++];
        if ((b & 0xc0) !== 0x80) {
            return null;
        }
        num = (num * 64) + (b & 0x3f);
    }

    let blockSize;
    if (blockCode === 1) {
        blockSize = 192;
    } else if (blockCode <= 5) {
        blockSize = 576 << (blockCode - 2);
    } else if (blockCode === 6) {
        if (p + 1 > end) return null;
        blockSize = bytes[p++] + 1;
    } else if (blockCode === 7) {
        if (p + 2 > end) return null;
        blockSize = ((bytes[p] << 8) | bytes[p + 1]) + 1;
        p += 2;
    } else {
        blockSize = 256 << (blockCode - 8);
    }
    if (rateCode === 12) {
        p += 1;
    } else if (rateCode === 13 || rateCode === 14) {
        p += 2;
    }
    if (p + 1 > end) {
        return null;
    }
    if (crc8(bytes, pos, p) !== bytes[p]) {
        return null;
    }
    return { num, variable, blockSize, length: p + 1 - pos };
}

/**
 * Incremental FLAC frame splitter. Feed it consecutive byte chunks; it
 * returns whole frames with their sample positions. Frame boundaries are
 * found by searching for the next valid header (sync code, CRC-8, and a
 * frame/sample number that continues the previous one), so audio data that
 * happens to contain a sync pattern is never mistaken for a header.
 */
export class FlacFrameSplitter {
    /**
     * @param {Object} info - Result of parseFlacHeader().
     * @param {boolean} aligned - True when the first chunk starts exactly on
     *     a frame (at info.audioStart); false after a seek into the middle of
     *     the audio, in which case the splitter resynchronises first.
     */
    constructor(info, aligned) {
        this._info = info;
        this._buffer = null;
        this._synced = false;
        this._aligned = aligned;
        this._header = null;
        this._nominalBlockSize = info.minBlockSize === info.maxBlockSize ? info.maxBlockSize : 0;
    }

    /**
     * @param {Uint8Array} chunk - The next bytes of the file.
     * @param {boolean} isLast - True when the chunk ends at the end of the file.
     * @returns {Array<{data: Uint8Array, sample: number, blockSize: number}>}
     */
    push(chunk, isLast) {
        let bytes;
        if (this._buffer && this._buffer.length) {
            bytes = new Uint8Array(this._buffer.length + chunk.length);
            bytes.set(this._buffer, 0);
            bytes.set(chunk, this._buffer.length);
        } else {
            bytes = chunk;
        }
        this._buffer = null;

        const frames = [];
        let pos = 0;
        if (!this._synced) {
            const sync = this._sync(bytes, isLast);
            if (sync.pos == null) {
                // Keep the unconfirmed candidate (or a tail, in case a header
                // straddles the chunk boundary) for the next chunk.
                this._buffer = isLast ? null : bytes.slice(sync.keepFrom);
                return frames;
            }
            pos = sync.pos;
        }

        let header = this._header;
        for (;;) {
            const next = this._findNext(bytes, pos, header);
            if (next) {
                frames.push(this._frame(bytes.subarray(pos, next.pos), header));
                pos = next.pos;
                header = next.header;
                continue;
            }
            if (isLast) {
                frames.push(this._frame(stripId3v1(bytes.subarray(pos)), header));
                this._header = null;
                return frames;
            }
            this._buffer = bytes.slice(pos);
            this._header = header;
            return frames;
        }
    }

    /**
     * Locate the first trustworthy frame header: one followed by another
     * valid header that continues its numbering (or by end of file).
     * @returns {{pos: number} | {keepFrom: number}} The frame offset, or
     *     where to resume once more data has arrived.
     * @private
     */
    _sync(bytes, isLast) {
        for (let i = 0; i < bytes.length - 1; i++) {
            if (bytes[i] !== 0xff) continue;
            const header = readFrameHeader(bytes, i, this._info);
            if (!header) continue;
            if (this._aligned && i === 0) {
                this._accept(header);
                return { pos: 0 };
            }
            if (this._findNext(bytes, i, header) || isLast) {
                this._accept(header);
                return { pos: i };
            }
            // A candidate whose successor isn't in the buffer yet: wait for
            // more bytes rather than skipping what may be the real frame.
            if (bytes.length - i < (1 << 20)) {
                return { keepFrom: i };
            }
        }
        return { keepFrom: Math.max(0, bytes.length - 32) };
    }

    _accept(header) {
        this._synced = true;
        this._header = header;
        if (!this._nominalBlockSize) {
            this._nominalBlockSize = header.blockSize;
        }
    }

    /** @private */
    _findNext(bytes, pos, header) {
        const minFrame = Math.max(header.length + 1, this._info.minFrameSize || 0);
        const expected = header.variable ? header.num + header.blockSize : header.num + 1;
        for (let i = pos + minFrame; i < bytes.length - 1; i++) {
            if (bytes[i] !== 0xff || (bytes[i + 1] & 0xfe) !== 0xf8) continue;
            const next = readFrameHeader(bytes, i, this._info);
            if (next && next.variable === header.variable && next.num === expected) {
                return { pos: i, header: next };
            }
        }
        return null;
    }

    /** @private */
    _frame(data, header) {
        const sample = header.variable ? header.num : header.num * this._nominalBlockSize;
        return { data, sample, blockSize: header.blockSize };
    }
}

function stripId3v1(bytes) {
    const n = bytes.length;
    if (n > 128 && bytes[n - 128] === 0x54 && bytes[n - 127] === 0x41 && bytes[n - 126] === 0x47) {
        return bytes.subarray(0, n - 128);
    }
    return bytes;
}

// ---- ISO BMFF writing -------------------------------------------------

function u32(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function u16(v) {
    return [(v >>> 8) & 0xff, v & 0xff];
}

function fourcc(s) {
    return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
}

function box(type, ...parts) {
    const body = parts.flat(Infinity);
    return [...u32(8 + body.length), ...fourcc(type), ...body];
}

function fullBox(type, version, flags, ...parts) {
    return box(type, version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff, ...parts);
}

const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

/**
 * Build the fMP4 initialization segment (ftyp + moov) for a FLAC stream.
 *
 * @param {Object} info - Result of parseFlacHeader().
 * @returns {Uint8Array}
 */
export function buildInitSegment(info) {
    const ftyp = box('ftyp', fourcc('iso6'), u32(0), fourcc('iso6'), fourcc('isom'), fourcc('mp41'));
    const mvhd = fullBox('mvhd', 0, 0,
        u32(0), u32(0), u32(1000), u32(0), // times, timescale, duration
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), // rate, volume, reserved
        MATRIX, new Array(24).fill(0), u32(2)); // pre_defined, next_track_ID
    const tkhd = fullBox('tkhd', 0, 3,
        u32(0), u32(0), u32(1), u32(0), u32(0), // times, track_ID, reserved, duration
        u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0), // reserved, layer, group, volume
        MATRIX, u32(0), u32(0)); // width, height
    const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(info.sampleRate), u32(0), u16(0x55c4), u16(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), fourcc('soun'), u32(0), u32(0), u32(0), [...'SoundHandler'].map((c) => c.charCodeAt(0)), 0);
    const dfLa = fullBox('dfLa', 0, 0, 0x80, 0, 0, STREAMINFO_SIZE, Array.from(info.streamInfo));
    const fLaC = box('fLaC',
        new Array(6).fill(0), u16(1), // reserved, data_reference_index
        u32(0), u32(0), // reserved
        u16(info.channels), u16(info.bitsPerSample), u16(0), u16(0),
        // 16.16 sample rate; per the FLAC-in-ISOBMFF spec it is 0 when the
        // rate does not fit (e.g. 192 kHz) and decoders use STREAMINFO.
        u32(info.sampleRate < 65536 ? info.sampleRate * 65536 : 0),
        dfLa);
    const stbl = box('stbl',
        fullBox('stsd', 0, 0, u32(1), fLaC),
        fullBox('stts', 0, 0, u32(0)),
        fullBox('stsc', 0, 0, u32(0)),
        fullBox('stsz', 0, 0, u32(0), u32(0)),
        fullBox('stco', 0, 0, u32(0)));
    const minf = box('minf',
        fullBox('smhd', 0, 0, u16(0), u16(0)),
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        stbl);
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
    const mvex = box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
    return new Uint8Array([...ftyp, ...box('moov', mvhd, trak, mvex)]);
}

/**
 * Build one media fragment (moof + mdat) holding consecutive FLAC frames.
 *
 * @param {Array<{data: Uint8Array, sample: number, blockSize: number}>} frames
 * @param {number} sequenceNumber - Strictly increasing per SourceBuffer.
 * @returns {Uint8Array}
 */
export function buildFragment(frames, sequenceNumber) {
    const count = frames.length;
    let payload = 0;
    for (const frame of frames) {
        payload += frame.data.length;
    }
    // Sizes: mfhd 16, tfhd 16, tfdt 20, trun 20 + 8 per sample.
    const trunSize = 20 + (8 * count);
    const trafSize = 8 + 16 + 20 + trunSize;
    const moofSize = 8 + 16 + trafSize;
    const total = moofSize + 8 + payload;

    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let p = 0;
    const words = (...values) => {
        for (const v of values) {
            view.setUint32(p, v);
            p += 4;
        }
    };
    const header = (size, type) => {
        words(size);
        for (let i = 0; i < 4; i++) {
            out[p++] = type.charCodeAt(i);
        }
    };

    header(moofSize, 'moof');
    header(16, 'mfhd');
    words(0, sequenceNumber);
    header(trafSize, 'traf');
    header(16, 'tfhd');
    words(0x020000, 1); // flags: default-base-is-moof; track 1
    header(20, 'tfdt');
    words(0x01000000, Math.floor(frames[0].sample / 4294967296), frames[0].sample >>> 0); // version 1, 64-bit time
    header(trunSize, 'trun');
    words(0x000301, count, moofSize + 8); // flags: data-offset, duration, size
    for (const frame of frames) {
        words(frame.blockSize, frame.data.length);
    }
    header(8 + payload, 'mdat');
    for (const frame of frames) {
        out.set(frame.data, p);
        p += frame.data.length;
    }
    return out;
}
