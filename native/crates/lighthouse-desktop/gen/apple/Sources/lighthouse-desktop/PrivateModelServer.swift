// PrivateModelServer.swift — Tier-1 on-device private-model backend (iOS).
//
// docs/ios-private-model.md §5 (the loopback bridge). The "private, on-device
// model" is defined by ONE contract, not a platform: the OpenAI-compatible
// `/v1/chat/completions` (streaming SSE deltas) + `/health` pair the engine
// speaks at `local_llm_url()` (lighthouse-core/src/llm.rs). On desktop a
// supervised llama-server answers that URL; on iOS THIS file answers the SAME
// contract IN-PROCESS behind Apple Foundation Models, so the engine's local
// branch streams identically on device with ZERO core change.
//
// Kept deliberately THIN — API + plumbing only, no business logic (the
// lighthouse-desktop grep-verify convention): parse the OpenAI request, run a
// `LanguageModelSession`, DIFF Foundation Models' cumulative snapshots (§3.2)
// into the deltas the contract expects, and never surface a raw error — an
// overflow (§3.4) or guardrail refusal ends the stream as an EMPTY completion
// so the engine falls back to its extractive narration.
//
// Exposed to Rust as one C symbol (`lighthouse_fm_ensure`, @_cdecl) that both
// probes availability AND ensures the loopback server is running. Foundation
// Models is Swift-only (no C API); the whole file compiles only on iOS and
// only touches Foundation Models where the SDK provides it and the OS is new
// enough — everything else degrades to "unavailable".

#if os(iOS)

import Foundation
import Network

#if canImport(FoundationModels)
import FoundationModels
#endif

// Result codes shared with the Rust side (commands.rs::ios_private_model_*).
// 1 = available (server running, *outPort valid). <= 0 = unavailable, the value
// distinguishing the honest reason the roster shows.
private let FM_AVAILABLE: Int32 = 1
private let FM_AI_NOT_ENABLED: Int32 = 0 // Apple Intelligence off
private let FM_DEVICE_INELIGIBLE: Int32 = -1 // hardware not eligible
private let FM_MODEL_NOT_READY: Int32 = -2 // still downloading / preparing
private let FM_OS_TOO_OLD: Int32 = -3 // the RUNTIME OS is < iOS 26
private let FM_UNAVAILABLE_OTHER: Int32 = -4 // future/unknown reason
private let FM_SERVER_FAILED: Int32 = -5 // available, but the listener failed
private let FM_BUILD_UNSUPPORTED: Int32 = -6 // compiled without FM support — a BUILD defect, never the phone's OS

/// In-process HTTP/1.1 loopback responder backing the private-model contract.
/// One shared instance for the app; the listener binds once and is reused.
final class PrivateModelServer {
    static let shared = PrivateModelServer()

    private let lock = NSLock()
    private let queue = DispatchQueue(label: "app.lhvault.private-model", attributes: .concurrent)
    private var listener: NWListener?
    private var boundPort: UInt16?

    private init() {}

    /// Idempotent probe-and-ensure. Returns a result code; on `FM_AVAILABLE`
    /// writes the bound loopback port through `outPort`. Safe to call repeatedly
    /// (startup + first ask + UI refresh): once bound it just returns the port.
    func ensure(_ outPort: UnsafeMutablePointer<UInt16>) -> Int32 {
        lock.lock()
        defer { lock.unlock() }

        if let port = boundPort {
            outPort.pointee = port
            return FM_AVAILABLE
        }

        let availability = availabilityCode()
        if availability != FM_AVAILABLE {
            return availability
        }

        guard let port = startListener() else {
            return FM_SERVER_FAILED
        }
        boundPort = port
        outPort.pointee = port
        return FM_AVAILABLE
    }

    // MARK: - Availability

