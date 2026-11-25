import Foundation

public enum ArmadaError: Error, Sendable, Equatable, LocalizedError {
    case signedOut, forbidden, conflict, unavailable, invalidResponse, secureStorage, invalidOrigin, invalidRequest
    case emailCodeRefused, noRunningTurn
    case http(Int)
    public var errorDescription: String? {
        switch self {
        case .emailCodeRefused: "Could not verify this code. It may be incorrect, expired, or already used. Opening the email link uses up the code. Request a new code and enter it here without opening the link."
        case .signedOut: "Sign in to Armada again."
        case .forbidden: "You do not have access to this resource."
        case .noRunningTurn: "No turn was running, so nothing was delivered. Send your text as a normal message to start a new turn."
        case .conflict: "Armada could not confirm this operation. Refresh its status before retrying."
        case .invalidRequest: "Armada refused this request."
        case .unavailable: "Armada is temporarily unavailable."
        case .invalidResponse: "Armada returned an unsupported response."
        case .secureStorage: "Secure storage is unavailable."
        case .invalidOrigin: "A secure Armada origin is required."
        case .http: "The request could not be completed."
        }
    }
}

public enum ArmadaStreamEvent: Sendable { case response(HTTPURLResponse), data(Data) }

public protocol ArmadaTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    func stream(_ request: URLRequest) -> AsyncThrowingStream<ArmadaStreamEvent, Error>
}

public extension ArmadaTransport {
    func stream(_ request: URLRequest) -> AsyncThrowingStream<ArmadaStreamEvent, Error> { AsyncThrowingStream { $0.finish(throwing: ArmadaError.unavailable) } }
}

/// Ephemeral session: no cookies, credential cache or response cache. Never follows redirects
/// with an Armada bearer (including redirects back to the same host).
public final class URLSessionTransport: ArmadaTransport, Sendable {
    private let session: URLSession

    public init() {
        session = URLSession(configuration: Self.ephemeralConfiguration(),
                             delegate: RedirectDenyingDelegate(), delegateQueue: nil)
    }

    init(configuration: URLSessionConfiguration) {
        session = URLSession(configuration: configuration, delegate: RedirectDenyingDelegate(), delegateQueue: nil)
    }

    static func ephemeralConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        return configuration
    }

    deinit { session.invalidateAndCancel() }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ArmadaError.invalidResponse }
        return (data, http)
    }

    public func stream(_ request: URLRequest) -> AsyncThrowingStream<ArmadaStreamEvent, Error> {
        AsyncThrowingStream { c in
            let task = Task {
                do {
                    let (bytes, response) = try await self.session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else { c.finish(throwing: ArmadaError.invalidResponse); return }
                    c.yield(.response(http))
                    guard (200..<300).contains(http.statusCode) else { c.finish(); return }
                    var chunk: [UInt8] = []; chunk.reserveCapacity(1024)
                    for try await byte in bytes {
                        chunk.append(byte)
                        if byte == 0x0A || chunk.count >= 4096 { c.yield(.data(Data(chunk))); chunk.removeAll(keepingCapacity: true) }
                    }
                    if !chunk.isEmpty { c.yield(.data(Data(chunk))) }
                    c.finish()
                } catch is CancellationError { c.finish(throwing: CancellationError()) } catch let e as URLError where e.code == .cancelled { c.finish(throwing: CancellationError()) } catch { c.finish(throwing: error) }
            }
            c.onTermination = { @Sendable _ in task.cancel() }
        }
    }
}

// URLSession retains its delegate until invalidation. Keep it independent of the transport
// so releasing the transport can invalidate the session, even after cancelled requests.
private final class RedirectDenyingDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct OK: Codable, Sendable { let ok: Bool }
struct Empty: Encodable, Sendable {}

/// Presentation detail is independent of HTTP/admission semantics. Never treat an explained
/// server outage as a definite refusal, or an explained denial as permission to keep content.
public struct ArmadaServerFailure: Error, Sendable, Equatable, LocalizedError {
    public let cause: ArmadaError
    public let explanation: String
    public var errorDescription: String? { explanation }

    public static func underlying(_ error: any Error) -> ArmadaError? {
        (error as? Self)?.cause ?? error as? ArmadaError
    }

    static func explaining(_ cause: ArmadaError, body: Data) -> any Error {
        // Known idle-steer refusals need actionable copy even on older servers.
        if cause == .noRunningTurn { return cause }
        struct Envelope: Decodable {
            struct Detail: Decodable { let code: String; let message: String? }
            let error: Detail
        }
        guard let detail = try? JSONDecoder().decode(Envelope.self, from: body).error,
              !["unknown", "internal", "start_failed", "init_failed", "prompt_failed"].contains(detail.code),
              let message = detail.message.flatMap(SandboxLaunchFailure.oneLine),
              message != detail.code else { return cause }
        return Self(cause: cause, explanation: message)
    }
}
