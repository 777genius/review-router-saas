import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  readBoundedRegularFile,
  readExactZipEntries,
} from "./github-actions-trusted-evidence.mjs";

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(value), 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, value);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(value), 16);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0x80000000, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + value.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function falseInflatedSize(value: Buffer) {
  const compressed = deflateRawSync(value);
  const archive = zip({ bomb: compressed });
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt16LE(8, 8);
  archive.writeUInt16LE(8, central + 10);
  archive.writeUInt32LE(crc32(value), 14);
  archive.writeUInt32LE(crc32(value), central + 16);
  archive.writeUInt32LE(4, 22);
  archive.writeUInt32LE(4, central + 24);
  return archive;
}

function specialZip(mode: number, host = 3) {
  const archive = zip({ special: Buffer.from("value") });
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt16LE((host << 8) | 20, central + 4);
  archive.writeUInt32LE((mode << 16) >>> 0, central + 38);
  return archive;
}

function extraLinkMetadata(identifier: number, centralField: boolean) {
  const archive = zip({ entry: Buffer.from("value") });
  const extra = Buffer.from([identifier & 0xff, identifier >> 8, 1, 0, 1]);
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const end = archive.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const insertion = centralField
    ? central + 46 + archive.readUInt16LE(central + 28)
    : 30 + archive.readUInt16LE(26);
  const result = Buffer.concat([
    archive.subarray(0, insertion),
    extra,
    archive.subarray(insertion),
  ]);
  if (centralField) {
    result.writeUInt16LE(extra.length, central + 30);
    result.writeUInt32LE(
      archive.readUInt32LE(end + 12) + extra.length,
      end + extra.length + 12,
    );
  } else {
    result.writeUInt16LE(extra.length, 28);
    result.writeUInt32LE(central + extra.length, end + extra.length + 16);
  }
  return result;
}

describe("bounded offline evidence", () => {
  it.each(["symlink", "hardlink", "fifo", "directory"])(
    "rejects %s input",
    (kind) => {
      const directory = mkdtempSync(join(tmpdir(), "rr-bounded-file-"));
      const source = join(directory, "source");
      const target = join(directory, "target");
      writeFileSync(source, "safe");
      if (kind === "symlink") symlinkSync(source, target);
      if (kind === "hardlink") linkSync(source, target);
      if (kind === "fifo") execFileSync("/usr/bin/mkfifo", [target]);
      if (kind === "directory") mkdirSync(target);
      expect(() => readBoundedRegularFile(target, 16, "test")).toThrow(
        /live_catalog_test_file_/u,
      );
    },
  );

  it("rejects replacement between identity check and open", () => {
    const directory = mkdtempSync(join(tmpdir(), "rr-bounded-race-"));
    const target = join(directory, "target");
    const replacement = join(directory, "replacement");
    writeFileSync(target, "claim-a");
    writeFileSync(replacement, "claim-b");
    expect(() =>
      readBoundedRegularFile(target, 32, "race", {
        afterLstat: () => renameSync(replacement, target),
      }),
    ).toThrow(/live_catalog_race_file_/u);
  });

  it("enforces ZIP archive, inflate, CRC, entry, and aggregate limits", () => {
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(4) }), {
        maximumArchiveBytes: 8,
      }),
    ).toThrow("trusted evidence ZIP archive is too large");
    expect(() =>
      readExactZipEntries(falseInflatedSize(Buffer.alloc(64)), {
        maximumEntryBytes: 16,
      }),
    ).toThrow();
    const badCrc = zip({ one: Buffer.from("value") });
    badCrc.writeUInt32LE(0, 14);
    expect(() => readExactZipEntries(badCrc)).toThrow();
    expect(() =>
      readExactZipEntries(zip({ one: Buffer.alloc(4), two: Buffer.alloc(4) }), {
        maximumTotalBytes: 7,
      }),
    ).toThrow("trusted evidence ZIP uncompressed total is too large");
  });

  it.each([
    ["symlink", 0xa000, 3],
    ["fifo", 0x1000, 3],
    ["socket", 0xc000, 3],
    ["hardlink-like DOS-host metadata", 0xa000, 0],
  ])("rejects ZIP %s entries", (_name, mode, host) => {
    expect(() => readExactZipEntries(specialZip(mode, host))).toThrow(
      "trusted evidence ZIP entry is unsafe or unsupported",
    );
  });

  it.each([
    ["central PKWARE Unix", 0x000d, true],
    ["local PKWARE Unix", 0x000d, false],
    ["central ASi Unix", 0x756e, true],
    ["local ASi Unix", 0x756e, false],
  ])("rejects %s link metadata", (_name, identifier, central) => {
    expect(() =>
      readExactZipEntries(extraLinkMetadata(identifier, central)),
    ).toThrow("trusted evidence ZIP entry is unsafe or unsupported");
  });
});
