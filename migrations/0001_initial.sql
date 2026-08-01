CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  retention_days integer NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenants_slug_not_blank CHECK (btrim(slug) <> ''),
  CONSTRAINT tenants_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT tenants_retention_days_positive CHECK (retention_days > 0)
);

CREATE TABLE IF NOT EXISTS api_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['events:read', 'events:write']::text[],
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  CONSTRAINT api_clients_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT api_clients_key_prefix_not_blank CHECK (btrim(key_prefix) <> ''),
  CONSTRAINT api_clients_key_hash_sha256 CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT api_clients_scopes_not_empty CHECK (cardinality(scopes) > 0),
  CONSTRAINT api_clients_tenant_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT api_clients_tenant_id_id_unique UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS api_clients_tenant_revoked_idx
  ON api_clients (tenant_id, revoked_at);

CREATE TABLE IF NOT EXISTS source_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  stream text NOT NULL DEFAULT 'default',
  signing_secret text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT source_connections_provider_not_blank CHECK (btrim(provider) <> ''),
  CONSTRAINT source_connections_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT source_connections_stream_not_blank CHECK (btrim(stream) <> ''),
  CONSTRAINT source_connections_config_is_object CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT source_connections_tenant_provider_name_unique
    UNIQUE (tenant_id, provider, name)
);

COMMENT ON COLUMN source_connections.signing_secret IS
  'MVP only: plaintext webhook signing secret. Use an external secret manager or application-level encryption outside local development.';

CREATE INDEX IF NOT EXISTS source_connections_tenant_provider_active_idx
  ON source_connections (tenant_id, provider, active);

CREATE TABLE IF NOT EXISTS tenant_heads (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  last_offset bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenant_heads_last_offset_nonnegative CHECK (last_offset >= 0)
);

