import { nowIso } from './db.js';

// Picks the on-duty moderator with the fewest open conversations. Ties go to
// whoever was assigned least recently, so new customers rotate fairly.
export function pickModerator(db, workspaceId) {
  return db.prepare(`
    SELECT u.id,
      (SELECT COUNT(*) FROM conversations c WHERE c.assigned_user_id = u.id AND c.status = 'open') AS open_count
    FROM users u
    WHERE u.workspace_id = ? AND u.role = 'moderator' AND u.is_active = 1 AND u.is_online = 1
    ORDER BY open_count ASC, u.last_assigned_at IS NOT NULL, u.last_assigned_at ASC, u.id ASC
    LIMIT 1
  `).get(workspaceId)?.id ?? null;
}

export function assignConversation(db, conversationId, userId) {
  db.prepare('UPDATE conversations SET assigned_user_id = ? WHERE id = ?').run(userId, conversationId);
  if (userId) db.prepare('UPDATE users SET last_assigned_at = ? WHERE id = ?').run(nowIso(), userId);
}

function hasActiveAssignee(db, conversation) {
  if (!conversation.assigned_user_id) return false;
  const user = db.prepare('SELECT is_active FROM users WHERE id = ?').get(conversation.assigned_user_id);
  return Boolean(user?.is_active);
}

// Keeps an existing assignee (the sticky rule). Only conversations without an
// active owner are routed; if nobody is on duty they wait in "Unassigned".
export function ensureAssigned(db, conversation) {
  if (hasActiveAssignee(db, conversation)) return conversation.assigned_user_id;
  const userId = pickModerator(db, conversation.workspace_id);
  assignConversation(db, conversation.id, userId);
  return userId;
}

// Hands waiting conversations to on-duty moderators, oldest first. Called when
// someone goes on duty so nothing sits unanswered in the queue.
export function distributeUnassigned(db, workspaceId) {
  const waiting = db.prepare(`
    SELECT id FROM conversations
    WHERE workspace_id = ? AND status = 'open' AND assigned_user_id IS NULL
    ORDER BY last_inbound_at ASC
  `).all(workspaceId);
  const assigned = [];
  for (const { id } of waiting) {
    const userId = pickModerator(db, workspaceId);
    if (!userId) break;
    assignConversation(db, id, userId);
    assigned.push(id);
  }
  return assigned;
}
