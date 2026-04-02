// ─────────────────────────────────────────────
//  Cascade AI — Image Analysis Tool
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ImageAttachment, ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export class ImageAnalyzeTool extends BaseTool {
  readonly name = 'image_analyze';
  readonly description = 'Analyze an image file and describe its contents. Only available when using a vision-capable model.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the image file' },
      prompt: { type: 'string', description: 'What to look for or ask about the image' },
    },
    required: ['path'],
  };

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const prompt = (input['prompt'] as string | undefined) ?? 'Describe this image in detail.';

    const attachment = await fileToImageAttachment(filePath);

    // Return the image as base64 + prompt — the calling T3 worker will
    // include this in its next message to the vision-capable model
    return JSON.stringify({
      __cascade_image_request: true,
      attachment,
      prompt,
    });
  }
}

export async function fileToImageAttachment(filePath: string): Promise<ImageAttachment> {
  const data = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, ImageAttachment['mimeType']> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  const mimeType = mimeMap[ext] ?? 'image/jpeg';

  return {
    type: 'base64',
    data: data.toString('base64'),
    mimeType,
  };
}
