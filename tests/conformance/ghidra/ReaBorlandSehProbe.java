//@category REA Verification
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;

/** Verify the production producer on a real, source-owned PE32 Program. */
public class ReaBorlandSehProbe extends GhidraScript {
    private Address at(long value) { return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(value); }
    private void require(boolean value, String message) { if (!value) throw new IllegalStateException(message); }
    @Override public void run() throws Exception {
        var function = currentProgram.getFunctionManager().getFunctionAt(at(0x401000));
        require(function != null, "missing fixture entry");
        var original = new AddressSet(function.getBody());
        require(!original.contains(at(0x401025)), "fixture must contain a real orphan catch gap");
        var owner = currentProgram.getFunctionManager().getFunctionAt(at(0x401080));
        if (owner == null) { disassemble(at(0x401080)); owner = createFunction(at(0x401080), "rea_seh_rtl"); }
        owner.setName("unidentified_shared_handler", ghidra.program.model.symbol.SourceType.USER_DEFINED);
        var unverified = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(!function.getBody().contains(at(0x401025)), "unrelated bytes after a normal JMP were absorbed");
        require(!unverified.get(function.getEntryPoint()).omissions().isEmpty(), "unverified continuation omission lost");
        owner.setName("_HandleAnyException", ghidra.program.model.symbol.SourceType.USER_DEFINED);
        disassemble(at(0x401090));
        if (currentProgram.getFunctionManager().getFunctionAt(at(0x401090)) == null)
            createFunction(at(0x401090), "rea_seh_message");
        disassemble(at(0x4010a0));
        var negative = createFunction(at(0x4010a0), "rea_seh_nonzero");
        String signature = function.getPrototypeString(false, true);
        var observations = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(observations.containsKey(function.getEntryPoint()), "registration not observed");
        require(observations.get(function.getEntryPoint()).omissions().isEmpty(), observations.toString());
        require(function.getBody().contains(at(0x401025)), "catch body not recovered");
        require(function.getBody().contains(at(0x40102a)), "catch call not recovered");
        require(!function.getBody().contains(at(0x401080)), "shared RTL stolen");
        require(signature.equals(function.getPrototypeString(false, true)), "signature changed");
        require(!observations.containsKey(at(0x4010a0)), "nonzero FS offset misidentified");
        function.setBody(original);
        var immutable = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, false);
        require(!immutable.get(function.getEntryPoint()).omissions().isEmpty(), "read-only omission lost");
        require(!function.getBody().contains(at(0x401025)), "read-only body mutated");
        var independent = createFunction(at(0x401020), "rea_seh_independent");
        require(independent != null, "independent owner fixture unavailable");
        var conflict = ReaGhidraBorlandSeh.analyze(currentProgram, monitor, true);
        require(!conflict.get(function.getEntryPoint()).omissions().isEmpty(), "owner conflict omitted");
        require(currentProgram.getFunctionManager().getFunctionContaining(at(0x401020)).equals(independent), "independent owner changed");
        println("REA_BORLAND_SEH_PROBE_PASSED");
    }
}
