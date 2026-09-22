-- =============================================================================
-- 001_init: events -> attribution -> commission ledger
-- Money is BIGINT paise everywhere. Timestamps are timestamptz (UTC).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Reference data, loaded from the mock-data generator by `cli seed`.
-- ---------------------------------------------------------------------------
CREATE TABLE creators (
  id                  text PRIMARY KEY,
  commission_rate_bps integer NOT NULL CHECK (commission_rate_bps BETWEEN 0 AND 10000)
);

CREATE TABLE products (
  id        text PRIMARY KEY,
  vendor_id text NOT NULL
);

CREATE TABLE variants (
  id         text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products (id)
);

CREATE TABLE stories (
  id                 text PRIMARY KEY,
  creator_id         text NOT NULL,
  tagged_product_ids text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Raw events. The primary key IS the dedupe key (lower-cased UUID).
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          uuid PRIMARY KEY,
  user_id     text,
  session_id  text NOT NULL,
  name        text NOT NULL,
  props       jsonb NOT NULL,
  client_ts   timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  server_ts   timestamptz NOT NULL,
  device      jsonb,
  batch_id    uuid NOT NULL,
  source      text NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'backfill'))
);

-- Work queue for the event consumers (inserted in the same statement as the
-- event; deleted in the same transaction as the consumer's effects).
CREATE TABLE event_queue (
  seq         bigserial PRIMARY KEY,
  event_id    uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now()
) WITH (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 10000,
  autovacuum_vacuum_cost_delay = 0
);

CREATE TABLE event_dead_letters (
  event_id  uuid PRIMARY KEY,
  error     text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);

-- Interaction index: only the event types the attribution rule looks at,
-- only for logged-in users, keyed for "user's events in a time window".
CREATE TABLE interactions (
  event_id    uuid PRIMARY KEY,
  user_id     text NOT NULL,
  name        text NOT NULL CHECK (name IN ('story_view', 'story_product_tap')),
  server_ts   timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  story_id    text,
  product_id  text,
  watch_ms    bigint,
  stitched    boolean NOT NULL DEFAULT false
);
CREATE INDEX interactions_user_ts ON interactions (user_id, server_ts);

CREATE TABLE checkouts (
  event_id    uuid PRIMARY KEY,
  user_id     text NOT NULL,
  server_ts   timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE INDEX checkouts_user_ts ON checkouts (user_id, server_ts);

-- ---------------------------------------------------------------------------
-- Order lifecycle input. (order_id, status) is the dedupe key.
-- ---------------------------------------------------------------------------
CREATE TABLE order_events (
  order_id    text NOT NULL,
  status      text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL,
  PRIMARY KEY (order_id, status)
);

CREATE TABLE order_event_queue (
  seq         bigserial PRIMARY KEY,
  order_id    text NOT NULL,
  status      text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_event_dead_letters (
  order_id  text NOT NULL,
  status    text NOT NULL,
  error     text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, status)
);

-- Order state. Status columns hold the occurredAt of the first message for that
-- status. The ledger_* columns record what the ledger currently holds for this
-- order; they are only changed in the same transaction that posts to the ledger.
CREATE TABLE orders (
  id                         text PRIMARY KEY,
  user_id                    text NOT NULL,
  vendor_id                  text NOT NULL,
  lines                      jsonb NOT NULL,
  product_ids                text[] NOT NULL,
  subtotal_paise             bigint NOT NULL CHECK (subtotal_paise >= 0),
  currency                   text NOT NULL,
  created_at                 timestamptz NOT NULL,
  delivered_at               timestamptz,
  return_requested_at        timestamptz,
  returned_at                timestamptz,
  cancelled_at               timestamptz,
  payable_at                 timestamptz,
  locked_at                  timestamptz,
  lock_reason                text CHECK (lock_reason IN ('return_window_closed', 'returned', 'cancelled')),
  attribution_version        integer NOT NULL DEFAULT 0,
  ledger_bucket              text CHECK (ledger_bucket IN ('accrued', 'payable')),
  ledger_creator_id          text,
  ledger_amount_paise        bigint,
  ledger_attribution_version integer,
  first_seen_at              timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK ((locked_at IS NULL) = (lock_reason IS NULL)),
  CHECK ((ledger_bucket IS NULL) = (ledger_creator_id IS NULL)),
  CHECK ((ledger_bucket IS NULL) = (ledger_amount_paise IS NULL)),
  CHECK ((ledger_bucket IS NULL) = (ledger_attribution_version IS NULL))
);
CREATE INDEX orders_user_created ON orders (user_id, created_at);
CREATE INDEX orders_sweep_candidates ON orders (delivered_at) WHERE locked_at IS NULL AND delivered_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Attribution decisions: append-only, versioned per order.
-- ---------------------------------------------------------------------------
CREATE TABLE attribution_decisions (
  order_id              text NOT NULL REFERENCES orders (id),
  version               integer NOT NULL CHECK (version >= 1),
  attributed            boolean NOT NULL,
  story_id              text,
  creator_id            text,
  qualifying_event_id   uuid,
  qualifying_event_name text,
  qualifying_server_ts  timestamptz,
  anchor_source         text NOT NULL CHECK (anchor_source IN ('checkout_start', 'order_created')),
  anchor_at             timestamptz NOT NULL,
  anchor_event_id       uuid,
  commission_rate_bps   integer,
  commission_paise      bigint CHECK (commission_paise >= 0),
  rule_version          text NOT NULL,
  reason                text NOT NULL CHECK (reason IN ('initial', 'late_event', 'reattribution_job')),
  trigger_event_id      uuid,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, version),
  CHECK (attributed = (creator_id IS NOT NULL)),
  CHECK (attributed = (commission_paise IS NOT NULL))
);

-- A late event (or re-run) that would have changed a locked attribution.
CREATE TABLE late_locked_events (
  id                  bigserial PRIMARY KEY,
  order_id            text NOT NULL REFERENCES orders (id),
  trigger_event_id    uuid,
  locked_version      integer NOT NULL,
  would_be_attributed boolean NOT NULL,
  would_be_story_id   text,
  would_be_creator_id text,
  would_be_event_id   uuid,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (order_id, trigger_event_id, would_be_event_id)
);

-- ---------------------------------------------------------------------------
-- Ledger: double-entry, append-only. Debit = +, credit = -.
-- ---------------------------------------------------------------------------
CREATE TABLE ledger_accounts (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  kind       text NOT NULL CHECK (kind IN ('platform_commission_expense', 'creator_accrued', 'creator_payable')),
  creator_id text,
  CHECK ((kind = 'platform_commission_expense') = (creator_id IS NULL))
);
CREATE INDEX ledger_accounts_creator ON ledger_accounts (creator_id);

INSERT INTO ledger_accounts (code, kind) VALUES ('platform:commission_expense', 'platform_commission_expense');

CREATE TABLE ledger_transactions (
  id                  bigserial PRIMARY KEY,
  idempotency_key     text NOT NULL UNIQUE,
  type                text NOT NULL CHECK (type IN ('accrue', 'make_payable', 'reverse')),
  order_id            text NOT NULL,
  creator_id          text NOT NULL,
  amount_paise        bigint NOT NULL CHECK (amount_paise > 0),
  attribution_version integer NOT NULL,
  reason              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_transactions_creator ON ledger_transactions (creator_id, id);
CREATE INDEX ledger_transactions_order ON ledger_transactions (order_id, id);

CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  transaction_id bigint NOT NULL REFERENCES ledger_transactions (id),
  account_id     bigint NOT NULL REFERENCES ledger_accounts (id),
  order_id       text NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise <> 0)
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_transaction ON ledger_entries (transaction_id);

-- Results of the scheduled invariant checker.
CREATE TABLE invariant_checks (
  id         bigserial PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL,
  details    jsonb NOT NULL
);

-- ---------------------------------------------------------------------------
-- DB-enforced guarantees
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

-- TRUNCATE is only allowed when the test suite explicitly opts in.
CREATE FUNCTION forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('aumbram.allow_truncate', true), '') <> 'on' THEN
    RAISE EXCEPTION 'TRUNCATE on % is not allowed: the table is append-only', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER attribution_decisions_append_only BEFORE UPDATE OR DELETE ON attribution_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER attribution_decisions_no_truncate BEFORE TRUNCATE ON attribution_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();
CREATE TRIGGER late_locked_events_append_only BEFORE UPDATE OR DELETE ON late_locked_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER late_locked_events_no_truncate BEFORE TRUNCATE ON late_locked_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_truncate();

-- Every ledger transaction must have >= 2 entries summing to exactly 0.
-- Checked at COMMIT (deferred), so a transaction and its entries can be
-- inserted by separate statements inside one DB transaction.
CREATE FUNCTION check_ledger_transaction_balanced(txn_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total numeric;
  n     integer;
BEGIN
  SELECT coalesce(sum(amount_paise), 0), count(*) INTO total, n
  FROM ledger_entries WHERE transaction_id = txn_id;
  IF total <> 0 OR n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced (sum=%, entries=%)', txn_id, total, n
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION ledger_transaction_balanced_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_ledger_transaction_balanced(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION ledger_entry_balanced_trg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM check_ledger_transaction_balanced(NEW.transaction_id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_transaction_balanced_trg();
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_entry_balanced_trg();