import Foundation

/// One committed SSE frame emitted by `GET /api/v1/events`.
public struct SandboxStreamFrame: Decodable, Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case runtimeEvent(AgentEvent?), transition(status: String?, statusReason: String?), unknown(String) }
    public let id: String, sandboxId: String, sequence: String?, ref: String, createdAt: String, kind: Kind
    private enum CodingKeys: String, CodingKey { case id, sandboxId, sequence, kind, ref, createdAt, event, status, statusReason }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); sandboxId = try c.decode(String.self, forKey: .sandboxId)
        sequence = try c.decodeIfPresent(String.self, forKey: .sequence); ref = try c.decode(String.self, forKey: .ref); createdAt = try c.decode(String.self, forKey: .createdAt)
        switch try c.decode(String.self, forKey: .kind) {
        case "runtime_event": kind = .runtimeEvent(try? c.decodeIfPresent(AgentEvent.self, forKey: .event))
        case "transition": kind = .transition(status: try c.decodeIfPresent(String.self, forKey: .status), statusReason: try c.decodeIfPresent(String.self, forKey: .statusReason))
        case let other: kind = .unknown(other)
        }
    }
}
public enum SandboxStreamEvent: Sendable, Equatable { case connected, frame(SandboxStreamFrame) }
struct SSEFrameParser: Sendable {
    private static let maxLineBytes = 4 * 1024 * 1024, maxCursor: UInt64 = 9_223_372_036_854_775_807
    private let sandboxID: String
    private var rawLine: [UInt8] = [], sawCR = false, isFirstLine = true, frameID: String? = nil, dataLines: [String] = []
    private(set) var lastEventID: String?
    init(sandboxID: String, lastEventID: String? = nil) { self.sandboxID = sandboxID.lowercased(); self.lastEventID = lastEventID }
    static func isValidCursorID(_ v: String) -> Bool {
        !v.isEmpty && v.count <= 19 && v.allSatisfy { $0.isASCII && $0.isNumber } && (v.count == 1 || v.first != "0") && (UInt64(v).map { $0 <= maxCursor } ?? false)
    }
    mutating func feed(_ data: Data) throws -> [SandboxStreamFrame] {
        var frames: [SandboxStreamFrame] = []
        for byte in data {
            if sawCR { sawCR = false; if byte == 0x0A { continue } }
            if byte == 0x0D || byte == 0x0A { if byte == 0x0D { sawCR = true }; if let frame = try finishLine() { frames.append(frame) } }
            else { guard rawLine.count < Self.maxLineBytes else { throw ArmadaError.invalidResponse }; rawLine.append(byte) }
        }
        return frames
    }
    private mutating func finishLine() throws -> SandboxStreamFrame? {
        if isFirstLine { isFirstLine = false; if rawLine.starts(with: [0xEF, 0xBB, 0xBF]) { rawLine.removeFirst(3) } }
        let line = String(decoding: rawLine, as: UTF8.self); rawLine.removeAll(keepingCapacity: true)
        if line.isEmpty {
            let currentID = frameID; frameID = nil; guard !dataLines.isEmpty else { return nil }
            let payload = dataLines.joined(separator: "\n"); dataLines.removeAll(keepingCapacity: true)
            guard let frame = try? JSONDecoder().decode(SandboxStreamFrame.self, from: Data(payload.utf8)),
                  frame.sandboxId.lowercased() == sandboxID, Self.isValidCursorID(frame.id),
                  currentID == nil || currentID == frame.id else { throw ArmadaError.invalidResponse }
            if let prev = lastEventID.flatMap(UInt64.init), let next = UInt64(frame.id), next <= prev { return nil }
            lastEventID = frame.id; return frame
        }
        if line.hasPrefix(":") { return nil }
        let colon = line.firstIndex(of: ":"), field = colon.map { line[..<$0] } ?? line[...]
        var value = colon.map { line[line.index(after: $0)...] } ?? ""; if value.first == " " { value = value.dropFirst() }
        if field == "id", !value.contains("\0") { frameID = String(value) } else if field == "data" { dataLines.append(String(value)) }
        return nil
    }
}

extension ArmadaClient {
    /// Streams live inline SSE events from `GET /api/v1/events` (`cursor=tail` or `Last-Event-ID`).
    public nonisolated func streamSandboxEvents(id: String, cursor: String? = "tail", lastEventID: String? = nil) -> AsyncThrowingStream<SandboxStreamEvent, Error> {
        AsyncThrowingStream { c in
            let task = Task {
                do {
                    let ctx = try await self.streamContext(sandboxID: id, cursor: cursor, lastEventID: lastEventID)
                    var parser = SSEFrameParser(sandboxID: id, lastEventID: lastEventID)
                    for try await item in self.transport.stream(ctx.request) {
                        try Task.checkCancellation(); guard await self.isCurrentGeneration(ctx.fence) else { throw CancellationError() }
                        switch item {
                        case .response(let http):
                            switch http.statusCode {
                            case 200..<300 where http.value(forHTTPHeaderField: "Content-Type")?.lowercased().contains("text/event-stream") == true: c.yield(.connected)
                            case 200..<300: throw ArmadaError.invalidResponse
                            case 401: throw ArmadaError.signedOut
                            case 403: throw ArmadaError.forbidden
                            case 400: throw ArmadaError.invalidRequest
                            case 500...599: throw ArmadaError.unavailable
                            default: throw ArmadaError.http(http.statusCode)
                            }
                        case .data(let data): for frame in try parser.feed(data) { c.yield(.frame(frame)) }
                        }
                    }
                    c.finish()
                } catch is CancellationError { c.finish(throwing: CancellationError()) } catch let e as URLError where e.code == .cancelled { c.finish(throwing: CancellationError()) } catch let e as ArmadaError { c.finish(throwing: e) } catch { c.finish(throwing: ArmadaError.unavailable) }
            }
            c.onTermination = { @Sendable _ in task.cancel() }
        }
    }
}
