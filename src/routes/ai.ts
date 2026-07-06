import { Router, Request, Response } from 'express';
import logger from '../utils/logger';
import { processAICommand } from '../services/ai/orchestrator';
import { processAICommandStream } from '../services/ai/orchestrator-stream';
import { initSSE, writeSSE } from '../services/ai/stream-events';
import { resetGeminiModelCache } from '../services/ai/gemini';
import { AIChatTurn, AICommandRequest } from '../services/ai/types';

const router = Router();

const MAX_HISTORY_TURNS = 12;

function parseHistory(body: Record<string, unknown>): AIChatTurn[] {
  const raw = body.history;
  if (!Array.isArray(raw)) return [];

  const turns: AIChatTurn[] = [];
  for (const item of raw.slice(-MAX_HISTORY_TURNS)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (
      (role !== 'user' && role !== 'assistant') ||
      typeof content !== 'string'
    ) {
      continue;
    }
    const trimmed = content.trim();
    if (!trimmed) continue;
    turns.push({ role, content: trimmed.slice(0, 2000) });
  }
  return turns;
}

function parseCommandBody(body: Record<string, unknown>) {
  const text = body.text;
  if (!text || typeof text !== 'string') {
    return { error: 'Command text is required' as const };
  }

  const origin = body.origin;
  const parsedOrigin =
    origin &&
    typeof origin === 'object' &&
    typeof (origin as Record<string, unknown>).lat === 'number' &&
    typeof (origin as Record<string, unknown>).lng === 'number'
      ? {
          lat: (origin as Record<string, unknown>).lat as number,
          lng: (origin as Record<string, unknown>).lng as number,
        }
      : undefined;

  return {
    request: {
      text: text.trim(),
      origin: parsedOrigin,
      history: parseHistory(body),
    } satisfies AICommandRequest,
  };
}

router.post('/command', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = parseCommandBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const response = await processAICommand(riderId, parsed.request);
    res.json(response);
  } catch (err) {
    logger.error('[AI] Command error', { err, riderId: req.rider?.riderId });
    res.status(500).json({ error: 'AI processing failed' });
  }
});

router.post('/command/stream', (req: Request, res: Response) => {
  const riderId = req.rider?.riderId;
  if (!riderId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = parseCommandBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  initSSE(res);
  // SSE comment so clients know the stream is alive before the first event.
  res.write(': connected\n\n');

  let clientDisconnected = false;
  res.on('close', () => {
    clientDisconnected = true;
  });

  void (async () => {
    try {
      for await (const event of processAICommandStream(
        riderId,
        parsed.request
      )) {
        if (clientDisconnected || res.writableEnded) break;
        writeSSE(res, event);
      }
    } catch (err) {
      logger.error('[AI] Stream error', { err, riderId });
      if (!clientDisconnected && !res.writableEnded) {
        writeSSE(res, {
          type: 'error',
          message: 'AI processing failed',
        });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  })();
});

export { resetGeminiModelCache };
export default router;