    private func availabilityCode() -> Int32 {
        #if canImport(FoundationModels)
        if #available(iOS 26, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return FM_AVAILABLE
            case .unavailable(let reason):
                switch reason {
                case .appleIntelligenceNotEnabled:
                    return FM_AI_NOT_ENABLED
                case .deviceNotEligible:
                    return FM_DEVICE_INELIGIBLE
                case .modelNotReady:
                    return FM_MODEL_NOT_READY
                @unknown default:
                    return FM_UNAVAILABLE_OTHER
                }
            @unknown default:
                return FM_UNAVAILABLE_OTHER
            }
        } else {
            return FM_OS_TOO_OLD
        }
        #else
        // Built against an SDK without Foundation Models — a BUILD defect
        // (0.13.8 field lesson: never blame the phone's OS for it).
        return FM_BUILD_UNSUPPORTED
        #endif
    }

    // MARK: - Listener

    /// Bind an ephemeral port on 127.0.0.1 and wait (briefly) for it to be
    /// ready so the caller gets a usable port synchronously. Loopback-only via
    /// `requiredLocalEndpoint`; nothing is ever advertised (no Bonjour).
    private func startListener() -> UInt16? {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: 0)

        guard let listener = try? NWListener(using: params) else { return nil }
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        var readyPort: UInt16?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                readyPort = listener.port?.rawValue
                ready.signal()
            case .failed(_), .cancelled:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        // Tier-1 weights are resident, so binding a loopback socket is instant;
        // 3s is a generous ceiling that keeps startup honest if it is not.
        _ = ready.wait(timeout: .now() + 3.0)
        return readyPort
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(connection, buffer: Data())
    }

    // MARK: - Minimal HTTP/1.1 request parse

    private func receiveRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) {
            [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if error != nil {
                connection.cancel()
                return
            }
            var buf = buffer
            if let data = data { buf.append(data) }

            if let headerEnd = Self.headerTerminator(in: buf) {
                let head = buf.subdata(in: 0 ..< headerEnd.lowerBound)
                let (method, path, contentLength) = Self.parseHead(head)
                let bodyStart = headerEnd.upperBound
                let available = buf.count - bodyStart
                if available >= contentLength {
                    let body = contentLength > 0
                        ? buf.subdata(in: bodyStart ..< (bodyStart + contentLength))
                        : Data()
                    self.route(connection, method: method, path: path, body: body)
                    return
                }
            }

            if isComplete {
                connection.cancel()
                return
            }
            self.receiveRequest(connection, buffer: buf)
        }
    }

    /// Byte range of the CRLFCRLF that ends the header block, if present.
    private static func headerTerminator(in data: Data) -> Range<Int>? {
        let marker = Data([0x0d, 0x0a, 0x0d, 0x0a]) // \r\n\r\n
        return data.range(of: marker)
    }

    /// Returns (method, path, Content-Length). Tolerant: unknown headers and
    /// casing are ignored; a missing/blank Content-Length reads as 0.
    private static func parseHead(_ head: Data) -> (String, String, Int) {
        guard let text = String(data: head, encoding: .utf8) else { return ("", "", 0) }
        let lines = text.components(separatedBy: "\r\n")
        var method = ""
        var path = ""
        if let requestLine = lines.first {
            let parts = requestLine.split(separator: " ")
            if parts.count >= 2 {
                method = String(parts[0])
                path = String(parts[1])
            }
        }
        var contentLength = 0
        for line in lines.dropFirst() {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                let value = String(line.dropFirst("content-length:".count))
                    .trimmingCharacters(in: .whitespaces)
                contentLength = Int(value) ?? 0
            }
        }
        return (method, path, contentLength)
    }

    // MARK: - Routing

    private func route(_ connection: NWConnection, method: String, path: String, body: Data) {
        // Strip any query string.
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if method == "GET", route == "/health" {
            // Any non-503 status reads as Ready in local_health(); 200 is honest.
            // §32 §7 ADVERTISE: the body carries the model's context window so
            // the engine's §1 tier resolution can pick apple-fm-4096 vs -8192
            // from measurement, not assumption. KEEP IN SYNC with the
            // contextSize parse in llm.rs::local_health / llm.ts::localHealth.
            sendSimple(
                connection,
                status: "200 OK",
                contentType: "application/json",
                body: "{\"status\":\"ok\",\"contextSize\":\(Self.contextWindowSize())}"
            )
            return
        }
        if method == "POST", route == "/v1/chat/completions" {
            streamCompletion(connection, body: body)
            return
        }
        sendSimple(connection, status: "404 Not Found", contentType: "text/plain", body: "not found")
    }

    // MARK: - §32 §7: window facts + the two-layer overflow defense

    /// The on-device model's context window, in tokens. iOS 26 Foundation
    /// Models documents a 4,096-token window shared between prompt and
    /// answer; when a future SDK exposes the size (or an 8,192 window)
    /// directly, read it here — the /health advertisement and the pre-check
    /// both follow automatically. Deliberately a static fact, not a guess.
    static func contextWindowSize() -> Int { 4096 }

    /// Answer room the pre-check protects (the engine's §1 narration reserve
    /// for the 4k tier — KEEP IN SYNC with budget.rs output_reserve).
    static func outputReserve() -> Int { 900 }

    /// Estimated prompt tokens (chars/4 — the engine's §1 estimator). The
    /// exact `tokenCount(for:)` API is not in the stable-signature set this
    /// file deliberately sticks to across the iOS 26/27 SDKs; when it
    /// stabilizes, swap the estimate for the measurement here — the engine's
    /// 90%-budget margin absorbs the estimator's drift meanwhile.
    static func estimatedTokens(_ prompt: String) -> Int { prompt.count / 4 }

    /// §7 OBSERVE: a terminal SSE frame the engine can tell apart from a
    /// clean end — `{"lighthouse":{"final":"FM_OVERFLOW"|"FM_GUARDRAIL"}}`.
    /// It carries no `choices`, so an SSE consumer that only reads deltas
    /// ignores it; the engine's local dialect watches for it and renders the
    /// honest footer + bumps the local diagnostics counter.
    private func sendFinalMarker(_ connection: NWConnection, kind: String) {
        send(connection, string: "data: {\"lighthouse\":{\"final\":\"\(kind)\"}}\n\n", done: false)
    }

    // MARK: - Streaming completion (snapshot -> delta)

    private func streamCompletion(_ connection: NWConnection, body: Data) {
        // 200 headers go out immediately: an overflow/guardrail must NEVER read
        // as an HTTP error to the engine — it reads as a clean, empty stream.
        let headers = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: text/event-stream\r\n"
            + "Cache-Control: no-cache\r\n"
            + "Connection: close\r\n\r\n"
        send(connection, string: headers, done: false)

        let prompt = Self.buildPrompt(fromBody: body)

        // §7 EXACT PRE-CHECK (second layer after the engine's 90% budget):
        // an oversized prompt is REFUSED before Foundation Models is ever
        // called — the marker tells the engine exactly why the stream is
        // empty, instead of burning the model's time on a doomed call.
        if Self.estimatedTokens(prompt)
            > Self.contextWindowSize() - Self.outputReserve()
        {
            sendFinalMarker(connection, kind: "FM_OVERFLOW")
            finishStream(connection)
            return
        }

        #if canImport(FoundationModels)
        if #available(iOS 26, *), !prompt.isEmpty {
            Task { [weak self] in
                guard let self = self else { return }
                var sent = ""
                do {
                    // One plain session, prompt-only: Apple documents
                    // `instructions` as a system prompt merely PREPENDED to the
                    // prompt text (buildPrompt already folds the engine's system
                    // block in at the front), so this is behaviourally the same
                    // while calling only the no-arg initializer + String
                    // `streamResponse` — the two signatures that are stable
                    // across the iOS 26/27 FoundationModels SDKs.
                    let session = LanguageModelSession()
                    let stream = session.streamResponse(to: prompt)
                    // Elements are CUMULATIVE snapshots (§3.2); diff into deltas
                    // so the OpenAI-compatible contract sees forward tokens only.
                    for try await snapshot in stream {
                        let cumulative = snapshot.content
                        guard cumulative.count > sent.count, cumulative.hasPrefix(sent) else {
                            // Non-append revision (rare for text) — rebaseline
                            // without emitting; the engine appends, so we only
                            // ever forward monotonic growth.
                            sent = cumulative
                            continue
                        }
                        let delta = String(cumulative.dropFirst(sent.count))
                        sent = cumulative
                        if !delta.isEmpty {
                            self.sendDelta(connection, delta: delta)
                        }
                    }
                } catch {
                    // §7 OBSERVE: the empty catch becomes an HONEST catch. The
                    // stream still ends cleanly (never a 500, never raw error
                    // text), but a terminal marker now tells the engine WHICH
                    // silence this is: window overflow, guardrail refusal, or
                    // a plain failure (no marker — the engine's extractive
                    // fallback reads it as before).
                    let desc = String(describing: error).lowercased()
                    if desc.contains("context") || desc.contains("exceed") {
                        self.sendFinalMarker(connection, kind: "FM_OVERFLOW")
                    } else if desc.contains("guardrail") || desc.contains("unsafe")
                        || desc.contains("safety")
                    {
                        self.sendFinalMarker(connection, kind: "FM_GUARDRAIL")
                    }
                }
                self.finishStream(connection)
            }
            return
        }
        #endif

        // Foundation Models not usable at request time (should not happen — the
        // listener only runs when available) → empty completion, clean fallback.
        finishStream(connection)
    }

    /// Fold the OpenAI messages into a single prompt string for Foundation
    /// Models. The engine's SYSTEM_PROMPT (grounding rules) is the system block
    /// and leads; the conversation (prior turns + the final user block, which
    /// already carries the numbered context + question from the engine's
    /// `build_prompt`) follows in order. Apple documents `instructions` as a
    /// system prompt that is simply prepended to the prompt text, so folding it
    /// in here is behaviourally equivalent while keeping the on-device call on
    /// the initializer whose signature is stable across the iOS 26/27 SDKs. The
    /// model receives the engine's system + user text byte-for-byte (PARITY:
    /// only the transport framing is local; the text itself is the engine's,
    /// unchanged).
    private static func buildPrompt(fromBody body: Data) -> String {
        guard
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
            let messages = object["messages"] as? [[String: Any]]
        else {
            return ""
        }
        var blocks: [String] = []
        for message in messages {
            let role = (message["role"] as? String) ?? ""
            let content = (message["content"] as? String) ?? ""
            if content.isEmpty { continue }
            switch role {
            case "assistant":
                blocks.append("Assistant: \(content)")
            default:
                // system leads, user/other turns follow — order preserved.
                blocks.append(content)
            }
        }
        return blocks.joined(separator: "\n\n")
    }

    // MARK: - SSE framing

    private func sendDelta(_ connection: NWConnection, delta: String) {
        // JSONSerialization guarantees the delta is escaped correctly (quotes,
        // newlines, backslashes) inside the frame the engine's sse_deltas reads.
        let payload: [String: Any] = ["choices": [["delta": ["content": delta]]]]
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        send(connection, string: "data: \(json)\n\n", done: false)
    }

    private func finishStream(_ connection: NWConnection) {
        // Terminal SSE sentinel, then FIN. sse_deltas treats an empty stream as
        // "no local answer" → extractive fallback; a populated one as the answer.
        let done = "data: [DONE]\n\n"
        send(connection, string: done, done: true)
    }

    private func send(_ connection: NWConnection, string: String, done: Bool) {
        let data = string.data(using: .utf8) ?? Data()
        connection.send(
            content: data,
            contentContext: .defaultMessage,
            isComplete: done,
            completion: .contentProcessed { _ in
                if done { connection.cancel() }
            }
        )
    }

    private func sendSimple(_ connection: NWConnection, status: String, contentType: String, body: String) {
        let bodyData = body.data(using: .utf8) ?? Data()
        let response = "HTTP/1.1 \(status)\r\n"
            + "Content-Type: \(contentType)\r\n"
            + "Content-Length: \(bodyData.count)\r\n"
            + "Connection: close\r\n\r\n"
            + body
        send(connection, string: response, done: true)
    }
}

