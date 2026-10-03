-- Only newly issued credentials are recoverable. Existing HMAC verifiers stay
-- untouched and continue to authenticate; no automatic rotation or backfill.
-- Envelope: version byte (1), 12-byte AES-GCM nonce, ciphertext with auth tag.
ALTER TABLE webhook_credentials ADD COLUMN encrypted_key BLOB;
