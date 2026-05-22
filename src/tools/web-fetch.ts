// ─────────────────────────────────────────────
//  Cascade AI — Web Fetch Tool
// ─────────────────────────────────────────────

import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

const MAX_CHARS = 50_000;
const TIMEOUT_MS = 15_000;

function stripHtml(html: string): string {
  // Remove <script> and <style> blocks with their content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Convert common block elements to newlines
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  // Collapse excessive whitespace / blank lines
  text = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');

  return text;
}

export class WebFetchTool extends BaseTool {
  readonly name = 'web_fetch';
  readonly description =
    'Fetch a URL and return its content as plain text (HTML stripped). Use for reading documentation, web pages, or any URL. Limit: 50,000 characters.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch',
      },
      prompt: {
        type: 'string',
        description:
          'Optional hint for what information to extract from the page (not used for filtering, just context)',
      },
    },
    required: ['url'],
  };

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const url = input['url'] as string;

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: {
          'User-Agent': 'Cascade-AI/1.0 WebFetchTool',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
    } catch (err) {
      return `Failed to fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!resp.ok) {
      return `HTTP ${resp.status} ${resp.statusText} from ${url}`;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    let text: string;

    try {
      const raw = await resp.text();
      text = contentType.includes('html') ? stripHtml(raw) : raw;
    } catch (err) {
      return `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS) + `\n\n[Content truncated at ${MAX_CHARS} characters]`;
    }

    return `URL: ${url}\nContent-Type: ${contentType}\n\n${text}`;
  }
}
