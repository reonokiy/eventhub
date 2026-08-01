-- Application credentials are intentionally limited to the two public event
-- capabilities.  The existing non-empty constraint remains responsible for
-- rejecting an empty array.
ALTER TABLE api_clients
  ADD CONSTRAINT api_clients_scopes_supported
  CHECK (scopes <@ ARRAY['events:read', 'events:write']::text[]);
