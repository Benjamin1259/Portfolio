import SwiftUI

/// Circular ring gauge showing a 0–100 quality score, color-coded with a
/// qualitative label underneath.
struct QualityGauge: View {
    let score: Int

    private var progress: Double {
        Double(min(max(score, 0), 100)) / 100
    }

    private var color: Color {
        switch score {
        case ..<40: return .red
        case 40..<70: return .orange
        default: return .green
        }
    }

    private var label: String {
        switch score {
        case ..<40: return "Needs Work"
        case 40..<70: return "Getting There"
        case 70..<90: return "Good"
        default: return "Excellent"
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle()
                    .stroke(Color.gray.opacity(0.15), lineWidth: 14)

                Circle()
                    .trim(from: 0, to: progress)
                    .stroke(color, style: StrokeStyle(lineWidth: 14, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.6), value: progress)

                VStack(spacing: 0) {
                    Text("\(score)")
                        .font(.system(size: 36, weight: .bold, design: .rounded))
                    Text("/ 100")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(width: 150, height: 150)

            Text(label)
                .font(.headline)
                .foregroundStyle(color)
        }
    }
}
