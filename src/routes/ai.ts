import { Router, Request, Response } from 'express';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { StopStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import logger from '../utils/logger';

const router = Router();

const ACTIVE_STATUSES: StopStatus[] = [
  StopStatus.pending,
  StopStatus.in_progress,
];

const FAILED_STATUSES = new Set<StopStatus>([StopStatus.failed, StopStatus.rts]);

function getGeminiModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-pro',
    tools: [
      {
        functionDeclarations: [
          {
            name: 'optimize_route',
            description:
              'Reorder delivery stops to optimize the route. Can optionally prioritize a specific stop to be delivered first.',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                priorityStopId: {
                  type: SchemaType.STRING,
                  description: 'The stop ID to prioritize (e.g., "stop-003")',
                },
                priorityRecipientName: {
                  type: SchemaType.STRING,
                  description:
                    'The recipient name to prioritize (e.g., "Maria Santos")',
                },
              },
            },
          },
          {
            name: 'filter_deliveries',
            description:
              'Filter and navigate to the delivery history view with specific date and/or status filters applied.',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                date: {
                  type: SchemaType.STRING,
                  description: 'Date filter: "today", "yesterday", or "this_week"',
                },
                status: {
                  type: SchemaType.STRING,
                  description:
                    'Status filter: "delivered", "failed", "rts", or "all"',
                },
              },
            },
          },
          {
            name: 'query_status',
            description:
              'Query the current route/delivery statistics like remaining count, completed count, failed count, total COD, or next stop ETA.',
            parameters: {
              type: SchemaType.OBJECT,
              properties: {
                metric: {
                  type: SchemaType.STRING,
                  description:
                    'The metric to query: "remaining", "completed", "failed", "cod_total", "eta_next", "summary"',
                },
              },
              required: ['metric'],
            },
          },
        ],
      },
    ],
  });
}

async function getLatestManifest(riderId: string) {
  return prisma.manifest.findFirst({
    where: { riderId },
    orderBy: { date: 'desc' },
  });
}

async function executeOptimizeRoute(
  riderId: string,
  args: Record<string, unknown>
) {
  const manifest = await getLatestManifest(riderId);
  if (!manifest) return { error: 'No manifest found' };

  let priorityStopId =
    typeof args.priorityStopId === 'string' ? args.priorityStopId : undefined;
  const priorityRecipientName =
    typeof args.priorityRecipientName === 'string'
      ? args.priorityRecipientName
      : undefined;

  if (!priorityStopId && priorityRecipientName) {
    const stop = await prisma.stop.findFirst({
      where: {
        manifestId: manifest.id,
        status: { in: ACTIVE_STATUSES },
        order: {
          recipientName: {
            contains: priorityRecipientName,
            mode: 'insensitive',
          },
        },
      },
    });
    if (stop) priorityStopId = stop.stopId;
  }

  const pendingStops = await prisma.stop.findMany({
    where: {
      manifestId: manifest.id,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { sequence: 'asc' },
  });

  if (pendingStops.length === 0) {
    return { message: 'No pending stops to optimize', newOrder: [] };
  }

  let ordered = [...pendingStops];
  if (priorityStopId) {
    const idx = ordered.findIndex((s) => s.stopId === priorityStopId);
    if (idx > 0) {
      const [prioritized] = ordered.splice(idx, 1);
      ordered.unshift(prioritized);
    }
  }

  const completedCount = await prisma.stop.count({
    where: {
      manifestId: manifest.id,
      status: StopStatus.completed,
    },
  });

  const newOrder: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    await prisma.stop.updateMany({
      where: { stopId: ordered[i].stopId },
      data: { sequence: completedCount + i + 1 },
    });
    newOrder.push(ordered[i].stopId);
  }

  return {
    newOrder,
    message: `Route optimized. ${priorityStopId || 'No priority'} set.`,
  };
}

async function executeFilterDeliveries(
  _riderId: string,
  args: Record<string, unknown>
) {
  const date = typeof args.date === 'string' ? args.date : 'today';
  const status = typeof args.status === 'string' ? args.status : 'all';

  return {
    action: {
      type: 'NAVIGATE',
      tab: 'deliveries',
      filters: {
        date,
        status,
      },
    },
  };
}

