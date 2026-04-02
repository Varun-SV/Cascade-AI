// ─────────────────────────────────────────────
//  Cascade AI — CASCADE.md Parser
// ─────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';

export interface CascadeMdContent {
  raw: string;
  sections: Record<string, string>;
  systemPrompt: string;
}

export async function loadCascadeMd(workspacePath: string): Promise<CascadeMdContent | null> {
  const filePath = path.join(workspacePath, 'CASCADE.md');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return parseCascadeMd(raw);
  } catch {
    return null;
  }
}

export function parseCascadeMd(raw: string): CascadeMdContent {
  const sections: Record<string, string> = {};
  const lines = raw.split('\n');
  let currentSection = 'main';
  const sectionLines: string[] = [];

  for (const line of lines) {
    const h2Match = /^##\s+(.+)$/.exec(line);
    if (h2Match) {
      sections[currentSection] = sectionLines.join('\n').trim();
      sectionLines.length = 0;
      currentSection = h2Match[1]!.toLowerCase().replace(/\s+/g, '_');
    } else {
      sectionLines.push(line);
    }
  }
  sections[currentSection] = sectionLines.join('\n').trim();

  // Build system prompt from the full content
  const systemPrompt = `[Project Instructions from CASCADE.md]\n${raw.trim()}`;

  return { raw, sections, systemPrompt };
}

export async function createDefaultCascadeMd(workspacePath: string): Promise<void> {
  const filePath = path.join(workspacePath, 'CASCADE.md');
  const content = `# Cascade Project Instructions

This file contains project-specific instructions for the Cascade AI agent.
Edit this file to customize how agents behave in this project.

## Project Overview

Describe your project here.

## Coding Guidelines

- Follow existing code style
- Write tests for new features
- Document public APIs

## Agent Behavior

- Prefer small, focused changes
- Always ask before deleting files
- Run tests before committing

## Allowed Tools

All tools are allowed unless specified otherwise.

## Out of Scope

List any areas the agent should not touch.
`;
  await fs.writeFile(filePath, content, 'utf-8');
}
