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
        case .noRunningTurn: "No turn is running. Use send to start one."
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

public protocol ArmadaTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// Ephemeral session: no cookies, credential cache or response cache. Never follows redirects
/// with an Armada bearer (including redirects back to the same host).
public final class URLSessionTransport: NSObject, ArmadaTransport, URLSessionTaskDelegate, Sendable {
    public override init() { super.init() }
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ArmadaError.invalidResponse }
        return (data, http)
    }
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
