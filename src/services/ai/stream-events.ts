import { Response } from 'express';
import { AICommandResponse } from './types';

export type AIStreamEventType =
  | 'status'
  | 'thinking'
  | 'tool_start'
  | 'tool_end'
  | 'message_delta'
  | 'done'
  | 'error';

export interface AIStatusEvent {
  type: 'status';
  message: string;
}

export interface AIThinkingEvent {
  type: 'thinking';
  step: string;
  index: number;
  done?: boolean;
}

export interface AIToolStartEvent {
  type: 'tool_start';
  tool: string;
  label: string;
}

export interface AIToolEndEvent {
  type: 'tool_end';
  tool: string;
  label: string;
  success: boolean;
  summary: string;
}

export interface AIMessageDeltaEvent {
  type: 'message_delta';
  delta: string;
}

export interface AIDoneEvent {
  type: 'done';
  response: AICommandResponse;
}

export interface AIErrorEvent {
  type: 'error';
  message: string;
}

export type AIStreamEvent =
  | AIStatusEvent
  | AIThinkingEvent
  | AIToolStartEvent
  | AIToolEndEvent
  | AIMessageDeltaEvent
  | AIDoneEvent
  | AIErrorEvent;

export function formatSSE(event: AIStreamEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function writeSSE(res: Response, event: AIStreamEvent): void {
  res.write(formatSSE(event));
  const flushable = res as Response & { flush?: () => void };
  flushable.flush?.();
}

export function initSSE(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}
