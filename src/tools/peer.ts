// ─────────────────────────────────────────────
//  Cascade AI — Peer Communication Tool
// ─────────────────────────────────────────────

import { BaseTool } from './base.js';
import type { ToolExecuteOptions } from '../types.js';

export class PeerCommunicationTool extends BaseTool {
  readonly name = 'peer_message';
  readonly description = 'Communicate with peer agents in the same tier or level. Use this to sync outputs, request data, or signal completion of a dependency.';
  readonly inputSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'receive'],
        description: 'Whether to send a message to a peer or retrieve pending messages from all peers.'
      },
      toId: {
        type: 'string',
        description: 'The ID of the recipient peer (required for action="send").'
      },
      messageType: {
        type: 'string',
        enum: ['SHARE_OUTPUT', 'RESOLVE_CONFLICT', 'DIVIDE_WORK', 'CHECK_ASSUMPTION', 'SIGNAL_READY'],
        description: 'The category of the peer message.'
      },
      content: {
        type: 'string',
        description: 'The text content or JSON string of the message.'
      }
    },
    required: ['action']
  };

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const action = input.action as 'send' | 'receive';

    if (action === 'send') {
      const toId = input.toId as string;
      const messageType = (input.messageType as string) || 'SHARE_OUTPUT';
      const content = input.content as string;

      if (!toId) return 'Error: toId is required when action is "send"';
      if (!options.sendPeerSync) return 'Error: Peer communication is not enabled for this agent.';

      options.sendPeerSync(toId, messageType, content);
      return `Successfully sent ${messageType} message to peer ${toId}.`;
    }

    if (action === 'receive') {
      if (!options.getPeerMessages) return 'Error: Peer communication is not enabled for this agent.';
      const messages = options.getPeerMessages();

      if (messages.length === 0) {
        return 'No new messages from peers.';
      }

      const formatted = messages.map(m => `[From ${m.fromId} at ${m.timestamp}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n---\n');
      return `Received ${messages.length} peer messages:\n\n${formatted}`;
    }

    return `Unknown action: ${action}`;
  }
}
