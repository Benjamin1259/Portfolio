import SwiftUI

/// SwiftUI's Text can't render block-level Markdown (headings, lists, rules)
/// with real line breaks — a whole response collapses into one paragraph.
/// This splits Gemini's Markdown output into blocks ourselves and renders
/// each with proper spacing, while still parsing inline bold/italic per line.
private enum MarkdownBlock: Identifiable {
    case heading(String, level: Int)
    case bullet(String)
    case numbered(String, String)
    case paragraph(String)
    case divider

    var id: String {
        switch self {
        case .heading(let text, let level): return "h\(level)-\(text)"
        case .bullet(let text): return "b-\(text)"
        case .numbered(let number, let text): return "n\(number)-\(text)"
        case .paragraph(let text): return "p-\(text)"
        case .divider: return "hr-\(UUID().uuidString)"
        }
    }
}

struct MarkdownBlocksView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Self.parse(text)) { block in
                switch block {
                case .heading(let text, let level):
                    Text(Self.inline(text))
                        .font(level <= 2 ? .headline : .subheadline.weight(.semibold))
                        .padding(.top, 4)
                case .bullet(let text):
                    HStack(alignment: .top, spacing: 6) {
                        Text("•")
                        Text(Self.inline(text))
                    }
                    .font(.callout)
                case .numbered(let number, let text):
                    HStack(alignment: .top, spacing: 6) {
                        Text(number).fontWeight(.semibold)
                        Text(Self.inline(text))
                    }
                    .font(.callout)
                case .paragraph(let text):
                    Text(Self.inline(text))
                        .font(.callout)
                        .lineSpacing(4)
                case .divider:
                    Divider()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Parses inline Markdown (bold/italic/etc.) without touching block
    /// structure — shared by anywhere that renders a short line of AI text.
    static func inline(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }

    private static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }

            if line == "---" || line == "***" {
                blocks.append(.divider)
            } else if line.hasPrefix("#### ") {
                blocks.append(.heading(String(line.dropFirst(5)), level: 4))
            } else if line.hasPrefix("### ") {
                blocks.append(.heading(String(line.dropFirst(4)), level: 3))
            } else if line.hasPrefix("## ") {
                blocks.append(.heading(String(line.dropFirst(3)), level: 2))
            } else if line.hasPrefix("# ") {
                blocks.append(.heading(String(line.dropFirst(2)), level: 1))
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") {
                blocks.append(.bullet(String(line.dropFirst(2))))
            } else if let match = line.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
                let number = line[line.startIndex..<match.upperBound].trimmingCharacters(in: .whitespaces)
                blocks.append(.numbered(number, String(line[match.upperBound...])))
            } else {
                blocks.append(.paragraph(line))
            }
        }

        return blocks
    }
}
