import Foundation

enum GeminiError: LocalizedError {
    case missingAPIKey
    case badResponse(String)
    case network(Error)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey:
            return "No Gemini API key set. Add one in Settings."
        case .badResponse(let message):
            return "Gemini request failed: \(message)"
        case .network(let error):
            return "Network error: \(error.localizedDescription)"
        }
    }
}

struct ChatMessage: Identifiable, Codable, Equatable {
    enum Role: String, Codable {
        case user
        case model
    }

    var id = UUID()
    let role: Role
    let text: String
}

/// Talks to the Gemini API to help a PM sharpen a problem statement:
/// spotting vague language, missing evidence, and unstated assumptions.
struct GeminiService {
    /// Below this clarity score, a draft is considered not ready — drives
    /// the readiness graphic and the "Revise Flagged Sections" action.
    static let notReadyThreshold = 50

    private let model = "gemini-3.6-flash"

    private var endpoint: URL {
        URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(model):generateContent")!
    }

    private let systemInstruction = """
    You are a sharp, experienced product thinking partner helping a product \
    manager arrive at a clear, well-framed problem statement — the kind of \
    foundational clarity that any downstream work (design, engineering, \
    prioritization, stakeholder alignment) can be built on. Your goal is not \
    to make this "ready for engineering" specifically; it's to make sure the \
    problem itself is correctly and precisely understood before any work \
    starts. Draw on established product-management problem-framing practices \
    to sharpen your feedback — Jobs-to-be-Done (what job is the user "hiring" \
    a solution to do), the Five Whys for root-causing rather than stopping at \
    symptoms, Amazon's "Working Backwards" discipline of starting from \
    customer impact, well-formed How-Might-We reframing, and the strict \
    separation of problems from solutions. Apply these as your own judgment \
    rather than lecturing about the frameworks by name, unless naming one \
    genuinely helps the PM see what's missing. You are direct but \
    constructive. Push back on vague language, unstated assumptions, and \
    solutions disguised as problems. Ask pointed clarifying questions when \
    something is missing. When the draft is genuinely solid, say so plainly \
    and explain why it gives a clear foundation for whatever work follows. \
    Keep responses focused and skimmable — short paragraphs or bullet \
    points, no filler.
    """

    func send(history: [ChatMessage], frame: ProblemFrame) async throws -> String {
        guard let apiKey = ApiKeyStore.loadAPIKey(), !apiKey.isEmpty else {
            throw GeminiError.missingAPIKey
        }

        var urlComponents = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        urlComponents.queryItems = [URLQueryItem(name: "key", value: apiKey)]

        var request = URLRequest(url: urlComponents.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let contextPreamble = """
        Here is the product manager's current draft of the problem frame. \
        Treat this as shared context, not a message to directly reply to \
        line by line unless asked:

        \(frame.asMarkdown())
        """

        var contents: [[String: Any]] = [
            ["role": "user", "parts": [["text": contextPreamble]]]
        ]
        contents.append(contentsOf: history.map { message in
            ["role": message.role.rawValue, "parts": [["text": message.text]]]
        })

        let body: [String: Any] = [
            "contents": contents,
            "systemInstruction": [
                "parts": [["text": systemInstruction]]
            ]
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw GeminiError.network(error)
        }

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let message = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw GeminiError.badResponse(message)
        }

        guard
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let candidates = json["candidates"] as? [[String: Any]],
            let firstCandidate = candidates.first,
            let content = firstCandidate["content"] as? [String: Any],
            let parts = content["parts"] as? [[String: Any]],
            let text = parts.first?["text"] as? String
        else {
            throw GeminiError.badResponse("Unexpected response shape")
        }

        return text
    }

    /// Scores the clarity of the current draft from 0–100, for the quality gauge.
    func scoreClarity(frame: ProblemFrame) async throws -> Int {
        let scoreText = try await send(history: [ChatMessage(role: .user, text: Self.scorePrompt)], frame: frame)
        let digits = scoreText.filter(\.isNumber)
        return min(max(Int(digits) ?? 0, 0), 100)
    }

    /// Critiques each wizard section individually so a low-scoring frame can
    /// send the PM straight back to the first weak section instead of a
    /// wall of undifferentiated feedback. Keys absent from the result are
    /// sections the AI considered already clear.
    func sectionFeedback(frame: ProblemFrame) async throws -> [String: String] {
        let text = try await send(history: [ChatMessage(role: .user, text: Self.sectionFeedbackPrompt)], frame: frame)
        var result: [String: String] = [:]
        let validKeys = Set(WizardStepOrder.keys)

        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard let colonIndex = trimmed.firstIndex(of: ":") else { continue }
            let key = String(trimmed[trimmed.startIndex..<colonIndex]).trimmingCharacters(in: .whitespaces)
            guard validKeys.contains(key) else { continue }
            let value = String(trimmed[trimmed.index(after: colonIndex)...]).trimmingCharacters(in: .whitespaces)
            if !value.isEmpty && value.uppercased() != "OK" {
                result[key] = value
            }
        }

        return result
    }

    private static let sectionFeedbackPrompt = """
    For EACH of the following sections, give a one-sentence critique of \
    whether it's clear enough to build on, or reply exactly "OK" if it's \
    already solid. Respond with EXACTLY six lines, one per section, in \
    this exact format and these exact keys — no markdown, no extra text:

    context: <critique or OK>
    timing: <critique or OK>
    whoIsAffected: <critique or OK>
    whyItMatters: <critique or OK>
    impact: <critique or OK>
    successCriteria: <critique or OK>
    """

    private static let scorePrompt = """
    On a scale from 0 to 100, how clear and well-framed is this problem \
    statement as a foundation for any work that would follow — design, \
    engineering, or prioritization? Consider specificity, supporting \
    evidence, absence of embedded solutions, and whether success criteria \
    are measurable. Respond with ONLY the integer — no words, no percent \
    sign, no explanation, nothing else.
    """
}
