import ghidra.app.cmd.disassemble.DisassembleCommand;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.util.task.TaskMonitor;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Recover only registered Win32 handler gaps, without changing executable bytes. */
public final class ReaGhidraBorlandSeh {
    public record Observation(List<String> diagnostics, List<String> omissions, List<Address> handlers) {}

    public static Map<Address, Observation> analyze(Program program, TaskMonitor monitor,
            boolean allowMutation) throws Exception {
        Map<Address, Observation> observations = new LinkedHashMap<>();
        if (!program.getExecutableFormat().equals("Portable Executable (PE)") ||
            !program.getLanguageID().getIdAsString().startsWith("x86:LE:32:")) return observations;
        AddressSet owned = new AddressSet();
        for (Function function : program.getFunctionManager().getFunctions(true)) {
            monitor.checkCancelled();
            owned.add(function.getBody());
        }
        for (Function function : program.getFunctionManager().getFunctions(true)) {
            monitor.checkCancelled();
            List<Address> handlers = registrations(program, function, function.getBody(), monitor);
            if (handlers.isEmpty()) continue;
            List<String> diagnostics = new ArrayList<>();
            List<String> omissions = new ArrayList<>();
            for (int index = 0; index < handlers.size(); index++) {
                Address handler = handlers.get(index);
                monitor.checkCancelled();
                AddressSet previous = new AddressSet(function.getBody());
                String prefix = "Borland-style Win32 SEH registration in function " +
                    function.getEntryPoint() + " identifies handler " + handler + ": ";
                Instruction entry = program.getListing().getInstructionAt(handler);
                boolean included = function.getBody().contains(handler) &&
                    (!externalJump(program, function, entry) ||
                        (rtlVeneer(program, function, entry) &&
                            function.getBody().contains(entry.getMaxAddress().next())));
                String failure = included ? null :
                    !allowMutation ? "Windows P0 does not admit handler body recovery." :
                    recover(program, function, handler, owned, monitor);
                owned.add(function.getBody());
                AddressSet newlyOwned = new AddressSet(function.getBody()).subtract(previous);
                for (Address nested : registrations(program, function, newlyOwned, monitor))
                    if (!handlers.contains(nested)) handlers.add(nested);
                if (failure == null) diagnostics.add(prefix +
                    "handler instructions are included in the Ghidra function body; " +
                    (rtlVeneer(program, function, entry)
                        ? "the continuation after its JMP is derived from the supplied/imported Borland RTL symbol; " : "") +
                    "this is a static registration observation, not proof of runtime execution.");
                else omissions.add(prefix + failure +
                    " Handler callees, strings and instructions may be excluded from function queries.");
            }
            observations.put(function.getEntryPoint(), new Observation(
                List.copyOf(diagnostics), List.copyOf(omissions), List.copyOf(handlers)));
        }
        return observations;
    }

    private static List<Address> registrations(Program program, Function function, AddressSetView scan,
            TaskMonitor monitor) throws Exception {
        List<Address> handlers = new ArrayList<>();
        var listing = program.getListing();
        for (Instruction push : listing.getInstructions(scan, true)) {
            monitor.checkCancelled();
            byte[] bytes = push.getBytes();
            if (bytes.length != 5 || (bytes[0] & 255) != 0x68) continue;
            Instruction savedFrame = listing.getInstructionBefore(push.getAddress());
            if (!adjacent(savedFrame, push) || !function.getBody().contains(savedFrame.getAddress()) ||
                !encoding(savedFrame, 0x55)) continue;
            Instruction oldHead = listing.getInstructionAt(push.getMaxAddress().next());
            Instruction install = oldHead == null ? null :
                listing.getInstructionAt(oldHead.getMaxAddress().next());
            if (install == null || !function.getBody().contains(oldHead.getAddress()) ||
                !function.getBody().contains(install.getAddress())) continue;
            boolean absolute = encoding(oldHead, 0x64, 0xff, 0x35, 0, 0, 0, 0) &&
                encoding(install, 0x64, 0x89, 0x25, 0, 0, 0, 0);
            boolean eax = encoding(oldHead, 0x64, 0xff, 0x30) &&
                encoding(install, 0x64, 0x89, 0x20);
            Instruction zero = listing.getInstructionBefore(savedFrame.getAddress());
            if (!absolute && !(eax && adjacent(zero, savedFrame) &&
                function.getBody().contains(zero.getAddress()) &&
                (encoding(zero, 0x31, 0xc0) || encoding(zero, 0x33, 0xc0)))) continue;
            long offset = Integer.toUnsignedLong((bytes[1] & 255) | (bytes[2] & 255) << 8 |
                (bytes[3] & 255) << 16 | (bytes[4] & 255) << 24);
            Address handler = program.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
            if (!handlers.contains(handler)) handlers.add(handler);
        }
        return handlers;
    }

