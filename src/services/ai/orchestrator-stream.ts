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
import {
  summarizeToolResult,
  toolActiveLabel,
  toolDoneLabel,
} from './tool-labels';
import { AIChatTurn, AICommandRequest, AICommandResponse, RiderContext } from './types';
import { AIStreamEvent } from './stream-events';

const CONVERSATIONAL_FALLBACK =
  "I'm not sure how to help with that. Try asking about your route, remaining stops, COD collected, or say \"optimize my route\".";

function buildThinkingSteps(
  ctx: RiderContext,
  command: string,
  history: AIChatTurn[] = []
): string[] {
  const steps: string[] = [
    `Connected as ${ctx.rider.name} at ${ctx.rider.hubName}`,
  ];

  if (ctx.manifest) {
    steps.push(
      `Loaded manifest ${ctx.manifest.manifestId} — ${ctx.manifest.remaining} stops remaining`
    );
    if (ctx.nextStop) {
      steps.push(
        `Next delivery: ${ctx.nextStop.recipientName}${ctx.nextStop.eta ? ` (${ctx.nextStop.eta})` : ''}`
      );
    }
  } else {
    steps.push('No active manifest — rider may need to scan packages first');
  }

  if (history.length > 0) {
    steps.push(`Using ${history.length} prior message${history.length === 1 ? '' : 's'} for context`);
  }

  steps.push(`Interpreting: "${command.trim()}"`);
  return steps;
}

async function* streamTextDeltas(
  prompt: string,
  followUpText: string
): AsyncGenerator<AIStreamEvent, string> {
  const model = getGeminiModel();
  const streamResult = await model.generateContentStream([
    { text: prompt },
    { text: followUpText },
  ]);

  let fullText = '';
  for await (const chunk of streamResult.stream) {
    const delta = chunk.text();
    if (!delta) continue;
    fullText += delta;
    yield { type: 'message_delta', delta };
  }

  if (!fullText) {
    const aggregated = await streamResult.response;
    fullText = extractText(getResponseParts(aggregated)) ?? 'Done!';
    if (fullText) {
      yield { type: 'message_delta', delta: fullText };
    }
  }

  return fullText;
}

export async function* processAICommandStream(
  riderId: string,
  request: AICommandRequest
): AsyncGenerator<AIStreamEvent, void> {
  const { text, origin, history = [] } = request;

  yield { type: 'status', message: 'Understanding your request…' };

  const ctx = await buildRiderContext(riderId);
  const thinkingSteps = buildThinkingSteps(ctx, text, history);

  for (let i = 0; i < thinkingSteps.length; i++) {
    yield { type: 'thinking', step: thinkingSteps[i], index: i };
  }

  const prompt = buildCommandPrompt(ctx, text, history);
  const model = getGeminiModel();

  yield { type: 'status', message: 'Thinking…' };

  const streamResult = await model.generateContentStream(prompt);
  let bufferedText = '';
  let functionCall: { name: string; args: Record<string, unknown> } | null = null;

  for await (const chunk of streamResult.stream) {
    try {
      const calls = chunk.functionCalls?.();
      if (calls && calls.length > 0) {
        functionCall = {
          name: calls[0].name,
          args: (calls[0].args ?? {}) as Record<string, unknown>,
        };
        bufferedText = '';
        break;
      }
    } catch {
      // functionCalls() throws when no calls in chunk — expected during text streaming
    }

    const delta = chunk.text();
    if (delta) bufferedText += delta;
  }

  const aggregated = await streamResult.response;
  if (!functionCall) {
    functionCall = extractFunctionCall(getResponseParts(aggregated));
  }

  if (!functionCall) {
    const finalText =
      bufferedText ||
      extractText(getResponseParts(aggregated)) ||
      CONVERSATIONAL_FALLBACK;

    if (finalText) {
      yield { type: 'message_delta', delta: finalText };
    }

    logger.debug('[AI] Conversational stream response', { riderId });
    yield {
      type: 'done',
      response: {
        intent: 'CONVERSATIONAL',
        message: finalText,
        action: null,
        data: null,
      },
    };
    return;
  }

  const { name, args } = functionCall;
  logger.info('[AI] Stream function call', { riderId, intent: name, args });

  yield {
    type: 'thinking',
    step: `Selected action: ${toolActiveLabel(name).toLowerCase()}`,
    index: thinkingSteps.length,
  };

  yield {
    type: 'tool_start',
    tool: name,
    label: toolActiveLabel(name),
  };

  const toolResult = await executeTool(name, riderId, args, { origin });

  const success = !(
    toolResult.data &&
    typeof toolResult.data === 'object' &&
    'error' in (toolResult.data as Record<string, unknown>)
  );

  yield {
    type: 'tool_end',
    tool: name,
    label: toolDoneLabel(name),
    success,
    summary: summarizeToolResult(name, toolResult.data),
  };

  yield { type: 'status', message: 'Preparing your answer…' };

  let responseText = '';
  const deltaStream = streamTextDeltas(
    prompt,
    buildFollowUpPrompt(name, args, toolResult.data)
  );

  while (true) {
    const next = await deltaStream.next();
    if (next.done) {
      responseText = next.value ?? '';
      break;
    }
    yield next.value;
  }

  if (!responseText) {
    responseText = 'Done!';
  }

  yield {
    type: 'done',
    response: {
      intent: name,
      message: responseText,
      action: toolResult.clientAction ?? null,
      data: toolResult.data,
    },
  };
}
