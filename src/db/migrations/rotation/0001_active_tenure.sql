ALTER TABLE antigravity_account_turns ADD COLUMN threshold_percentage INTEGER;
ALTER TABLE antigravity_account_turns ADD COLUMN tenure_state TEXT NOT NULL DEFAULT 'inactive';
