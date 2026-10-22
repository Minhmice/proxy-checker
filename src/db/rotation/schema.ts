import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const accountTurns = sqliteTable('antigravity_account_turns', {
  accountId: text('account_id').primaryKey(),
  turnCount: integer('turn_count').notNull().default(0),
  lastActivatedAt: integer('last_activated_at'),
});
