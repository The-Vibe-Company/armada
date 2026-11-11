import SwiftUI

/// Code-only email sign-in over Armada's `auth/email/start` and `auth/email/verify`, through
/// ArmadaKit. The email's link targets the CLI's loopback flow and is not an app callback, so the
/// screen asks for the code it contains. No password, provider key or browser callback.
struct SignInView: View {
    @Environment(AppModel.self) private var model

    private enum Step: Equatable {
        case email
        case code(email: String)
    }

    @State private var step: Step = .email
    @State private var email = ""
    @State private var code = ""
    @State private var busy = false
    @State private var error: String?
    @State private var resent = false
    @FocusState private var focused: Field?

    private enum Field { case email, code }

    var body: some View {
        ArmadaBackdrop {
            ScrollView {
                VStack(spacing: 28) {
                    Spacer(minLength: 56)
                    brand
                    if let notice = model.signInNotice, step == .email {
                        InlineBanner(text: notice, style: .warning)
                    }
                    form
                    Text("Use the same account as the Armada dashboard and CLI.")
                        .font(.footnote)
                        .foregroundStyle(ArmadaTheme.textSecondary)
                        .multilineTextAlignment(.center)
                    Spacer(minLength: 32)
                }
                .frame(maxWidth: 500)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .onAppear { focused = .email }
    }

    private var brand: some View {
        VStack(spacing: 14) {
            ArmadaMarkTile(size: 82)
            VStack(spacing: 6) {
                Text("Armada")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(ArmadaTheme.textPrimary)
                Text("Sign in to manage your sandboxes.")
                    .font(.subheadline)
                    .foregroundStyle(ArmadaTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var form: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch step {
            case .email:
                emailFields
            case .code(let address):
                codeFields(address)
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(ArmadaTheme.dangerText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Sign-in error: \(error)")
                    .accessibilityIdentifier("login.error")
            }
        }
        .padding(20)
        .armadaCard()
    }

    @ViewBuilder
    private var emailFields: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Email")
                .font(.subheadline.weight(.medium))
            TextField("you@company.com", text: $email)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .submitLabel(.send)
                .focused($focused, equals: .email)
                .onSubmit(sendEmail)
                .armadaField()
                .accessibilityIdentifier("login.email")
        }
        Button(action: sendEmail) {
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Text(busy ? "Sending…" : "Email Me a Code")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(busy || !Self.looksLikeEmail(email))
        .accessibilityIdentifier("login.send-code")
    }

    @ViewBuilder
    private func codeFields(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Check your email")
                .font(.headline)
            Text("Armada sent a sign-in code to \(address). Type the code here; do not open a sign-in link before entering the code.")
                .font(.subheadline)
                .foregroundStyle(ArmadaTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        VStack(alignment: .leading, spacing: 7) {
            Text("Code")
                .font(.subheadline.weight(.medium))
            TextField("6 to 10 digits", text: $code)
                .textContentType(.oneTimeCode)
                .keyboardType(.numberPad)
                .font(.title3.monospacedDigit())
                .focused($focused, equals: .code)
                .armadaField()
                .accessibilityIdentifier("login.code")
        }
        Button(action: verify) {
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Text(busy ? "Signing in…" : "Sign In")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .controlSize(.large)
        .disabled(busy || !Self.isCode(code))
        .accessibilityIdentifier("login.submit")
        HStack {
            Button("Use another email") {
                step = .email
                code = ""
                error = nil
                focused = .email
            }
            Spacer()
            Button(resent ? "Code sent again" : "Send a new code") {
                resend(to: address)
            }
            .disabled(busy || resent)
        }
        .font(.footnote.weight(.medium))
        .buttonStyle(.borderless)
        .frame(minHeight: 44)
    }

    private func sendEmail() {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, Self.looksLikeEmail(address) else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.startEmailLogin(email: address)
            busy = false
            if let failure {
                error = failure
            } else {
                resent = false
                step = .code(email: address)
                focused = .code
            }
        }
    }

    private func resend(to address: String) {
        busy = true
        error = nil
        Task {
            let failure = await model.startEmailLogin(email: address)
            busy = false
            if let failure { error = failure } else { resent = true }
        }
    }

    private func verify() {
        guard case .code(let address) = step, !busy else { return }
        let digits = code.filter { !$0.isWhitespace }
        guard Self.isCode(digits) else { return }
        busy = true
        error = nil
        Task {
            let failure = await model.verifyEmail(email: address, code: digits)
            busy = false
            if let failure {
                error = failure
                code = ""
                focused = .code
            }
        }
    }

    /// Mirrors `assertEmailCode`: 6 to 10 digits once whitespace is removed.
    static func isCode(_ value: String) -> Bool {
        let digits = value.filter { !$0.isWhitespace }
        return (6...10).contains(digits.count) && digits.allSatisfy(\.isASCII) && digits.allSatisfy(\.isNumber)
    }

    static func looksLikeEmail(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = trimmed.firstIndex(of: "@") else { return false }
        return at != trimmed.startIndex && trimmed[trimmed.index(after: at)...].contains(".")
    }
}

#if DEBUG
#Preview("Sign in") {
    SignInView()
        .environment(AppModel.preview(phase: .signedOut))
}
#endif
