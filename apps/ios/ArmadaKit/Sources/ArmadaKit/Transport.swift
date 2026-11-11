import Foundation

public enum ArmadaError: Error, Sendable, Equatable, LocalizedError {
    case signedOut, forbidden, conflict, unavailable, invalidResponse, secureStorage, invalidOrigin, invalidRequest
    case emailCodeRefused
    case http(Int)
    public var errorDescription: String? {
        switch self {
        case .emailCodeRefused: "Could not verify this code. It may be incorrect, expired, or already used. Opening the email link uses up the code. Request a new code and enter it here without opening the link."
        case .signedOut: "Sign in to Armada again."
        case .forbidden: "You do not have access to this resource."
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
public final class URLSessionTransport: ArmadaTransport, Sendable {
    private let session: URLSession

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: RedirectDenier(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ArmadaError.invalidResponse }
        return (data, http)
    }
}

// The session retains its delegate, so the delegate must not retain the transport.
private final class RedirectDenier: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
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