    private static boolean adjacent(Instruction first, Instruction second) {
        return first != null && first.getMaxAddress().next() != null &&
            first.getMaxAddress().next().equals(second.getAddress());
    }

    private static boolean encoding(Instruction instruction, int... expected) throws Exception {
        if (instruction == null) return false;
        byte[] bytes = instruction.getBytes();
        if (bytes.length != expected.length) return false;
        for (int index = 0; index < bytes.length; index++)
            if ((bytes[index] & 255) != expected[index]) return false;
        return true;
    }

    private static String recover(Program program, Function function, Address handler,
            AddressSet owned, TaskMonitor monitor) throws Exception {
        AddressSet original = new AddressSet(function.getBody());
        if (!original.getMinAddress().getAddressSpace().equals(original.getMaxAddress().getAddressSpace()) ||
            !handler.getAddressSpace().equals(
                function.getEntryPoint().getAddressSpace()) ||
            handler.compareTo(original.getMinAddress()) < 0 ||
            handler.compareTo(original.getMaxAddress()) > 0)
            return "Handler lies outside the observed function body span.";
        MemoryBlock block = program.getMemory().getBlock(handler);
        if (block == null || !block.isInitialized() || !block.isExecute())
            return "Handler does not belong to initialized executable memory.";
        Function owner = program.getFunctionManager().getFunctionContaining(handler);
        if (owner != null && !owner.equals(function))
            return "Handler belongs to an independently identified function.";
        Instruction entry = program.getListing().getInstructionAt(handler);
        if (externalJump(program, function, entry) && !rtlVeneer(program, function, entry))
            return "No supplied Borland RTL identity establishes a continuation after the handler jump.";
        AddressSet allowed = new AddressSet(original.getMinAddress(), original.getMaxAddress());
        for (MemoryBlock region : program.getMemory().getBlocks())
            if (!region.isInitialized() || !region.isExecute()) allowed.delete(region.getStart(), region.getEnd());
        allowed.delete(owned);
        for (var data : program.getListing().getDefinedData(allowed, true)) {
            monitor.checkCancelled();
            allowed.delete(data.getMinAddress(), data.getMaxAddress());
        }
        AddressSet added = new AddressSet();
        var pending = new ArrayDeque<Address>();
        pending.add(handler);
        boolean continuation = false;
        boolean veneer = false;
        while (!pending.isEmpty()) {
            monitor.checkCancelled();
            Address address = pending.removeFirst();
            if (original.contains(address)) {
                Instruction existing = program.getListing().getInstructionAt(address);
                if (address.equals(handler) && rtlVeneer(program, function, existing)) {
                    veneer = true;
                    pending.add(existing.getMaxAddress().next());
                } else continuation = true;
                continue;
            }
            if (added.contains(address)) continue;
            if (!allowed.contains(address)) return "Handler flow crosses a data or ownership boundary.";
            Instruction instruction = program.getListing().getInstructionAt(address);
            if (instruction == null) {
                DisassembleCommand command = new DisassembleCommand(new AddressSet(address), allowed, false);
                command.enableCodeAnalysis(false);
                command.applyTo(program, monitor);
                instruction = program.getListing().getInstructionAt(address);
            }
            if (instruction == null || !allowed.contains(instruction.getMinAddress(), instruction.getMaxAddress()))
                return "Handler flow could not be decoded completely within the unowned gap.";
            added.add(instruction.getMinAddress(), instruction.getMaxAddress());
            var flow = instruction.getFlowType();
            Address[] destinations = instruction.getFlows();
            // Borland's initial JMP calls its RTL through a continuation encoded immediately
            // after the veneer. Do not absorb the shared RTL function into this body.
            if (address.equals(handler) && rtlVeneer(program, function, instruction)) {
                veneer = true;
                pending.add(instruction.getMaxAddress().next());
                continue;
            }
            if (flow.isJump()) {
                if (flow.isComputed() || destinations.length == 0)
                    return "Handler has an unresolved computed jump.";
                pending.addAll(Arrays.asList(destinations));
            }
            Address fallthrough = instruction.getFallThrough();
            if (fallthrough != null) pending.add(fallthrough);
            else if (!flow.isJump()) {
                boolean returns = Arrays.stream(instruction.getPcode()).anyMatch(op ->
                    op.getOpcode() == ghidra.program.model.pcode.PcodeOp.RETURN);
                if (returns) continuation = true;
                else return "Handler instruction " + instruction.getAddress() + " (" +
                    instruction.getMnemonicString() + ") has no decoded continuation.";
            }
        }
        if (!continuation || added.isEmpty() || !veneer)
            return "Handler lacks an identified Borland RTL veneer and a verified body continuation.";
        // The ordinary function-entry analyzer cannot reach exception-only paths.
        // Run Ghidra's own reference producers on the still-unowned decoded gap,
        // before assigning it to the function. Respect the caller's analyzer options.
        var options = program.getOptions(Program.ANALYSIS_PROPERTIES);
        var constants = new ghidra.app.plugin.core.analysis.X86Analyzer();
        if (options.getBoolean(constants.getName(), true) && constants.canAnalyze(program)) {
            constants.optionsChanged(options.getOptions(constants.getName()), program);
            constants.analyzeSet(program, new AddressSet(added), monitor);
        }
        var references = new ghidra.app.plugin.core.analysis.OperandReferenceAnalyzer();
        if (options.getBoolean(references.getName(), true) && references.canAnalyze(program)) {
            references.optionsChanged(options.getOptions(references.getName()), program);
            references.added(program, added, monitor, new ghidra.app.util.importer.MessageLog());
        }
        original.add(added);
        function.setBody(original);
        return null;
    }

