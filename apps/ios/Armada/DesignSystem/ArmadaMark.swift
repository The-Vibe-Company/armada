import SwiftUI

/// The Armada mark as vector geometry, drawn from the same 32-point paths as the dashboard's
/// `icon.svg` and `landing/Mark.tsx`: the lead agent, two flankers and two trailing agents.
struct ArmadaMarkShape: Shape {
    enum Part: CaseIterable {
        case lead
        case flank
        case trail
    }

    let part: Part

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 32
        let origin = CGPoint(
            x: rect.midX - 16 * scale,
            y: rect.midY - 16 * scale
        )
        var path = Path()
        for triangle in Self.triangles(for: part) {
            path.move(to: point(triangle.0, scale: scale, origin: origin))
            path.addLine(to: point(triangle.1, scale: scale, origin: origin))
            path.addLine(to: point(triangle.2, scale: scale, origin: origin))
            path.closeSubpath()
        }
        return path
    }

    private func point(_ value: (CGFloat, CGFloat), scale: CGFloat, origin: CGPoint) -> CGPoint {
        CGPoint(x: origin.x + value.0 * scale, y: origin.y + value.1 * scale)
    }

    private typealias Triangle = ((CGFloat, CGFloat), (CGFloat, CGFloat), (CGFloat, CGFloat))

    private static func triangles(for part: Part) -> [Triangle] {
        switch part {
        case .lead:
            [((16, 4.5), (20, 11.5), (12, 11.5))]
        case .flank:
            [((10, 13), (14, 20), (6, 20)), ((22, 13), (26, 20), (18, 20))]
        case .trail:
            [((4, 21.5), (8, 28.5), (0, 28.5)), ((28, 21.5), (32, 28.5), (24, 28.5))]
        }
    }
}

/// The mark on its night tile, the same composition as the app icon. Decorative unless labeled.
struct ArmadaMarkTile: View {
    var size: CGFloat = 64

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                .fill(ArmadaTheme.brandNight)
            ZStack {
                ArmadaMarkShape(part: .trail).fill(ArmadaTheme.brandBone.opacity(0.45))
                ArmadaMarkShape(part: .flank).fill(ArmadaTheme.brandBone)
                ArmadaMarkShape(part: .lead).fill(ArmadaTheme.brandLead)
            }
            .padding(size * 0.16)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview("Mark") {
    HStack(spacing: 16) {
        ArmadaMarkTile(size: 32)
        ArmadaMarkTile(size: 64)
        ArmadaMarkTile(size: 96)
    }
    .padding()
}
