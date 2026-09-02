import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ExperienceFeedback {
  company: string;
  role: string;
  feedback: string;
  suggestions: string[];
}

export interface AnalysisResult {
  score: number;
  impactScore?: number;
  companyName: string;
  roleTitle: string;
  summary: string;
  strengths: string[];
  gaps: string[];
  resumeSuggestions: string[];
  rewrittenSection: string;
  grammarIssues: string[];
  coverLetter: string;
  referralNote?: string;
  experienceFeedback: ExperienceFeedback[];
  actionVerbAudit?: { weak: string; suggested: string; context: string }[];
  atsOptimizationTips?: string[];
  recruiterRedFlags?: string[];
}

export async function analyzeJobMatch(
  resumeBase64: string,
  linkedInUrl: string,
  jobInfo: { url?: string; text?: string }
): Promise<AnalysisResult> {
  const model = "gemini-3-flash-preview";
  const today = new Date();
  const todayFormatted = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const jobContext = jobInfo.url 
    ? `Target Job URL: ${jobInfo.url}` 
    : `Target Job Description:\n${jobInfo.text}`;

  const prompt = `
    You are an expert Career Coach and Hiring Manager. 
    
    IMPORTANT TEMPORAL CONTEXT:
    - Today's date is ${todayFormatted} (${today.toISOString().split('T')[0]}).
    - When evaluating dates on the resume or job posting, use ${todayFormatted} as the current anchor date.
    - Any date up to and including ${todayFormatted} (e.g., October 2025 – May 2026, or early 2026) is in the PAST or PRESENT relative to today. Do NOT flag dates on or before ${todayFormatted} as "in the future" or as errors/red flags.

    Analyze the provided candidate data (Resume PDF and LinkedIn Profile) against the Job Posting.
    
    Candidate Data:
    - Resume: (Attached as PDF)
    - LinkedIn: ${linkedInUrl}
    
    ${jobContext}
    
    Tasks:
    1. Identify the Name of the Company and the Title of the Role from the Job Posting.
    2. Determine a overall qualification score from 1 to 10.
    3. Determine an "Impact Score" (1-10) specifically evaluating how well the candidate quantifies their achievements with metrics (e.g., %, $, time saved).
    4. Provide a concise summary of the match.
    5. List key strengths the candidate has for this specific role.
    6. Identify critical gaps between the candidate's profile and the job requirements.
    7. Provide specific, actionable suggestions to improve the resume to appeal more to the hiring manager for THIS specific role.
    8. Rewrite a key section of the resume (e.g., the Professional Summary or a relevant Experience block) to better align with the job description. **Bold the specific areas of change or additions** using markdown syntax (**text**).
    9. Identify any spelling or grammar issues found in the resume. If none, return an empty list.
    10. Write a tailored cover letter that matches the candidate's highlights to the job posting. 
       - Strictly follow the official Indeed Cover Letter Standard Format structure:
         * [Candidate Full Name]
         * [City, State Zip] | [Phone Number] | [Email Address] | [LinkedIn URL]
         * (blank line)
         * [Date of Writing, e.g., ${todayFormatted}]
         * (blank line)
         * [Hiring Manager Name] (or Hiring Committee / Team)
         * [Company Name]
         * [Company Address, City, State, Zip (or generic placeholder in brackets if unknown)]
         * (blank line)
         * Dear [Hiring Manager Name or Hiring Team],
         * (blank line)
         * [Opening Paragraph] (express interest in specific Role Title, how you found it, and overview of why you want to join Company Name)
         * (blank line)
         * [1-2 Body Paragraphs] (showcase 1st and 2nd key achievements with quantified impact, metrics like %, $, or hours saved, directly matching the job requirements)
         * (blank line)
         * [Closing Paragraph] (reiterate interest, mention resume stands attached, state a professional Call to Action requesting a discussion, and express polite thank you)
         * (blank line)
         * Sincerely,
         * (blank+double line break)
         * [Candidate Name]
       - Write the entire cover letter in professional markdown format.
       - Synthesize Yale Law School Cover Letter Guidelines:
         * Maintain an active, bold, and highly professional tone (no passive voice or hesitation).
         * STRICTLY avoid weak filler qualifiers or self-evaluative platitudes, including: "I believe", "I think", "I feel", "I believe I am uniquely qualified", "natural leader". Replace them with direct, evidence-based assertions (e.g., "My practice building...", "I designed...").
         * Give real narrative details highlighting your fit and knowledge of the company’s projects, goals, or mission rather than just repeating resume bullets.
       - The cover letter MUST NOT contain any bullet points.
       - Ensure there are DOUBLE LINE BREAKS between all sections and paragraphs to maintain clear, spacious separation on the page.
       - The cover letter MUST NOT use hyphens ("-") for punctuation or as list indicators; use commas (",") instead for list-like separation in sentences.
       - It should be professional, persuasive, and no longer than one page (approx 300-400 words total).
       - Ensure it highlights the most relevant strengths identified in the analysis.
    11. Provide experience-by-experience feedback. For each significant work experience listed in the resume, provide feedback and suggestions.
    12. Perform an "Action Verb Audit": Identify 3-5 weak or passive verbs used in the resume and suggest stronger, high-impact alternatives.
    13. Provide 3-5 "ATS Optimization Tips" specifically for this resume and job (e.g., key skills missing from the text that a computer would look for).
    14. Identify any "Recruiter Red Flags" (e.g., job title mismatches, layout issues, length, lack of contact info, or vague descriptions).
    15. Write an "Internal Referral Pitch Note". This is a concise, warm message the candidate can send to an internal employee, friend, former colleague, or mutual connection at the company to request an internal referral.
        Guidelines for the Referral Note:
        * Tone: Light, conversational, and warm, yet thoroughly professional and polite.
        * Structure:
          - A friendly, personal opening greeting (e.g. "Hi [Name], hope you're having a great week!").
          - Explicit mention of the target role and company.
          - A concise 2-3 sentence value pitch highlighting the candidate's top strengths and concrete achievements directly mapped to the core job requirements.
          - A frictionless ask that makes it effortless for the internal contact to forward to the recruiter / hiring manager or submit through their internal portal.
          - Note that the resume is attached, with a gracious thank you.
        * Format cleanly in markdown.
    
    Return the result in JSON format.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: resumeBase64,
            },
          },
        ],
      },
    ],
    config: {
      temperature: 0,
      tools: [{ urlContext: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          score: { type: Type.NUMBER },
          impactScore: { type: Type.NUMBER },
          companyName: { type: Type.STRING },
          roleTitle: { type: Type.STRING },
          summary: { type: Type.STRING },
          strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
          gaps: { type: Type.ARRAY, items: { type: Type.STRING } },
          resumeSuggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
          rewrittenSection: { type: Type.STRING },
          grammarIssues: { type: Type.ARRAY, items: { type: Type.STRING } },
          coverLetter: { type: Type.STRING },
          referralNote: { type: Type.STRING },
          experienceFeedback: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                company: { type: Type.STRING },
                role: { type: Type.STRING },
                feedback: { type: Type.STRING },
                suggestions: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ["company", "role", "feedback", "suggestions"],
            },
          },
          actionVerbAudit: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                weak: { type: Type.STRING },
                suggested: { type: Type.STRING },
                context: { type: Type.STRING },
              },
              required: ["weak", "suggested", "context"],
            },
          },
          atsOptimizationTips: { type: Type.ARRAY, items: { type: Type.STRING } },
          recruiterRedFlags: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: [
          "score", 
          "impactScore", 
          "companyName",
          "roleTitle",
          "summary", 
          "strengths", 
          "gaps", 
          "resumeSuggestions", 
          "rewrittenSection", 
          "grammarIssues", 
          "coverLetter", 
          "referralNote",
          "experienceFeedback",
          "actionVerbAudit",
          "atsOptimizationTips",
          "recruiterRedFlags"
        ],
      },
    },
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    throw new Error("Failed to analyze job match. Please try again.");
  }
}

export async function refineExperience(
  experience: { company: string; role: string },
  feedback: string,
  userPrompt: string,
  jobDescription: string
): Promise<string> {
  const model = "gemini-3-flash-preview";

  const prompt = `
    You are an expert Career Coach. 
    A candidate has the following work experience:
    Company: ${experience.company}
    Role: ${experience.role}
    
    Initial Feedback for this role relative to a target job:
    ${feedback}
    
    Target Job Context:
    ${jobDescription}
    
    The user wants to refine this experience block based on the following instructions:
    "${userPrompt}"
    
    Task:
    Rewrite the bullet points or description for this specific experience block to be more impactful and better aligned with the target job, incorporating the user's suggestions.
    Use professional language and quantify achievements where possible.
    **Bold the specific areas of change or additions** using markdown syntax (**text**).
    
    Return ONLY the rewritten text in markdown format.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0 },
  });

  return response.text || "Failed to generate refinement.";
}

