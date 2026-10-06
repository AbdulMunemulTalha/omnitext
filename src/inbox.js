import { transaction, nowIso } from './db.js';
import { ensureAssigned, assignConversation, distributeUnassigned } from './assignment.js';
import { messagingWindow, sendText, fetchProfileName, INVALID_TOKEN } from './platforms/meta.js';
import { decryptSecret } from './secrets.js';

export class InboxError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CONVERSATION_VIEW = `
  SELECT c.id, c.workspace_id, c.status, c.unread_count, c.last_message_at, c.last_message_preview,
    c.last_inbound_at, c.assigned_user_id, u.name AS assigned_user_name,
    ct.id AS contact_id, ct.name AS contact_name, ct.external_id AS contact_external_id,
    ch.id AS channel_id, ch.platform, ch.name AS channel_name
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN users u ON u.id = c.assigned_user_id
`;

function messageRow(row) {
  return row && { ...row, attachments: JSON.parse(row.attachments) };
}

function preview(text, attachments) {
  if (text) return text.slice(0, 120);
  return attachments.length ? `[${attachments[0].type}]` : '';
}

export function createInbox(db, config, { emit = () => {}, fetchImpl } = {}) {
  const getConversation = (id) => db.prepare(`${CONVERSATION_VIEW} WHERE c.id = ?`).get(id) ?? null;
  const getMessage = (id) => messageRow(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));

  function publish(conversationId, messageId) {
    const conversation = getConversation(conversationId);
    if (messageId) emit(conversation.workspace_id, 'message', { conversationId, message: getMessage(messageId) });
    emit(conversation.workspace_id, 'conversation', conversation);
    return conversation;
  }

  function canAccess(user, conversation) {
    if (!conversation || conversation.workspace_id !== user.workspace_id) return false;
    if (user.role === 'owner') return true;
    return conversation.assigned_user_id === null || conversation.assigned_user_id === user.id;
  }

  function requireConversation(user, id) {
    const conversation = getConversation(id);
    if (!canAccess(user, conversation)) throw new InboxError(404, 'Conversation not found');
    return conversation;
  }

  // contactId -> time of the last failed lookup, so a broken token or a
  // private profile is not asked about on every message.
  const failedLookups = new Map();
  const RETRY_MS = 60 * 60_000;

  async function lookupName(contactId) {
    const row = db.prepare(`
      SELECT ct.id, ct.external_id, ct.name, ch.platform, ch.access_token
      FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id WHERE ct.id = ?
    `).get(contactId);
    if (!row || row.name || !['messenger', 'instagram'].includes(row.platform)) return null;
    if (!row.access_token || config.dryRun) return null;
    if (Date.now() - (failedLookups.get(contactId) ?? 0) < RETRY_MS) return null;
    try {
      const name = await fetchProfileName({
        platform: row.platform,
        userId: row.external_id,
        accessToken: decryptSecret(row.access_token, config.tokenKey),
        graphVersion: config.meta.graphVersion,
        fetchImpl,
      });
      if (!name) throw new Error('profile has no name');
      db.prepare('UPDATE contacts SET name = ? WHERE id = ? AND name IS NULL').run(name, contactId);
      failedLookups.delete(contactId);
      const conversation = db.prepare('SELECT id FROM conversations WHERE contact_id = ?').get(contactId);
      if (conversation) publish(conversation.id);
      return name;
    } catch (err) {
      failedLookups.set(contactId, Date.now());
      console.warn(`could not read ${row.platform} profile name for contact ${contactId}: ${err.message}`);
      return null;
    }
  }

  // How recent an unanswered customer message must be for an imported chat to
  // stay open; older history is filed under Closed so it doesn't flood the queue.
  const IMPORT_OPEN_DAYS = 7;

  // Stores past conversations (from Meta's Conversations API or WhatsApp
  // history sync). Safe to repeat: messages are matched on their Meta ID.
  function importHistory(channelId, threads, { now = Date.now() } = {}) {
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!channel) return { conversations: 0, messages: 0 };
    let messageCount = 0;
    const touched = new Set();
    transaction(db, () => {
      const insertMessage = db.prepare(`
        INSERT INTO messages (conversation_id, direction, text, attachments, external_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
      `);
      for (const thread of threads) {
        if (!thread.messages.length) continue;
        db.prepare(`
          INSERT INTO contacts (workspace_id, channel_id, external_id, name) VALUES (?, ?, ?, ?)
          ON CONFLICT (channel_id, external_id) DO UPDATE SET name = COALESCE(contacts.name, excluded.name)
        `).run(channel.workspace_id, channel.id, thread.contactExternalId, thread.contactName ?? null);
        const contact = db.prepare('SELECT id FROM contacts WHERE channel_id = ? AND external_id = ?')
          .get(channel.id, thread.contactExternalId);
        const created = db.prepare(`
          INSERT INTO conversations (workspace_id, channel_id, contact_id, status) VALUES (?, ?, ?, 'closed')
          ON CONFLICT (contact_id) DO NOTHING
        `).run(channel.workspace_id, channel.id, contact.id).changes > 0;
        const conversation = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contact.id);

        for (const m of thread.messages) {
          const { changes } = insertMessage.run(conversation.id, m.direction, m.text ?? '', JSON.stringify(m.attachments ?? []),
            m.messageId, m.direction === 'in' ? 'received' : 'sent', m.timestamp);
          messageCount += changes;
        }

        // Recompute the summary from everything stored, so imports and live messages agree.
        const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(conversation.id);
        const lastInbound = db.prepare("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ? AND direction = 'in'").get(conversation.id).at;
        db.prepare('UPDATE conversations SET last_message_at = ?, last_message_preview = ?, last_inbound_at = ? WHERE id = ?')
          .run(last.created_at, preview(last.text, JSON.parse(last.attachments)), lastInbound, conversation.id);
        const waiting = last.direction === 'in' && now - Date.parse(last.created_at) < IMPORT_OPEN_DAYS * 86_400_000;
        if (created && waiting) {
          db.prepare("UPDATE conversations SET status = 'open', unread_count = 1 WHERE id = ?").run(conversation.id);
          ensureAssigned(db, { ...conversation, status: 'open' });
        }
        touched.add(conversation.id);
      }
    });
    if (touched.size) emit(channel.workspace_id, 'imported', { channelId, conversations: touched.size });
    return { conversations: touched.size, messages: messageCount };
  }

  // Names saved in the business's phone contacts beat anything else we know.
  function setContactName(channelId, contactExternalId, name) {
    const { changes } = db.prepare('UPDATE contacts SET name = ? WHERE channel_id = ? AND external_id = ?')
      .run(name, channelId, contactExternalId);
    if (!changes) {
      const channel = db.prepare('SELECT workspace_id FROM channels WHERE id = ?').get(channelId);
      db.prepare('INSERT INTO contacts (workspace_id, channel_id, external_id, name) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(channel.workspace_id, channelId, contactExternalId, name);
      return;
    }
    const conversation = db.prepare(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.channel_id = ? AND ct.external_id = ?`).get(channelId, contactExternalId);
    if (conversation) publish(conversation.id);
  }

  return {
    getConversation,
    canAccess,
    importHistory,
    setContactName,

    // Stores one normalized webhook message. Safe to call twice for the same
    // message because Meta retries deliveries.
    ingestMessage(evt) {
      const channel = db.prepare('SELECT * FROM channels WHERE platform = ? AND external_id = ?')
        .get(evt.platform, evt.channelExternalId);
      if (!channel) return { ignored: 'unknown_channel' };
      if (db.prepare('SELECT 1 FROM messages WHERE external_id = ?').get(evt.messageId)) return { ignored: 'duplicate' };

      const result = transaction(db, () => {
        db.prepare(`
          INSERT INTO contacts (workspace_id, channel_id, external_id, name) VALUES (?, ?, ?, ?)
          ON CONFLICT (channel_id, external_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)
        `).run(channel.workspace_id, channel.id, evt.contactExternalId, evt.contactName ?? null);
        const contact = db.prepare('SELECT id FROM contacts WHERE channel_id = ? AND external_id = ?')
          .get(channel.id, evt.contactExternalId);

        db.prepare(`
          INSERT INTO conversations (workspace_id, channel_id, contact_id) VALUES (?, ?, ?)
          ON CONFLICT (contact_id) DO NOTHING
        `).run(channel.workspace_id, channel.id, contact.id);
        const conversation = db.prepare('SELECT * FROM conversations WHERE contact_id = ?').get(contact.id);

        const inbound = evt.direction === 'in';
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO messages (conversation_id, direction, text, attachments, external_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(conversation.id, evt.direction, evt.text, JSON.stringify(evt.attachments), evt.messageId,
          inbound ? 'received' : 'sent', evt.timestamp);

        if (inbound) {
          db.prepare(`
            UPDATE conversations SET status = 'open', unread_count = unread_count + 1,
              last_message_at = ?, last_inbound_at = ?, last_message_preview = ?
            WHERE id = ?
          `).run(evt.timestamp, evt.timestamp, preview(evt.text, evt.attachments), conversation.id);
          ensureAssigned(db, conversation);
        } else {
          db.prepare('UPDATE conversations SET last_message_at = ?, last_message_preview = ? WHERE id = ?')
            .run(evt.timestamp, preview(evt.text, evt.attachments), conversation.id);
        }
        return { conversationId: conversation.id, messageId: Number(lastInsertRowid), contactId: contact.id };
      });

      const conversation = publish(result.conversationId, result.messageId);
      // Look the name up in the background so the webhook is answered quickly.
      const nameLookup = conversation.contact_name ? Promise.resolve(null) : lookupName(result.contactId);
      return { conversation, message: getMessage(result.messageId), nameLookup };
    },

    lookupName,

    // Fills in names for customers saved before names were looked up.
    async fillMissingNames() {
      const contacts = db.prepare(`
        SELECT ct.id FROM contacts ct JOIN channels ch ON ch.id = ct.channel_id
        WHERE ct.name IS NULL AND ch.platform IN ('messenger', 'instagram') AND ch.access_token != ''
        ORDER BY ct.id DESC LIMIT 500
      `).all();
      for (const { id } of contacts) await lookupName(id);
    },

    applyStatus({ messageId, status, error }) {
      if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return;
      const row = db.prepare('SELECT id, conversation_id, status FROM messages WHERE external_id = ?').get(messageId);
      // Statuses can arrive out of order; never move "read" back to "delivered".
      const rank = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
      if (!row || rank[status] <= rank[row.status]) return;
      db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(status, error ?? null, row.id);
      publish(row.conversation_id, row.id);
    },

    // status 'all' lists every chat; 'open'/'closed' only matter internally
    // (closed chats are old ones that are not waiting for a reply).
    listConversations(user, { filter = 'mine', status = 'all' } = {}) {
      const where = ['c.workspace_id = ?'];
      const params = [user.workspace_id];
      if (status === 'open' || status === 'closed') { where.push('c.status = ?'); params.push(status); }
      if (filter === 'unassigned') where.push('c.assigned_user_id IS NULL');
      else if (filter === 'all' && user.role === 'owner') { /* everything */ }
      else { where.push('c.assigned_user_id = ?'); params.push(user.id); }
      return db.prepare(`${CONVERSATION_VIEW} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 200`)
        .all(...params);
    },

    listMessages(user, conversationId) {
      requireConversation(user, conversationId);
      return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(conversationId).map(messageRow);
    },

    markRead(user, conversationId) {
      const conversation = requireConversation(user, conversationId);
      if (conversation.assigned_user_id !== user.id && user.role !== 'owner') return conversation;
      db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conversationId);
      return publish(conversationId);
    },

    async sendReply(user, conversationId, text) {
      text = String(text ?? '').trim();
      if (!text) throw new InboxError(400, 'Message is empty');
      const conversation = requireConversation(user, conversationId);
      if (conversation.assigned_user_id && conversation.assigned_user_id !== user.id && user.role !== 'owner') {
        throw new InboxError(403, `This customer is handled by ${conversation.assigned_user_name}`);
      }
      const window = messagingWindow(conversation.platform, conversation.last_inbound_at);
      if (!window.ok) throw new InboxError(422, window.reason);

      const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(conversation.channel_id);
      const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(conversation.contact_id);

      const messageId = transaction(db, () => {
        // Whoever answers an unassigned customer keeps them from now on.
        if (!conversation.assigned_user_id) assignConversation(db, conversationId, user.id);
        const now = nowIso();
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO messages (conversation_id, direction, sender_user_id, text, status, created_at)
          VALUES (?, 'out', ?, ?, 'pending', ?)
        `).run(conversationId, user.id, text, now);
        db.prepare('UPDATE conversations SET last_message_at = ?, last_message_preview = ?, unread_count = 0 WHERE id = ?')
          .run(now, preview(text, []), conversationId);
        return Number(lastInsertRowid);
      });
      publish(conversationId, messageId);

      try {
        const { externalId } = await sendText({
          channel: { ...channel, access_token: decryptSecret(channel.access_token, config.tokenKey) },
          contact, text, tag: window.tag,
          graphVersion: config.meta.graphVersion, dryRun: config.dryRun, fetchImpl,
        });
        db.prepare("UPDATE messages SET status = 'sent', external_id = ? WHERE id = ?").run(externalId, messageId);
      } catch (err) {
        db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?").run(err.message, messageId);
        if (err.code === INVALID_TOKEN) {
          db.prepare('UPDATE channels SET needs_reconnect = 1 WHERE id = ?').run(channel.id);
          emit(conversation.workspace_id, 'channels', null);
        }
      }
      publish(conversationId, messageId);
      return getMessage(messageId);
    },

    reassign(user, conversationId, assigneeId) {
      requireConversation(user, conversationId);
      if (assigneeId !== null) {
        const assignee = db.prepare('SELECT id FROM users WHERE id = ? AND workspace_id = ? AND is_active = 1')
          .get(assigneeId, user.workspace_id);
        if (!assignee) throw new InboxError(400, 'Unknown team member');
      }
      assignConversation(db, conversationId, assigneeId);
      return publish(conversationId);
    },

    setStatus(user, conversationId, status) {
      if (!['open', 'closed'].includes(status)) throw new InboxError(400, 'Invalid status');
      const conversation = requireConversation(user, conversationId);
      if (user.role !== 'owner' && conversation.assigned_user_id !== user.id) {
        throw new InboxError(403, 'Only the assigned moderator can change this conversation');
      }
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, conversationId);
      return publish(conversationId);
    },

    setOnDuty(user, online) {
      db.prepare('UPDATE users SET is_online = ? WHERE id = ?').run(online ? 1 : 0, user.id);
      const assigned = online ? transaction(db, () => distributeUnassigned(db, user.workspace_id)) : [];
      for (const id of assigned) publish(id);
      return assigned.length;
    },
  };
}
