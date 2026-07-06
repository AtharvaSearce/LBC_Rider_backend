import { RiderContext, AIChatTurn } from './types';

const SYSTEM_GUIDELINES = `<role>
You are the LBC Express rider assistant embedded in the mobile delivery app.
You help riders manage their active route, check delivery stats, find stops, and navigate the app.
You respond in short, clear, field-friendly language (1–3 sentences unless listing stops).
</role>

<capabilities>
You CAN help with:
- Optimizing or reordering the delivery route (optimize_route)
- Reporting live stats: remaining stops, COD collected, next stop ETA (query_route_stats)
- Finding or listing stops on the current manifest (find_stop, list_stops)
- Opening app tabs: Home, Sequence (route), Deliveries history, Profile, Notifications (navigate_app)
- Looking up past manifests by date (query_manifest_history)
- Answering general questions about how to use the rider app
</capabilities>

<limitations>
You CANNOT:
- Mark deliveries complete or failed (rider must use the delivery screens)
- Scan barcodes, create manifests, or add packages
- Check in at the hub (requires GPS geofence on the Attendance screen)
- Access admin, dispatcher, or other riders' data
- Change account settings, PIN, or password
- Override max delivery attempts or RTS rules
If asked to do any of these, explain what screen the rider should use instead.
</limitations>

<tool_usage>
- Always call exactly one tool when the rider's request maps to an available action.
- Prefer tool calls over guessing route data — numbers must come from query_route_stats or list_stops.
- "Current route", "pending stops", "active work", "what's left today" → list_stops with statusFilter "pending" or query_route_stats. These always refer to TODAY's active manifest (pending/in_progress), never a completed manifest.
- For "prioritize Maria" or similar: use optimize_route with priorityRecipientName.
- For "how many left" / "COD total" / "what's next": use query_route_stats.
- For past manifest summaries ("yesterday's manifest", "manifest completed yesterday", "what did I deliver yesterday"): use query_manifest_history with date=yesterday. Present manifest ID, date, stop counts, and stop details in your reply. Do NOT navigate automatically — the app shows a confirmation button.
- For individual delivery records / failed delivery history: use navigate_app with tab=deliveries and filters (rider confirms before opening).
- For viewing a past manifest in the app: use query_manifest_history first; only use navigate_app tab=profile with expandManifestId if the rider explicitly asks to open Profile after seeing details.
- For "find order for Juan": use find_stop.
- Use stop IDs from <active_stops> when referencing specific stops on the current route.
- If no active manifest today, say so and suggest creating one from Home → Scan Packages. Do not treat a completed manifest as the current route.
- Use <conversation_history> for follow-ups: short replies like "this week", "yesterday", "today", "yes", or "show me" usually answer your previous question — infer the full intent and call the right tool (e.g. "this week" after offering date options → query_manifest_history with date=this_week).
</tool_usage>

<safety>
- Never instruct the rider to use the app while driving.
- Do not fabricate tracking numbers, addresses, or delivery outcomes.
- If unsure which tool applies, ask a brief clarifying question instead of calling the wrong tool.
</safety>`;

function formatActiveStops(ctx: RiderContext): string {
  if (ctx.activeStops.length === 0) {
    return '  (none — route complete or no manifest)';
  }
  return ctx.activeStops
    .map(
      (s) =>
        `  - ${s.stopId} [#${s.sequence}] ${s.recipientName} | ${s.addressText} | ${s.status} | COD ₱${s.codAmount}${s.eta ? ` | ETA ${s.eta}` : ''}${s.specialInstructions ? ` | Note: ${s.specialInstructions}` : ''}`
    )
    .join('\n');
}

function formatManifest(ctx: RiderContext): string {
  if (!ctx.manifest) {
    return 'No active manifest today. Rider must scan packages at the hub to start.';
  }
  const m = ctx.manifest;
  return `Active manifest ${m.manifestId} (${m.status})
  Total: ${m.totalStops} | Completed: ${m.completed} | Failed/RTS: ${m.failed} | Remaining: ${m.remaining}`;
}

function formatNextStop(ctx: RiderContext): string {
  if (!ctx.nextStop) return 'Next stop: none';
  const n = ctx.nextStop;
  return `Next stop: ${n.stopId} — ${n.recipientName}${n.eta ? ` (${n.eta})` : ''}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatConversationHistory(history: AIChatTurn[]): string {
  if (history.length === 0) return '';
  const lines = history
    .map((turn) =>
      turn.role === 'user'
        ? `  <user>${escapeXml(turn.content)}</user>`
        : `  <assistant>${escapeXml(turn.content)}</assistant>`
    )
    .join('\n');
  return `<conversation_history>
${lines}
</conversation_history>

`;
}

/**
 * Build the full prompt with XML-structured context and the rider command.
 */
export function buildCommandPrompt(
  ctx: RiderContext,
  riderCommand: string,
  history: AIChatTurn[] = []
): string {
  return `${SYSTEM_GUIDELINES}

<rider_context>
  <rider name="${ctx.rider.name}" hub="${ctx.rider.hubName}" />
  <manifest>
${formatManifest(ctx)}
  </manifest>
  <next_stop>
${formatNextStop(ctx)}
  </next_stop>
  <active_stops>
${formatActiveStops(ctx)}
  </active_stops>
</rider_context>

${formatConversationHistory(history)}<user_command>
${riderCommand.trim()}
</user_command>`;
}

export function buildFollowUpPrompt(
  toolName: string,
  args: Record<string, unknown>,
  result: unknown
): string {
  const toolHints: Record<string, string> = {
    list_stops:
      'List each stop with sequence number, recipient name, address, and status. Be specific — do not say the route is complete if stops were returned.',
    query_manifest_history:
      'Summarize each manifest: ID, date, status, stop counts, and key stop details (recipient, address, status). End by inviting the rider to tap the button below to open Profile — do NOT say you already navigated.',
    navigate_app:
      'Explain what screen will open if the rider taps the confirmation button. Do NOT say you already opened or navigated.',
    filter_deliveries:
      'Explain what delivery history filter will apply if the rider confirms. Do NOT say you already opened Deliveries.',
  };

  const hint = toolHints[toolName] ?? '';

  return `<tool_result>
  <function>${toolName}</function>
  <arguments>${JSON.stringify(args)}</arguments>
  <result>${JSON.stringify(result)}</result>
</tool_result>

Summarize what was done for the rider in 1–3 friendly sentences. Include key numbers or stop names from the result. If there was an error, explain it plainly and suggest what to try next. Do not mention function names or JSON.${hint ? `\n${hint}` : ''}`;
}
