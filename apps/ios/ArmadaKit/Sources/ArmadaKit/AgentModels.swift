import Foundation

/// Unknown tool payloads retain their JSON value, never reinterpret as instructions.
public enum JSONValue: Codable, Sendable, Equatable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}
public struct AgentToolCall: Decodable, Sendable, Identifiable {
    public struct Result: Decodable, Sendable { public let output: JSONValue; public let isError: Bool }
    public let id: String
    public let name: String
    public let input: JSONValue?
    public let result: Result?
}
public struct AgentEvent: Decodable, Sendable, Identifiable {
    public enum Body: Sendable {
        case prompt(text: String, status: String, reason: String?)
        case message(text: String, partial: Bool, messageId: String?, textMode: String?, model: String?, tools: [AgentToolCall])
        case steer(text: String, mode: String?)
        case other(type: String, data: JSONValue)
        case unknown(kind: String, payload: JSONValue)
    }
    public let id: String
    public let at: Double
    public let conversationId: String?
    public let promptId: String?
    public let body: Body
    private enum K: String, CodingKey { case id, at, conversationId, promptId, kind, text, status, reason, partial, messageId, textMode, model, tools, mode, type, data }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = try c.decode(String.self, forKey: .id); at = try c.decode(Double.self, forKey: .at)
        conversationId = try c.decodeIfPresent(String.self, forKey: .conversationId)
        promptId = try c.decodeIfPresent(String.self, forKey: .promptId)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "prompt": body = .prompt(text: try c.decode(String.self, forKey: .text), status: try c.decode(String.self, forKey: .status), reason: try c.decodeIfPresent(String.self, forKey: .reason))
        case "message": body = .message(text: try c.decode(String.self, forKey: .text), partial: try c.decode(Bool.self, forKey: .partial), messageId: try c.decodeIfPresent(String.self, forKey: .messageId), textMode: try c.decodeIfPresent(String.self, forKey: .textMode), model: try c.decodeIfPresent(String.self, forKey: .model), tools: try c.decode([AgentToolCall].self, forKey: .tools))
        case "steer": body = .steer(text: try c.decode(String.self, forKey: .text), mode: try c.decodeIfPresent(String.self, forKey: .mode))
        // `data: unknown` is omitted from JSON when undefined; keep the event rather than fail the page.
        case "other": body = .other(type: try c.decode(String.self, forKey: .type), data: try c.decodeIfPresent(JSONValue.self, forKey: .data) ?? .null)
        default: body = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }
}
