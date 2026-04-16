// ─────────────────────────────────────────────
//  Cascade AI — GitHub / GitLab Tool
// ─────────────────────────────────────────────

import axios from 'axios';
import type { ToolExecuteOptions } from '../types.js';
import { BaseTool } from './base.js';

export class GitHubTool extends BaseTool {
  readonly name = 'github';
  readonly description = 'Interact with GitHub or GitLab: create PRs, list issues, comment on issues.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: ['github', 'gitlab'], description: 'Platform' },
      token: { type: 'string', description: 'API token (or read from env)' },
      operation: {
        type: 'string',
        enum: ['list_issues', 'create_pr', 'comment_issue', 'get_pr', 'list_prs'],
      },
      repo: { type: 'string', description: 'owner/repo format' },
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR/comment body' },
      head: { type: 'string', description: 'PR head branch' },
      base: { type: 'string', description: 'PR base branch (default: main)' },
      issue_number: { type: 'number', description: 'Issue or PR number' },
    },
    required: ['operation', 'repo'],
  };

  isDangerous(): boolean { return true; }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    const platform = (input['platform'] as string | undefined) ?? 'github';
    const token = (input['token'] as string | undefined) ?? process.env['GITHUB_TOKEN'] ?? process.env['GITLAB_TOKEN'] ?? '';
    const operation = input['operation'] as string;
    const repo = input['repo'] as string;

    if (platform === 'github') {
      return this.executeGitHub(operation, repo, token, input);
    }
    return this.executeGitLab(operation, repo, token, input);
  }

  private async executeGitHub(
    operation: string,
    repo: string,
    token: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    };
    const base = `https://api.github.com/repos/${repo}`;

    switch (operation) {
      case 'list_issues': {
        const response = await axios.get<Array<{ number: number; title: string; state: string }>>(`${base}/issues`, { headers });
        return response.data.map((i) => `#${i.number} [${i.state}] ${i.title}`).join('\n');
      }
      case 'list_prs': {
        const response = await axios.get<Array<{ number: number; title: string; state: string; head: { ref: string }; base: { ref: string } }>>(`${base}/pulls`, { headers });
        return response.data.map((p) => `#${p.number} [${p.state}] ${p.title} (${p.head.ref} → ${p.base.ref})`).join('\n');
      }
      case 'create_pr': {
        const response = await axios.post<{ number: number; html_url: string }>(`${base}/pulls`, {
          title: input['title'],
          body: input['body'] ?? '',
          head: input['head'],
          base: input['base'] ?? 'main',
        }, { headers });
        return `Created PR #${response.data.number}: ${response.data.html_url}`;
      }
      case 'comment_issue': {
        const num = input['issue_number'] as number;
        await axios.post(`${base}/issues/${num}/comments`, { body: input['body'] }, { headers });
        return `Comment added to #${num}`;
      }
      case 'get_pr': {
        const num = input['issue_number'] as number;
        const response = await axios.get<{ title: string; state: string; body: string; html_url: string }>(`${base}/pulls/${num}`, { headers });
        return `PR #${num}: ${response.data.title}\nState: ${response.data.state}\n${response.data.html_url}\n\n${response.data.body}`;
      }
      default:
        throw new Error(`Unknown GitHub operation: ${operation}`);
    }
  }

  private async executeGitLab(
    operation: string,
    repo: string,
    token: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const encodedRepo = encodeURIComponent(repo);
    const headers = { 'PRIVATE-TOKEN': token };
    const base = `https://gitlab.com/api/v4/projects/${encodedRepo}`;

    switch (operation) {
      case 'list_issues': {
        const response = await axios.get<Array<{ iid: number; title: string; state: string }>>(`${base}/issues`, { headers });
        return response.data.map((i) => `#${i.iid} [${i.state}] ${i.title}`).join('\n');
      }
      case 'create_pr': {
        const response = await axios.post<{ iid: number; web_url: string }>(`${base}/merge_requests`, {
          title: input['title'],
          description: input['body'] ?? '',
          source_branch: input['head'],
          target_branch: input['base'] ?? 'main',
        }, { headers });
        return `Created MR !${response.data.iid}: ${response.data.web_url}`;
      }
      case 'list_prs': {
        const response = await axios.get<Array<{ iid: number; title: string; state: string; source_branch: string; target_branch: string }>>(`${base}/merge_requests`, { headers });
        return response.data.map((p) => `!${p.iid} [${p.state}] ${p.title} (${p.source_branch} → ${p.target_branch})`).join('\n');
      }
      case 'comment_issue': {
        const num = input['issue_number'] as number;
        await axios.post(`${base}/issues/${num}/notes`, { body: input['body'] }, { headers });
        return `Comment added to #${num}`;
      }
      case 'get_pr': {
        const num = input['issue_number'] as number;
        const response = await axios.get<{ title: string; state: string; description: string; web_url: string }>(`${base}/merge_requests/${num}`, { headers });
        return `MR !${num}: ${response.data.title}\nState: ${response.data.state}\n${response.data.web_url}\n\n${response.data.description}`;
      }
      default:
        throw new Error(`GitLab operation not supported: ${operation}`);
    }
  }
}
