/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Briefcase, 
  Linkedin, 
  FileText, 
  Upload, 
  CheckCircle2, 
  AlertCircle, 
  ArrowRight, 
  Loader2, 
  Trophy, 
  Target, 
  Sparkles,
  ChevronRight,
  RefreshCw,
  Clock,
  Download,
  Trash2,
  Send,
  BookOpen,
  FileCheck,
  ExternalLink,
  ListChecks,
  ThumbsUp,
  ThumbsDown,
  UserCheck,
  Copy,
  Check,
  MessageSquare,
  Share2,
  Lightbulb
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { analyzeJobMatch, AnalysisResult, refineExperience, refineCoverLetter, refineReferralNote } from './services/geminiService';
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { get, set } from 'idb-keyval';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface HistoryItem {
  id: string;
  fileName: string;
  uploadDate: string;
  resumeBase64: string;
  linkedInUrl: string;
  jobUrl?: string;
  jobDescription?: string;
  result: AnalysisResult;
}

const cleanMarkdown = (text: string | undefined | null) => (text || '').replace(/\\n/g, '\n');

const checkIndeedStandards = (text: string | undefined | null) => {
  if (!text) return {
    hasHeader: false,
    hasDate: false,
    hasRecipient: false,
    hasSalutation: false,
    hasIntro: false,
    hasBody: false,
    hasConclusion: false,
    hasSignOff: false,
    hasNoHyphens: false,
    score: 0,
    grade: "Pending"
  };
  
  const clean = cleanMarkdown(text).trim();
  const lower = clean.toLowerCase();
  
  const hasHeader = clean.length > 10 && (
    lower.includes("@") || 
    lower.includes(".com") || 
    lower.includes("linkedin") ||
    lower.includes("[email]") ||
    lower.includes("[phone]") ||
    lower.includes("[your name]") ||
    clean.split("\n")[0].length > 3
  );
  
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "date of writing"];
  const hasDate = months.some(m => lower.includes(m)) || /\d{4}/.test(clean) || lower.includes("[date");
  
  const hasRecipient = lower.includes("hiring manager") || lower.includes("company") || lower.includes("hiring committee") || lower.includes("recruiter") || lower.includes("[company") || lower.includes("manager]");
  
  const hasSalutation = lower.includes("dear");
  
  const hasIntro = lower.includes("apply") || lower.includes("excited") || lower.includes("interest") || lower.includes("enthusiasm") || lower.includes("opportunity") || lower.includes("position");
  
  const paragraphs = clean.split(/\n\s*\n/).filter(p => p.trim().length > 40);
  const hasBody = paragraphs.length >= 3;
  
  const hasConclusion = lower.includes("thank") || lower.includes("discuss") || lower.includes("forward to") || lower.includes("consider") || lower.includes("interview");
  
  const hasSignOff = lower.includes("sincerely") || lower.includes("best regards") || lower.includes("respectfully") || lower.includes("warm regards");
  
  const hasNoHyphens = !clean.includes(" - ") && !/\s-[a-zA-Z]/.test(clean);

  const checks = [hasHeader, hasDate, hasRecipient, hasSalutation, hasIntro, hasBody, hasConclusion, hasSignOff];
  const count = checks.filter(Boolean).length;
  
  let grade = "Excellent Match";
  if (count < 5) grade = "Needs Review";
  else if (count < 8) grade = "Good Alignment";

  return {
    hasHeader,
    hasDate,
    hasRecipient,
    hasSalutation,
    hasIntro,
    hasBody,
    hasConclusion,
    hasSignOff,
    hasNoHyphens,
    score: count,
    grade
  };
};

const checkYaleStandards = (text: string | undefined | null) => {
  if (!text) return {
    noBulletPoints: false,
    noWeakPhrasings: false,
    specificAddressee: false,
    compellingWhyUs: false,
    narrativeStrength: false,
    strongActions: false,
    hasSignOff: false,
    score: 0,
    grade: "Pending"
  };

  const clean = cleanMarkdown(text).trim();
  const lower = clean.toLowerCase();

  // No list bullets, hyphens or stars at the beginning of parsed lines
  const lines = clean.split("\n");
  const noBulletPoints = !lines.some(line => {
    const trimmed = line.trim();
    return trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*") || trimmed.startsWith("+");
  });

  // Check for qualifiers that Yale recommends avoiding (weak / passive qualifiers / fluff)
  const weakPhrases = ["i believe", "i think", "i feel", "uniquely qualified", "natural leader", "to whom it may concern"];
  const noWeakPhrasings = !weakPhrases.some(phrase => lower.includes(phrase));

  // Exclude "To Whom It May Concern" and expect structural greeting
  const specificAddressee = !lower.includes("to whom it may concern") && lower.includes("dear");

  // Compelling "Why Them / Statement of Interest" keywords showing specific reasons / research
  const compellingWhyUs = lower.includes("culture") || 
                          lower.includes("reputation") || 
                          lower.includes("strategic") || 
                          lower.includes("mission") || 
                          lower.includes("impact") || 
                          lower.includes("innovative") || 
                          lower.includes("growth") ||
                          lower.includes("focus");

  // Standard prose length (3 to 5 logical sections/paragraphs)
  const paragraphBlocks = clean.split(/\n\s*\n/).filter(p => p.trim().length > 40);
  const narrativeStrength = paragraphBlocks.length >= 3 && paragraphBlocks.length <= 6;

  // Yale stresses active, proactive verbs showing quantifiable achievement
  const strongVerbs = ["spearheaded", "designed", "architected", "delivered", "led", "managed", "implemented", "scaled", "optimized", "built", "drove"];
  const strongActions = strongVerbs.some(verb => lower.includes(verb));

  const hasSignOff = lower.includes("sincerely") || lower.includes("best regards") || lower.includes("respectfully") || lower.includes("with thanks");

  const checks = [noBulletPoints, noWeakPhrasings, specificAddressee, compellingWhyUs, narrativeStrength, strongActions, hasSignOff];
  const count = checks.filter(Boolean).length;

  let grade = "Ivy Standard";
  if (count < 4) grade = "Needs Direction";
  else if (count < 7) grade = "Strong Prose";

  return {
    noBulletPoints,
    noWeakPhrasings,
    specificAddressee,
    compellingWhyUs,
    narrativeStrength,
    strongActions,
    hasSignOff,
    score: count,
    grade
  };
};