    private static boolean rtlVeneer(Program program, Function function, Instruction instruction) {
        if (!externalJump(program, function, instruction)) return false;
        Function target = program.getFunctionManager().getFunctionAt(instruction.getDefaultFlows()[0]);
        if (target == null) return false;
        var source = target.getSymbol().getSource();
        if (source != ghidra.program.model.symbol.SourceType.USER_DEFINED &&
            source != ghidra.program.model.symbol.SourceType.IMPORTED) return false;
        String name = target.getName().replaceFirst("(?i)^system\\.", "").replaceFirst("^[@_]+", "");
        return name.equalsIgnoreCase("HandleAnyException") ||
            name.equalsIgnoreCase("HandleFinally") || name.equalsIgnoreCase("HandleOnException");
    }

    private static boolean externalJump(Program program, Function function, Instruction instruction) {
        if (instruction == null) return false;
        // Ghidra can override this original JMP as CALL_RETURN once an RTL
        // destination has a function seed. The registration identifies the
        // veneer; inspect decoder flow here, not that tail-call interpretation.
        var flow = instruction.getPrototype().getFlowType(instruction.getInstructionContext());
        Address[] targets = instruction.getDefaultFlows();
        if (!flow.isJump() || flow.isConditional() || flow.isComputed() || targets.length != 1) return false;
        Address target = targets[0];
        if (!target.getAddressSpace().equals(function.getEntryPoint().getAddressSpace()) ||
            (target.compareTo(function.getBody().getMinAddress()) >= 0 &&
                target.compareTo(function.getBody().getMaxAddress()) <= 0)) return false;
        MemoryBlock block = program.getMemory().getBlock(target);
        return block != null && block.isInitialized() && block.isExecute() &&
            program.getListing().getDefinedDataContaining(target) == null;
    }
}
