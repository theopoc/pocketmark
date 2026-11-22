-- AI tagging can classify through either a ChatGPT plan or an Anthropic API key.
-- Credential row 1 keeps the ChatGPT session. Row 2 holds the encrypted API key.
ALTER TABLE ai_tag_settings ADD COLUMN provider text NOT NULL DEFAULT 'chatgpt'
    CHECK (provider IN ('chatgpt','claude'));
ALTER TABLE ai_tag_credentials DROP CONSTRAINT ai_tag_credentials_id_check;
ALTER TABLE ai_tag_credentials ADD CONSTRAINT ai_tag_credentials_id_check CHECK (id IN (1,2));