async function executeQueryStatus(
  riderId: string,
  args: Record<string, unknown>
) {
  const metric = typeof args.metric === 'string' ? args.metric : 'summary';
  const manifest = await getLatestManifest(riderId);
  if (!manifest) return { error: 'No manifest found' };

  const stops = await prisma.stop.findMany({
    where: { manifestId: manifest.id },
    include: {
      order: { select: { recipientName: true } },
      deliveryResult: { select: { codCollected: true } },
    },
  });

  const remaining = stops.filter((s) => ACTIVE_STATUSES.includes(s.status))
    .length;
  const completed = stops.filter((s) => s.status === StopStatus.completed)
    .length;
  const failed = stops.filter((s) => FAILED_STATUSES.has(s.status)).length;
  const codTotal = stops
    .filter(
      (s) => s.status === StopStatus.completed && s.deliveryResult?.codCollected
    )
    .reduce(
      (sum, s) => sum + Number(s.deliveryResult?.codCollected ?? 0),
      0
    );
  const nextStop = stops
    .filter((s) => ACTIVE_STATUSES.includes(s.status))
    .sort((a, b) => a.sequence - b.sequence)[0];

  const stats: Record<string, unknown> = {
    remaining,
    completed,
    failed,
    cod_total: codTotal,
    eta_next: nextStop
      ? {
          stopId: nextStop.stopId,
          recipient: nextStop.order.recipientName,
          eta: nextStop.eta,
          distance: nextStop.distance,
        }
      : null,
    summary: { total: stops.length, remaining, completed, failed, codTotal },
  };

  return { metric, data: stats[metric] ?? stats.summary };
}

router.post('/command', async (req: Request, res: Response) => {
  try {
    const riderId = req.rider?.riderId;
    if (!riderId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { text } = req.body;
    if (!text) {
      res.status(400).json({ error: 'Command text is required' });
      return;
    }

    const model = getGeminiModel();

    const manifest = await getLatestManifest(riderId);
    const stops = manifest
      ? await prisma.stop.findMany({
          where: { manifestId: manifest.id },
          orderBy: { sequence: 'asc' },
          include: {
            order: {
              select: {
                recipientName: true,
                addressText: true,
              },
            },
          },
        })
      : [];

    const contextPrompt = `You are an AI assistant for an LBC Express delivery rider. The rider is currently on their route.

Current manifest: ${manifest?.manifestId || 'N/A'}
Total stops: ${stops.length}
Completed: ${stops.filter((s) => s.status === StopStatus.completed).length}
Failed: ${stops.filter((s) => FAILED_STATUSES.has(s.status)).length}
Remaining: ${stops.filter((s) => ACTIVE_STATUSES.includes(s.status)).length}

Current stops (pending/in-progress):
${stops
  .filter((s) => ACTIVE_STATUSES.includes(s.status))
  .map(
    (s) =>
      `- ${s.stopId}: ${s.order.recipientName} at ${s.order.addressText} (${s.status})`
  )
  .join('\n')}

Rider command: "${text}"

Use the available functions to fulfill the rider's request. Be concise and helpful.`;

    const result = await model.generateContent(contextPrompt);
    const response = result.response;

    const parts = response.candidates?.[0]?.content?.parts || [];
    const fcPart = parts.find(
      (p: any): p is { functionCall: { name: string; args: Record<string, unknown> } } =>
        'functionCall' in p && !!p.functionCall
    );

    if (fcPart?.functionCall) {
      const fc = fcPart.functionCall;
      const name = fc.name;
      const args = fc.args || {};
      let actionResult: unknown;

      logger.info('[AI] Function call dispatched', { riderId, intent: name, args });

      switch (name) {
        case 'optimize_route':
          actionResult = await executeOptimizeRoute(riderId, args);
          break;
        case 'filter_deliveries':
          actionResult = await executeFilterDeliveries(riderId, args);
          break;
        case 'query_status':
          actionResult = await executeQueryStatus(riderId, args);
          break;
        default:
          actionResult = { error: `Unknown function: ${name}` };
      }

      const followUp = await model.generateContent([
        { text: contextPrompt },
        {
          text: `Function ${name} was called with args ${JSON.stringify(args)} and returned: ${JSON.stringify(actionResult)}. Provide a brief, friendly response to the rider summarizing what was done.`,
        },
      ]);

      const responseText =
        followUp.response.candidates?.[0]?.content?.parts?.[0]?.text || 'Done!';

      res.json({
        intent: name,
        message: responseText,
        action: actionResult,
        data: actionResult,
      });
    } else {
      const textResponse =
        response.candidates?.[0]?.content?.parts?.[0]?.text ||
        "I'm not sure how to help with that. Try asking about your route, deliveries, or optimization.";

      logger.debug('[AI] Conversational response', { riderId });
      res.json({
        intent: 'CONVERSATIONAL',
        message: textResponse,
        action: null,
        data: null,
      });
    }
  } catch (err) {
    logger.error('[AI] Command error', { err, riderId: req.rider?.riderId });
    res.status(500).json({ error: 'AI processing failed' });
  }
});

export default router;
