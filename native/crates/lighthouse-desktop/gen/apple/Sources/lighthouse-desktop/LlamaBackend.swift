// LlamaBackend.swift — §42 Tier-2: the in-process GGUF backend (iOS).
//
// docs/ios-private-model.md §4 (§42 refresh). Devices WITHOUT Apple
// Foundation Models get a real private model: Qwen2.5-1.5B-Instruct Q4_K_M
// running in-process through llama.cpp + Metal, behind the SAME loopback
// contract PrivateModelServer serves for Tier-1 — the engine cannot tell the
// backends apart except by the /health advertisement it is meant to read.
//
// Kept deliberately THIN (the grep-verify convention): C-API calls and
// plumbing only. All business rules (what to do on overflow, how budgets
// size prompts) live in the engine; the one policy fact this file owns is
// the §4.3 memory bar, because only the process can measure itself.
//
// Everything compiles ONLY when the llama xcframework is present
// (`canImport(llama)`) — a build without it behaves exactly like today's
// FM-only build, honestly reporting the FM unavailability reason instead of
// offering a download the binary could not serve.

#if os(iOS)

import Foundation

#if canImport(llama)
import llama

/// The Tier-2 backend: model residency, the memory bar, and the decode loop.
/// One shared instance; the model loads lazily on the first completion (the
/// §22.4 warm machinery narrates the wait) and drops on memory pressure.
final class LlamaBackend {
    static let shared = LlamaBackend()

    /// The downloaded artifact — ONE shared name with the Rust download
    /// config (local_model.rs::IOS_TIER2_GGUF; the §42 pin test asserts the
    /// two literals agree). Lives under Application Support with the rest of
    /// the app state (§41 layout): <Application Support>/models/<file>.
    static let modelFileName = "qwen2.5-1.5b-instruct-q4_k_m.gguf"

    /// §4.3: the advertised context — 6144 keeps the KV cache at ~168 MiB
    /// (28 KiB/token, f16) and matches the registered llama-mobile tier.
    static let contextTokens: Int32 = 6_144

    /// §4.3: required AVAILABLE memory before a load is even attempted
    /// (weights ~1,043 MiB + KV 168 MiB + Metal scratch ~250 MiB + margin).
    /// `os_proc_available_memory` is the ONLY truth — the entitlement is a
    /// request the store build may not honor.
    static let loadBarBytes: UInt64 = 1_700 * 1_024 * 1_024

    /// §4.3: the static device bar — a device whose TOTAL RAM cannot clear
    /// the bar even empty (3 GB-class) is never offered the download.
    static let deviceBarBytes: UInt64 = 3_600 * 1_024 * 1_024

    private let lock = NSLock()
    private var model: OpaquePointer? // llama_model *
    private var context: OpaquePointer? // llama_context *

    private init() {}

    // MARK: - The three-state facts ensure() selects on

    static func modelPath() -> URL? {
        guard
            let base = FileManager.default.urls(
                for: .applicationSupportDirectory, in: .userDomainMask
            ).first
        else { return nil }
        return base.appendingPathComponent("models").appendingPathComponent(modelFileName)
    }

    static func modelPresent() -> Bool {
        guard let path = modelPath() else { return false }
        return FileManager.default.fileExists(atPath: path.path)
    }

    static func deviceBelowBar() -> Bool {
        return ProcessInfo.processInfo.physicalMemory < deviceBarBytes
    }

    static func memoryClearsBar() -> Bool {
        // Remaining headroom for THIS process right now (baseline already
        // spent) — the §4.3 pre-load check that never trusts the entitlement.
        return UInt64(os_proc_available_memory()) >= loadBarBytes
    }

    // MARK: - Lazy residency

    /// Load weights if not resident. Returns false on any failure — the
    /// caller ends the stream empty (the engine's extractive fallback), never
    /// crashes. A jetsam/background eviction is survived by the next call
    /// re-initializing (the §22.4 health→respawn semantics, in-process).
    private func ensureLoaded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if context != nil { return true }
        guard Self.memoryClearsBar(), let path = Self.modelPath() else { return false }