export default function App() {
  const [auditTab, setAuditTab] = useState<'indeed' | 'yale'>('indeed');
  const [linkedInUrl, setLinkedInUrl] = useState('');
  const [jobUrl, setJobUrl] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [jobInputMode, setJobInputMode] = useState<'url' | 'text'>('url');
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingStep, setLoadingStep] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);

  const selectHistoryItem = useCallback((item: HistoryItem) => {
    setSelectedHistoryId(item.id);
    setResult(item.result);

    // Restore/Select Job Requirements Information (URL or Text)
    if (item.jobUrl) {
      setJobInputMode('url');
      setJobUrl(item.jobUrl);
      setJobDescription('');
    } else if (item.jobDescription) {
      setJobInputMode('text');
      setJobDescription(item.jobDescription);
      setJobUrl('');
    }

    // Restore/Select LinkedIn URL
    if (item.linkedInUrl) {
      setLinkedInUrl(item.linkedInUrl);
    }

    // Restore/Select Resume file object
    if (item.resumeBase64 && item.fileName) {
      try {
        const byteCharacters = atob(item.resumeBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: 'application/pdf' });
        const restoredFile = new File([blob], item.fileName, { type: 'application/pdf' });
        setFile(restoredFile);
      } catch (err) {
        console.error("Error restoring file object from history item:", err);
      }
    }
  }, []);
  const [refinementPrompts, setRefinementPrompts] = useState<Record<number, string>>({});
  const [refinedExperiences, setRefinedExperiences] = useState<Record<number, string>>({});
  const [isRefining, setIsRefining] = useState<Record<number, boolean>>({});
  const [coverLetterPrompt, setCoverLetterPrompt] = useState('');
  const [isRefiningCoverLetter, setIsRefiningCoverLetter] = useState(false);
  const [referralPrompt, setReferralPrompt] = useState('');
  const [isRefiningReferral, setIsRefiningReferral] = useState(false);
  const [referralAppliedNotes, setReferralAppliedNotes] = useState<string | null>(null);
  const [copiedReferral, setCopiedReferral] = useState(false);

  useEffect(() => {
    const loadHistory = async () => {
      const savedHistory = await get<HistoryItem[]>('resume_history');
      if (savedHistory) {
        setHistory(savedHistory);
      }
    };
    loadHistory();
  }, []);

  const saveToHistory = async (newItem: HistoryItem) => {
    const updatedHistory = [newItem, ...history];
    setHistory(updatedHistory);
    await set('resume_history', updatedHistory);
  };

  const deleteFromHistory = async (id: string) => {
    const updatedHistory = history.filter(item => item.id !== id);
    setHistory(updatedHistory);
    await set('resume_history', updatedHistory);
  };

  const downloadResume = (base64: string, fileName: string) => {
    const link = document.createElement('a');
    link.href = `data:application/pdf;base64,${base64}`;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRefineCoverLetter = async () => {
    if (!result || !coverLetterPrompt) return;
    
    setIsRefiningCoverLetter(true);
    try {
      const jobDesc = jobInputMode === 'url' ? jobUrl : jobDescription;
      const refined = await refineCoverLetter(result.coverLetter, coverLetterPrompt, jobDesc);
      setResult(prev => prev ? { ...prev, coverLetter: refined } : null);
      setCoverLetterPrompt('');
    } catch (err) {
      console.error("Failed to refine cover letter:", err);
    } finally {
      setIsRefiningCoverLetter(false);
    }
  };

  const handleCopyReferral = () => {
    const noteText = result?.referralNote || '';
    if (!noteText) return;
    navigator.clipboard.writeText(cleanMarkdown(noteText));
    setCopiedReferral(true);
    setTimeout(() => setCopiedReferral(false), 2500);
  };

  const handleRefineReferral = async (customPrompt?: string) => {
    const promptToUse = customPrompt || referralPrompt;
    if (!result || !promptToUse) return;

    const currentNote = result.referralNote || '';
    setIsRefiningReferral(true);
    try {
      const jobDesc = jobInputMode === 'url' ? jobUrl : jobDescription;
      const response = await refineReferralNote(
        currentNote,
        promptToUse,
        {
          url: jobInputMode === 'url' ? jobUrl : undefined,
          text: jobInputMode === 'text' ? jobDescription : undefined,
          companyName: result.companyName,
          roleTitle: result.roleTitle,
        },
        result.strengths
      );
      
      setResult(prev => prev ? { ...prev, referralNote: response.referralNote } : null);
      setReferralAppliedNotes(response.howApplied);
      setReferralPrompt('');
    } catch (err) {
      console.error("Failed to refine referral note:", err);
    } finally {
      setIsRefiningReferral(false);
    }
  };

  const downloadCoverLetterPDF = () => {
    if (!result?.coverLetter) return;
    
    const doc = new jsPDF();
    doc.setFont("times", "normal");
    doc.setFontSize(11);
    
    const margin = 20;
    const pageWidth = 210;
    const contentWidth = pageWidth - (margin * 2);
    let cursorY = 25;

    // Clean up markdown bolding for the PDF
    const content = cleanMarkdown(result.coverLetter);
    const cleanContent = content.replace(/\*\*(.*?)\*\*/g, '$1');
    
    const paragraphs = cleanContent.split(/\n\s*\n/);
    
    paragraphs.forEach((p) => {
      const lines = doc.splitTextToSize(p.trim(), contentWidth);
      
      // Check if we need a new page
      if (cursorY + (lines.length * 7) > 280) {
        doc.addPage();
        cursorY = 20;
      }
      
      doc.text(lines, margin, cursorY);
      cursorY += (lines.length * 5) + 8; // Line height + paragraph spacing
    });
    
    const fileName = result.companyName 
      ? `${result.companyName.replace(/[^a-z0-9]/gi, '_')}_Cover_Letter.pdf`
      : 'Cover_Letter.pdf';
    doc.save(fileName);
  };

  const loadingMessages = [
    "Reading your resume and LinkedIn profile...",
    "Scanning the job posting for key requirements...",
    "Comparing your skills with the hiring manager's needs...",
    "Analyzing achievement metrics for Impact Score...",
    "Conducting Action Verb Audit...",
    "Scanning for Recruiter Red Flags...",
    "Optimizing keywords for ATS systems...",
    "Drafting optimization tips for your resume...",
    "Finalizing your match score..."
  ];

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setError(null);
    }
  }, []);

  const removeFile = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setFile(null);
    setFileInputKey(prev => prev + 1);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    multiple: false
  });

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    const isUrlMode = jobInputMode === 'url';
    const jobData = isUrlMode ? jobUrl : jobDescription;

    if (!file || !linkedInUrl || !jobData) {
      setError(`Please fill in all fields and upload your resume. ${!jobData ? (isUrlMode ? "Job URL is required." : "Job description is required.") : ""}`);
      return;
    }

    setIsAnalyzing(true);
    setError(null);
    setResult(null);
    setLoadingStep(0);

    const interval = setInterval(() => {
      setLoadingStep((prev) => (prev < loadingMessages.length - 1 ? prev + 1 : prev));
    }, 3000);

    try {
      const base64 = await fileToBase64(file);

      // Check if there is an exact duplicate in history (same resume, same LinkedIn profile, and same job details)
      const existingMatch = history.find(item => 
        item.resumeBase64 === base64 &&
        item.linkedInUrl.trim().toLowerCase() === linkedInUrl.trim().toLowerCase() &&
        (isUrlMode 
          ? (item.jobUrl?.trim().toLowerCase() === jobUrl.trim().toLowerCase())
          : (item.jobDescription?.trim().toLowerCase() === jobDescription.trim().toLowerCase())
        )
      );

      if (existingMatch) {
        // Match found! Use the existing cached result and select the submission details.
        selectHistoryItem(existingMatch);
        clearInterval(interval);
        setIsAnalyzing(false);
        return;
      }

      const analysis = await analyzeJobMatch(
        base64, 
        linkedInUrl, 
        isUrlMode ? { url: jobUrl } : { text: jobDescription }
      );
      setResult(analysis);

      // Save to history
      const newItem: HistoryItem = {
        id: crypto.randomUUID(),
        fileName: file.name,
        uploadDate: new Date().toLocaleString(),
        resumeBase64: base64,
        linkedInUrl,
        jobUrl: isUrlMode ? jobUrl : undefined,
        jobDescription: isUrlMode ? undefined : jobDescription,
        result: analysis
      };
      await saveToHistory(newItem);
      setSelectedHistoryId(newItem.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      clearInterval(interval);
      setIsAnalyzing(false);
    }
  };

  const handleRefine = async (index: number, exp: any) => {
    const prompt = refinementPrompts[index];
    if (!prompt) return;

    setIsRefining(prev => ({ ...prev, [index]: true }));
    try {
      const jobDesc = jobInputMode === 'url' ? jobUrl : jobDescription;
      const refined = await refineExperience(
        { company: exp.company, role: exp.role },
        exp.feedback,
        prompt,
        jobDesc
      );
      setRefinedExperiences(prev => ({ ...prev, [index]: refined }));
    } catch (err) {
      console.error("Refinement failed", err);
    } finally {
      setIsRefining(prev => ({ ...prev, [index]: false }));
    }
  };

  const reset = () => {
    setResult(null);
    setFile(null);
    setFileInputKey(prev => prev + 1);
    setLinkedInUrl('');
    setJobUrl('');
    setJobDescription('');
    setJobInputMode('url');
    setRefinementPrompts({});
    setRefinedExperiences({});
    setIsRefining({});
    setCoverLetterPrompt('');
    setReferralPrompt('');
    setReferralAppliedNotes(null);
  };

  const backToEdit = () => {
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] text-[#1a1a1a] font-sans selection:bg-blue-100">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white sticky top-0 z-10">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Sparkles className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight">CareerMatch AI</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 py-10">
        <AnimatePresence mode="wait">
          {!result && !isAnalyzing ? (
            <motion.div
              key="form"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* Top Third Hero */}
              <div className="text-center space-y-4 max-w-2xl mx-auto">
                <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-gray-900 leading-tight">
                  Are you the <span className="text-blue-600">perfect match</span> for your next role?
                </h1>
                <p className="text-lg text-gray-600">
                  Upload your resume and links to get an AI-powered qualification score and expert tips to land the interview.
                </p>
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center justify-start">
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-2 px-4 py-1.5 text-xs font-semibold text-gray-600 hover:text-gray-900 bg-white hover:bg-gray-100 border border-gray-200 rounded-full transition-all shadow-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reset / Clear Inputs
                </button>
              </div>

              <form onSubmit={handleAnalyze} className="grid grid-cols-1 md:grid-cols-2 gap-8 bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                {/* Left Column: Resume (PDF) Upload */}
                <div className="space-y-4 flex flex-col">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-semibold flex items-center gap-2 text-gray-700">
                      <FileText className="w-4 h-4 text-blue-600" />
                      Resume (PDF)
                    </label>
                    {file && (
                      <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                        Uploaded
                      </span>
                    )}
                  </div>
                  <div
                    {...getRootProps()}
                    className={cn(
                      "border-2 border-dashed rounded-2xl p-6 sm:p-8 text-center cursor-pointer transition-all flex-1 min-h-[220px] flex flex-col items-center justify-center gap-3",
                      isDragActive ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-blue-400 hover:bg-gray-50",
                      file ? "border-green-500 bg-green-50/50" : ""
                    )}
                  >
                    <input {...getInputProps()} key={fileInputKey} />
                    {file ? (
                      <div className="flex flex-col items-center gap-2.5">
                        <CheckCircle2 className="w-10 h-10 text-green-600" />
                        <p className="text-sm font-bold text-green-800 truncate max-w-full px-4">
                          {file.name}
                        </p>
                        <p className="text-xs text-gray-500 font-medium">
                          {(file.size / (1024 * 1024)).toFixed(2)} MB • PDF Ready
                        </p>
                        <div className="flex items-center gap-3 pt-1">
                          <span className="text-xs text-blue-600 hover:underline font-semibold">Click to replace</span>
                          <span className="text-gray-300">|</span>
                          <button 
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFile();
                            }}
                            className="text-xs text-red-500 hover:text-red-700 font-bold hover:underline"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shadow-xs">
                          <Upload className="w-6 h-6" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-700">
                            {isDragActive ? "Drop your resume here" : "Drag & drop or click to upload"}
                          </p>
                          <p className="text-xs text-gray-400 mt-1">PDF format (max 5MB)</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Right Column: LinkedIn Profile URL & Job Requirements */}
                <div className="space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold flex items-center gap-2 text-gray-700">
                      <Linkedin className="w-4 h-4 text-blue-600" />
                      LinkedIn Profile URL
                    </label>
                    <input
                      type="url"
                      required
                      placeholder="https://linkedin.com/in/username"
                      className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm bg-white"
                      value={linkedInUrl}
                      onChange={(e) => setLinkedInUrl(e.target.value)}
                    />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-semibold flex items-center gap-2 text-gray-700">
                        <Briefcase className="w-4 h-4 text-blue-600" />
                        Job Requirements
                      </label>
                      <div className="flex bg-gray-100 p-1 rounded-lg">
                        <button
                          type="button"
                          onClick={() => setJobInputMode('url')}
                          className={cn(
                            "px-3 py-1 text-xs font-bold rounded-md transition-all",
                            jobInputMode === 'url' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                          )}
                        >
                          URL
                        </button>
                        <button
                          type="button"
                          onClick={() => setJobInputMode('text')}
                          className={cn(
                            "px-3 py-1 text-xs font-bold rounded-md transition-all",
                            jobInputMode === 'text' ? "bg-white text-blue-600 shadow-sm" : "text-gray-500 hover:text-gray-700"
                          )}
                        >
                          Text
                        </button>
                      </div>
                    </div>
                    
                    {jobInputMode === 'url' ? (
                      <input
                        type="url"
                        required={jobInputMode === 'url'}
                        placeholder="https://company.com/careers/job-id"
                        className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-sm bg-white"
                        value={jobUrl}
                        onChange={(e) => setJobUrl(e.target.value)}
                      />
                    ) : (
                      <textarea
                        required={jobInputMode === 'text'}
                        placeholder="Paste the job description here..."
                        className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all min-h-[120px] resize-none text-sm bg-white"
                        value={jobDescription}
                        onChange={(e) => setJobDescription(e.target.value)}
                      />
                    )}
                  </div>
                </div>

                <div className="md:col-span-2 pt-4">
                  {error && (
                    <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl flex items-center gap-3 text-red-700 text-sm">
                      <AlertCircle className="w-5 h-5 flex-shrink-0" />
                      {error}
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={isAnalyzing}
                    className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-200 hover:shadow-blue-300 disabled:opacity-50 disabled:cursor-not-allowed group"
                  >
                    Analyze My Qualification
                    <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </button>
                </div>
              </form>

              {/* History Table Section */}
              {history.length > 0 && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                       <Clock className="w-6 h-6 text-blue-600" />
                       Recent History
                    </h2>
                    <span className="text-sm text-gray-500 font-medium">{history.length} analysis sessions</span>
                  </div>
                  
                  <div className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse min-w-full">
                        <thead>
                          <tr className="bg-gray-50/50 border-b border-gray-100 text-[10px] uppercase tracking-widest text-gray-400 font-bold">
                            <th className="px-3 py-3">Company</th>
                            <th className="px-3 py-3">Role Title</th>
                            <th className="px-3 py-3">Job Requirements</th>
                            <th className="px-3 py-3">Resume Used</th>
                            <th className="px-3 py-3">Date</th>
                            <th className="px-3 py-3">Score</th>
                            <th className="px-3 py-3 text-center">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history.map((item) => {
                            const isSelected = selectedHistoryId === item.id || result === item.result;
                            return (
                              <motion.tr 
                                key={item.id}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                onClick={() => selectHistoryItem(item)}
                                className={cn(
                                  "border-b border-gray-50 last:border-0 transition-colors group cursor-pointer",
                                  isSelected ? "bg-blue-50/70 border-l-4 border-l-blue-600 font-medium" : "hover:bg-blue-50/30"
                                )}
                              >
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-2">
                                    <div className={cn(
                                      "w-6 h-6 rounded-lg flex items-center justify-center transition-colors flex-shrink-0",
                                      isSelected ? "bg-blue-600 text-white" : "bg-indigo-50 text-indigo-500"
                                    )}>
                                      <Briefcase className="w-3 h-3" />
                                    </div>
                                    <span className="font-bold text-sm text-gray-900 truncate max-w-[110px] sm:max-w-[140px] xl:max-w-[180px]">{item.result.companyName || 'Unknown'}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-3 text-sm text-gray-600 font-medium">
                                  <span className="truncate block max-w-[110px] sm:max-w-[140px] xl:max-w-[180px]" title={item.result.roleTitle || 'Position N/A'}>
                                    {item.result.roleTitle || 'Position N/A'}
                                  </span>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-1.5 text-xs">
                                    {item.jobUrl ? (
                                      <>
                                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded uppercase flex-shrink-0">URL</span>
                                        <span 
                                          className="truncate max-w-[130px] sm:max-w-[170px] lg:max-w-[220px] xl:max-w-[280px] font-medium text-gray-700 hover:text-blue-600 transition-colors" 
                                          title={item.jobUrl}
                                        >
                                          {item.jobUrl}
                                        </span>
                                      </>
                                    ) : item.jobDescription ? (
                                      <>
                                        <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-[10px] font-bold rounded uppercase flex-shrink-0">Text</span>
                                        <span 
                                          className="truncate max-w-[130px] sm:max-w-[170px] lg:max-w-[220px] xl:max-w-[280px] font-medium text-gray-700" 
                                          title={item.jobDescription}
                                        >
                                          {item.jobDescription}
                                        </span>
                                      </>
                                    ) : (
                                      <span className="text-gray-400 italic">N/A</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                                    <FileText className="w-3 h-3 text-blue-400 flex-shrink-0" />
                                    <span 
                                      className="truncate max-w-[130px] sm:max-w-[170px] lg:max-w-[220px] xl:max-w-[280px] font-medium text-gray-700" 
                                      title={item.fileName}
                                    >
                                      {item.fileName}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-3 py-3 text-xs text-gray-400 whitespace-nowrap">
                                  {item.uploadDate}
                                </td>
                                <td className="px-3 py-3 whitespace-nowrap">
                                  <span className={cn(
                                    "px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider",
                                    item.result.score >= 7 ? "bg-green-100 text-green-700" : 
                                    item.result.score >= 5 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"
                                  )}>
                                    {item.result.score}/10
                                  </span>
                                </td>
                                <td className="px-3 py-3 whitespace-nowrap">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        selectHistoryItem(item);
                                      }}
                                      className={cn(
                                        "p-1.5 rounded-lg transition-all",
                                        isSelected ? "text-blue-700 bg-blue-200 font-bold" : "text-gray-400 hover:text-blue-600 hover:bg-blue-100"
                                      )}
                                      title="Select submission"
                                    >
                                      <ChevronRight className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        downloadResume(item.resumeBase64, item.fileName);
                                      }}
                                      className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-100 rounded-lg transition-all"
                                      title="Download Resume"
                                    >
                                      <Download className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        deleteFromHistory(item.id);
                                      }}
                                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                                      title="Delete"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </td>
                              </motion.tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          ) : isAnalyzing ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-24 space-y-8"
            >
              <div className="relative">
                <div className="w-24 h-24 border-4 border-blue-100 rounded-full animate-pulse" />
                <Loader2 className="w-24 h-24 text-blue-600 animate-spin absolute top-0 left-0" />
              </div>
              <div className="text-center space-y-2">
                <h2 className="text-2xl font-bold text-gray-900">Analyzing your profile...</h2>
                <p className="text-gray-500 animate-pulse">{loadingMessages[loadingStep]}</p>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="results"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-8"
            >
              {/* Top Bar with Navigation Actions & Selected Job Requirements metadata */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={backToEdit}
                    className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 text-gray-700 font-bold rounded-xl hover:bg-gray-50 transition-all text-sm shadow-xs"
                  >
                    <ArrowRight className="w-4 h-4 rotate-180" />
                    Back to Edit
                  </button>
                  <button
                    onClick={reset}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-800 transition-all text-sm shadow-xs"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Start Over
                  </button>
                </div>

                <div className="flex items-center gap-2 bg-white px-4 py-2 rounded-2xl border border-gray-200 text-xs shadow-sm">
                  <span className="font-bold text-gray-400 uppercase tracking-wider text-[10px]">Job Requirements Selected:</span>
                  {jobInputMode === 'url' && jobUrl ? (
                    <span className="font-semibold text-blue-600 truncate max-w-[280px] lg:max-w-[400px]" title={jobUrl}>
                      URL: {jobUrl}
                    </span>
                  ) : jobDescription ? (
                    <span className="font-semibold text-purple-600 truncate max-w-[280px] lg:max-w-[400px]" title={jobDescription}>
                      Text: {jobDescription}
                    </span>
                  ) : (
                    <span className="text-gray-400 italic">No job requirements text stored</span>
                  )}
                </div>
              </div>

              {/* Grammar & Spelling Issues */}
              {result?.grammarIssues && result.grammarIssues.length > 0 && (
                <div className="bg-red-50 p-8 rounded-3xl border border-red-100 space-y-6">
                  <h3 className="text-xl font-bold flex items-center gap-2 text-red-700">
                    <AlertCircle className="w-6 h-6" />
                    Spelling & Grammar Issues
                  </h3>
                  <ul className="space-y-3">
                    {result.grammarIssues.map((issue, i) => (
                      <li key={i} className="flex items-start gap-3 text-red-800">
                        <div className="w-1.5 h-1.5 bg-red-400 rounded-full mt-2.5 flex-shrink-0" />
                        <span>{issue}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Deeper Insights: Why you might be getting ignored */}
              {(result?.actionVerbAudit || result?.recruiterRedFlags || result?.atsOptimizationTips) && (
                <div className="space-y-8">
                  <div className="text-center space-y-2">
                    <h3 className="text-3xl font-bold text-gray-900">The "No Response" Audit</h3>
                    <p className="text-gray-500">Deeper insights into why recruiters or systems might be passing over your application.</p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Recruiter Red Flags - Left Column */}
                    {result?.recruiterRedFlags && (
                      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                        <h4 className="text-xl font-bold flex items-center gap-2 text-rose-700">
                          <AlertCircle className="w-6 h-6" />
                          Recruiter Red Flags
                        </h4>
                        <ul className="space-y-4">
                          {result.recruiterRedFlags.map((flag, i) => (
                            <li key={i} className="flex items-start gap-3 text-gray-700 text-sm">
                              <div className="w-1.5 h-1.5 bg-rose-500 rounded-full mt-1.5 flex-shrink-0" />
                              <span>{flag}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* ATS Optimization - Middle Column */}
                    {result?.atsOptimizationTips && (
                      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                        <h4 className="text-xl font-bold flex items-center gap-2 text-blue-700">
                          <Target className="w-6 h-6" />
                          ATS Optimization
                        </h4>
                        <ul className="space-y-4">
                          {result.atsOptimizationTips.map((tip, i) => (
                            <li key={i} className="flex items-start gap-3 text-gray-700 text-sm">
                              <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mt-1.5 flex-shrink-0" />
                              <span>{tip}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Action Verb Audit - Right Column */}
                    {result?.actionVerbAudit && (
                      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                        <h4 className="text-xl font-bold flex items-center gap-2 text-indigo-700">
                          <RefreshCw className="w-6 h-6" />
                          Action Verb Audit
                        </h4>
                        <div className="space-y-4">
                          {result.actionVerbAudit.map((item, i) => (
                            <div key={i} className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-bold text-indigo-400 line-through">"{item.weak}"</span>
                                <ArrowRight className="w-4 h-4 text-indigo-400" />
                                <span className="text-sm font-bold text-indigo-700">"{item.suggested}"</span>
                              </div>
                              <p className="text-xs text-indigo-600 italic">Context: {item.context}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Score Header */}
              <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 flex flex-col lg:flex-row items-stretch gap-8">
                {/* Left Side: Score Gauges with detailed descriptions */}
                <div className="flex-1 flex flex-col sm:flex-row gap-8 items-center justify-center bg-gray-50/50 p-6 rounded-2xl border border-gray-100">
                  {/* Gauge 1: Job Match Score */}
                  <div className="flex flex-col items-center text-center space-y-3 max-w-[180px]">
                    <div className="relative flex-shrink-0">
                      <svg className="w-32 h-32 transform -rotate-90">
                        <circle
                          cx="64"
                          cy="64"
                          r="56"
                          stroke="currentColor"
                          strokeWidth="10"
                          fill="transparent"
                          className="text-gray-100"
                        />
                        <circle
                          cx="64"
                          cy="64"
                          r="56"
                          stroke="currentColor"
                          strokeWidth="10"
                          fill="transparent"
                          strokeDasharray={352}
                          strokeDashoffset={352 - (352 * (result?.score || 0)) / 10}
                          className="text-blue-600 transition-all duration-1000 ease-out"
                          strokeLinecap="round"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-3xl font-black text-gray-900">{result?.score}</span>
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">/ 10</span>
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-gray-900">Overall Job Match</h4>
                      <p className="text-[11px] text-gray-500 mt-1 leading-normal">
                        Measures how well your skills, past titles, and background align with the core requirements of this role.
                      </p>
                    </div>
                  </div>

                  {/* Gauge 2: Metrics & Impact Score */}
                  {result?.impactScore !== undefined && (
                    <div className="flex flex-col items-center text-center space-y-3 max-w-[180px]">
                      <div className="relative flex-shrink-0">
                        <svg className="w-32 h-32 transform -rotate-90">
                          <circle
                            cx="64"
                            cy="64"
                            r="56"
                            stroke="currentColor"
                            strokeWidth="10"
                            fill="transparent"
                            className="text-gray-100"
                          />
                          <circle
                            cx="64"
                            cy="64"
                            r="56"
                            stroke="currentColor"
                            strokeWidth="10"
                            fill="transparent"
                            strokeDasharray={352}
                            strokeDashoffset={352 - (352 * (result?.impactScore || 0)) / 10}
                            className="text-emerald-500 transition-all duration-1000 ease-out"
                            strokeLinecap="round"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-3xl font-black text-gray-900">{result?.impactScore}</span>
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">/ 10</span>
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-gray-900 font-sans">Metrics & Impact</h4>
                      <p className="text-[11px] text-gray-500 mt-1 leading-normal">
                        Evaluates how effectively you quantify achievements (e.g., %, $, hours saved) rather than just listing job duties.
                      </p>
                    </div>
                  </div>
                  )}
                </div>

                {/* Right Side: Verdict / Summary */}
                <div className="flex-1 flex flex-col justify-center space-y-4 text-center lg:text-left p-2">
                  <div className="flex flex-wrap items-center justify-center lg:justify-start gap-2.5">
                    <div className="inline-flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-bold uppercase tracking-wider">
                      <Trophy className="w-3 h-3" />
                      Match Analysis
                    </div>
                    {result?.score !== undefined && (
                      result.score >= 7 ? (
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-green-50 text-green-700 border border-green-200 rounded-full text-xs font-bold uppercase tracking-wider shadow-sm">
                          <ThumbsUp className="w-3.5 h-3.5 fill-green-50" />
                          Apply: Strong Match
                        </div>
                      ) : result.score >= 5 ? (
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-full text-xs font-bold uppercase tracking-wider shadow-sm">
                          <ThumbsUp className="w-3.5 h-3.5 fill-amber-50" />
                          Apply: Moderate Match
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-50 text-red-700 border border-red-200 rounded-full text-xs font-bold uppercase tracking-wider shadow-sm">
                          <ThumbsDown className="w-3.5 h-3.5 fill-red-50" />
                          Caution: Low Match
                        </div>
                      )
                    )}
                  </div>
                  <h2 className="text-3xl font-bold text-gray-900">Qualification Verdict</h2>
                  <p className="text-gray-600 leading-relaxed text-base">
                    {result?.summary}
                  </p>
                </div>
              </div>

              {/* Rewritten Section */}
              <div className="bg-white p-10 rounded-[2.5rem] shadow-sm border border-gray-100 space-y-8">
                <div className="space-y-2">
                  <h3 className="text-3xl font-bold text-gray-900">Rewritten Resume Section</h3>
                  <p className="text-gray-500">A tailored version of a key section from your resume, optimized for this role. **Bolded** text indicates suggested changes or additions.</p>
                </div>
                <div className="bg-gray-50 p-8 rounded-3xl border border-gray-200">
                  <div className="prose prose-blue max-w-none text-gray-700 leading-relaxed">
                    <ReactMarkdown>{cleanMarkdown(result?.rewrittenSection)}</ReactMarkdown>
                  </div>
                </div>
              </div>

              {/* Strengths & Gaps */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                  <h3 className="text-xl font-bold flex items-center gap-2 text-green-700">
                    <CheckCircle2 className="w-6 h-6" />
                    Key Strengths
                  </h3>
                  <ul className="space-y-4">
                    {result?.strengths.map((strength, i) => (
                      <li key={i} className="flex items-start gap-3 text-gray-700">
                        <div className="w-1.5 h-1.5 bg-green-500 rounded-full mt-2.5 flex-shrink-0" />
                        <span>{strength}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-6">
                  <h3 className="text-xl font-bold flex items-center gap-2 text-amber-700">
                    <Target className="w-6 h-6" />
                    Critical Gaps
                  </h3>
                  <ul className="space-y-4">
                    {result?.gaps.map((gap, i) => (
                      <li key={i} className="flex items-start gap-3 text-gray-700">
                        <div className="w-1.5 h-1.5 bg-amber-500 rounded-full mt-2.5 flex-shrink-0" />
                        <span>{gap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Experience-by-Experience Feedback */}
              {result?.experienceFeedback && result.experienceFeedback.length > 0 && (
                <div className="space-y-6">
                  <h3 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                    <Briefcase className="w-6 h-6 text-blue-600" />
                    Experience-by-Experience Feedback
                  </h3>
                  <div className="grid grid-cols-1 gap-6">
                    {result.experienceFeedback.map((exp, i) => (
                      <div key={i} className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 space-y-4">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 border-b border-gray-50 pb-4">
                          <div>
                            <h4 className="text-lg font-bold text-gray-900">{exp.role}</h4>
                            <p className="text-blue-600 font-medium">{exp.company}</p>
                          </div>
                        </div>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">Alignment Feedback</p>
                            <p className="text-gray-700 leading-relaxed">{exp.feedback}</p>
                          </div>
                          <div className="space-y-2">
                            <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">Optimization Suggestions</p>
                            <ul className="space-y-2">
                              {exp.suggestions.map((suggestion, j) => (
                                <li key={j} className="flex items-start gap-2 text-gray-600 text-sm">
                                  <div className="w-1 h-1 bg-blue-400 rounded-full mt-2 flex-shrink-0" />
                                  <span>{suggestion}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          {/* Refinement Prompt Field */}
                          <div className="pt-4 border-t border-gray-50 space-y-4">
                            <div className="space-y-2">
                              <p className="text-sm font-bold text-gray-400 uppercase tracking-wider">Refine this experience</p>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  placeholder="e.g., 'Emphasize my leadership in the cloud migration project'"
                                  className="flex-1 px-4 py-2 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                                  value={refinementPrompts[i] || ''}
                                  onChange={(e) => setRefinementPrompts(prev => ({ ...prev, [i]: e.target.value }))}
                                  onKeyDown={(e) => e.key === 'Enter' && handleRefine(i, exp)}
                                />
                                <button
                                  onClick={() => handleRefine(i, exp)}
                                  disabled={isRefining[i] || !refinementPrompts[i]}
                                  className="px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2 text-sm font-bold"
                                >
                                  {isRefining[i] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                  Refine
                                </button>
                              </div>
                            </div>

                            {refinedExperiences[i] && (
                              <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100 space-y-3">
                                <p className="text-xs font-bold text-blue-400 uppercase tracking-wider">Refined Version</p>
                                <div className="prose prose-blue prose-sm max-w-none text-blue-900 leading-relaxed">
                                  <ReactMarkdown>{cleanMarkdown(refinedExperiences[i])}</ReactMarkdown>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Rewritten Section */}
              <div className="bg-blue-900 text-white p-10 rounded-[2.5rem] shadow-xl space-y-8 relative overflow-hidden">
                <div className="absolute top-0 right-0 p-12 opacity-10">
                  <Sparkles className="w-48 h-48" />
                </div>
                <div className="relative z-10 space-y-6">
                  <div className="space-y-2">
                    <h3 className="text-3xl font-bold">Resume Optimization Tips</h3>
                    <p className="text-blue-200">Specific changes to make your resume more appealing to the hiring manager.</p>
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    {result?.resumeSuggestions.map((suggestion, i) => (
                      <div key={i} className="bg-white/10 backdrop-blur-sm p-6 rounded-2xl border border-white/10 flex items-start gap-4 group hover:bg-white/15 transition-colors">
                        <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0">
                          {i + 1}
                        </div>
                        <p className="text-blue-50 leading-relaxed">
                          {suggestion}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="pt-4 border-t border-white/10 space-y-3">
                    <a 
                      href="https://www.jobscan.co/tailor-resume" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-blue-200 hover:text-white transition-colors text-sm font-medium"
                    >
                      <Sparkles className="w-4 h-4" />
                      Guide: How to Tailor Your Resume
                      <ArrowRight className="w-4 h-4 -rotate-45" />
                    </a>
                    <a 
                      href="https://igotanoffer.com/blogs/product-manager/product-manager-resume" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-blue-200 hover:text-white transition-colors text-sm font-medium"
                    >
                      <Briefcase className="w-4 h-4" />
                      Guide: Product Manager Resume Tips
                      <ArrowRight className="w-4 h-4 -rotate-45" />
                    </a>
                  </div>
                </div>
              </div>

              {/* Cover Letter */}
              <div className="bg-white p-10 rounded-[2.5rem] shadow-sm border border-gray-100 space-y-8">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded-full uppercase tracking-wider">Indeed Layout Aligned</span>
                      <span className="px-3 py-1 bg-indigo-100 text-indigo-700 text-xs font-bold rounded-full uppercase tracking-wider">Yale Writing Compliant</span>
                      <span className="px-3 py-1 bg-slate-100 text-slate-700 text-xs font-bold rounded-full uppercase tracking-wider font-mono">1.15x Spacing</span>
                    </div>
                    <h3 className="text-3xl font-bold text-gray-900">Tailored Cover Letter</h3>
                    <p className="text-gray-500">A professional, one-page cover letter matching recommended structures from Indeed and Yale Law Career Development advisor rules.</p>
                  </div>
                  <button
                    onClick={downloadCoverLetterPDF}
                    className="flex items-center gap-2 px-6 py-3 bg-green-600 text-white font-bold rounded-2xl hover:bg-green-700 transition-all shadow-sm flex-shrink-0 self-start md:self-center"
                  >
                    <Download className="w-5 h-5" />
                    Download PDF
                  </button>
                </div>
                
                {/* Two-Column Audit Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                  
                  {/* Left Column (lg:col-span-5): Indeed & Yale Audit Checklist & Formatting Guidelines */}
                  <div className="lg:col-span-5 space-y-6">
                    
                    {/* Standard Selector Tabs */}
                    <div className="flex bg-gray-100 p-1 rounded-2xl border border-gray-200/60 shadow-sm">
                      <button
                        onClick={() => setAuditTab('indeed')}
                        className={cn(
                          "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5",
                          auditTab === 'indeed' 
                            ? "bg-white text-blue-700 shadow-sm border border-gray-150" 
                            : "text-gray-500 hover:text-gray-800"
                        )}
                      >
                        <ListChecks className="w-3.5 h-3.5" />
                        Indeed Format
                      </button>
                      <button
                        onClick={() => setAuditTab('yale')}
                        className={cn(
                          "flex-1 py-2 px-3 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-1.5",
                          auditTab === 'yale' 
                            ? "bg-white text-indigo-700 shadow-sm border border-gray-150" 
                            : "text-gray-500 hover:text-gray-800"
                        )}
                      >
                        <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
                        Yale Writing Standard
                      </button>
                    </div>

                    {/* Conditional Audit Panel rendering */}
                    {auditTab === 'indeed' ? (
                      <>
                        {/* Indeed Live Match Checklist Box */}
                        {(() => {
                          const audit = checkIndeedStandards(result?.coverLetter);
                          return (
                            <div className="bg-slate-50 p-6 rounded-3xl border border-slate-200/60 space-y-4 shadow-inner">
                              <div className="flex items-center justify-between">
                                <h4 className="font-bold text-gray-900 flex items-center gap-2 text-sm">
                                  <ListChecks className="w-5 h-5 text-indigo-600" />
                                  Indeed Format Audit
                                </h4>
                                <span className={cn(
                                  "px-2.5 py-1 rounded-full text-xs font-bold font-mono shadow-sm",
                                  audit.grade === "Excellent Match" ? "bg-green-100 text-green-800 border border-green-200" :
                                  audit.grade === "Good Alignment" ? "bg-amber-100 text-amber-800 border border-amber-200" : "bg-red-100 text-red-800 border border-red-200"
                                )}>
                                  {audit.score}/8 • {audit.grade}
                                </span>
                              </div>
                              
                              <p className="text-xs text-gray-500 leading-normal">
                                This analyzer scans your generated cover letter dynamically to confirm it satisfies standard layout criteria from Indeed's advisory framework.
                              </p>

                              <div className="space-y-2 pt-1 font-mono">
                                {/* Contact Header Check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasHeader ? "bg-green-500" : "bg-gray-300")} />
                                    1. Personal Header Block
                                  </span>
                                  {audit.hasHeader ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Present
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Date check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasDate ? "bg-green-500" : "bg-gray-300")} />
                                    2. Date of Writing
                                  </span>
                                  {audit.hasDate ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Found
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Recipient block check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasRecipient ? "bg-green-500" : "bg-gray-300")} />
                                    3. Employer/Company Address
                                  </span>
                                  {audit.hasRecipient ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Found
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Salutation check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasSalutation ? "bg-green-500" : "bg-gray-300")} />
                                    4. Professional Greeting (Dear)
                                  </span>
                                  {audit.hasSalutation ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Verified
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Intro Paragraph check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasIntro ? "bg-green-500" : "bg-gray-300")} />
                                    5. Opening Declaration
                                  </span>
                                  {audit.hasIntro ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Complete
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Body Paragraph check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasBody ? "bg-green-500" : "bg-gray-300")} />
                                    6. 1-2 Compelling Core Paragraphs
                                  </span>
                                  {audit.hasBody ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Complete
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Segment
                                    </span>
                                  )}
                                </div>

                                {/* Conclusion check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasConclusion ? "bg-green-500" : "bg-gray-300")} />
                                    7. Call to Action / Appreciation
                                  </span>
                                  {audit.hasConclusion ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Covered
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Sign-off check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasSignOff ? "bg-green-500" : "bg-gray-300")} />
                                    8. Formal Closing & Signature
                                  </span>
                                  {audit.hasSignOff ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Checked
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Missing
                                    </span>
                                  )}
                                </div>

                                {/* Formatting / Non-hyphen list items check */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-slate-50/50 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", audit.hasNoHyphens ? "bg-green-500" : "bg-amber-500")} />
                                    9. Comma Separated (No Hyphen Lists)
                                  </span>
                                  {audit.hasNoHyphens ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Compliant
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Adjust
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Indeed Styling Specs Box */}
                        <div className="bg-blue-50/40 p-6 rounded-3xl border border-blue-100/70 space-y-4">
                          <div className="flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-blue-600 flex-shrink-0" />
                            <h4 className="font-bold text-gray-900 text-sm">Indeed Format Directives</h4>
                          </div>
                          <div className="space-y-3.5 text-xs text-gray-700 font-sans">
                            <p className="leading-relaxed">
                              According to Indeed's official <span className="font-bold">Cover Letter Formatting Guide</span>, standard professional letters adhere to these exact constraints:
                            </p>
                            <ul className="space-y-2">
                              <li className="flex gap-2">
                                <span className="text-blue-500 font-bold">•</span>
                                <span><strong>Standard 1-inch margins:</strong> Left, right, top, and bottom alignment maintains readability on screens and layouts.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-blue-500 font-bold">•</span>
                                <span><strong>Simple single spacing:</strong> Standard 1x to 1.15x line-height avoids visual clutter. Double line-breaks separate blocks.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-blue-500 font-bold">•</span>
                                <span><strong>Humble 10-12pt text:</strong> Simple professional fonts like Garamond, Times New Roman, or Arial are highly standard.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-blue-500 font-bold">•</span>
                                <span><strong>Concise single page limit:</strong> Restrict length to 300 - 450 words total, framing content in a scannable grid pattern instead of list bullets.</span>
                              </li>
                            </ul>
                            <div className="pt-2 border-t border-blue-100/50 text-center">
                              <a 
                                href="https://www.indeed.com/career-advice/resumes-cover-letters/how-to-format-a-cover-letter-example" 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="inline-flex items-center gap-1 text-xs font-bold text-indigo-600 hover:text-indigo-800 transition-colors"
                              >
                                Explore official Indeed guide <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Yale Law Checklist Box */}
                        {(() => {
                          const yaleAudit = checkYaleStandards(result?.coverLetter);
                          return (
                            <div className="bg-indigo-50/30 p-6 rounded-3xl border border-indigo-200/60 space-y-4 shadow-inner">
                              <div className="flex items-center justify-between">
                                <h4 className="font-bold text-slate-900 flex items-center gap-2 text-sm">
                                  <Sparkles className="w-5 h-5 text-indigo-600" />
                                  Yale Writing Audit
                                </h4>
                                <span className={cn(
                                  "px-2.5 py-1 rounded-full text-xs font-bold font-mono shadow-sm",
                                  yaleAudit.grade === "Ivy Standard" ? "bg-indigo-100 text-indigo-800 border border-indigo-200" :
                                  yaleAudit.grade === "Strong Prose" ? "bg-blue-100 text-blue-800 border border-blue-200" : "bg-amber-100 text-amber-800 border border-amber-200"
                                )}>
                                  {yaleAudit.score}/7 • {yaleAudit.grade}
                                </span>
                              </div>
                              
                              <p className="text-xs text-gray-500 leading-normal">
                                Inspired by the <span className="font-bold">Yale Law School Career Development toolkit</span>, this module audits the rhetoric, tone force, and structure of your prose.
                              </p>

                              <div className="space-y-2 pt-1 font-mono">
                                
                                {/* Bullet points presence */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.noBulletPoints ? "bg-green-500" : "bg-amber-500")} />
                                    1. Zero Bullet Lists (Narrative Format)
                                  </span>
                                  {yaleAudit.noBulletPoints ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Compliant
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-550 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> List Found
                                    </span>
                                  )}
                                </div>

                                {/* Passive language & speculative qualifiers */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.noWeakPhrasings ? "bg-green-500" : "bg-amber-500")} />
                                    2. Confident Assertions (No filler qualifiers)
                                  </span>
                                  {yaleAudit.noWeakPhrasings ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Confident
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-550 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Passive Language
                                    </span>
                                  )}
                                </div>

                                {/* Specific addressee */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.specificAddressee ? "bg-green-500" : "bg-gray-300")} />
                                    3. Non-Generic Addressee
                                  </span>
                                  {yaleAudit.specificAddressee ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Focused
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Generic Greeting
                                    </span>
                                  )}
                                </div>

                                {/* Compelling Interest */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.compellingWhyUs ? "bg-green-500" : "bg-gray-300")} />
                                    4. Dynamic Alignment / Statement of Interest
                                  </span>
                                  {yaleAudit.compellingWhyUs ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Anchored
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Needs Focus
                                    </span>
                                  )}
                                </div>

                                {/* Paragraph narrative focus */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.narrativeStrength ? "bg-green-500" : "bg-gray-300")} />
                                    5. Structured Narrative (3-4 Prose Blocks)
                                  </span>
                                  {yaleAudit.narrativeStrength ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Good Length
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Too Short/Long
                                    </span>
                                  )}
                                </div>

                                {/* Proactive active verbs */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.strongActions ? "bg-green-500" : "bg-gray-300")} />
                                    6. Active Delivery Verbs (Spearheaded, Led)
                                  </span>
                                  {yaleAudit.strongActions ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Proactive
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Passive Voice
                                    </span>
                                  )}
                                </div>

                                {/* formal closing */}
                                <div className="flex items-center justify-between p-2.5 bg-white rounded-xl border border-slate-200/60 hover:bg-indigo-50/30 transition-colors">
                                  <span className="text-[11px] font-medium text-gray-700 flex items-center gap-2">
                                    <span className={cn("w-1.5 h-1.5 rounded-full", yaleAudit.hasSignOff ? "bg-green-500" : "bg-gray-300")} />
                                    7. Classic Respectful Closing Block
                                  </span>
                                  {yaleAudit.hasSignOff ? (
                                    <span className="text-[11px] font-bold text-green-600 flex items-center gap-1">
                                      <CheckCircle2 className="w-3.5 h-3.5" /> Sign-off
                                    </span>
                                  ) : (
                                    <span className="text-[11px] font-bold text-amber-500 flex items-center gap-1">
                                      <AlertCircle className="w-3.5 h-3.5" /> Unchecked
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* Yale Writing Directives Box */}
                        <div className="bg-purple-50/40 p-6 rounded-3xl border border-purple-100/70 space-y-4">
                          <div className="flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-purple-600 flex-shrink-0" />
                            <h4 className="font-bold text-gray-900 text-sm">Yale Toolkit Advice</h4>
                          </div>
                          <div className="space-y-3.5 text-xs text-slate-700 font-sans">
                            <p className="leading-relaxed">
                              According to the <span className="font-bold">Yale Law School Career Development Toolkit</span>, your job-seeking documents must adhere to these strategic principles:
                            </p>
                            <ul className="space-y-2">
                              <li className="flex gap-2">
                                <span className="text-purple-500 font-bold">•</span>
                                <span><strong>Mirror resume headers exactingly:</strong> This creates a professional visual consistency that forms a single cohesive package.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-purple-500 font-bold">•</span>
                                <span><strong>Eliminate weak qualifiers:</strong> Avoid phrasing like "I am hoping to" or "I believe I am suited". Assert your value cleanly using factual proof of work.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-purple-500 font-bold">•</span>
                                <span><strong>Ground your "Why Us" intensely:</strong> Cite specific transactions, missions, or team focus rather than copy-pasted generalities.</span>
                              </li>
                              <li className="flex gap-2">
                                <span className="text-purple-500 font-bold">•</span>
                                <span><strong>Zero bullet lists:</strong> Rely purely on pristine prose. Let your paragraph rhythm carry the argument and demonstrate professional literacy.</span>
                              </li>
                            </ul>
                            <div className="pt-2 border-t border-purple-100/50 text-center">
                              <a 
                                href="https://law.yale.edu/student-life/career-development/students/toolkit-student-job-seekers/cover-letter-advice-samples" 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="inline-flex items-center gap-1 text-xs font-bold text-purple-700 hover:text-purple-900 transition-colors"
                              >
                                Yale Law Cover Letter Toolkit <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Right Column (lg:col-span-7): Stationary Document Canvas Preview */}
                  <div className="lg:col-span-7 space-y-4">
                    <span className="text-xs font-mono text-gray-400 block text-right">Preview: Letter Stationery Style</span>
                    <div className="bg-gray-100 p-6 sm:p-8 rounded-3xl border border-gray-200/80 shadow-inner bg-[radial-gradient(#d1d5db_1px,transparent_1px)] [background-size:12px_12px]">
                      <div className="bg-white p-6 sm:p-10 rounded-2xl shadow-xl border border-gray-150 relative overflow-hidden">
                        {/* Letter Header subtle styling */}
                        <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
                        <div className="prose prose-sm prose-slate max-w-none text-slate-800 leading-relaxed font-serif pt-4">
                          <ReactMarkdown>{cleanMarkdown(result?.coverLetter)}</ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cover Letter Refinement */}
                <div className="pt-8 border-t border-gray-100 space-y-4">
                  <div className="space-y-2">
                    <h4 className="text-lg font-bold text-gray-900">Refine Your Cover Letter</h4>
                    <p className="text-sm text-gray-500">Provide feedback or instructions to rewrite the cover letter (e.g., "Make it sound more enthusiastic" or "Focus more on my technical skills").</p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Your feedback here..."
                        className="flex-1 px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        value={coverLetterPrompt}
                        onChange={(e) => setCoverLetterPrompt(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleRefineCoverLetter()}
                      />
                      <button
                        onClick={handleRefineCoverLetter}
                        disabled={isRefiningCoverLetter || !coverLetterPrompt}
                        className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2 text-sm font-bold shadow-sm"
                      >
                        {isRefiningCoverLetter ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        Generate New Version
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Internal Referral Note Section */}
              <div className="bg-white p-8 sm:p-10 rounded-[2.5rem] shadow-sm border border-gray-100 space-y-8">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-3 py-1 bg-amber-100 text-amber-800 text-xs font-bold rounded-full uppercase tracking-wider flex items-center gap-1.5">
                        <UserCheck className="w-3.5 h-3.5 text-amber-600" />
                        Internal Referral Pitch
                      </span>
                      <span className="px-3 py-1 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-full uppercase tracking-wider">
                        Light & Professional
                      </span>
                      <span className="px-3 py-1 bg-purple-100 text-purple-800 text-xs font-bold rounded-full uppercase tracking-wider">
                        Frictionless Ask
                      </span>
                    </div>
                    <h3 className="text-3xl font-bold text-gray-900">Internal Referral Note</h3>
                    <p className="text-gray-500">
                      A tailored, conversational pitch to send to a friend, former coworker, alumnus, or connection at <span className="font-semibold text-gray-700">{result?.companyName || 'the target company'}</span> to champion your application.
                    </p>
                  </div>

                  <div className="flex items-center gap-3 self-start md:self-center flex-wrap">
                    <button
                      onClick={handleCopyReferral}
                      className={cn(
                        "flex items-center gap-2 px-6 py-3 font-bold rounded-2xl transition-all shadow-sm flex-shrink-0",
                        copiedReferral
                          ? "bg-green-600 text-white"
                          : "bg-gray-900 text-white hover:bg-gray-800 active:scale-95"
                      )}
                    >
                      {copiedReferral ? (
                        <>
                          <Check className="w-5 h-5 text-white" />
                          Copied to Clipboard!
                        </>
                      ) : (
                        <>
                          <Copy className="w-5 h-5" />
                          Copy Referral Note
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Content Showcase Grid */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                  {/* Left Column: Context & Tactical Referral Best Practices */}
                  <div className="lg:col-span-4 space-y-4">
                    <div className="bg-gradient-to-br from-amber-500/10 via-amber-50 to-orange-50/50 p-6 rounded-3xl border border-amber-200/70 space-y-4">
                      <div className="flex items-center gap-2 text-amber-900">
                        <MessageSquare className="w-5 h-5 text-amber-600" />
                        <h4 className="font-bold text-sm">How to Use This Note</h4>
                      </div>
                      <p className="text-xs text-amber-950/80 leading-relaxed">
                        Internal referrals are up to <strong>4x more likely</strong> to secure an interview. Send this note via LinkedIn message, email, or Slack to an internal contact at <strong>{result?.companyName || 'the company'}</strong>.
                      </p>
                      <div className="space-y-2.5 pt-1 text-xs text-amber-900 font-sans">
                        <div className="flex items-start gap-2 bg-white/80 p-2.5 rounded-xl border border-amber-200/50">
                          <span className="font-bold text-amber-600 text-sm leading-none mt-0.5">1</span>
                          <span><strong>Attach your resume:</strong> Mention your PDF is attached so they can forward it in one click.</span>
                        </div>
                        <div className="flex items-start gap-2 bg-white/80 p-2.5 rounded-xl border border-amber-200/50">
                          <span className="font-bold text-amber-600 text-sm leading-none mt-0.5">2</span>
                          <span><strong>Personalize [Name]:</strong> Customize the greeting and any shared past background or team.</span>
                        </div>
                        <div className="flex items-start gap-2 bg-white/80 p-2.5 rounded-xl border border-amber-200/50">
                          <span className="font-bold text-amber-600 text-sm leading-none mt-0.5">3</span>
                          <span><strong>Include Job Req/Link:</strong> Give them the exact requisition link to paste into their internal portal.</span>
                        </div>
                      </div>
                    </div>

                    {/* Suggested Quick Refinements */}
                    <div className="bg-gray-50 p-6 rounded-3xl border border-gray-200/70 space-y-3">
                      <div className="flex items-center gap-2 text-gray-900">
                        <Sparkles className="w-4 h-4 text-indigo-600" />
                        <h5 className="font-bold text-xs uppercase tracking-wider text-gray-600">Quick Refinement Prompts</h5>
                      </div>
                      <div className="flex flex-col gap-2">
                        {[
                          "Make the tone more casual & conversational",
                          "Mention that we worked together previously",
                          "Keep it under 100 words (concise elevator pitch)",
                          `Emphasize my experience in ${result?.strengths?.[0] || 'leadership and execution'}`,
                          "Add a friendly request to grab 10 mins for coffee/virtual catch-up"
                        ].map((promptText, i) => (
                          <button
                            key={i}
                            onClick={() => handleRefineReferral(promptText)}
                            disabled={isRefiningReferral}
                            className="text-left text-xs bg-white hover:bg-indigo-50/80 hover:text-indigo-900 text-gray-700 p-2.5 rounded-xl border border-gray-200 transition-all flex items-center justify-between group disabled:opacity-50"
                          >
                            <span>{promptText}</span>
                            <ArrowRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-indigo-600 group-hover:translate-x-0.5 transition-all flex-shrink-0 ml-2" />
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Interactive Note Preview Bubble & Applied Notes Feedback */}
                  <div className="lg:col-span-8 space-y-4">
                    {/* If suggestions were applied, display the "How your suggestions were applied" explanation card */}
                    <AnimatePresence>
                      {referralAppliedNotes && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="bg-emerald-50 border border-emerald-200 p-4 sm:p-5 rounded-2xl space-y-1.5 shadow-sm"
                        >
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-2 text-xs font-bold text-emerald-900 uppercase tracking-wider">
                              <Lightbulb className="w-4 h-4 text-emerald-600" />
                              How Your Suggestions Were Applied
                            </span>
                            <button
                              onClick={() => setReferralAppliedNotes(null)}
                              className="text-xs text-emerald-700 hover:text-emerald-900 font-medium"
                            >
                              Dismiss
                            </button>
                          </div>
                          <p className="text-xs text-emerald-800 leading-relaxed font-sans">
                            {referralAppliedNotes}
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Note Canvas Container */}
                    <div className="bg-slate-50 p-6 sm:p-8 rounded-3xl border border-slate-200/80 shadow-inner relative">
                      <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200 text-xs text-slate-500 font-mono">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                          Message Template Preview
                        </span>
                        <span>
                          {result?.referralNote ? `${result.referralNote.trim().split(/\s+/).length} words • ~${result.referralNote.length} chars` : 'Ready'}
                        </span>
                      </div>

                      {/* Message bubble */}
                      <div className="bg-white p-6 sm:p-8 rounded-2xl shadow-md border border-gray-150 text-gray-800 leading-relaxed font-sans text-sm sm:text-base relative overflow-hidden">
                        <div className="absolute top-0 left-0 bottom-0 w-1.5 bg-gradient-to-b from-amber-500 via-orange-500 to-amber-600" />
                        <div className="prose prose-sm sm:prose max-w-none text-gray-800 pl-2">
                          <ReactMarkdown>
                            {cleanMarkdown(result?.referralNote || `Hi [Contact Name],\n\nHope you're having a great week!\n\nI saw that **${result?.companyName || 'your team'}** is currently hiring for a **${result?.roleTitle || 'role'}**, and I wanted to reach out because my experience aligns closely with the role's priorities.\n\nOver the course of my work, I've specialized in **${result?.strengths?.[0] || 'delivering high-impact projects'}** and **${result?.strengths?.[1] || 'driving measurable outcomes'}**. Given ${result?.companyName || 'the team'}'s current focus, I'd love the opportunity to contribute.\n\nI've attached my resume for reference. Would you be open to submitting an internal referral on my behalf or connecting me with the recruiter? I'd be very grateful!\n\nThanks so much,\n[Your Name]`)}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>

                    {/* Refine Custom Prompt Input */}
                    <div className="pt-4 space-y-3">
                      <div className="space-y-1.5">
                        <h4 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                          <RefreshCw className="w-4 h-4 text-blue-600" />
                          Customize & Regenerate Referral Note
                        </h4>
                        <p className="text-xs text-gray-500">
                          Tell the AI how you'd like to adjust the note (e.g. adjust tone, mention a specific achievement, target a specific relationship, or change the length).
                        </p>
                      </div>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          placeholder="e.g. Mention we were college classmates, highlight my cloud architecture background, and make it shorter..."
                          className="flex-1 px-4 py-3 rounded-xl border border-gray-200 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none text-sm bg-white"
                          value={referralPrompt}
                          onChange={(e) => setReferralPrompt(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleRefineReferral()}
                        />
                        <button
                          onClick={() => handleRefineReferral()}
                          disabled={isRefiningReferral || !referralPrompt}
                          className="px-6 py-3 bg-amber-600 text-white rounded-xl hover:bg-amber-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm font-bold shadow-sm flex-shrink-0"
                        >
                          {isRefiningReferral ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                          Apply & Regenerate
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-gray-200 mt-12 text-center text-gray-400 text-sm">
        <p>© 2026 CareerMatch AI. Powered by Gemini. All rights reserved.</p>
      </footer>
    </div>
  );
}