// MARK: - C ABI exposed to Rust

/// Probe availability AND ensure the loopback server is running. Returns a
/// result code (see the FM_* constants, mirrored in commands.rs); on success
/// writes the bound 127.0.0.1 port through `outPort`. Called from Rust's
/// `private_model_availability` command and the iOS startup hook.
@_cdecl("lighthouse_fm_ensure")
func lighthouse_fm_ensure(_ outPort: UnsafeMutablePointer<UInt16>) -> Int32 {
    return PrivateModelServer.shared.ensure(outPort)
}

// MARK: - ObjC-runtime bridge (the lookup that cannot be stripped)

/// 0.13.9: the dlsym route above proved unreliable in release archives ON
/// DEVICE — the 0.13.8 field report (iPhone 17, iOS 26.5.2, SDK 26.5) still
/// read the symbol-absent verdict even with `-exported_symbol` pinning the
/// export-trie entry at link time. The Objective-C runtime is the lookup that
/// cannot break this way: class metadata lives in `__objc_classlist` and is
/// found BY NAME at runtime — no symbol table, no export trie, no dead-strip
/// exposure. Rust resolves `objc_getClass("LHFMBridge")` +
/// `+[LHFMBridge ensure:]` FIRST and keeps dlsym only as a fallback. The
/// explicit @objc names pin the runtime contract against Swift renames; the
/// ios-build tripwire asserts this class boarded the shipped binary.
@objc(LHFMBridge)
final class LHFMBridge: NSObject {
    @objc(ensure:)
    static func ensure(_ outPort: UnsafeMutablePointer<UInt16>) -> Int32 {
        return PrivateModelServer.shared.ensure(outPort)
    }
}

#endif