export async function refineCoverLetter(
  currentCoverLetter: string,
  userPrompt: string,
  jobDescription: string
): Promise<string> {
  const model = "gemini-3-flash-preview";
  const today = new Date();
  const todayFormatted = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const prompt = `
    You are an expert Career Coach. 
    
    IMPORTANT TEMPORAL CONTEXT:
    - Today's date is ${todayFormatted} (${today.toISOString().split('T')[0]}).

    A candidate has the following current cover letter tailored for a job:
    
    Current Cover Letter:
    ${currentCoverLetter}
    
    Target Job Context:
    ${jobDescription}
    
    The user wants to refine this cover letter based on the following instructions:
    "${userPrompt}"
    
    Task:
    Refine the cover letter based on the user's instructions while maintaining professional standards.
    - Strictly follow the official Indeed Cover Letter Standard Format structure:
      * [Candidate Full Name]
      * [City, State Zip] | [Phone Number] | [Email Address] | [LinkedIn URL]
      * (blank line)
      * [Date of Writing, e.g., ${todayFormatted}]
      * (blank line)
      * [Hiring Manager Name] (or Hiring Committee / Team)
      * [Company Name]
      * [Company Address, City, State, Zip (or generic placeholder in brackets if unknown)]
      * (blank line)
      * Dear [Hiring Manager Name or Hiring Team],
      * (blank line)
      * [Opening Paragraph] (express interest in specific Role Title, how you found it, and overview of why you want to join Company Name)
      * (blank line)
      * [1-2 Body Paragraphs] (showcase key achievements with quantified impact, metrics like %, $, or hours saved, directly matching the job requirements)
      * (blank line)
      * [Closing Paragraph] (reiterate interest, mention resume stands attached, state a professional Call to Action requesting a discussion, and express polite thank you)
      * (blank line)
      * Sincerely,
      * (blank+double line break)
      * [Candidate Name]
    - Write the refined cover letter in professional markdown format.
    - Synthesize Yale Law School Cover Letter Guidelines:
      * Maintain an active, bold, and highly professional tone (no passive voice or hesitation).
      * STRICTLY avoid weak filler qualifiers or self-evaluative platitudes, including: "I believe", "I think", "I feel", "I believe I am uniquely qualified", "natural leader". Replace them with direct, evidence-based assertions (e.g., "My practice building...", "I designed...").
      * Give real narrative details highlighting your fit and knowledge of the company’s projects, goals, or mission rather than just repeating resume bullets.
    - The cover letter MUST NOT contain any bullet points.
    - Ensure there are DOUBLE LINE BREAKS between all sections and paragraphs to maintain clear, spacious separation on the page.
    - The cover letter MUST NOT use hyphens ("-") for punctuation or as list indicators; use commas (",") instead for list-like separation in sentences.
    - It should be professional, persuasive, and no longer than one page (approx 300-400 words total).
    
    Return ONLY the refined cover letter text in markdown format.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: { temperature: 0 },
  });

  return response.text || "Failed to refine cover letter.";
}

export interface RefineReferralResult {
  referralNote: string;
  howApplied: string;
}

export async function refineReferralNote(
  currentReferralNote: string,
  userPrompt: string,
  jobContext: { url?: string; text?: string; companyName?: string; roleTitle?: string },
  candidateStrengths?: string[]
): Promise<RefineReferralResult> {
  const model = "gemini-3-flash-preview";
  const today = new Date();
  const todayFormatted = today.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const jobInfo = jobContext.url
    ? `Target Job URL: ${jobContext.url}`
    : `Target Job Description:\n${jobContext.text || 'N/A'}`;

  const prompt = `
    You are an expert Career Coach.
    
    IMPORTANT TEMPORAL CONTEXT:
    - Today's date is ${todayFormatted} (${today.toISOString().split('T')[0]}).

    A candidate has the following current Internal Referral Note / pitch to reach out to an internal contact, colleague, or friend at a target company:
    
    Target Company: ${jobContext.companyName || 'Target Company'}
    Target Role: ${jobContext.roleTitle || 'Target Position'}

    Current Referral Note:
    """
    ${currentReferralNote}
    """
    
    Target Job Information:
    ${jobInfo}

    ${candidateStrengths && candidateStrengths.length > 0 ? `Candidate Key Strengths:\n${candidateStrengths.map(s => `- ${s}`).join('\n')}` : ''}
    
    The user wants to refine this referral note based on the following instructions:
    "${userPrompt}"
    
    Tasks:
    1. Rewrite and refine the internal referral note following the user's instructions:
       - Keep the tone light, warm, approachable, but thoroughly professional.
       - Highlight key candidate strengths and how they align with the role/company.
       - Make it easy and natural for the internal contact to forward or submit as an employee referral.
       - Format cleanly in markdown.
    2. Provide a clear, concise bulleted or 1-2 sentence explanation for "howApplied" detailing exactly how the user's suggestions were incorporated and what changes were made.
    
    Return ONLY a JSON object with:
    - "referralNote": The full refined referral note in markdown format.
    - "howApplied": A concise 1-3 bullet or 1-2 sentence summary explaining how the user's instructions were incorporated.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          referralNote: { type: Type.STRING },
          howApplied: { type: Type.STRING },
        },
        required: ["referralNote", "howApplied"],
      },
    },
  });

  try {
    const parsed = JSON.parse(response.text || "{}");
    return {
      referralNote: parsed.referralNote || currentReferralNote,
      howApplied: parsed.howApplied || "Applied your feedback to update the tone and key alignment points."
    };
  } catch (e) {
    console.error("Failed to parse refineReferralNote response", e);
    return {
      referralNote: response.text || currentReferralNote,
      howApplied: "Updated the referral note based on your feedback."
    };
  }
}