CREATE TABLE IF NOT EXISTS events (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  "offset" bigint NOT NULL,
  stream text NOT NULL,
  specversion text NOT NULL DEFAULT '1.0',
  id text NOT NULL,
  source text NOT NULL,
  type text NOT NULL,
  subject text,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  datacontenttype text NOT NULL DEFAULT 'application/json',
  dataschema text,
  data jsonb NOT NULL DEFAULT 'null'::jsonb,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  envelope_hash text NOT NULL,
  CONSTRAINT events_pkey PRIMARY KEY (tenant_id, "offset"),
  CONSTRAINT events_identity_unique UNIQUE (tenant_id, source, id),
  CONSTRAINT events_offset_positive CHECK ("offset" > 0),
  CONSTRAINT events_stream_not_blank CHECK (btrim(stream) <> ''),
  CONSTRAINT events_specversion_v1 CHECK (specversion = '1.0'),
  CONSTRAINT events_id_not_blank CHECK (btrim(id) <> ''),
  CONSTRAINT events_source_not_blank CHECK (btrim(source) <> ''),
  CONSTRAINT events_type_not_blank CHECK (btrim(type) <> ''),
  CONSTRAINT events_datacontenttype_not_blank CHECK (btrim(datacontenttype) <> ''),
  CONSTRAINT events_attributes_is_object CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT events_envelope_hash_sha256 CHECK (envelope_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS events_tenant_stream_offset_idx
  ON events (tenant_id, stream, "offset");

CREATE INDEX IF NOT EXISTS events_tenant_type_offset_idx
  ON events (tenant_id, type, "offset");

CREATE INDEX IF NOT EXISTS events_tenant_source_offset_idx
  ON events (tenant_id, source, "offset");

CREATE INDEX IF NOT EXISTS events_tenant_received_at_idx
  ON events (tenant_id, received_at);

CREATE TABLE IF NOT EXISTS publish_idempotency_keys (
  tenant_id uuid NOT NULL,
  api_client_id uuid NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  event_offset bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT publish_idempotency_keys_pkey
    PRIMARY KEY (tenant_id, api_client_id, key_hash),
  CONSTRAINT publish_idempotency_keys_client_fk
    FOREIGN KEY (tenant_id, api_client_id)
    REFERENCES api_clients (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT publish_idempotency_keys_event_fk
    FOREIGN KEY (tenant_id, event_offset)
    REFERENCES events (tenant_id, "offset")
    ON DELETE CASCADE,
  CONSTRAINT publish_idempotency_keys_key_hash_sha256
    CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT publish_idempotency_keys_request_hash_sha256
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT publish_idempotency_keys_expiry_after_creation
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS publish_idempotency_keys_expiry_idx
  ON publish_idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS publish_idempotency_keys_event_idx
  ON publish_idempotency_keys (tenant_id, event_offset);

-- All writers for a tenant take the same tenant_heads row lock before either
-- checking idempotency or allocating an offset. The lock is held until commit,
-- so an observed offset can never refer to an event that commits later than a
-- larger offset. A rollback also rolls back the counter increment.
CREATE OR REPLACE FUNCTION eventhub_append_event(
  p_tenant_id uuid,
  p_stream text,
  p_id text,
  p_source text,
  p_type text,
  p_data jsonb DEFAULT 'null'::jsonb,
  p_specversion text DEFAULT '1.0',
  p_subject text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT NULL,
  p_datacontenttype text DEFAULT 'application/json',
  p_dataschema text DEFAULT NULL,
  p_attributes jsonb DEFAULT '{}'::jsonb,
  p_envelope_hash text DEFAULT NULL,
  p_api_client_id uuid DEFAULT NULL,
  p_idempotency_key_hash text DEFAULT NULL,
  p_request_hash text DEFAULT NULL,
  p_idempotency_ttl interval DEFAULT interval '30 days'
)
RETURNS TABLE (
  tenant_id uuid,
  "offset" bigint,
  stream text,
  specversion text,
  id text,
  source text,
  type text,
  subject text,
  occurred_at timestamptz,
  received_at timestamptz,
  datacontenttype text,
  dataschema text,
  data jsonb,
  attributes jsonb,
  envelope_hash text,
  inserted boolean,
  replay_reason text
)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_event events%ROWTYPE;
  v_offset bigint;
  v_idempotency publish_idempotency_keys%ROWTYPE;
BEGIN
  IF p_envelope_hash IS NULL OR p_envelope_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'envelope_hash must be a lowercase SHA-256 hex digest';
  END IF;

  IF (p_api_client_id IS NULL) <> (p_idempotency_key_hash IS NULL)
    OR (p_api_client_id IS NULL) <> (p_request_hash IS NULL) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'api client, idempotency key hash, and request hash must be provided together';
  END IF;

  IF p_api_client_id IS NOT NULL AND p_idempotency_ttl < interval '30 days' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'idempotency records must be retained for at least 30 days';
  END IF;

  -- This also verifies that the tenant exists through the foreign key. In the
  -- first-write race, ON CONFLICT waits for the winning transaction as needed.
  INSERT INTO tenant_heads (tenant_id, last_offset)
  VALUES (p_tenant_id, 0)
  ON CONFLICT ON CONSTRAINT tenant_heads_pkey DO NOTHING;

  PERFORM 1
  FROM tenant_heads AS h
  WHERE h.tenant_id = p_tenant_id
  FOR UPDATE;

  IF p_api_client_id IS NOT NULL THEN
    SELECT k.*
    INTO v_idempotency
    FROM publish_idempotency_keys AS k
    WHERE k.tenant_id = p_tenant_id
      AND k.api_client_id = p_api_client_id
      AND k.key_hash = p_idempotency_key_hash;

    IF FOUND AND v_idempotency.expires_at <= clock_timestamp() THEN
      DELETE FROM publish_idempotency_keys AS k
      WHERE k.tenant_id = p_tenant_id
        AND k.api_client_id = p_api_client_id
        AND k.key_hash = p_idempotency_key_hash;
    ELSIF FOUND THEN
      IF v_idempotency.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'idempotency_key_conflict';
      END IF;

      SELECT e.*
      INTO STRICT v_event
      FROM events AS e
      WHERE e.tenant_id = p_tenant_id
        AND e."offset" = v_idempotency.event_offset;

      RETURN QUERY
      SELECT
        v_event.tenant_id,
        v_event."offset",
        v_event.stream,
        v_event.specversion,
        v_event.id,
        v_event.source,
        v_event.type,
        v_event.subject,
        v_event.occurred_at,
        v_event.received_at,
        v_event.datacontenttype,
        v_event.dataschema,
        v_event.data,
        v_event.attributes,
        v_event.envelope_hash,
        false,
        'idempotency_key'::text;
      RETURN;
    END IF;
  END IF;

  SELECT e.*
  INTO v_event
  FROM events AS e
  WHERE e.tenant_id = p_tenant_id
    AND e.source = p_source
    AND e.id = p_id;

  IF FOUND THEN
    IF v_event.envelope_hash IS DISTINCT FROM p_envelope_hash
      OR v_event.stream IS DISTINCT FROM p_stream
      OR v_event.specversion IS DISTINCT FROM p_specversion
      OR v_event.type IS DISTINCT FROM p_type
      OR v_event.subject IS DISTINCT FROM p_subject
      OR v_event.occurred_at IS DISTINCT FROM p_occurred_at
      OR v_event.datacontenttype IS DISTINCT FROM p_datacontenttype
      OR v_event.dataschema IS DISTINCT FROM p_dataschema
      OR v_event.data IS DISTINCT FROM p_data
      OR v_event.attributes IS DISTINCT FROM p_attributes THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'event_identity_conflict';
    END IF;

    IF p_api_client_id IS NOT NULL THEN
      INSERT INTO publish_idempotency_keys (
        tenant_id,
        api_client_id,
        key_hash,
        request_hash,
        event_offset,
        expires_at
      )
      VALUES (
        p_tenant_id,
        p_api_client_id,
        p_idempotency_key_hash,
        p_request_hash,
        v_event."offset",
        clock_timestamp() + p_idempotency_ttl
      );
    END IF;

    RETURN QUERY
    SELECT
      v_event.tenant_id,
      v_event."offset",
      v_event.stream,
      v_event.specversion,
      v_event.id,
      v_event.source,
      v_event.type,
      v_event.subject,
      v_event.occurred_at,
      v_event.received_at,
      v_event.datacontenttype,
      v_event.dataschema,
      v_event.data,
      v_event.attributes,
      v_event.envelope_hash,
      false,
      'event_identity'::text;
    RETURN;
  END IF;

  UPDATE tenant_heads AS h
  SET
    last_offset = h.last_offset + 1,
    updated_at = clock_timestamp()
  WHERE h.tenant_id = p_tenant_id
  RETURNING h.last_offset INTO v_offset;

  INSERT INTO events (
    tenant_id,
    "offset",
    stream,
    specversion,
    id,
    source,
    type,
    subject,
    occurred_at,
    datacontenttype,
    dataschema,
    data,
    attributes,
    envelope_hash
  )
  VALUES (
    p_tenant_id,
    v_offset,
    p_stream,
    p_specversion,
    p_id,
    p_source,
    p_type,
    p_subject,
    p_occurred_at,
    p_datacontenttype,
    p_dataschema,
    p_data,
    p_attributes,
    p_envelope_hash
  )
  RETURNING events.* INTO v_event;

  IF p_api_client_id IS NOT NULL THEN
    INSERT INTO publish_idempotency_keys (
      tenant_id,
      api_client_id,
      key_hash,
      request_hash,
      event_offset,
      expires_at
    )
    VALUES (
      p_tenant_id,
      p_api_client_id,
      p_idempotency_key_hash,
      p_request_hash,
      v_event."offset",
      clock_timestamp() + p_idempotency_ttl
    );
  END IF;

  -- NOTIFY is only a wake-up hint. Consumers always read the durable event
  -- from events by offset. PostgreSQL delivers this after the transaction commits.
  PERFORM pg_notify(
    'eventhub_events',
    json_build_object('tenant_id', p_tenant_id, 'offset', v_offset::text)::text
  );

  RETURN QUERY
  SELECT
    v_event.tenant_id,
    v_event."offset",
    v_event.stream,
    v_event.specversion,
    v_event.id,
    v_event.source,
    v_event.type,
    v_event.subject,
    v_event.occurred_at,
    v_event.received_at,
    v_event.datacontenttype,
    v_event.dataschema,
    v_event.data,
    v_event.attributes,
    v_event.envelope_hash,
    true,
    NULL::text;
END;
$function$;

COMMENT ON FUNCTION eventhub_append_event(
  uuid,
  text,
  text,
  text,
  text,
  jsonb,
  text,
  text,
  timestamptz,
  text,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  interval
) IS
  'Atomically handles request idempotency and appends an event with a commit-ordered per-tenant offset.';
