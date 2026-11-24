-- Add is_forwarded column to support forwarded email detection (t_adf6c52a)
ALTER TABLE transactions ADD COLUMN is_forwarded INTEGER NOT NULL DEFAULT 0;