        llama_backend_init()
        var mparams = llama_model_default_params()
        mparams.n_gpu_layers = 999 // whole model on Metal
        guard let model = llama_model_load_from_file(path.path, mparams) else {
            return false
        }
        var cparams = llama_context_default_params()
        cparams.n_ctx = UInt32(Self.contextTokens)
        cparams.n_batch = 512
        guard let context = llama_init_from_model(model, cparams) else {
            llama_model_free(model)
            return false
        }
        self.model = model
        self.context = context
        return true
    }

    /// §42 §3: is the model resident right now? /health reports 503 (loading)
    /// until this is true, so the §22.4 warm-wait shows the honest "Private
    /// model warming up… (Ns)" during the REAL weight paging (unlike Tier-1,
    /// whose weights are already resident and warm instantly).
    func isLoaded() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return context != nil
    }

    /// §42 §3: kick the lazy load on a background queue so the weights start
    /// paging the moment the llama listener comes up — the warm-wait then
    /// polls /health and narrates the load instead of the first ask blocking
    /// silently. Idempotent (ensureLoaded is lock-guarded and returns early
    /// when resident).
    func beginLoad() {
        loadQueue.async { [weak self] in
            _ = self?.ensureLoaded()
        }
    }

    private let loadQueue = DispatchQueue(label: "app.lhvault.llama-load")

    /// Drop residency (memory-pressure path; the next ask re-warms).
    func unload() {
        lock.lock()
        defer { lock.unlock() }
        if let context = context { llama_free(context) }
        if let model = model { llama_model_free(model) }
        context = nil
        model = nil
    }

    // MARK: - Streaming completion

    enum StreamEnd {
        case done
        case overflow // context full — the engine's FM_OVERFLOW vocabulary
        case failed
    }

    /// Tokenize → decode → sample, forwarding each detokenized piece to
    /// `onDelta`. Greedy-ish low-temperature sampling: narration wants
    /// faithful prose over a handed table, not creativity.
    func stream(prompt: String, maxTokens: Int32, onDelta: (String) -> Void) -> StreamEnd {
        guard ensureLoaded(), let context = context, let model = model else {
            return .failed
        }
        lock.lock()
        defer { lock.unlock() }

        let vocab = llama_model_get_vocab(model)

        // Tokenize the whole prompt (add BOS; parse special tokens so the
        // chat template's markers survive).
        let utf8 = Array(prompt.utf8)
        var tokens = [llama_token](repeating: 0, count: utf8.count + 8)
        let count = llama_tokenize(
            vocab, prompt, Int32(utf8.count), &tokens, Int32(tokens.count), true, true
        )
        guard count >= 0 else { return .failed }
        tokens.removeSubrange(Int(count)...)

        // The §7-style second belt: a prompt that cannot fit alongside the
        // answer reserve is refused as overflow BEFORE any decode burns time.
        if Int32(tokens.count) + maxTokens > Self.contextTokens {
            return .overflow
        }

        // Fresh conversation per completion — the contract is stateless.
        llama_memory_clear(llama_get_memory(context), true)

        // Prompt ingestion (prefill), batched.
        var pos: Int32 = 0
        let batchCap: Int32 = 512
        var idx = 0
        while idx < tokens.count {
            let n = min(Int(batchCap), tokens.count - idx)
            var chunk = Array(tokens[idx ..< idx + n])
            let batch = llama_batch_get_one(&chunk, Int32(n))
            if llama_decode(context, batch) != 0 { return .failed }
            pos += Int32(n)
            idx += n
        }

        // Sampler chain: temp 0.3 → top-p 0.9 → seeded dist. Low temperature
        // keeps the narration grounded; the seed makes reruns comparable.
        let sparams = llama_sampler_chain_default_params()
        guard let sampler = llama_sampler_chain_init(sparams) else { return .failed }
        defer { llama_sampler_free(sampler) }
        llama_sampler_chain_add(sampler, llama_sampler_init_temp(0.3))
        llama_sampler_chain_add(sampler, llama_sampler_init_top_p(0.9, 1))
        llama_sampler_chain_add(sampler, llama_sampler_init_dist(0x4C48)) // "LH"

        var produced: Int32 = 0
        var pieceBuf = [CChar](repeating: 0, count: 256)
        while produced < maxTokens {
            if pos >= Self.contextTokens {
                return .overflow
            }
            let token = llama_sampler_sample(sampler, context, -1)
            if llama_vocab_is_eog(vocab, token) {
                return .done
            }
            let n = llama_token_to_piece(vocab, token, &pieceBuf, Int32(pieceBuf.count), 0, false)
            if n > 0 {
                let piece = pieceBuf[0 ..< Int(n)].withUnsafeBufferPointer { buf in
                    String(
                        decoding: buf.map { UInt8(bitPattern: $0) },
                        as: UTF8.self
                    )
                }
                if !piece.isEmpty { onDelta(piece) }
            }
            var next = [token]
            let batch = llama_batch_get_one(&next, 1)
            if llama_decode(context, batch) != 0 { return .failed }
            pos += 1
            produced += 1
        }
        return .done
    }
}

#endif // canImport(llama)
#endif // os(iOS)
