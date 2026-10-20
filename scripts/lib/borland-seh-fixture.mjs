/** Self-owned PE32 with a Borland RTL veneer and an orphaned catch body. Never executed. */
export const borlandSehFixture = () => {
  const bytes = Buffer.alloc(0x600);
  bytes.write("MZ");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(0x14c, 0x84);
  bytes.writeUInt16LE(2, 0x86);
  bytes.writeUInt16LE(0xe0, 0x94);
  bytes.writeUInt16LE(0x102, 0x96);
  const optional = 0x98;
  bytes.writeUInt16LE(0x10b, optional);
  bytes.writeUInt32LE(0x200, optional + 4);
  bytes.writeUInt32LE(0x200, optional + 8);
  bytes.writeUInt32LE(0x1000, optional + 16);
  bytes.writeUInt32LE(0x1000, optional + 20);
  bytes.writeUInt32LE(0x2000, optional + 24);
  bytes.writeUInt32LE(0x400000, optional + 28);
  bytes.writeUInt32LE(0x1000, optional + 32);
  bytes.writeUInt32LE(0x200, optional + 36);
  bytes.writeUInt16LE(6, optional + 40);
  bytes.writeUInt16LE(6, optional + 48);
  bytes.writeUInt32LE(0x3000, optional + 56);
  bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt16LE(3, optional + 68);
  bytes.writeUInt32LE(0x100000, optional + 72);
  bytes.writeUInt32LE(0x1000, optional + 76);
  bytes.writeUInt32LE(0x100000, optional + 80);
  bytes.writeUInt32LE(0x1000, optional + 84);
  bytes.writeUInt32LE(16, optional + 92);
  for (const [index, name, rva, raw, flags] of [
    [0, ".text", 0x1000, 0x200, 0x60000020],
    [1, ".rdata", 0x2000, 0x400, 0x40000040],
  ]) {
    const section = 0x178 + index * 40;
    bytes.write(name, section, "ascii");
    bytes.writeUInt32LE(0x200, section + 8);
    bytes.writeUInt32LE(rva, section + 12);
    bytes.writeUInt32LE(0x200, section + 16);
    bytes.writeUInt32LE(raw, section + 20);
    bytes.writeUInt32LE(flags, section + 36);
  }
  const code = (offset, hex) =>
    bytes.set(Buffer.from(hex, "hex"), 0x200 + offset);
  // XOR EAX,EAX; PUSH EBP; PUSH handler; PUSH FS:[EAX]; MOV FS:[EAX],ESP.
  code(0, "558bec31c055682010400064ff30648920684020400083c404eb35");
  // JMP shared RTL; catch: PUSH diagnostic; CALL message; remove argument; JMP continuation.
  code(0x20, "e95b0000006800204000e86100000083c404eb1c");
  code(0x50, "31c0648b106489105dc3");
  code(0x80, "c3");
  code(0x90, "c3");
  // Same registration encoding but EAX is one: not an FS:[0] registration.
  code(0xa0, "558becb8010000005568c010400064ff306489205dc3");
  code(0xc0, "e9bbffffff6800204000e8c1ffffff83c404ebd9");
  // A separate seeded function makes the catch-only string known to Ghidra's
  // string inventory without attributing that reference to the protected function.
  code(0xf0, "680020400083c404c3");
  bytes.write("REA_BORLAND_SEH_ERROR_ONLY\0", 0x400, "ascii");
  bytes.write("REA_BORLAND_SEH_NORMAL\0", 0x440, "ascii");
  return bytes;
};
