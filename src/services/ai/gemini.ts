import {
  GoogleGenerativeAI,
  GenerativeModel,
} from '@google/generative-ai';
import { AI_TOOL_DECLARATIONS } from './tools';

const DEFAULT_MODEL = 'gemini-2.5-pro';

let cachedModel: GenerativeModel | null = null;

export function getGeminiModel(): GenerativeModel {
  if (cachedModel) return cachedModel;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  cachedModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
    tools: [{ functionDeclarations: AI_TOOL_DECLARATIONS }],
  });

  return cachedModel;
}

/** Reset cached model — used in tests when env changes. */
export function resetGeminiModelCache(): void {
  cachedModel = null;
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

export function extractFunctionCall(parts: GeminiPart[]):
  | { name: string; args: Record<string, unknown> }
  | null {
  const fcPart = parts.find((p) => p.functionCall?.name);
  if (!fcPart?.functionCall) return null;
  return {
    name: fcPart.functionCall.name,
    args: fcPart.functionCall.args ?? {},
  };
}

export function extractText(parts: GeminiPart[]): string | null {
  const textPart = parts.find((p) => typeof p.text === 'string' && p.text.trim());
  return textPart?.text?.trim() ?? null;
}

export function getResponseParts(response: {
  candidates?: { content?: { parts?: unknown[] } }[];
}): GeminiPart[] {
  return (response.candidates?.[0]?.content?.parts ?? []) as GeminiPart[];
}
