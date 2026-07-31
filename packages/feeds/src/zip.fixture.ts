import { crc32 } from 'node:zlib'

// Builds a ZIP archive in memory so the two feed streamers can be driven end-to-end without a committed
// binary fixture. Generating it beats checking one in for three reasons: a binary blob in the tree is
// unreviewable in a diff, writing one through the editing tools risks corrupting it, and the entries a
// given test needs (an entry nested under a root folder, a non-.json file, a malformed payload) are
// clearer expressed as a literal map than as an opaque file someone has to unzip to understand.
//
// Entries are STORED (compression method 0) rather than deflated. unzipper reads method 0 natively, and
// stored entries keep this helper to the header layout alone — no compressor, no streaming state.
//
// Layout per the PKZIP spec: [local header + data] per entry, then the central directory, then the
// end-of-central-directory record. Sizes and offsets are little-endian throughout.

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const END_OF_CENTRAL_DIR_SIG = 0x06054b50

// Version 2.0 — the floor for a stored entry, and what every reader accepts.
const VERSION = 20

type Entry = {
    name: string
    data: Buffer
    crc: number
    offset: number
}

function localHeader(entry: Entry): Buffer {
    const name = Buffer.from(entry.name, 'utf8')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    header.writeUInt16LE(VERSION, 4)
    // No flags: not encrypted, sizes known up front so no data descriptor is needed.
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(0, 8)
    // A fixed DOS timestamp keeps the bytes deterministic across runs.
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0x2100, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    return Buffer.concat([header, name])
}

function centralHeader(entry: Entry): Buffer {
    const name = Buffer.from(entry.name, 'utf8')
    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    header.writeUInt16LE(VERSION, 4)
    header.writeUInt16LE(VERSION, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0x2100, 14)
    header.writeUInt32LE(entry.crc, 16)
    header.writeUInt32LE(entry.data.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(entry.offset, 42)
    return Buffer.concat([header, name])
}

// `files` maps archive path → file contents. Directory entries are not emitted: neither streamer needs
// them, and both skip anything whose type is not 'File' anyway.
export function makeZip(files: Record<string, string>): Buffer {
    const parts: Buffer[] = []
    const entries: Entry[] = []
    let offset = 0
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content, 'utf8')
        const entry: Entry = { name, data, crc: crc32(data), offset }
        const header = localHeader(entry)
        parts.push(header, data)
        offset += header.length + data.length
        entries.push(entry)
    }
    const centralStart = offset
    const central = entries.map(centralHeader)
    const centralSize = central.reduce(function total(sum, buf) {
        return sum + buf.length
    }, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralStart, 16)
    end.writeUInt16LE(0, 20)
    return Buffer.concat([...parts, ...central, end])
}
