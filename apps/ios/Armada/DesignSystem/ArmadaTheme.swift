import SwiftUI
import UIKit

/// The native palette, carried over from Companion `8e01b209` (`CompanionAppearancePalette`): dynamic
/// code-defined colors that follow the system appearance, system typography and hairlines. Armada
/// adds only its brand colors, used by the mark and nowhere that needs text contrast.
enum ArmadaTheme {
    static let canvas = adaptive(light: 0xFFFFFF, dark: 0x000000)
    static let card = adaptive(light: 0xF2F2F7, dark: 0x1C1C1E)
    static let botBubble = adaptive(light: 0xEFEFF1, dark: 0x1C1C1E)
    static let innerBubble = adaptive(light: 0xFFFFFF, dark: 0x1C1C1E)
    static let chip = adaptive(light: 0xEFEFF1, dark: 0x1C1C1E)
    static let userBubble = adaptive(light: 0x0B0B0F, dark: 0xFFFFFF)
    static let userBubbleText = adaptive(light: 0xFFFFFF, dark: 0x000000)
    static let textPrimary = adaptive(light: 0x111111, dark: 0xF2F2F7)
    /// Companion's #8E8E93 in dark mode; darkened in light mode so small text keeps 4.5:1 on the
    /// canvas and cards.
    static let textSecondary = adaptive(light: 0x6A6A6F, dark: 0x8E8E93)
    static let separator = adaptive(light: 0xE5E5EA, dark: 0x38383A)
    static let primaryCTA = adaptive(light: 0x0B0B0F, dark: 0xFFFFFF)
    static let primaryCTAText = adaptive(light: 0xFFFFFF, dark: 0x000000)
    static let actionBlue = color(0x007AFF)
    // Small inline links need 4.5:1 against the pale assistant bubble as well as white.
    static let linkBlue = adaptive(light: 0x0066CC, dark: 0x0A84FF)
    static let userBubbleLink = adaptive(light: 0x0A84FF, dark: 0x007AFF)
    static let live = color(0x34C759)
    static let danger = color(0xFF3B30)
    static let warning = color(0xFF9500)

    // Text variants keep the semantic hue while meeting small-text contrast on light surfaces.
    static let dangerText = adaptive(light: 0xC21429, dark: 0xFF3B30)
    static let successText = adaptive(light: 0x10733B, dark: 0x34C759)
    static let warningText = adaptive(light: 0x955000, dark: 0xFF9500)

    // The Armada mark ("Formation", `apps/dashboard/src/app/icon.svg`): five agents in a V.
    static let brandNight = color(0x0F1012)
    static let brandLead = color(0xB6F15A)
    static let brandBone = color(0xF0EFEC)

    static func tone(_ tone: StatusTone) -> Color {
        switch tone {
        case .live: live
        case .ready: successText
        case .transitioning: warning
        case .error: danger
        case .inactive: textSecondary
        }
    }

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            UIColor(armadaRGB: traits.userInterfaceStyle == .dark ? dark : light)
        })
    }

    private static func color(_ rgb: UInt32) -> Color {
        Color(uiColor: UIColor(armadaRGB: rgb))
    }
}

private extension UIColor {
    convenience init(armadaRGB rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}
