// ─────────────────────────────────────────────
//  Cascade AI — PDF Tool
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export class PDFCreateTool extends BaseTool {
  readonly name = 'pdf_create';
  readonly description = 'Create a PDF document from text or markdown. Supports basic formatting and auto-pagination.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to save the PDF file' },
      content: { type: 'string', description: 'The text or markdown content to include in the PDF' },
      title: { type: 'string', description: 'Optional title for the document' },
    },
    required: ['path', 'content'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const filePath = input['path'] as string;
    const content = input['content'] as string;
    const title = input['title'] as string | undefined;

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filePath);

        doc.pipe(stream);

        // Metadata
        if (title) {
          doc.info['Title'] = title;
          doc.fontSize(24).text(title, { align: 'center' });
          doc.moveDown();
        }

        // Content
        doc.fontSize(12).text(content, {
          align: 'justify',
          indent: 20,
          paragraphGap: 10,
          lineGap: 5,
        });

        doc.end();

        stream.on('finish', () => {
          resolve(`Successfully created PDF at ${filePath} (${content.length} characters)`);
        });

        stream.on('error', (err) => {
          reject(new Error(`Failed to write PDF: ${err.message}`));
        });
      } catch (err) {
        reject(err);
      }
    });
  }
}
