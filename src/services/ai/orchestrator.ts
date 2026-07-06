import logger from '../../utils/logger';
import { buildRiderContext } from './context';
import { executeTool } from './handlers';
import {
  extractFunctionCall,
  extractText,
  getGeminiModel,
  getResponseParts,
} from './gemini';
import { buildCommandPrompt, buildFollowUpPrompt } from './prompts';
import { AICommandRequest, AICommandResponse } from './types';

const CONVERSATIONAL_FALLBACK =
  "I'm not sure how to help with that. Try asking about your route, remaining stops, COD collected, or say \"optimize my route\".";

export async function processAICommand(
  riderId: string,
  request: AICommandRequest
): Promise<AICommandResponse> {
  const { text, origin, history = [] } = request;
  const ctx = await buildRiderContext(riderId);
  const prompt = buildCommandPrompt(ctx, text, history);
  const model = getGeminiModel();

  const result = await model.generateContent(prompt);
  const parts = getResponseParts(result.response);
  const functionCall = extractFunctionCall(parts);

  if (!functionCall) {
    const responseText = extractText(parts) ?? CONVERSATIONAL_FALLBACK;
    logger.debug('[AI] Conversational response', { riderId });
    return {
      intent: 'CONVERSATIONAL',
      message: responseText,
      action: null,
      data: null,
    };
  }

  const { name, args } = functionCall;
  logger.info('[AI] Function call dispatched', { riderId, intent: name, args });

  const toolResult = await executeTool(name, riderId, args, { origin });

  const followUp = await model.generateContent([
    { text: prompt },
    { text: buildFollowUpPrompt(name, args, toolResult.data) },
  ]);

  const responseText =
    extractText(getResponseParts(followUp.response)) ?? 'Done!';

  return {
    intent: name,
    message: responseText,
    action: toolResult.clientAction ?? null,
    data: toolResult.data,
  };
}
