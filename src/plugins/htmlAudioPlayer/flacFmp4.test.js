import { describe, expect, it } from 'vitest';

import { FlacFrameSplitter, buildFragment, buildInitSegment, continueFlacHeader, parseFlacHeader } from './flacFmp4';

function crc8(bytes) {
    let c = 0;
    for (const b of bytes) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c;
}

function codedNumber(n) {
    if (n < 0x80) return [n];
    if (n < 0x800) return [0xc0 | (n >> 6), 0x80 | (n & 0x3f)];
    return [0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f)];
}

/**
 * A small 16-bit stereo 44.1 kHz FLAC file with VERBATIM subframes. The
 * samples are 0xFFF8 on purpose: audio data full of fake sync codes.
 * A PICTURE block pads the metadata to test multi-request headers.
 */
function makeFlac({ blockSize = 1024, totalSamples = 10000, pictureBytes = 0 } = {}) {
    const streamInfo = new Uint8Array(34);
    streamInfo[0] = blockSize >> 8;
    streamInfo[1] = blockSize & 0xff;
    streamInfo[2] = blockSize >> 8;
    streamInfo[3] = blockSize & 0xff;
    const rate = 44100;
    streamInfo[10] = rate >> 12;
    streamInfo[11] = (rate >> 4) & 0xff;
    streamInfo[12] = ((rate & 0x0f) << 4) | (1 << 1) | 0; // 2 channels, bps-1 high bit 0
    streamInfo[13] = (15 << 4); // bps-1 = 15 -> 16 bits
    streamInfo[16] = (totalSamples >> 8) & 0xff;
    streamInfo[17] = totalSamples & 0xff;
    streamInfo[15] = (totalSamples >> 16) & 0xff;

    const parts = [[0x66, 0x4c, 0x61, 0x43]];
    parts.push([pictureBytes ? 0x00 : 0x80, 0, 0, 34], Array.from(streamInfo));
    if (pictureBytes) {
        parts.push([0x80 | 6, (pictureBytes >> 16) & 0xff, (pictureBytes >> 8) & 0xff, pictureBytes & 0xff], new Array(pictureBytes).fill(0));
    }
    const audioStart = parts.reduce((n, p) => n + p.length, 0);
    const frames = [];
    for (let frame = 0, off = 0; off < totalSamples; frame++, off += blockSize) {
        const n = Math.min(blockSize, totalSamples - off);
        const header = [0xff, 0xf8, (7 << 4) | 9, (1 << 4) | (4 << 1), ...codedNumber(frame), (n - 1) >> 8, (n - 1) & 0xff];
        header.push(crc8(header));
        const body = [];
        for (let ch = 0; ch < 2; ch++) {
            body.push(0x02);
            for (let i = 0; i < n; i++) body.push(0xff, 0xf8);
        }
        const bytes = [...header, ...body, 0, 0]; // CRC-16 isn't checked by the splitter
        frames.push({ sample: off, blockSize: n, length: bytes.length });
        parts.push(bytes);
    }
    return { file: new Uint8Array(parts.flat()), audioStart, frames };
}

function readHeader(file, probe) {
    let result = parseFlacHeader(file.subarray(0, probe));
    while (!result.done) {
        result = continueFlacHeader(file.subarray(result.needOffset, result.needOffset + probe), result.needOffset, result.state);
    }
    return result.info;
}

function split(info, file, from, chunkSize, aligned) {
    const splitter = new FlacFrameSplitter(info, aligned);
    const out = [];
    for (let off = from; off < file.length; off += chunkSize) {
        const end = Math.min(file.length, off + chunkSize);
        out.push(...splitter.push(file.subarray(off, end), end === file.length));
    }
    return out;
}

function topLevelBoxes(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const boxes = [];
    for (let p = 0; p < bytes.length;) {
        const size = view.getUint32(p);
        boxes.push(String.fromCharCode(...bytes.subarray(p + 4, p + 8)));
        p += size;
    }
    return boxes;
}

describe('flacFmp4', () => {
    it('reads STREAMINFO and finds where the audio starts', () => {
        const { file, audioStart } = makeFlac();
        const info = readHeader(file, 65536);
        expect(info).toMatchObject({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 10000, audioStart });
    });

    it('skips large blocks such as cover art without reading them', () => {
        const { file, audioStart } = makeFlac({ pictureBytes: 5000 });
        const result = parseFlacHeader(file.subarray(0, 100));
        expect(result.done).toBe(true);
        expect(result.info.audioStart).toBe(audioStart);
    });

    it('asks for more bytes when a block header is past the first request', () => {
        const { file, audioStart } = makeFlac({ pictureBytes: 5000 });
        const first = parseFlacHeader(file.subarray(0, 40));
        expect(first).toMatchObject({ done: false, needOffset: 4 });
        expect(readHeader(file, 40).audioStart).toBe(audioStart);
    });

    it('splits every frame, despite sync-like audio bytes and any chunk size', () => {
        const { file, audioStart, frames } = makeFlac();
        const info = readHeader(file, 65536);
        for (const chunkSize of [7, 1000, 4096, file.length]) {
            const found = split(info, file, audioStart, chunkSize, true);
            expect(found.map((f) => [f.sample, f.blockSize, f.data.length]))
                .toEqual(frames.map((f) => [f.sample, f.blockSize, f.length]));
        }
    });

    it('resynchronises on a real frame after starting mid-file', () => {
        const { file, audioStart, frames } = makeFlac();
        const info = readHeader(file, 65536);
        const found = split(info, file, audioStart + 6000, 512, false);
        const firstFrame = frames.findIndex((f) => f.sample === found[0].sample);
        expect(firstFrame).toBeGreaterThan(0);
        expect(found.map((f) => f.sample)).toEqual(frames.slice(firstFrame).map((f) => f.sample));
    });

    it('builds an init segment carrying the real sample size and STREAMINFO', () => {
        const { file } = makeFlac();
        const info = readHeader(file, 65536);
        const init = buildInitSegment(info);
        expect(topLevelBoxes(init)).toEqual(['ftyp', 'moov']);
        const text = String.fromCharCode(...init);
        const entry = text.indexOf('fLaC');
        const view = new DataView(init.buffer);
        expect(view.getUint16(entry + 4 + 16)).toBe(2); // channel count
        expect(view.getUint16(entry + 4 + 18)).toBe(16); // sample size
        expect(view.getUint32(entry + 4 + 24)).toBe(44100 * 65536);
        const dfLa = text.indexOf('dfLa');
        expect(Array.from(init.subarray(dfLa + 12, dfLa + 12 + 34))).toEqual(Array.from(info.streamInfo));
    });

    it('builds fragments whose timing and data match the frames', () => {
        const { file, audioStart } = makeFlac();
        const info = readHeader(file, 65536);
        const frames = split(info, file, audioStart, file.length, true).slice(2, 5);
        const fragment = buildFragment(frames, 7);
        expect(topLevelBoxes(fragment)).toEqual(['moof', 'mdat']);
        const view = new DataView(fragment.buffer);
        const text = String.fromCharCode(...fragment);
        expect(view.getUint32(text.indexOf('mfhd') + 8)).toBe(7);
        expect(view.getUint32(text.indexOf('tfdt') + 12)).toBe(frames[0].sample);
        const trun = text.indexOf('trun');
        expect(view.getUint32(trun + 8)).toBe(3);
        const dataOffset = view.getUint32(trun + 12);
        expect(fragment.subarray(dataOffset, dataOffset + frames[0].data.length)).toEqual(frames[0].data);
        expect(view.getUint32(trun + 16)).toBe(frames[0].blockSize);
    });
});
